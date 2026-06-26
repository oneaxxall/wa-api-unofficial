# Baileys Migration — Phase 3: BaileysAdapter Implementation

> **Priority:** 🔴 High
> **Goal:** Implementasi WAAdapter pake @whiskeysockets/baileys

---

## Latar Belakang

Phase 2 bikin `WwebAdapter` yang membungkus `whatsapp-web.js`. Sekarang kita buat `BaileysAdapter` yang implementasi `WAAdapter` yang sama tapi pake `@whiskeysockets/baileys` — library WebSocket murni tanpa browser.

## Goal Phase 3

- Install `@whiskeysockets/baileys` + dependencies
- Buat `BaileysAdapter` extends `WAAdapter`
- Replace `client.js` content pake BaileysAdapter
- Hapus dependency `whatsapp-web.js` + `qrcode-terminal`
- Test dengan akun real

## Perbedaan Fundamental

| Aspek | whatsapp-web.js | Baileys |
|-------|----------------|---------|
| **Session storage** | Chrome profile (folder) | `creds.json` + `app-state-sync-*.json` (multi file) |
| **Pairing** | QR scan via Chrome | Pairing code atau QR code langsung |
| **Message ID** | `msg.id._serialized` | `msg.key.id` |
| **JID format** | `628xxx@c.us` | `628xxx@s.whatsapp.net` |
| **Media sending** | `MessageMedia` object | Buffer langsung |
| **Connection** | WebSocket via Chrome | WebSocket langsung (baileys built-in) |
| **Multi-device** | Supported | Native (default) |

## Files affected

| File | Action |
|------|--------|
| `src/client.js` | **REWRITE** — Ganti WwebAdapter → BaileysAdapter |
| `package.json` | **MODIFY** — Tambah `@whiskeysockets/baileys`, hapus `whatsapp-web.js`, `qrcode-terminal` |
| `src/account-manager.js` | **MODIFY** — JID format: `@c.us` → `@s.whatsapp.net` |
| `src/broadcast.js` | **MODIFY** — JID format: `@c.us` → `@s.whatsapp.net` |
| `.env` | **MODIFY** — Hapus `PUPPETEER_EXECUTABLE_PATH`, `WEB_VERSION` |

## Detail Implementasi

### Session Storage

Baileys pake `useMultiFileAuthState()` — tiap session disimpan sebagai beberapa file JSON:

```
sessions/{accountId}/
├── creds.json              # Credentials utama
├── app-state-sync-key.json
├── app-state-sync-version-*.json
└── pre-key-*.json
```

**Ukuran:** ~1-5 KB per session (vs 20-50 MB Chrome profile).

### Pairing Flow

Baileys bisa pairing via 2 cara:

**1. QR Code (existing — user familiar):**
```js
const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
const sock = makeWASocket({ auth: state, printQRInTerminal: true })
```

**2. Pairing Code (baru — lebih praktis):**
```js
// Generate pairing code — user masukin di WhatsApp > Linked Devices
const code = await sock.requestPairingCode(phoneNumber)
console.log(`Pairing code: ${code}`)
```

### Connection Lifecycle

```js
import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys'

export class BaileysAdapter extends WAAdapter {
  constructor(account, sessionDir) {
    super(account)
    this._sessionPath = `${sessionDir}/${account.id}`
    this._sock = null
    this._qrBuffer = null
    this._ready = false
  }

  async initialize() {
    const { state, saveCreds } = await useMultiFileAuthState(this._sessionPath)

    this._sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,  // Kita handle QR sendiri
      syncFullHistory: false,
      markOnlineOnConnect: true,
    })

    // QR event — muncul kalo session gak valid
    this._sock.ev.on('connection.update', ({ qr, connection, lastDisconnect }) => {
      if (qr) {
        this._qrBuffer = qr
        this._onQR?.(qr)
      }
      if (connection === 'open') {
        this._ready = true
        this._qrBuffer = null
        this._onReady?.()
      }
      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode
        const reason = statusCode === DisconnectReason.loggedOut ? 'LOGOUT'
          : statusCode === DisconnectReason.badSession ? 'SESSION_EXPIRED'
          : 'DISCONNECTED'
        this._ready = false
        this._onDisconnected?.(reason)
      }
    })

    // Message event
    this._sock.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) {
        if (msg.key.fromMe) continue
        this._onMessage?.(this._toWAMessage(msg))
      }
    })

    // Message update (ACK)
    this._sock.ev.on('messages.update', (updates) => {
      for (const update of updates) {
        this._onMessageAck?.({
          id: update.key.id,
          from: update.key.remoteJid,
          ack: update.status,  // 0=error, 1=pending, 2=sent, 3=received, 4=read
        })
      }
    })

    // Auto-save credentials
    this._sock.ev.on('creds.update', saveCreds)
  }
}
```

### Sending Messages

**Text:**
```js
async sendText(jid, text, options = {}) {
  await this._sock.sendMessage(jid, { text })
}
```

**Media:**
Baileys butuh buffer langsung, bukan file path atau URL. Kita perlu download dulu:

```js
async sendMedia(jid, media, options = {}) {
  let buffer
  if (media.mediaPath) {
    buffer = await readFile(media.mediaPath)
  } else if (media.mediaUrl) {
    const res = await axios.get(media.mediaUrl, { responseType: 'arraybuffer' })
    buffer = Buffer.from(res.data)
  }

  const msgContent = {}
  if (media.mediaType === 'image') {
    msgContent.image = buffer
    msgContent.caption = media.caption || ''
  } else if (media.mediaType === 'document') {
    msgContent.document = buffer
    msgContent.fileName = media.filename || 'document'
    msgContent.caption = media.caption || ''
  } else if (media.mediaType === 'audio') {
    msgContent.audio = buffer
  } else if (media.mediaType === 'video') {
    msgContent.video = buffer
    msgContent.caption = media.caption || ''
  }

  await this._sock.sendMessage(jid, msgContent)
}
```

### JID Format

**PENTING:** Baileys pake format JID berbeda:

| Library | Format | Contoh |
|---------|--------|--------|
| whatsapp-web.js | `{phone}@c.us` | `62812345678@c.us` |
| Baileys | `{phone}@s.whatsapp.net` | `62812345678@s.whatsapp.net` |

Semua tempat yang format JID harus diubah:
- `src/account-manager.js:sendMessage()` — `to.includes('@')` logic
- `src/account-manager.js:sendMedia()` — same
- `src/broadcast.js:_execute()` — `contact.chatId || \`${contact.phone}@c.us\`` → `@s.whatsapp.net`
- `src/routes/messages.js` — Schema documentation update

**Approach:** Buat helper function di adapter:
```js
// wa-adapter.js
export function formatJID(phone) {
  return phone.includes('@') ? phone : `${phone}@s.whatsapp.net`
}
```

## Dependencies

### Install
```bash
npm install @whiskeysockets/baileys@latest
# Baileys butuh: libpag, protobufjs, jimp, tmp (usually auto-installed)
```

### Remove (setelah migrasi stabil)
```bash
npm uninstall whatsapp-web.js qrcode-terminal
```

## Migration Path for Existing Accounts

Existing session dari `whatsapp-web.js` (Chrome profile di `sessions/{clientId}/`) **tidak kompatibel** dengan Baileys. User harus pairing ulang.

**Cara:**
1. WAUN jalan dengan Baileys
2. User hit `POST /accounts/:id/reconnect` (destroy old session)
3. QR/pairing code muncul
4. User scan QR via WhatsApp > Linked Devices
5. Session baru tersimpan di `sessions/{accountId}/creds.json`

## Acceptance Criteria

- `BaileysAdapter` extends `WAAdapter` dengan implementasi lengkap
- Session storage: `sessions/{accountId}/creds.json` (bukan Chrome profile)
- JID format: `@s.whatsapp.net` (bukan `@c.us`)
- QR code masih muncul di console (user familiar)
- Pairing code juga available sebagai alternatif
- `sendText` → pake `sock.sendMessage(jid, { text })`
- `sendMedia` → load buffer dulu, baru kirim sesuai mediaType
- `onMessage` → dari `messages.upsert` event
- `onMessageAck` → dari `messages.update` event
- `onDisconnected` → dari `connection.update` event (close)
- Auto-reconnect: handle `DisconnectReason.restartRequired` → reconnect otomatis
- Session data per account: max 5 KB (vs 20-50 MB sebelumnya)
- `whatsapp-web.js` masih bisa dipake sebagai fallback via env `WA_LIBRARY=wwebjs|baileys`

## Testing

```bash
# RAM test — compare before/after
# Sebelum: 10 accounts = ~1.5-2.5 GB
# Sesudah:  10 accounts = ~50-100 MB

# Session storage test
ls -la sessions/{accountId}/
# total 5K — creds.json + beberapa key files
```
