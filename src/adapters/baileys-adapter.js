// baileys-adapter — implementasi WAAdapter pake @whiskeysockets/baileys
// WebSocket murni, tanpa browser. RAM per session: ~5-10 MB vs 150-250 MB (wwebjs).
import { readFile } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import axios from 'axios'
import pino from 'pino'
import logger from '../utils/logger.js'
import { WAAdapter, createWAMessage } from '../wa-adapter.js'

const BAILEYS_CACHE = {}

// Lazy load Baileys — pake dynamic import karena CJS module
async function getBaileys() {
  if (!BAILEYS_CACHE.module) {
    BAILEYS_CACHE.module = await import('@whiskeysockets/baileys')
  }
  return BAILEYS_CACHE.module
}

// Getter biar ga perlu await tiap kali — udah di-cache
function B(method) {
  if (!BAILEYS_CACHE.module) throw new Error('Baileys not loaded yet')
  return BAILEYS_CACHE.module[method]
}

export class BaileysAdapter extends WAAdapter {
  constructor(account) {
    super(account)
    this._name = 'baileys'
    this._sessionPath = `${process.env.SESSION_DIR || './sessions'}/${account.id}`
    this._sock = null
    this._saveCreds = null

    // Dedup cache untuk pesan masuk — biar auto-reply gak trigger 2x
    this._recentMessages = new Map()
    this._dedupTTL = 5000 // 5 detik
    this._dedupMaxSize = 200

    // Intercept console.log biar log Baileys "Closing session" gak muncul
    // Baileys pake console.log langsung (bukan pino) buat debug signal session.
    // Ini gak ngaruh ke WAUN sendiri karena WAUN pake pino.
    this._origConsoleLog = console.log
    console.log = (...args) => {
      const msg = typeof args[0] === 'string' ? args[0] : ''
      if (msg.includes('Closing session') || msg.includes('SessionEntry')) return
      this._origConsoleLog.apply(console, args)
    }
  }

  async initialize() {
    const { makeWASocket, DisconnectReason, useMultiFileAuthState, Browsers } = await getBaileys()

    // Pastikan folder session ada
    const dir = this._sessionPath
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    // Load atau buat session — disimpan sebagai JSON files
    const { state, saveCreds } = await useMultiFileAuthState(dir)
    this._saveCreds = saveCreds

    // Buat WebSocket connection — tanpa browser! 🎉
    // Pake silent logger biar internal Baileys (session close, handshake, dll)
    // gak banjir log. Baileys kadang pake console.log langsung.
    const baileysLogger = pino({ level: 'silent' })

    // Beberapa versi Baileys pake console.log (bukan pino) buat debug internal.
    // Kita intercept sebentar biar log "Closing session" gak muncul.
    const origConsoleLog = console.log
    console.log = () => {}

    this._sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('WAUN'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      logger: baileysLogger,
      qrTimeout: 60000,
    })

    // Kembalikan console.log setelah socket dibuat
    console.log = origConsoleLog

    // ================================================================
    // Connection update — QR code, ready, disconnect
    // ================================================================
    this._sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
      // QR code — disimpan di buffer, diambil via GET /accounts/:id/qr
      if (qr) {
        this._qrBuffer = qr
        logger.info(`${this._label}: QR Code received — get via API: GET /accounts/${this._accountId}/qr?format=image`)
        this._onQR?.(qr)
        return
      }

      // Koneksi berhasil — client siap dipake
      if (connection === 'open') {
        this._ready = true
        this._authenticated = true
        this._qrBuffer = null
        logger.info(`${this._label}: Baileys connected`)
        this._onReady?.()
        return
      }

      // Koneksi putus — cari tau alasannya
      if (connection === 'close') {
        this._ready = false
        this._authenticated = false

        const statusCode = lastDisconnect?.error?.output?.statusCode
        let reason = 'DISCONNECTED'

        if (statusCode === DisconnectReason.loggedOut) reason = 'LOGOUT'
        else if (statusCode === DisconnectReason.badSession) reason = 'SESSION_EXPIRED'
        else if (statusCode === DisconnectReason.connectionReplaced) reason = 'CONNECTION_REPLACED'
        else if (statusCode === DisconnectReason.restartRequired) reason = 'RESTART_REQUIRED'
        else if (statusCode === DisconnectReason.timedOut) reason = 'TIMED_OUT'

        logger.warn(`${this._label}: Disconnected — ${reason} (code: ${statusCode})`)

        // Auto-reconnect untuk restartRequired (protocol upgrade / registration)
        if (statusCode === DisconnectReason.restartRequired) {
          logger.info(`${this._label}: restart required — reconnecting in 2s...`)
          this._reconnectAttempts = 0
          // Tunggu 2 detik biar creds selesai di-save ke disk
          setTimeout(() => {
            this.initialize().catch(err => {
              logger.error(`${this._label}: reconnect failed — ${err.message}`)
            })
          }, 2000)
          return
        }

        this._onDisconnected?.(reason)
      }
    })

    // ================================================================
    // Message masuk — dari messages.upsert event
    // Cuma proses type 'notify' (pesan baru) — skip history sync / append
    // Dedup by message ID + sender + TTL biar gak trigger auto-reply 2x
    // ================================================================

    this._sock.ev.on('messages.upsert', ({ messages, type }) => {
      // Cuma process pesan baru (notify), skip history sync & append
      if (type !== 'notify') return

      for (const msg of messages) {
        if (msg.key?.fromMe) continue

        const msgId = msg.key?.id || ''
        const sender = msg.key?.remoteJid || ''
        if (!msgId && !sender) continue

        // Dedup key: kombinasi messageId atau sender+body
        const dedupKey = msgId || `${sender}:${this._getMessageText(msg)}`
        const now = Date.now()

        // Cek apakah pernah diproses dalam TTL
        const lastTime = this._recentMessages.get(dedupKey)
        if (lastTime && (now - lastTime) < this._dedupTTL) {
          continue
        }

        // Catat timestamp proses
        this._recentMessages.set(dedupKey, now)

        // Bersihin cache lama kalau udah penuh
        if (this._recentMessages.size > this._dedupMaxSize) {
          const expired = now - this._dedupTTL
          for (const [key, time] of this._recentMessages) {
            if (time < expired) this._recentMessages.delete(key)
          }
        }

        const content = this._extractMessageContent(msg)
        if (!content) continue

        // Ambil nama kontak: pushName = nama akun WhatsApp, notifyName = nama notifikasi
        // Kalau keduanya kosong, fallback ke nomor (clean dari JID)
        const rawName = msg.pushName || msg.notifyName || (msg.key?.remoteJid || '').split('@')[0] || ''

        const waMsg = createWAMessage({
          id: msgId,
          from: sender,
          to: this._sock?.user?.id || '',
          body: content.text || '',
          type: content.type || 'chat',
          timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now(),
          hasMedia: !!content.mediaType,
          fromMe: false,
          mediaType: content.mediaType || null,
          senderName: rawName,
          senderJid: msg.key?.participant || sender,
        })
        this._onMessage?.(waMsg)
      }
    })

    // ================================================================
    // Message update — ACK status (terkirim, terbaca, dll)
    // ================================================================
    this._sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        if (!update.key?.id) continue
        this._onMessageAck?.({
          id: update.key.id,
          from: update.key.remoteJid || '',
          ack: update.status ?? 0,
        })
      }
    })

    // Auto-save credentials kalo ada perubahan (session sync)
    this._sock.ev.on('creds.update', saveCreds)
  }

  // Ekstrak teks dari Baileys message object tanpa perlu extract content dulu
  // Dipake buat dedup key fallback kalau msgId kosong
  _getMessageText(msg) {
    const proto = msg.message
    if (!proto) return ''
    const getContentType = B('getContentType')
    const type = getContentType?.(proto)
    if (!type) return ''
    const content = proto[type]
    if (!content) return ''
    return content.text || content.caption || content || ''
  }

  // Ekstrak teks dan tipe dari Baileys message object
  // Format Baileys beda dengan whatsapp-web.js — pake proto message
  _extractMessageContent(msg) {
    const proto = msg.message
    if (!proto) return null

    const getContentType = B('getContentType')
    const type = getContentType?.(proto)
    if (!type) return null

    const content = proto[type]
    if (!content) return null

    const result = { text: '', type, mediaType: null }

    switch (type) {
      case 'conversation':
        result.text = content || ''
        break
      case 'extendedTextMessage':
        result.text = content.text || ''
        break
      case 'imageMessage':
        result.text = content.caption || ''
        result.mediaType = 'image'
        break
      case 'videoMessage':
        result.text = content.caption || ''
        result.mediaType = 'video'
        break
      case 'audioMessage':
        result.mediaType = 'audio'
        break
      case 'documentMessage':
        result.text = content.caption || ''
        result.mediaType = 'document'
        break
      case 'stickerMessage':
        result.mediaType = 'sticker'
        break
      default:
        result.text = content.text || content.caption || ''
    }

    return result
  }

  async destroy() {
    // Kembalikan console.log ke aslinya — biar gak bocor ke adapter lain
    if (this._origConsoleLog) {
      console.log = this._origConsoleLog
      this._origConsoleLog = null
    }

    if (this._sock) {
      try {
        this._sock.end(undefined)
        this._sock = null
        logger.info(`${this._label}: Baileys disconnected`)
      } catch (err) {
        logger.warn(`${this._label}: destroy error — ${err.message}`)
      }
    }
  }

  // Helper: jalankan promise dengan timeout — biar gak hang selamanya
  async _withTimeout(promise, ms, errorMsg = 'Operation timed out') {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${errorMsg} (${ms}ms)`)), ms)
    })
    try {
      const result = await Promise.race([promise, timeout])
      return result
    } finally {
      clearTimeout(timer)
    }
  }

  // Kirim pesan teks — pake sendMessage dengan timeout
  // Kalo timeout, balik ID lokal biar response gak ilang
  async sendText(jid, text, options = {}) {
    if (!this._ready) throw new Error(`${this._label}: client not ready`)

    if (options.simulateTyping !== false) {
      await this._sock.sendPresenceUpdate('composing', jid)
    }

    const { generateMessageID } = await getBaileys()
    const localId = generateMessageID?.() || `WAUN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

    let resultId = localId
    try {
      const result = await this._withTimeout(
        this._sock.sendMessage(jid, { text }),
        15000,
        'sendMessage timeout'
      )
      resultId = result?.key?.id || localId
    } catch (err) {
      logger.warn(`${this._label}: sendMessage error, using local ID: ${err.message}`)
    }

    if (options.simulateTyping !== false) {
      await this._sock.sendPresenceUpdate('paused', jid)
    }

    return { id: resultId }
  }

  // Kirim media — load buffer dulu via axios/fs, baru kirim via Baileys
  // Typing indicator juga dikirim biar keliatan natural
  async sendMedia(jid, media, options = {}) {
    if (!this._ready) throw new Error(`${this._label}: client not ready`)

    const { mediaType, mediaUrl, mediaPath, caption, filename } = media
    if (!mediaUrl && !mediaPath) throw new Error('mediaUrl atau mediaPath wajib diisi')

    // Kirim typing indicator — biar kontak liat "typing..." sebelum file masuk
    if (options.simulateTyping !== false) {
      await this._sock.sendPresenceUpdate('composing', jid)
    }

    // Load buffer: dari URL (axios) atau file lokal (fs)
    let buffer
    try {
      if (mediaPath) {
        buffer = await readFile(mediaPath)
      } else {
        const res = await axios.get(mediaUrl, { responseType: 'arraybuffer' })
        buffer = Buffer.from(res.data)
      }
    } catch (err) {
      throw new Error(`Gagal load media: ${err.message}`)
    }

    // Buat Baileys message content sesuai mediaType
    const msgContent = {}
    switch (mediaType) {
      case 'image':
        msgContent.image = buffer
        if (caption) msgContent.caption = caption
        break
      case 'document':
        msgContent.document = buffer
        if (filename) msgContent.fileName = filename
        if (caption) msgContent.caption = caption
        break
      case 'audio':
        msgContent.audio = buffer
        break
      case 'video':
        msgContent.video = buffer
        if (caption) msgContent.caption = caption
        break
      default:
        msgContent.document = buffer
        msgContent.fileName = filename || 'file'
    }

    const result = await this._withTimeout(
      this._sock.sendMessage(jid, msgContent),
      60000,
      'sendMedia timeout'
    )

    // Stop typing indicator
    if (options.simulateTyping !== false) {
      await this._sock.sendPresenceUpdate('paused', jid)
    }

    return { id: result?.key?.id || '' }
  }
}

// Pre-load Baileys di background biar gak nunggu pas initialize
getBaileys().then(() => {
  logger.debug('Baileys library pre-loaded')
}).catch(err => {
  logger.error(`Baileys pre-load failed: ${err.message}`)
})
