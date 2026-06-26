// wweb-adapter — implementasi WAAdapter pake whatsapp-web.js (Puppeteer + Chromium)
// Import library pake lazy dynamic import biar module ini gak crash
// kalo library gak di-install (optionalDependencies)
import logger from '../utils/logger.js'
import { WAAdapter, createWAMessage } from '../wa-adapter.js'

let _wwPkg = null
async function getWWPkg() {
  if (!_wwPkg) _wwPkg = await import('whatsapp-web.js')
  return _wwPkg
}

export class WwebAdapter extends WAAdapter {
  constructor(account) {
    super(account)
    this._name = 'wwebjs'
    this._qrResolve = null
    this._client = null
  }

  get name() { return this._name }

  // whatsapp-web.js pake format @c.us untuk JID
  // Otomatis konversi nomor lokal Indonesia: 08xxx → 628xxx
  formatJID(phone) {
    if (!phone || phone.includes('@')) return phone
    let normalized = phone.trim()
    if (normalized.startsWith('0')) {
      normalized = '62' + normalized.slice(1)
    }
    return `${normalized}@c.us`
  }

  async initialize() {
    const { Client, LocalAuth } = await getWWPkg()

    // Buat instance whatsapp-web.js Client — butuh Chromium
    this._client = new Client({
      authStrategy: new LocalAuth({
        clientId: this._accountId,
        dataPath: process.env.SESSION_DIR || './sessions',
      }),
      puppeteer: {
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
          '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
          '--disable-gpu', '--disable-accelerated-2d-canvas', '--no-first-run',
          '--no-zygote', '--single-process',
        ],
      },
      webVersion: process.env.WEB_VERSION || '2.3000.1019783070',
      webVersionCache: { type: 'local' },
      takeoverOnConflict: true,
      takeoverTimeoutMs: 0,
    })

    this._setupListeners()

    try {
      await this._client.initialize()
    } catch (err) {
      this._error = err.message
      logger.error(`${this._label}: initialize error — ${err.message}`)
      throw err
    }
  }

  // Pasang semua event listener whatsapp-web.js → mapping ke callback WAAdapter
  _setupListeners() {
    this._client.on('qr', async (qr) => {
      this._qrBuffer = qr
      logger.info(`${this._label}: QR Code received — get via API: GET /accounts/${this._accountId}/qr?format=image`)
      this._onQR?.(qr)
      if (this._qrResolve) { this._qrResolve(qr); this._qrResolve = null }
    })

    this._client.on('authenticated', () => {
      this._authenticated = true
      this._qrBuffer = null
      logger.info(`${this._label}: Authenticated`)
      this._onAuthenticated?.()
    })

    this._client.on('auth_failure', (msg) => {
      this._authenticated = false
      logger.error(`${this._label}: Auth failure — ${msg}`)
      this._onAuthFailure?.(msg)
    })

    this._client.on('ready', () => {
      this._ready = true
      this._qrBuffer = null
      logger.info(`${this._label}: Client ready`)
      this._onReady?.()
    })

    this._client.on('disconnected', (reason) => {
      this._ready = false
      this._authenticated = false
      logger.warn(`${this._label}: Disconnected — ${reason}`)
      this._onDisconnected?.(reason)
    })

    this._client.on('message', async (msg) => {
      if (msg.fromMe) return
      const waMsg = createWAMessage({
        id: msg.id?._serialized || msg.id,
        from: msg.from, to: msg.to, body: msg.body, type: msg.type,
        timestamp: msg.timestamp, hasMedia: msg.hasMedia, fromMe: msg.fromMe,
        mediaType: msg.type,
      })
      this._onMessage?.(waMsg)
    })

    this._client.on('message_ack', async (msg, ack) => {
      this._onMessageAck?.({
        id: typeof msg.id === 'object' ? (msg.id._serialized || `${msg.from}_${Date.now()}`) : String(msg.id),
        from: msg.from, ack,
      })
    })
  }

  async destroy() {
    if (this._client) {
      try {
        await this._client.destroy()
        logger.info(`${this._label}: client destroyed`)
      } catch (err) {
        logger.warn(`${this._label}: destroy error — ${err.message}`)
      }
    }
  }

  async sendText(jid, text, options = {}) {
    if (!this._ready) throw new Error(`${this._label}: client not ready`)
    const result = await this._client.sendMessage(jid, text, options)
    return { id: result.id?._serialized || result.id }
  }

  async sendMedia(jid, media, options = {}) {
    if (!this._ready) throw new Error(`${this._label}: client not ready`)

    const { mediaUrl, mediaPath, caption, filename } = media
    if (!mediaUrl && !mediaPath) throw new Error('mediaUrl atau mediaPath wajib diisi')

    const { MessageMedia } = await getWWPkg()

    let messageMedia
    try {
      if (mediaPath) {
        messageMedia = MessageMedia.fromFilePath(mediaPath)
      } else {
        messageMedia = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true, filename: filename || undefined })
      }
    } catch (err) {
      throw new Error(`Gagal load media: ${err.message}`)
    }

    const sendOpts = {}
    if (caption) sendOpts.caption = caption
    if (filename) sendOpts.filename = filename

    const result = await this._client.sendMessage(jid, messageMedia, sendOpts)
    return { id: result.id?._serialized || result.id }
  }
}
