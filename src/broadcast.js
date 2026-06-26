// broadcast engine — kirim pesan massal ke banyak kontak dengan batch processing
// Semua record di-persist ke SQLite biar gak hilang pas restart
// Opsional: bisa pake BullMQ (Redis) buat queue yang lebih reliable
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import logger from './utils/logger.js'
import { getDatabase } from './db.js'
import { createQueue, createWorker, enqueueJob, isQueueEnabled } from './queue.js'

// Maksimum kontak per broadcast: 10.000 (configurable via env).
// Alasan: 100k kontak di 1 request bakal overload memory & riskan kena ban.
// Kalau perlu > 10k kontak, bagi jadi beberapa broadcast.
const MAX_CONTACTS = parseInt(process.env.BROADCAST_MAX_CONTACTS || '10000')

export class BroadcastEngine {
  constructor(accountManager) {
    this.am = accountManager
    // In-memory cache untuk broadcast active — biar cepat diakses
    this.active = new Map()
    // Metrics instance — di-set dari index.js pas startup
    this.metrics = null
    // Event listeners buat WebSocket progress — Map<broadcastId, Set<callback>>
    // Dipake di ws.js buat push real-time progress ke client
    this._listeners = new Map()
  }

  /**
   * Set metrics instance dari index.js.
   * Dipanggil setelah BroadcastEngine di-init.
   */
  setMetrics(metrics) {
    this.metrics = metrics
  }

  getMaxContacts() {
    return MAX_CONTACTS
  }

  // Load broadcast records dari database pas init
  loadFromDb() {
    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM broadcasts ORDER BY created_at DESC LIMIT 100').all()
    for (const row of rows) {
      this.active.set(row.id, rowToBroadcast(row))
    }
    logger.info(`Loaded ${rows.length} broadcast records from database`)
  }

  // Template variables: {{name}}, {{phone}}, dll — di-replace dari data contact
  interpolate(template, contact) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      contact[k] !== undefined ? String(contact[k]) : `{{${k}}}`
    )
  }

  // Bagi array jadi chunk-chunk kecil biar gak overload memory
  chunk(arr, size) {
    const chunks = []
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size))
    return chunks
  }

  /**
   * Mulai broadcast baru.
   * - Contacts di-shuffle biar gak kelihatan pattern
   * - Record disimpan ke SQLite sebelum mulai
   * - Eksekusi via setImmediate biar response cepet balik
   */
  async start(accountId, { name, message, contacts, options = {} }) {
    // Validasi jumlah kontak — jangan sampai overload memory atau kena ban
    if (!contacts || contacts.length === 0) {
      throw new Error('Daftar kontak tidak boleh kosong')
    }
    if (contacts.length > MAX_CONTACTS) {
      throw new Error(
        `Jumlah kontak (${contacts.length}) melebihi batas maksimum ${MAX_CONTACTS}. ` +
        `Bagi broadcast menjadi beberapa bagian atau set env BROADCAST_MAX_CONTACTS untuk meningkatkan limit.`
      )
    }

    const id = randomUUID()
    const {
      batchSize = 10,
      batchDelay = 60000,
      shuffle = true,
      simulateTyping = true,
    } = options

    // Shuffle contacts biar distribusi merata
    const list = [...contacts]
    if (shuffle) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]]
      }
    }

    const now = new Date().toISOString()
    const record = {
      id,
      accountId,
      name: name || `Broadcast-${id.slice(0, 6)}`,
      message,
      contacts: list,
      total: list.length,
      sent: 0,
      failed: 0,
      status: 'pending',
      options: { batchSize, batchDelay, shuffle, simulateTyping },
      createdAt: now,
      startedAt: null,
      completedAt: null,
      errors: [],
    }

    // Simpan ke database
    this._insertRecord(record)

    // Cache di memory & mulai eksekusi
    this.active.set(id, record)

    // Increment metrics — track total broadcast yang pernah dimulai
    if (this.metrics) this.metrics.inc('broadcasts_total')

    // ================================================================
    // Opsional: enqueue via BullMQ kalau Redis tersedia
    // Fallback: setImmediate (backward compatible)
    // ================================================================
    const queue = isQueueEnabled() ? await createQueue('waun-broadcast') : null
    if (queue) {
      // Enqueue sebagai job — biar persist dan bisa retry per-contact
      const job = await enqueueJob(queue, 'broadcast', {
        broadcastId: id,
        accountId,
        batchSize,
        batchDelay,
        simulateTyping,
      }, {
        // Job identity biar gak duplicate
        jobId: `broadcast:${id}`,
        // Delay 1 detik biar response cepet balik
        delay: 1000,
      })
      if (job) {
        logger.info(`Broadcast ${id}: queued via BullMQ (job ${job.id})`)
        return id
      } else {
        // Enqueue gagal — fallback ke setImmediate
        logger.warn(`Broadcast ${id}: BullMQ enqueue failed — fallback ke setImmediate`)
      }
    }

    // Fallback: pake setImmediate (existing behavior)
    // Bungkus pake async IIFE + catch biar error synchronuous di _execute
    // gak bikin broadcast stuck di status 'pending'
    setImmediate(async () => {
      try {
        await this._execute(id, batchSize, batchDelay, simulateTyping)
      } catch (err) {
        logger.error(`Broadcast ${id}: unexpected error — ${err.message}`)
        const rec = this.active.get(id)
        if (rec) {
          rec.status = 'failed'
          rec.errors.push({ error: err.message })
          this._updateRecord(id, { status: 'failed', errors: rec.errors })
        }
      }
    })

    return id
  }

  // Simpan broadcast record baru ke SQLite
  _insertRecord(record) {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO broadcasts (id, account_id, name, message, total, sent, failed, status, contacts, options, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.accountId, record.name, record.message,
      record.total, record.sent, record.failed, record.status,
      JSON.stringify(record.contacts.map(c => ({ phone: c.phone, name: c.name }))),
      JSON.stringify(record.options),
      record.createdAt,
    )
  }

  // Update status broadcast di SQLite
  _updateRecord(id, changes) {
    const db = getDatabase()
    const fields = []
    const values = []

    for (const [key, value] of Object.entries(changes)) {
      if (key === 'errors') {
        fields.push('errors = ?')
        values.push(JSON.stringify(value))
      } else {
        fields.push(`${key} = ?`)
        values.push(value)
      }
    }

    values.push(id)
    db.prepare(`UPDATE broadcasts SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  /**
   * Eksekusi broadcast — kirim pesan per batch.
   - Tiap batch: kirim ke N kontak (configurable batchSize)
   - Antar batch: delay (configurable batchDelay)
   - Kalau kena DailyLimitError: pause, bisa di-resume besok
   */
  async _execute(id, batchSize, batchDelay, simulateTyping) {
    const rec = this.active.get(id)
    if (!rec) return

    // Safety check: jangan mulai kalau broadcast udah di-cancel atau selesai
    // Cegah race condition: cancel() dipanggil sebelum _execute berjalan
    // (Task 3.3 — Broadcast Race Condition)
    if (rec.status === 'cancelled' || rec.status === 'completed') return
    // Cegah double execution dari resume() yang dipanggil 2x berturut-turut
    if (rec.status === 'running') return

    // Set status running sebelum mulai — prevent duplicate execution
    rec.status = 'running'
    rec.startedAt = new Date().toISOString()
    this._updateRecord(id, { status: 'running', started_at: rec.startedAt })
    logger.info(`Broadcast ${id} — ${rec.total} contacts`)

    const client = this.am.getClient(rec.accountId)
    if (!client) {
      rec.status = 'failed'
      this._updateRecord(id, { status: 'failed' })
      this._emit(id, 'error', { message: 'WhatsApp client not found for account', accountId: rec.accountId })
      return
    }

    const batches = this.chunk(rec.contacts, batchSize || 10)

    for (let i = 0; i < batches.length; i++) {
      // Cek cancellation setiap batch
      if (rec.status === 'cancelled') {
        logger.info(`Broadcast ${id} cancelled`)
        this._emit(id, 'cancelled', { sent: rec.sent, total: rec.total, failed: rec.failed })
        return
      }

      const batch = batches[i]

      for (const contact of batch) {
        try {
          // Pake formatJID dari adapter (wwebjs: @c.us, baileys: @s.whatsapp.net)
          const chatId = contact.chatId || client.wa.formatJID(contact.phone)
          const text = this.interpolate(rec.message, contact)
          await this.am.sendMessage(rec.accountId, chatId, text, { simulateTyping })
          rec.sent++
          logger.info(`  ✓ ${contact.phone || chatId}`)
        } catch (err) {
          // Daily limit reached — pause biar bisa lanjut besok
          if (err.name === 'DailyLimitError') {
            logger.warn(`Broadcast ${id} paused — daily limit`)
            rec.status = 'paused'
            rec.pausedReason = err.message
            this._updateRecord(id, {
              status: 'paused',
              sent: rec.sent,
              failed: rec.failed,
            })
            this._emit(id, 'paused', { sent: rec.sent, total: rec.total, failed: rec.failed, reason: err.message })
            return
          }
          rec.failed++
          rec.errors.push({ phone: contact.phone || contact.chatId, error: err.message })
          logger.error(`  ✗ ${contact.phone || chatId}: ${err.message}`)
        }
      }

      // Update progress di DB setiap batch
      this._updateRecord(id, { sent: rec.sent, failed: rec.failed })

      // Emit progress event ke WebSocket subscribers
      this._emit(id, 'progress', { sent: rec.sent, total: rec.total, failed: rec.failed })

      // Delay antar batch
      if (i < batches.length - 1) {
        await sleep(batchDelay || 60000)
      }
    }

    // Broadcast selesai
    rec.status = 'completed'
    rec.completedAt = new Date().toISOString()
    this._updateRecord(id, {
      status: 'completed',
      sent: rec.sent,
      failed: rec.failed,
      completed_at: rec.completedAt,
      errors: rec.errors.length > 0 ? JSON.stringify(rec.errors) : null,
    })
    logger.info(`Broadcast ${id} done — sent: ${rec.sent}, failed: ${rec.failed}`)

    // Emit complete event ke WebSocket subscribers
    this._emit(id, 'complete', { sent: rec.sent, total: rec.total, failed: rec.failed, status: 'completed' })
  }

  /**
   * Subscribe ke progress event broadcast tertentu.
   * Callback dipanggil tiap ada update progress / complete / error.
   * Return: unsubscribe function — panggil untuk berhenti subscribe.
   *
   * Dipake oleh WebSocket handler (ws.js) buat push real-time ke client.
   */
  onProgress(id, cb) {
    if (!this._listeners.has(id)) this._listeners.set(id, new Set())
    this._listeners.get(id).add(cb)
    return () => this._listeners.get(id).delete(cb)
  }

  /**
   * Emit event ke semua subscriber broadcast tertentu.
   * Dipanggil internal dari _execute() pas progress atau complete.
   */
  _emit(id, event, data) {
    const listeners = this._listeners.get(id)
    if (listeners) {
      for (const cb of listeners) {
        try { cb(event, data) } catch {} // Safety net: jangan sampai satu callback yang error nge-crash yang lain
      }
    }
  }

  /**
   * Hitung jumlah broadcast yang masih aktif (running + pending).
   * Dipake pas shutdown buat ngecek apakah perlu nunggu broadcast selesai.
   */
  getActiveCount() {
    let count = 0
    for (const rec of this.active.values()) {
      if (rec.status === 'running' || rec.status === 'pending') {
        count++
      }
    }
    return count
  }

  /**
   * Pause semua broadcast yang sedang running.
   * Dipanggil pas shutdown kalau timeout nunggu broadcast selesai.
   * Broadcast bisa di-resume nanti setelah restart.
   */
  drainAll() {
    let count = 0
    for (const [id, rec] of this.active) {
      if (rec.status === 'running') {
        rec.status = 'paused'
        rec.pausedReason = 'Shutdown drain — server dimatikan'
        this._updateRecord(id, { status: 'paused' })
        logger.info(`Broadcast ${id}: di-pause oleh shutdown drain`)
        count++
      }
    }
    logger.info(`Broadcast drain: ${count} broadcast di-pause`)
    return count
  }

  get(id) {
    return this.active.get(id) || null
  }

  list() {
    return Array.from(this.active.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  /**
   * Inisialisasi BullMQ worker untuk proses broadcast dari queue.
   * Dipanggil dari index.js pas startup, cuma jalan kalau QUEUE_ENABLED=true.
   * Worker ini bakal nerima job dari queue dan panggil _execute().
   */
  async initQueueWorker() {
    if (!isQueueEnabled()) {
      logger.debug('BullMQ queue disabled — skip worker initialization')
      return
    }

    const worker = await createWorker('waun-broadcast', async (job) => {
      const { broadcastId, accountId, batchSize, batchDelay, simulateTyping } = job.data
      logger.info(`BullMQ worker processing broadcast ${broadcastId}`)

      const rec = this.active.get(broadcastId)
      if (!rec) {
        logger.warn(`Broadcast ${broadcastId} not found in memory — skipping`)
        return
      }

      await this._execute(broadcastId, batchSize, batchDelay, simulateTyping)
    })

    if (worker) {
      logger.info('BullMQ broadcast worker initialized')
    }
  }

  cancel(id) {
    const rec = this.active.get(id)
    if (!rec) return false
    if (['running', 'pending', 'paused'].includes(rec.status)) {
      rec.status = 'cancelled'
      rec.completedAt = new Date().toISOString()
      this._updateRecord(id, { status: 'cancelled', completed_at: rec.completedAt })
      return true
    }
    return false
  }

  resume(id) {
    const rec = this.active.get(id)
    if (!rec || rec.status !== 'paused') return false

    // Pakai batchSize dan batchDelay dari options yang disimpan
    const opts = rec.options || {}

    // Bungkus pake async IIFE + catch biar error gak silent fail
    // (Task 3.6 — setImmediate Error Handling)
    // Catatan: double execution dicegah oleh _execute() yang check
    // rec.status === 'running' sebelum mulai — jadi resume() dobel
    // gak perlu set status 'running' di sini
    setImmediate(async () => {
      try {
        await this._execute(id, opts.batchSize, opts.batchDelay, opts.simulateTyping)
      } catch (err) {
        // Gunakan rec dari closure — object reference masih valid
        logger.error(`Broadcast ${id} resume error — ${err.message}`)
        rec.status = 'failed'
        rec.errors.push({ error: err.message })
        this._updateRecord(id, { status: 'failed', errors: rec.errors })
      }
    })
    return true
  }
}

// Helper: konversi row SQLite ke object broadcast
function rowToBroadcast(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    message: row.message,
    total: row.total,
    sent: row.sent,
    failed: row.failed,
    status: row.status,
    contacts: row.contacts ? tryParseJson(row.contacts) : [],
    options: row.options ? tryParseJson(row.options) : {},
    errors: row.errors ? tryParseJson(row.errors) : [],
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

function tryParseJson(str) {
  try { return JSON.parse(str) } catch { return null }
}
