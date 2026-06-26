// account-manager — multi-account lifecycle, webhook delivery, auto-reply engine
// Semua data di-persist ke SQLite via db.js, gak pake JSON file lagi
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { isIP } from 'node:net'
import logger from './utils/logger.js'
import { createWAClient } from './client.js'
import { getDatabase } from './db.js'
import { AntiBan } from './anti-ban.js'
import { createQueue, createWorker, enqueueJob, isQueueEnabled } from './queue.js'

// Bersihin nomor dari format JID: 628xxx@s.whatsapp.net → 628xxx
// Juga handle @c.us, @g.us, dan format lainnya
// Biar webhook dapet nomor bersih tanpa domain suffix
function cleanPhone(jid) {
  if (!jid || typeof jid !== 'string') return jid || ''
  const atIndex = jid.indexOf('@')
  let phone = atIndex > -1 ? jid.substring(0, atIndex) : jid
  // Buang device ID (:0, :1, :5, dll) — cuma ambil nomor aja
  const colonIndex = phone.indexOf(':')
  return colonIndex > -1 ? phone.substring(0, colonIndex) : phone
}

// Deteksi tipe JID — user, group, atau channel/newsletter
function getJidType(jid) {
  if (!jid) return 'user'
  if (jid.endsWith('@g.us')) return 'group'
  if (jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return 'channel'
  // @lid = LID (Login ID) — format JID baru WhatsApp, tetap user biasa
  return 'user'
}

export class AccountManager {
  constructor() {
    // In-memory cache: account config + WhatsApp client instances
    this.accounts = new Map()
    this.clients = new Map()
    // Anti-ban instances per account (keyed by account ID, not label)
    this.antiBans = new Map()
    // Webhook failed delivery tracker: Map<webhookId, {url, payload, error, timestamp}>
    // Disimpan di memory aja — gak perlu persist karena untuk debugging
    this.failedWebhooks = new Map()
    // Auto-reply cooldown tracker: Map<"${accountId}:${contactId}:${ruleId}", timestamp>
    // Key composite biar cooldown per-contact per-rule
    this.cooldownMap = new Map()
    // Metrics instance — di-set via setMetrics() pas startup
    this.metrics = null
    // Job tracker — mapping jobId → { status, messageId, accountId, to, message, timestamp }
    this._jobTracker = new Map()
    // Mapping messageId → jobId — biar webhook message.ack bisa ngebawa jobId asalnya
    this._messageToJob = new Map()
    // Quick QR pairing — pending sessions yang nunggu di-scan
    // Map<tempId, { socket, tempDir, createdAt, resolve, reject }>
    this._pendingQRSessions = new Map()
  }

  /**
   * Set metrics instance dari index.js.
   * Dipanggil setelah AccountManager di-init.
   */
  setMetrics(metrics) {
    this.metrics = metrics
  }

  async init() {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM accounts ORDER BY created_at ASC').all()

    for (const row of rows) {
      const account = rowToAccount(row, db)
      this.accounts.set(account.id, account)
      this.clients.set(account.id, this._initClient(account))
      this.antiBans.set(account.id, AntiBan.fromDb(row.id, db))
    }

    logger.info(`Loaded ${rows.length} accounts from database`)
    return this
  }

  // Inisialisasi WhatsApp client + register event handlers untuk incoming message dan ACK
  _initClient(account) {
    let wa, antiBan
    try {
      // createWAClient return WAAdapter instance — library-agnostic
      wa = createWAClient(account)
      antiBan = this.antiBans.get(account.id) || new AntiBan(account.id)

      // Handler pesan masuk — trigger webhook + auto-reply via adapter callback
      // Callback menerima WAMessage standard (library-agnostic)
      wa.onMessage(async (waMsg) => {
        if (waMsg.fromMe) return
        try {
          await this._handleIncoming(account.id, waMsg)
        } catch (err) {
          logger.error(`${account.label}: incoming handler error — ${err.message}`)
        }
      })

      // Handler ACK (delivery status) — trigger webhook via adapter callback
      wa.onMessageAck(async (waAck) => {
        try {
          await this._handleAck(account.id, waAck)
        } catch (err) {
          logger.error(`${account.label}: ack handler error — ${err.message}`)
        }
      })

      // ================================================================
      // Handler ready: koneksi WhatsApp berhasil — simpan nomor HP + kirim webhook
      // ================================================================
      wa.onReady(() => {
        logger.info(`${account.label}: connection ready`)

        // Simpan nomor HP dari session creds — biar bisa deteksi duplikat
        // dan biar findAccountByPhone bisa jalan
        if (!account.phone) {
          const sessionDir = process.env.SESSION_DIR || './sessions'
          const credsFile = join(sessionDir, account.id, 'creds.json')
          try {
            if (existsSync(credsFile)) {
              const creds = JSON.parse(readFileSync(credsFile, 'utf-8'))
              const meId = creds.me?.id || ''
              if (meId) this.updateAccountPhone(account.id, meId)
            }
          } catch {}
        }

        this._sendConnectionWebhook(account, 'connected')
      })

      // ================================================================
      // Handler disconnect: auto-reconnect untuk network glitch
      // ================================================================
      wa.onDisconnected(async (reason) => {
        logger.warn(`${account.label}: disconnected — ${reason}`)

        // Kirim webhook connection status — biar tau kalo koneksi putus
        this._sendConnectionWebhook(account, 'disconnected', reason)

        // Skip auto-reconnect kalo account udah dihapus
        if (!this.accounts.has(account.id)) {
          logger.info(`${account.label}: account deleted — skip reconnect`)
          return
        }

        // Kalau LOGOUT atau SESSION_EXPIRED → jangan auto-reconnect
        // RESTART_REQUIRED juga di-skip — udah ditangani internal adapter
        if (reason === 'LOGOUT' || reason === 'SESSION_EXPIRED' || reason === 'RESTART_REQUIRED') {
          logger.warn(`${account.label}: ${reason} — auto-reconnect disabled${reason === 'RESTART_REQUIRED' ? ' (handled by adapter)' : '. Scan QR to re-authenticate.'}`)
          wa._reconnectAttempts = wa._maxReconnectAttempts
          return
        }

        // Kalau akun BARU (belum pernah scan QR) → skip reconnect
        // Biarin Baileys generate QR code instead of retrying forever
        if (reason === 'DISCONNECTED') {
          const credsPath = `${process.env.SESSION_DIR || './sessions'}/${account.id}/creds.json`
          const { existsSync } = await import('node:fs')
          if (!existsSync(credsPath)) {
            logger.info(`${account.label}: new account (no creds) — waiting for QR, skip reconnect`)
            return
          }
        }

        // Coba reconnect dengan backoff
        if (wa._reconnectAttempts < wa._maxReconnectAttempts) {
          wa._reconnectAttempts++
          const attempt = wa._reconnectAttempts
          const delay = wa._reconnectDelay * attempt
          logger.info(`${account.label}: reconnect attempt ${attempt}/${wa._maxReconnectAttempts} in ${delay}ms...`)
          await sleep(delay)
          try {
            await wa.initialize()
            logger.info(`${account.label}: reconnect attempt ${attempt} successful`)
          } catch (err) {
            logger.error(`${account.label}: reconnect attempt ${attempt} failed — ${err.message}`)
          }
        } else {
          logger.error(`${account.label}: max reconnect attempts (${wa._maxReconnectAttempts}) reached.`)
        }
      })

      // Mulai koneksi WhatsApp — error handling biar gak crash server
      wa.initialize().catch(err => {
        logger.error(`${account.label}: client initialize error — ${err.message}`)
      })
    } catch (err) {
      logger.error(`${account.label}: client creation failed — ${err.message}`)
      return { wa: null, antiBan: null, error: err.message }
    }

    return { wa, antiBan }
  }

  // Kirim event pesan masuk ke semua webhook + proses auto-reply rules
  // msg adalah WAMessage standard — library-agnostic { id, from, body, type, timestamp, hasMedia, fromMe, isGroup }
  async _handleIncoming(accountId, msg) {
    const account = this.accounts.get(accountId)
    if (!account) return

    const webhooks = account.webhooks || []
    const autoReplies = account.autoReplies || []

    // Payload standard buat webhook — dari WAMessage field yang udah standard
    // Nomor di-clean dari format JID: 628xxx@s.whatsapp.net → 628xxx
    // from = nomor pengirim (senderJid untuk grup, from untuk 1-on-1)
    // chatId = ID percakapan (grup: ID grup, 1-on-1: nomor kontak)
    const senderJid = msg.senderJid || msg.from
    const jidType = getJidType(msg.from)
    let fromNumber = cleanPhone(senderJid)

    // Untuk LID user (@lid) — coba resolve ke nomor HP via lidMapping
    if (senderJid?.endsWith('@lid')) {
      try {
        const client = this.clients.get(accountId)
        // BaileysAdapter pake _sock, WwebAdapter pake _client
        const sock = client?.wa?._sock || client?.wa?.client
        if (sock?.signalRepository?.lidMapping) {
          const pnJid = await sock.signalRepository.lidMapping.getPNForLID(senderJid)
          if (pnJid) {
            fromNumber = cleanPhone(pnJid)
          }
        }
      } catch {}
    }

    const payload = {
      event: 'message',
      accountId,
      accountLabel: account.label,
      senderName: msg.senderName || '',
      from: fromNumber,
      fromMe: msg.fromMe,
      body: msg.body,
      type: msg.type,
      timestamp: msg.timestamp,
      hasMedia: msg.hasMedia,
      isGroup: jidType === 'group',
      isChannel: jidType === 'channel',
      chatId: cleanPhone(msg.from),
      senderJid: fromNumber,
    }

    // Kirim ke semua webhook yang terdaftar (fire & forget biar gak blocking)
    // Setiap webhook di-wrap try-catch sendiri biar satu kegagalan
    // gak ngaruh ke webhook lain (Task 3.5 — Webhook Error Isolation)
    for (const wh of webhooks) {
      if (wh.url && wh.enabled) {
        try {
          this._deliverWebhook(wh, payload)
        } catch (err) {
          // _deliverWebhook udah punya internal try-catch, tapi kita
          // tambahin safety net buat synchronous error jaga-jaga
          logger.warn(`${account.label}: webhook ${wh.url} error — ${err.message}`)
        }
      }
    }

    // Proses auto-reply — cari rule yang match, kirim balasan
    for (const rule of autoReplies) {
      if (!rule.enabled) continue
      if (this._matchRule(rule, msg)) {
        const client = this.clients.get(accountId)
        if (!client) continue

        // ================================================================
        // Cooldown check: jangan spam balas pesan yang sama berulang kali
        // ================================================================
        // Composite key: accountId:contactId:ruleId — biar per-contact per-rule
        const contactId = msg.from
        const cooldownKey = `${accountId}:${contactId}:${rule.id}`
        const cooldownSeconds = rule.cooldown ?? 30

        if (cooldownSeconds > 0) {
          const lastReplied = this.cooldownMap.get(cooldownKey) || 0
          const elapsed = Date.now() - lastReplied
          const cooldownMs = cooldownSeconds * 1000

          if (elapsed < cooldownMs) {
            // Masih dalam cooldown — skip reply
            logger.debug(`${account.label}: auto-reply cooldown aktif untuk ${contactId} (${rule.keyword}) — ${Math.round((cooldownMs - elapsed) / 1000)}s lagi`)
            continue
          }
        }

        // Proses kirim auto-reply
        try {
            // Template variables: {{body}} -> isi pesan, {{from}} -> nomor pengirim, {{senderName}} -> nama kontak
            // Fallback senderName ke nomor (clean) biar gak muncul "2077@lid!"
            const fallbackName = msg.from ? msg.from.split('@')[0] : ''
            const replyMsg = rule.reply
              .replace(/{{body}}/g, msg.body)
              .replace(/{{from}}/g, msg.from)
              .replace(/{{senderName}}/g, msg.senderName || fallbackName)

          await this.sendMessage(accountId, msg.from, replyMsg, { skipAntiBan: true })
          logger.info(`${account.label}: auto-replied to ${msg.from}`)

          // Update cooldown timestamp — catet kapan terakhir reply
          if (cooldownSeconds > 0) {
            this.cooldownMap.set(cooldownKey, Date.now())
          }
        } catch (err) {
          logger.error(`${account.label}: auto-reply failed — ${err.message}`)
        }
      }
    }
  }

  // Kirim event ACK ke webhook
  // waAck adalah WAAck standard: { id, from, ack } — dari adapter, id udah clean string
  async _handleAck(accountId, waAck) {
    const account = this.accounts.get(accountId)
    if (!account) return

    // Cari jobId dari messageId — biar webhook bawa referensi queue job
    const jobId = this._messageToJob?.get(waAck.id) || null

    for (const wh of account.webhooks || []) {
      if (wh.url && wh.enabled) {
        try {
          this._deliverWebhook(wh, {
            event: 'message.ack',
            accountId,
            accountLabel: account.label,
            from: cleanPhone(waAck.from),
            id: waAck.id,
            ack: waAck.ack,
            jobId, // ← referensi queue job, null kalo dikirim langsung (bukan via queue)
          })
        } catch (err) {
          logger.warn(`${account.label}: ack webhook ${wh.url} error — ${err.message}`)
        }
      }
    }
  }

  /**
   * Kirim webhook connection status — connected / disconnected
   * Dipanggil dari _initClient pas onReady & onDisconnected
   */
  _sendConnectionWebhook(account, status, reason) {
    for (const wh of account.webhooks || []) {
      if (wh.url && wh.enabled) {
        this._deliverWebhook(wh, {
          event: 'connection.status',
          accountId: account.id,
          accountLabel: account.label,
          status,
          reason: reason || '',
          timestamp: Math.floor(Date.now() / 1000),
        })
      }
    }
  }

  /**
   * Kirim HTTP POST ke URL webhook — pake axios, timeout configurable.
   * Retry 3x dengan exponential backoff: 1s → 4s → 16s.
   * Hanya retry kalau error bukan 4xx (client error) — jangan retry 400/404.
   * Kalau semua retry gagal → simpan ke failedWebhooks tracker.
   */
  async _deliverWebhook(wh, payload) {
    const maxRetries = wh.maxRetries ?? 3
    // Backoff: 1 detik → 4 detik → 16 detik (exponential: 2^(2*attempt))
    const backoff = (attempt) => Math.pow(2, attempt * 2) * 1000

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const { default: axios } = await import('axios')
        await axios.post(wh.url, payload, {
          headers: {
            'Content-Type': 'application/json',
            ...(wh.headers || {}),
          },
          timeout: wh.timeout || 10000,
        })
        // Sukses — gak perlu lanjut retry
        if (this.metrics) this.metrics.inc('webhook_deliveries_total')
        return
      } catch (err) {
        const isLastAttempt = attempt === maxRetries

        // Cek apakah error 4xx — jangan retry client error
        // 4xx berarti request kita yang salah, retry gak bakal nolong
        const statusCode = err.response?.status || 0
        const is4xx = statusCode >= 400 && statusCode < 500

        if (is4xx) {
          // Client error — log dan simpan ke failed, gak usah retry
          logger.warn(`Webhook ${wh.url} failed (${statusCode}): ${err.message} — client error, no retry`)
          if (!isLastAttempt || statusCode >= 500) {
            // Untuk 4xx, simpan ke failed meskipun gak retry
            this._recordFailedWebhook(wh, payload, err.message)
          }
          if (this.metrics) this.metrics.inc('webhook_failures_total')
          return
        }

        if (isLastAttempt) {
          // Semua retry gagal — log error + simpan ke tracker
          logger.error(`Webhook ${wh.url} failed after ${maxRetries + 1} attempts: ${err.message}`)
          if (this.metrics) this.metrics.inc('webhook_failures_total')
          this._recordFailedWebhook(wh, payload, err.message)
        } else {
          // Masih ada retry — tunggu backoff, lalu coba lagi
          const delay = backoff(attempt)
          logger.warn(`Webhook ${wh.url} attempt ${attempt + 1}/${maxRetries + 1} failed — retry in ${delay}ms: ${err.message}`)
          await sleep(delay)
        }
      }
    }
  }

  /**
   * Catat webhook yang gagal total (setelah semua retry) ke failedWebhooks Map.
   */
  _recordFailedWebhook(wh, payload, error) {
    const entry = {
      webhookId: wh.id,
      accountId: wh.accountId || payload?.accountId || null,
      url: wh.url,
      event: payload?.event || 'unknown',
      payload,
      error,
      timestamp: new Date().toISOString(),
    }
    this.failedWebhooks.set(wh.id || wh.url, entry)
    logger.warn(`Webhook failed recorded: ${wh.url} — ${error}`)
  }

  /**
   * Ambil daftar webhook yang gagal. Untuk debugging / retry manual via API.
   */
  getFailedWebhooks(accountId) {
    const account = this.accounts.get(accountId)
    if (!account) return []

    const results = []
    for (const [, entry] of this.failedWebhooks) {
      if (entry.accountId === accountId) {
        results.push(entry)
      }
    }
    return results
  }

  /**
   * Hapus semua catatan webhook failed untuk satu account.
   */
  clearFailedWebhooks(accountId) {
    const account = this.accounts.get(accountId)
    if (!account) return 0

    const webhookIds = new Set((account.webhooks || []).map(wh => wh.id))
    let count = 0
    for (const [key, entry] of this.failedWebhooks) {
      if (key.startsWith(accountId) || webhookIds.has(entry.webhookId)) {
        this.failedWebhooks.delete(key)
        count++
      }
    }
    return count
  }

  /**
   * Cek apakah pesan match dengan rule auto-reply.
   * Support exact, contains, startsWith, regex.
   * Regex dari user wajib di-try-catch biar gak kena ReDoS.
   */
  _matchRule(rule, msg) {
    const body = (msg.body || '').toLowerCase()
    const keyword = (rule.keyword || '').toLowerCase()

    if (!keyword) return false

    switch (rule.matchType) {
      case 'exact':
        return body === keyword
      case 'contains':
        return body.includes(keyword)
      case 'startsWith':
        return body.startsWith(keyword)
      case 'regex':
        try {
          return new RegExp(rule.keyword, 'i').test(body)
        } catch {
          // Regex invalid — skip rule
          return false
        }
      default:
        return false
    }
  }

  // === Account CRUD ===

  addAccount(data) {
    const db = getDatabase()
    const id = data.id || randomUUID()
    const apiKey = data.apiKey || randomUUID()
    const now = new Date().toISOString()

    // Simpan ke database — phone optional, diisi pas pertama kali connected
    db.prepare(`
      INSERT INTO accounts (id, label, api_key, web_version, phone, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, data.label || `Account-${id.slice(0, 6)}`, apiKey, data.webVersion || null, data.phone || null, now, now)

    const account = {
      id,
      label: data.label || `Account-${id.slice(0, 6)}`,
      apiKey,
      webVersion: data.webVersion || null,
      phone: data.phone || null,
      webhooks: [],
      autoReplies: [],
      createdAt: now,
    }

    this.accounts.set(id, account)
    this.clients.set(id, this._initClient(account))
    // Anti-ban instance di-key pake account.id (UUID) — label bisa berubah, ID gak bisa
    this.antiBans.set(id, new AntiBan(id))

    logger.info(`Account added: ${account.label} (${id})`)
    return account
  }

  /**
   * Hapus account dari memory, database, session disk.
   * Urutan penting: hapus memory DULU sebelum destroy client,
   * biar disconnected handler gak trigger reconnect.
   */
  removeAccount(id) {
    // Cek dulu apakah account beneran ada — kalau gak ada return false
    if (!this.accounts.has(id)) {
      logger.warn(`removeAccount: account ${id} not found`)
      return false
    }

    // 1. Hapus dari memory DULU — before destroy, so disconnected handler
    //    ngecek accounts.has(id) → false → skip reconnect
    const client = this.clients.get(id)
    this.accounts.delete(id)
    this.clients.delete(id)
    this.antiBans.delete(id)

    // 2. Baru destroy WhatsApp client (trigger disconnected event)
    if (client && client.wa) {
      try {
        client.wa.destroy()
        logger.info(`${id}: client destroyed`)
      } catch (err) {
        logger.warn(`Client destroy error for ${id}: ${err.message}`)
      }
    } else if (client) {
      logger.warn(`${id}: no wa client to destroy`)
    }

    // 3. Hapus dari database — cascade delete webhooks + auto_replies
    const db = getDatabase()
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    logger.info(`Account removed from DB: ${id}`)

    // 4. Hapus session folder dari disk
    const sessionDir = join(process.env.SESSION_DIR || './sessions', id)
    if (existsSync(sessionDir)) {
      import('node:fs/promises').then(fs => {
        fs.rm(sessionDir, { recursive: true, force: true }).catch(err => {
          logger.warn(`Failed to delete session folder for ${id}: ${err.message}`)
        })
      })
    }

    logger.info(`Account removed: ${id}`)
    return true
  }

  // Update nomor telepon setelah account berhasil terautentikasi
  updateAccountPhone(id, phone) {
    if (!phone || !id) return
    const db = getDatabase()
    const cleanPhone = phone.split('@')[0].split(':')[0]
    db.prepare('UPDATE accounts SET phone = ? WHERE id = ?').run(cleanPhone, id)
    const acc = this.accounts.get(id)
    if (acc) acc.phone = cleanPhone
    logger.info(`Phone updated for account ${id}: ${cleanPhone}`)
  }

  // Cari account berdasarkan nomor telepon — query database langsung
  // Biar gak ada duplikat registrasi nomor yang sama
  findAccountByPhone(phone) {
    if (!phone) return null
    const cleanPhone = phone.split('@')[0].split(':')[0]
    const db = getDatabase()
    const row = db.prepare('SELECT * FROM accounts WHERE phone = ?').get(cleanPhone)
    if (row) return this.accounts.get(row.id) || null
    return null
  }

  getAccount(id) {
    return this.accounts.get(id) || null
  }

  listAccounts() {
    return Array.from(this.accounts.values()).map(a => ({
      ...a,
      status: this.getStatus(a.id),
    }))
  }

  getStatus(id) {
    const client = this.clients.get(id)
    if (!client) return 'unknown'
    // Handle case di mana wa null (gagal initialize)
    if (!client.wa) {
      return {
        ready: false,
        authenticated: false,
        hasQR: false,
        error: client.error || 'client not initialized',
        antiBan: client.antiBan ? client.antiBan.getState() : {},
      }
    }
    return {
      ready: client.wa.ready,
      authenticated: client.wa.authenticated,
      hasQR: !!client.wa.getQR(),
      antiBan: client.antiBan.getState(),
    }
  }

  getClient(id) {
    return this.clients.get(id) || null
  }

  // === Send Message ===

  async sendMessage(accountId, to, message, options = {}) {
    const client = this.clients.get(accountId)
    if (!client) throw new Error(`Account ${accountId} not found`)
    if (!client.wa) throw new Error(`Account ${accountId}: client not initialized (${client.error || 'unknown error'})`)
    if (!client.wa.ready) throw new Error(`${client.wa.label}: client not ready`)

    // Pake formatJID dari adapter — library-specific (wwebjs: @c.us, baileys: @s.whatsapp.net)
    const chatId = client.wa.formatJID(to)
    const contactId = to.split('@')[0]

    // Anti-ban: delay, rate limit, typing simulation (kecuali skipAntiBan)
    if (!options.skipAntiBan) {
      await client.antiBan.preSend(contactId)

      if (options.simulateTyping !== false) {
        await client.antiBan.simulateTyping(message)
      }

      client.antiBan.incrementCounters(contactId)

      // Persist anti-ban state tiap 10 pesan biar lebih real-time
      if (client.antiBan.dailySent % 10 === 0) {
        this.saveAntiBanState(accountId)
      }
    }

    // Pake adapter sendText — return { id: string } (library-agnostic)
    const result = await client.wa.sendText(chatId, message, options)

    // Increment metrics counter
    if (this.metrics) {
      this.metrics.inc('messages_sent_total')
    }

    return result
  }

  /**
   * Kirim media message (image, document, audio, video) via WhatsApp.
   * - Delegasi ke adapter sendMedia — adapter yang handle loading media (library-specific)
   * - Anti-ban delay + typing simulation same as text message
   *
   * media object: { mediaType, mediaUrl?, mediaPath?, caption?, filename? }
   */
  async sendMedia(accountId, to, media, options = {}) {
    const client = this.clients.get(accountId)
    if (!client) throw new Error(`Account ${accountId} not found`)
    if (!client.wa) throw new Error(`Account ${accountId}: client not initialized (${client.error || 'unknown error'})`)
    if (!client.wa.ready) throw new Error(`${client.wa.label}: client not ready`)

    const chatId = client.wa.formatJID(to)
    const contactId = to.split('@')[0]
    const { mediaType, mediaUrl, mediaPath, caption, filename } = media

    // Validasi: harus ada mediaUrl atau mediaPath
    if (!mediaUrl && !mediaPath) {
      throw new Error('mediaUrl atau mediaPath wajib diisi')
    }

    // Anti-ban: delay + rate limit + typing simulation (kecuali skipAntiBan)
    if (!options.skipAntiBan) {
      await client.antiBan.preSend(contactId)

      if (options.simulateTyping !== false) {
        await client.antiBan.simulateTyping(media.caption || '')
      }

      client.antiBan.incrementCounters(contactId)

      if (client.antiBan.dailySent % 10 === 0) {
        this.saveAntiBanState(accountId)
      }
    }

    // Delegasi ke adapter — sendMedia handle loading + kirim media
    // Adapter tau cara load media dari URL/file sesuai library masing-masing
    const result = await client.wa.sendMedia(chatId, media, options)

    // Increment metrics — media message juga dihitung sebagai sent message
    if (this.metrics) {
      this.metrics.inc('messages_sent_total')
    }

    return result
  }

  /**
   * Rotate API key — generate UUID baru, update DB + memory cache.
   * Dipanggil dari endpoint POST /accounts/:id/rotate-key
   */
  rotateApiKey(id) {
    const account = this.accounts.get(id)
    if (!account) throw new Error('Account not found')

    const db = getDatabase()
    const newKey = randomUUID()
    db.prepare('UPDATE accounts SET api_key = ? WHERE id = ?').run(newKey, id)
    account.apiKey = newKey

    logger.info(`API key rotated for account ${id}`)
    return newKey
  }

  // === Webhook CRUD ===

  // Refresh cache webhooks dari database — parse JSON headers + boolean
  _refreshWebhooks(accountId) {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    const db = getDatabase()
    acc.webhooks = db.prepare('SELECT * FROM webhooks WHERE account_id = ?').all(accountId).map(wh => ({
      id: wh.id,
      accountId,
      url: wh.url,
      headers: wh.headers ? tryParseJson(wh.headers) : null,
      timeout: wh.timeout,
      enabled: !!wh.enabled,
    }))
  }

  addWebhook(accountId, webhook) {
    const acc = this.accounts.get(accountId)
    if (!acc) throw new Error('Account not found')

    // Validasi URL dulu sebelum disimpan — proteksi SSRF
    // Lempar error kalau URL指向 internal/private IP atau protocol gak aman
    validateWebhookUrl(webhook.url)

    const db = getDatabase()
    const id = randomUUID()
    const headers = webhook.headers ? JSON.stringify(webhook.headers) : null

    db.prepare(`
      INSERT INTO webhooks (id, account_id, url, headers, timeout, enabled)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, accountId, webhook.url, headers, webhook.timeout || 10000, webhook.enabled !== false ? 1 : 0)

    // Refresh cache — biar format konsisten
    this._refreshWebhooks(accountId)

    const wh = { id, accountId, url: webhook.url, headers: webhook.headers, timeout: webhook.timeout || 10000, enabled: true }
    logger.info(`Webhook added for ${accountId}: ${webhook.url}`)
    return wh
  }

  removeWebhook(accountId, webhookId) {
    const acc = this.accounts.get(accountId)
    if (!acc) return false

    const db = getDatabase()
    const result = db.prepare('DELETE FROM webhooks WHERE id = ? AND account_id = ?').run(webhookId, accountId)

    if (result.changes > 0) {
      this._refreshWebhooks(accountId)
      return true
    }
    return false
  }

  // === Auto-Reply CRUD ===

  // Refresh cache auto-replies dari database
  _refreshAutoReplies(accountId) {
    const acc = this.accounts.get(accountId)
    if (!acc) return
    const db = getDatabase()
    acc.autoReplies = db.prepare('SELECT * FROM auto_replies WHERE account_id = ?').all(accountId).map(ar => ({
      id: ar.id,
      keyword: ar.keyword,
      reply: ar.reply,
      matchType: ar.match_type,
      enabled: !!ar.enabled,
      cooldown: ar.cooldown,
    }))
  }

  addAutoReply(accountId, rule) {
    const acc = this.accounts.get(accountId)
    if (!acc) throw new Error('Account not found')

    // Validasi: keyword gak boleh kosong atau cuma whitespace — biar gak match semua pesan
    const keyword = (rule.keyword || '').trim()
    if (!keyword) throw new Error('Keyword tidak boleh kosong')

    const db = getDatabase()
    const id = randomUUID()

    db.prepare(`
      INSERT INTO auto_replies (id, account_id, keyword, reply, match_type, enabled, cooldown)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, accountId,
      keyword,
      rule.reply || '',
      rule.matchType || 'contains',
      rule.enabled !== false ? 1 : 0,
      rule.cooldown ?? 30,
    )

    // Refresh cache — biar format konsisten
    this._refreshAutoReplies(accountId)

    const ar = { id, keyword: rule.keyword, reply: rule.reply, matchType: rule.matchType || 'contains', enabled: true, cooldown: rule.cooldown ?? 30 }
    logger.info(`Auto-reply added for ${accountId}: "${rule.keyword}"`)
    return ar
  }

  removeAutoReply(accountId, ruleId) {
    const acc = this.accounts.get(accountId)
    if (!acc) return false

    const db = getDatabase()
    const result = db.prepare('DELETE FROM auto_replies WHERE id = ? AND account_id = ?').run(ruleId, accountId)

    if (result.changes > 0) {
      this._refreshAutoReplies(accountId)
      return true
    }
    return false
  }

  // === Anti-Ban State Persistence ===

  saveAntiBanState(accountId) {
    const antiBan = this.antiBans.get(accountId)
    if (!antiBan) return

    const db = getDatabase()
    db.prepare(`
      INSERT INTO anti_ban_state (account_id, daily_sent, daily_reset, warmup_day, warmup_complete, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(account_id) DO UPDATE SET
        daily_sent = excluded.daily_sent,
        daily_reset = excluded.daily_reset,
        warmup_day = excluded.warmup_day,
        warmup_complete = excluded.warmup_complete,
        updated_at = excluded.updated_at
    `).run(
      accountId,
      antiBan.dailySent,
      new Date(antiBan.dailyReset).toISOString(),
      antiBan.warmupDay,
      antiBan.warmupComplete ? 1 : 0,
    )
  }

  // === Graceful Shutdown ===

  async destroy() {
    logger.info('Shutting down all WhatsApp clients...')
    for (const [id, client] of this.clients) {
      try {
        // Persist anti-ban state sebelum destroy
        this.saveAntiBanState(id)
        if (client.wa) {
          await client.wa.destroy()
          logger.info(`  ${id}: destroyed`)
        } else {
          logger.warn(`  ${id}: no client to destroy (${client.error || 'unknown'})`)
        }
      } catch (err) {
        logger.warn(`  ${id}: destroy error — ${err.message}`)
      }
    }
    this.clients.clear()
    this.accounts.clear()
    this.antiBans.clear()
    logger.info('All clients destroyed')
  }

  // Persist semua anti-ban state (dipanggil periodik atau pas shutdown)
  persistAllAntiBan() {
    for (const id of this.antiBans.keys()) {
      this.saveAntiBanState(id)
    }
  }

  // ================================================================
  // BullMQ queue untuk send message — optional, butuh Redis
  // ================================================================

  // Enqueue send message ke Redis — response cepet, worker yg proses
  async sendViaQueue(accountId, to, message, options = {}) {
    const queue = await createQueue('waun-send')
    if (!queue) return null
    const job = await enqueueJob(queue, 'send', { accountId, to, message, options })
    if (job) {
      // Simpan tracker biar bisa di-cari nanti
      this._jobTracker.set(job.id, {
        jobId: job.id,
        accountId,
        to,
        message,
        status: 'queued',
        timestamp: new Date().toISOString(),
      })
    }
    return job
  }

  /** Dapatkan status job dari tracker */
  getJobStatus(jobId) {
    return this._jobTracker.get(String(jobId)) || null
  }

  /** Inisialisasi BullMQ worker untuk proses send message dari queue */
  async initSendQueueWorker() {
    if (!isQueueEnabled()) {
      logger.debug('Send queue disabled — skip worker initialization')
      return
    }

    const worker = await createWorker('waun-send', async (job) => {
      const { accountId, to, message, options } = job.data
      logger.info(`Processing queued send to ${to}`)
      try {
        const result = await this.sendMessage(accountId, to, message, options)
        // Update tracker dengan messageId asli dari WhatsApp
        if (this._jobTracker.has(job.id)) {
          const entry = this._jobTracker.get(job.id)
          entry.status = 'sent'
          entry.messageId = result.id
          entry.completedAt = new Date().toISOString()
        }
        // Simpan mapping messageId → jobId buat referensi webhook nantinya
        if (result?.id) {
          this._messageToJob.set(result.id, String(job.id))
        }
        logger.info(`Queued send to ${to} completed: ${result.id}`)
        return result
      } catch (err) {
        if (this._jobTracker.has(job.id)) {
          const entry = this._jobTracker.get(job.id)
          entry.status = 'failed'
          entry.error = err.message
        }
        logger.error(`Queued send to ${to} failed: ${err.message}`)
        throw err // Biar BullMQ retry
      }
    })

    if (worker) {
      logger.info('BullMQ send worker initialized')
    }
  }
}

// ============================================================
// Validasi URL webhook — proteksi SSRF biar gak bisa指向 internal service
// ============================================================

/**
 * Validasi URL webhook buat cegah SSRF (Server-Side Request Forgery).
 * - Hanya allow https:// (atau http:// di mode development)
 * - Blokir private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1)
 * - Blokir hostname internal (localhost, 0.0.0.0, metadata.google.internal, 169.254.169.254)
 *
 * Alasan: attacker bisa set webhook URL ke service internal kaya Redis (port 6379)
 * atau cloud metadata endpoint buat nyuri credentials kalo gak divalidasi.
 */
function validateWebhookUrl(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('Invalid URL format — tidak bisa di-parse')
  }

  // Cuma allow https:// — http:// cuma di mode development
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Hanya protocol https:// yang diizinkan (atau http:// untuk development)')
  }

  // Production mode WAJIB https:// — jangan sampai kirim data lewat HTTP polos
  if (process.env.NODE_ENV !== 'development' && parsed.protocol === 'http:') {
    throw new Error('HTTPS wajib digunakan di production mode')
  }

  const hostname = parsed.hostname.toLowerCase()

  // Blokir hostname internal yang umum dipake buat SSRF
  const blockedHostnames = [
    'localhost',
    '0.0.0.0',
    'metadata.google.internal',
    'metadata.internal',       // GCP internal
    '169.254.169.254',          // AWS metadata (juga dicek sebagai IP)
  ]
  if (blockedHostnames.includes(hostname)) {
    throw new Error(`URL menunjuk ke hostname internal/terblokir: ${hostname}`)
  }

  // Kalau hostname berupa IP address, cek apakah termasuk private range
  if (isIP(hostname) !== 0) {
    // IPv4 check
    if (isIP(hostname) === 4) {
      const parts = hostname.split('.').map(Number)
      const isPrivate =
        parts[0] === 10 ||                                                    // 10.0.0.0/8
        parts[0] === 127 ||                                                   // 127.0.0.0/8 (loopback)
        (parts[0] === 169 && parts[1] === 254) ||                             // 169.254.0.0/16 (link-local)
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||             // 172.16.0.0/12
        (parts[0] === 192 && parts[1] === 168) ||                             // 192.168.0.0/16
        parts[0] === 0                                                        // 0.0.0.0/8

      if (isPrivate) {
        throw new Error(`URL menunjuk ke private IP range: ${hostname}`)
      }
    }

    // IPv6 loopback (::1)
    if (hostname === '::1' || hostname === '[::1]' || hostname === '0:0:0:0:0:0:0:1') {
      throw new Error('URL menunjuk ke IPv6 loopback (::1)')
    }
  }

  return true
}

/**
 * Ambil IP dari hostname (resolve DNS).
 * Dipake buat ngecek apakah domain ternyata指向 private IP.
 * Catatan: kita cuma blokir IP langsung di URL, DNS resolve
 * dilakukan pas request biar gak blocking.
 */

// Helper: konversi row SQLite ke object account + load relasinya
// Map snake_case dari DB ke camelCase biar konsisten sama API response
function rowToAccount(row, db) {
  const webhooks = db.prepare('SELECT * FROM webhooks WHERE account_id = ?').all(row.id).map(wh => ({
    id: wh.id,
    accountId: row.id,
    url: wh.url,
    headers: wh.headers ? tryParseJson(wh.headers) : null,
    timeout: wh.timeout,
    enabled: !!wh.enabled,
  }))

  const autoReplies = db.prepare('SELECT * FROM auto_replies WHERE account_id = ?').all(row.id).map(ar => ({
    id: ar.id,
    keyword: ar.keyword,
    reply: ar.reply,
    matchType: ar.match_type,
    enabled: !!ar.enabled,
    cooldown: ar.cooldown,
  }))

  return {
    id: row.id,
    label: row.label,
    apiKey: row.api_key,
    webVersion: row.web_version,
    phone: row.phone || null,
    webhooks,
    autoReplies,
    createdAt: row.created_at,
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str) } catch { return null }
}
