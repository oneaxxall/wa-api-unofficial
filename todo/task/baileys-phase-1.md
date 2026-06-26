# Baileys Migration — Phase 1: Abstraction Layer

> **Priority:** 🔴 High
> **Goal:** Buat WhatsApp adapter interface yang library-agnostic

---

## Latar Belakang

WAUN saat ini pake `whatsapp-web.js` (Puppeteer + Chromium). Setiap session butuh **150-250 MB RAM** karena harus jalanin headless Chrome. Untuk scale ke 1000+ session, ini gak feasible.

**Solusi:** Migrasi ke `@whiskeysockets/baileys` — library WhatsApp WebSocket murni, **tanpa browser**. RAM per session turun dari 150 MB → 5-10 MB.

**Strategi:** Buat abstraction layer dulu, jadi library WhatsApp bisa diganti tanpa mengubah business logic.

---

## Goal Phase 1

Buat interface/adapter pattern `src/wa-adapter.js` yang mendefinisikan semua operasi WhatsApp yang dipakai WAUN, tanpa terikat ke library tertentu.

## Design

```js
// src/wa-adapter.js — WhatsApp Adapter Interface
// Semua method async, semua return value promise

class WAAdapter {
  // === Lifecycle ===
  async initialize(accountId, sessionDir)    // Init koneksi
  async destroy()                             // Kill koneksi + cleanup

  // === Events (register callbacks) ===
  onQR(callback)                     // callback(qrString)
  onAuthenticated(callback)          // callback()
  onAuthFailure(callback)            // callback(error)
  onReady(callback)                  // callback()
  onDisconnected(callback)           // callback(reason)
  onMessage(callback)                // callback(WAMessage)
  onMessageAck(callback)             // callback(WAMessage, ack)

  // === Actions ===
  async sendText(jid, text, options)           // Kirim text message
  async sendMedia(jid, media, options)         // Kirim media message
  async getQR()                                // Dapatkan QR string

  // === Status ===
  get ready()                    // Boolean
  get authenticated()            // Boolean
}
```

**Catatan:** `WAAdapter` adalah kelas abstrak (interface). Implementation di Phase 2 (WwebAdapter) dan Phase 3 (BaileysAdapter).

## Files affected

| File | Action |
|------|--------|
| `src/wa-adapter.js` | **NEW** — Adapter interface + abstract class |
| `src/client.js` | **MODIFY** — Extend WAAdapter |
| `src/account-manager.js` | **MODIFY** — Pake adapter methods instead of direct library calls |

## Acceptance Criteria

- `WAAdapter` class dengan semua method yang dibutuhkan
- WAAdapter bisa di-extend dengan implementasi apapun
- `src/client.js` extends WAAdapter (refactor kecil)
- WAAdapter gak import library WhatsApp apapun (pure abstraction)
- WAAdapter punya properti `name` yang return nama library
- Semua method WAAdapter throw `new Error('Not implemented')` sebagai default
- WAAdapter punya properti `jid` (WhatsApp ID format) — beda tiap library
- `onMessage` callback menerima object dengan field: `from`, `body`, `type`, `timestamp`, `hasMedia`, `fromMe`, `isGroup`
- `onMessageAck` callback menerima object dengan field: `from`, `id`, `ack`
- `sendMedia` menerima parameter: `jid, { mediaType, mediaUrl?, mediaPath?, caption?, filename? }, options`
- `sendText` menerima parameter: `jid, text, options`

## Task Breakdown

### Task 1.1 — Buat WAAdapter class
- File: `src/wa-adapter.js`
- Definisikan abstract class dengan semua method + event callbacks
- Method default throw error (not implemented)
- Properti: `name`, `ready`, `authenticated`, `jid`
- Event registration: constructor terima `{ onQR, onMessage, ... }` atau pake method `setCallbacks()`

### Task 1.2 — Event/Message interface
- Definisikan shape object yang diterima callback:
  - `WAMessage`: `{ id, from, to, body, type, timestamp, hasMedia, mediaType, fromMe, isGroup, raw }`
  - `WAAck`: `{ id, from, ack }`
- Documentasikan di code comment biar implementor tau harus ngapain

### Task 1.3 — Refactor client.js
- `createWAClient(account)` → return `WAAdapter` instance
- Ekstrak logic yang sekarang ke dalam `WAAdapter` methods
- Pastikan interface yang dikembalikan tetap kompatibel

### Task 1.4 — Refactor account-manager.js
- Ganti semua `client.wa.client.on(...)` → `client.wa.onMessage(...)` dll
- Ganti `client.wa.client.sendMessage(...)` → `client.wa.sendText(...)` atau `client.wa.sendMedia(...)`
- Ganti `client.wa.client.destroy()` → `client.wa.destroy()`
- Ganti `client.wa.ready` → `client.wa.ready` (sama — properti)
- Ganti `client.wa.getQR()` → `client.wa.getQR()` (sama — method)

### Task 1.5 — Update imports
- Import wa-adapter di client.js
- Hapus `import pkg from 'whatsapp-web.js'` dari client.js (pindah ke implementasi)

## Verification

```js
// Test: WAAdapter bisa di-instantiate
import { WAAdapter } from './wa-adapter.js'
const adapter = new WAAdapter()
try { await adapter.sendText() } catch (e) { /* Error: Not implemented */ }

// Test: client.js return WAAdapter
const wa = createWAClient({ id: 'test', label: 'Test' })
console.log(wa instanceof WAAdapter)  // true
console.log(wa.name)                  // string
```
