# Baileys Migration — Phase 2: WwebAdapter (whatsapp-web.js)

> **Priority:** 🔴 High
> **Goal:** Implementasi WAAdapter pake whatsapp-web.js — existing code refactored

---

## Latar Belakang

Phase 1 bikin abstraction layer (`WAAdapter`). Phase 2 ini buat implementasi konkret pertama: **WwebAdapter** yang membungkus `whatsapp-web.js`.

Tujuannya: setelah Phase 2, WAUN tetap jalan seperti biasa, cuma refactor dibalik layar. Phase 3 nanti tinggal buat implementasi baru (BaileysAdapter) tanpa ubah business logic.

## Goal Phase 2

Implementasi `WAAdapter` yang membungkus `whatsapp-web.js` dengan mapping:

| WAAdapter method | whatsapp-web.js |
|-----------------|-----------------|
| `initialize()` | `new Client(LocalAuth)` → `client.initialize()` |
| `destroy()` | `client.destroy()` |
| `sendText(jid, text)` | `client.sendMessage(jid, text)` |
| `sendMedia(jid, media)` | `MessageMedia.fromUrl()` / `fromFilePath()` → `client.sendMessage()` |
| `getQR()` | QR buffer dari event |
| `onQR(cb)` | `client.on('qr', cb)` |
| `onMessage(cb)` | `client.on('message', cb)` → mapping ke format WAAdapter |
| `onMessageAck(cb)` | `client.on('message_ack', cb)` → mapping ke format WAAdapter |
| `onDisconnected(cb)` | `client.on('disconnected', cb)` |
| `onAuthenticated(cb)` | `client.on('authenticated', cb)` |
| `onAuthFailure(cb)` | `client.on('auth_failure', cb)` |
| `onReady(cb)` | `client.on('ready', cb)` |

## Files affected

| File | Action |
|------|--------|
| `src/client.js` | **REWRITE** — Extend WAAdapter, implementasi whatsapp-web.js |
| `src/account-manager.js` | **MODIFY** — Pake adapter methods |
| `package.json` | Tetap — whatsapp-web.js masih dipake |

## Detail Implementasi

### WwebAdapter class

```js
import pkg from 'whatsapp-web.js'
const { Client, LocalAuth, MessageMedia } = pkg
import { WAAdapter } from './wa-adapter.js'

export class WwebAdapter extends WAAdapter {
  constructor(account, sessionDir) {
    super(account)
    this._client = new Client({ ... })
    this._qrBuffer = null
    this._setupListeners()
  }

  async initialize() {
    await this._client.initialize()
  }

  async sendText(jid, text, options = {}) {
    return this._client.sendMessage(jid, text, options)
  }

  async sendMedia(jid, media, options = {}) {
    // Load + kirim media via MessageMedia
    const messageMedia = media.mediaPath
      ? MessageMedia.fromFilePath(media.mediaPath)
      : await MessageMedia.fromUrl(media.mediaUrl, { ... })
    return this._client.sendMessage(jid, messageMedia, { caption: media.caption, ... })
  }
}
```

### Event Mapping — onMessage

`whatsapp-web.js` message object → WAAdapter WAMessage:
```js
{
  id: msg.id._serialized,
  from: msg.from,
  to: msg.to,
  body: msg.body,
  type: msg.type,
  timestamp: msg.timestamp,
  hasMedia: msg.hasMedia,
  fromMe: msg.fromMe,
  isGroup: msg.from.endsWith('@g.us'),
  raw: msg,  // Raw object dari library — untuk fallback
}
```

### Event Mapping — onMessageAck
```js
{
  id: msg.id?._serialized || JSON.stringify(msg.id),
  from: msg.from,
  ack: ack,
}
```

## Acceptance Criteria

- Semua method WAAdapter diimplementasikan
- `client.on('message')` → mapping ke `onMessage` callback → `WAMessage`
- `client.on('message_ack')` → mapping ke `onMessageAck` callback → `WAAck`
- `client.on('qr')` → `onQR` callback
- `sendMedia` bisa load dari URL dan file path
- `getQR()` return QR string atau null
- `ready` getter return `_client.info?.wid?.user` (ada user) atau status
- `authenticated` getter return Boolean
- Error handling: semua error di-catch, di-log, jangan crash server
- Server start → health endpoint OK
- `POST /send` → sukses (dengan account real)

## Testing

```bash
# Test basic
node --check src/client.js

# Test server start
node src/index.js
# → WAUN server running on http://0.0.0.0:3008

# Test API
curl http://localhost:3008/health
# → { status: "ok", ... }
```
