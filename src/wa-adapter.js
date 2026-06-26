// wa-adapter — WhatsApp adapter interface (abstract class)
// Semua method async, library-agnostic.
// Implementasi konkret: WwebAdapter (whatsapp-web.js), BaileysAdapter (Baileys).
// 
// WAMessage — standard message object yang dikirim ke callback:
//   { id, from, to, body, type, timestamp, hasMedia, mediaType, fromMe, isGroup, senderName, senderJid, raw }
// 
// WAAck — standard ACK object:
//   { id, from, ack }

// senderJid = participant JID (pengirim asli di grup). Untuk 1-on-1, nilainya sama dengan from.
//            Dipake biar webhook tau siapa yang ngirim di grup, bukan cuma ID grup-nya.

export class WAAdapter {
  constructor(account) {
    this._accountId = account.id
    this._label = account.label
    this._ready = false
    this._authenticated = false
    this._error = null
    this._qrBuffer = null

    // Event callbacks — di-set via onQR(), onMessage(), dll
    this._onQR = null
    this._onAuthenticated = null
    this._onAuthFailure = null
    this._onReady = null
    this._onDisconnected = null
    this._onMessage = null
    this._onMessageAck = null

    // Reconnect tracker — dipake account-manager buat auto-reconnect
    this._reconnectAttempts = 0
    this._maxReconnectAttempts = parseInt(process.env.RECONNECT_MAX_ATTEMPTS || '3')
    this._reconnectDelay = parseInt(process.env.RECONNECT_DELAY || '5000')
  }

  // === Status Read-only Properties ===

  get ready() { return this._ready }
  get authenticated() { return this._authenticated }
  get label() { return this._label }
  get name() { return 'wa-adapter' }
  get error() { return this._error }

  // === Event Registration ===
  // Semua return this biar bisa chaining: adapter.onQR(fn).onMessage(fn)

  onQR(cb) { this._onQR = cb; return this }
  onAuthenticated(cb) { this._onAuthenticated = cb; return this }
  onAuthFailure(cb) { this._onAuthFailure = cb; return this }
  onReady(cb) { this._onReady = cb; return this }
  onDisconnected(cb) { this._onDisconnected = cb; return this }
  onMessage(cb) { this._onMessage = cb; return this }
  onMessageAck(cb) { this._onMessageAck = cb; return this }

  // === Lifecycle ===

  async initialize() { throw new Error('Not implemented') }
  async destroy() { throw new Error('Not implemented') }

  // === Actions ===

  // sendText: kirim pesan teks. Return { id: string }
  async sendText(jid, text, options = {}) { throw new Error('Not implemented') }

  // sendMedia: kirim media (image, document, audio, video).
  // media: { mediaType, mediaUrl?, mediaPath?, caption?, filename? }
  // Return { id: string }
  async sendMedia(jid, media, options = {}) { throw new Error('Not implemented') }

  // getQR: return QR string atau null kalo gak ada
  getQR() { return this._qrBuffer }

  // formatJID: normalize nomor telepon ke JID format sesuai library
  // whatsapp-web.js pake @c.us, Baileys pake @s.whatsapp.net
  // Override di subclass masing-masing
  formatJID(phone) {
    if (!phone || phone.includes('@')) return phone
    return `${phone}@s.whatsapp.net`
  }
}

// Standard WAMessage shape — library-agnostic message object
// Implementor WAAdapter harus mapping dari library-specific message ke format ini
export function createWAMessage(msg) {
  return {
    id: msg.id || '',
    from: msg.from || '',
    to: msg.to || '',
    body: msg.body || '',
    type: msg.type || '',
    timestamp: msg.timestamp || 0,
    hasMedia: !!msg.hasMedia,
    mediaType: msg.mediaType || null,
    fromMe: !!msg.fromMe,
    isGroup: (msg.from || '').endsWith('@g.us'),
    senderName: msg.senderName || '',  // Nama kontak (pushName dari WhatsApp)
    senderJid: msg.senderJid || '',    // Participant (pengirim asli di grup)
    raw: msg,  // Original message dari library — fallback untuk akses library-specific fields
  }
}
