# Phase 1: Security & Critical Bug Fixes

> **Priority:** 🔴 Critical
> **Goal:** Patch gap keamanan paling kritis dan fix bug yang bikin fitur gak jalan

---

## Task 1.1 — Authentication / API Key

**Ref:** `issues-findings.md:5.1`, `5.2`
**Files:** All route files in `src/routes/`

### Problem
Semua endpoint bisa diakses tanpa autentikasi. Siapa pun yang reach port 3008 bisa kirim pesan, broadcast, delete account, dll.

### Requirements
- [ ] Generate API key per account (UUID)
- [ ] Middleware Fastify `preHandler` yang cek `Authorization: Bearer <key>`
- [ ] Endpoint `POST /accounts/:id/rotate-key`
- [ ] API key disimpan di data account (JSON/DB)
- [ ] Route `/health` tetap public (no auth)

### Acceptance Criteria
- Request tanpa `Authorization` header → `401 Unauthorized`
- Request dengan API key salah → `403 Forbidden`
- Request dengan API key valid → lanjut ke handler
- Tiap account punya key berbeda

---

## Task 1.2 — SSRF Protection (Webhook URL Validation)

**Ref:** `issues-findings.md:5.4`
**Files:** `src/account-manager.js:115-127`, `src/routes/webhooks.js:10-13`

### Problem
Webhook URL tidak divalidasi. Attacker bisa set URL ke internal service (`localhost:6379`, `169.254.169.254`, dll).

### Requirements
- [ ] Validasi scheme hanya `https://` (opsional `http://` untuk development)
- [ ] Blokir private IP ranges (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, ::1)
- [ ] Blokir hostname local (localhost, 0.0.0.0, metadata.google.internal, dll)
- [ ] URL timeout max 10 detik
- [ ] Tambah validasi di `addWebhook` sebelum menyimpan

### Acceptance Criteria
- `http://localhost:6379` → rejected
- `http://169.254.169.254/` → rejected
- `https://valid.com/webhook` → accepted
- `ftp://evil.com` → rejected

---

## Task 1.3 — Fix Broadcast Options Ignored (batchSize, batchDelay)

**Ref:** `issues-findings.md:9.1`, `9.2`, `9.4`
**Files:** `src/broadcast.js`

### Problem
`batchSize` dan `batchDelay` dari options di-destructure tapi tidak dipakai. Semua broadcast pake hardcoded 10/60000. `simulateTyping` juga tidak pernah生效.

### Requirements
- [ ] Pakai `batchSize` dari options di `this.chunk(rec.contacts, batchSize)`
- [ ] Pakai `batchDelay` dari options di `await sleep(batchDelay)`
- [ ] Simpan `options` di broadcast `record` supaya bisa diakses nanti
- [ ] `simulateTyping` harus connect ke client anti-ban

### Acceptance Criteria
- Broadcast dengan `batchSize: 5` → nge-chunk 5 kontak per batch
- Broadcast dengan `batchDelay: 30000` → delay 30 detik antar batch
- `simulateTyping: false` → skip typing simulation

---

## Task 1.4 — Fix saveAccounts Directory Crash

**Ref:** `issues-findings.md:9.3`
**Files:** `src/account-manager.js:19-24`

### Problem
`mkdirSync` dipanggil async (di dalam `.then()`) tapi `writeFileSync` jalan sync langsung. Kalau directory belum ada, crash ENOENT.

### Requirements
- [ ] Pindahin `import 'node:fs'` ke static import di top file
- [ ] Panggil `mkdirSync` secara synchronous SEBELUM `writeFileSync`
- [ ] Atau pake `mkdirSync` dengan `recursive: true` langsung
- [ ] Hapus dynamic import

### Acceptance Criteria
- First run dengan directory `data/` belum ada → auto-create + write sukses
- No more ENOENT crash

---

## Task 1.5 — Fix DELETE /accounts/:id Always Returns 200

**Ref:** `issues-findings.md:9.6`
**Files:** `src/routes/accounts.js:20-23`

### Problem
Delete account yang tidak ada tetap return `{ status: 'deleted' }` dengan 200.

### Requirements
- [ ] `removeAccount` return boolean (true jika ada, false jika tidak)
- [ ] Kalau return false → 404
- [ ] Kalau return true → 200 dengan `{ status: 'deleted' }`

### Acceptance Criteria
- Delete account valid → 200
- Delete account tidak ada → 404

---

## Task 1.6 — CORS Strict

**Ref:** `issues-findings.md:5.3`
**Files:** `src/index.js:21`

### Problem
CORS allow all origins (`origin: true`).

### Requirements
- [ ] Ganti ke whitelist dari env `CORS_ORIGINS`
- [ ] Default: same-origin saja (atau array kosong)
- [ ] Dokumentasi di .env.example

### Acceptance Criteria
- Origin tidak di whitelist → ditolak CORS
- Origin di whitelist → allowed

---

## Task 1.7 — Rate Limit Per Route

**Ref:** `issues-findings.md:5.6`
**Files:** `src/index.js:22`

### Problem
Global rate limit 200 req/min sama untuk semua route. `/send` harusnya lebih strict.

### Requirements
- [ ] Rate limit per route:
  - `/send` → 30 req/min
  - `/broadcast` → 10 req/min
  - `/accounts` → 60 req/min
  - `GET` endpoints → 200 req/min
- [ ] Global `max: 300` sebagai safety net

### Acceptance Criteria
- `/send` lebih dari 30x dalam 1 menit → 429
- `GET /health` unlimited
