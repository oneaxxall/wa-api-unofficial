# Phase 5: Production Features

> **Priority:** 🟠 High
> **Goal:** Resilience, reliability, feature parity dengan production gateway

---

## Task 5.1 — Graceful Shutdown with Broadcast Drain

**Ref:** `issues-findings.md:3.2`
**Files:** `src/index.js`, `src/broadcast.js`

### Problem
Broadcast mid-flight di abandon pas process exit. Gak ada drain mechanism.

### Requirements
- [ ] Sebelum exit, cek apakah ada broadcast `running` atau `pending`
- [ ] Kalau ada → log warning `"Waiting for N broadcast(s) to complete..."`
- [ ] Tunggu configurable timeout (default 30 detik)
- [ ] Kalau timeout → set status `paused` + force exit
- [ ] Broadcast `paused` bisa di-resume setelah restart

### Acceptance Criteria
- Exit saat broadcast jalan → broadcast di-pause (gak lost)
- Restart server → broadcast bisa di-resume
- No abrupt broadcast abortion

---

## Task 5.2 — Webhook Retry with Exponential Backoff

**Ref:** `issues-findings.md:8.3`
**Files:** `src/account-manager.js`

### Problem
Webhook gagal sekali → data ilang selamanya. Gak ada retry.

### Requirements
- [ ] Retry 3x dengan exponential backoff: 1s → 4s → 16s
- [ ] Configurable max retries (`webhook.maxRetries` di account config)
- [ ] Kalau semua retry gagal → log error + simpan ke `failedWebhooks[]` di account
- [ ] Opsional: endpoint `GET /accounts/:id/failed-webhooks` untuk retry manual

### Acceptance Criteria
- Webhook gagal → retry 3x
- Webhook sukses retry → no lebih lanjut
- Webhook gagal total → tercatat sebagai failed

---

## Task 5.3 — Media Message Support

**Ref:** `issues-findings.md:8.7`
**Files:** `src/routes/messages.js`, `src/client.js`

### Problem
`/send` hanya support text. `whatsapp-web.js` support image/document/audio/video via `MessageMedia`.

### Requirements
- [ ] Endpoint `POST /send/media` dengan fields:
  - `accountId`, `to`
  - `mediaType`: image | document | audio | video
  - `mediaUrl`: URL file (server download dulu)
  - `mediaPath`: atau upload langsung (file path)
  - `caption`: optional caption
  - `filename`: optional (untuk document)
- [ ] Implementasi download dari URL atau baca dari disk
- [ ] Gunakan `MessageMedia.fromFilePath()` atau `MessageMedia.fromUrl()`

### Acceptance Criteria
- `POST /send/media` dengan image URL → terkirim
- `POST /send/media` dengan document + filename → terkirim sebagai document
- Error handling: URL invalid → proper error message

---

## Task 5.4 — Auto-Reply Cooldown

**Ref:** `issues-findings.md:8.8`
**Files:** `src/account-manager.js`

### Problem
User spam 100 "halo" → dapat 100 auto-reply balik. Trigger WhatsApp anti-spam.

### Requirements
- [ ] Tambah `cooldown` field (detik) di auto-reply rule config
- [ ] Default: 30 detik per contact
- [ ] Track `lastReplied` per contact per rule (Map <contactId, timestamp>)
- [ ] Kalau masih dalam cooldown → skip reply
- [ ] Reset cooldownMap kalau server restart (gak perlu persist)

### Acceptance Criteria
- Auto-reply dengan cooldown 30s → dalam 30 detik, second message tidak di-reply
- Setelah 30 detik → reply lagi
- Cooldown 0 → reply setiap kali (no cooldown)

---

## Task 5.5 — Broadcast Size Limits & Validation

**Ref:** `issues-findings.md:6.6`, `8.10`
**Files:** `src/routes/broadcasts.js`, `src/broadcast.js`

### Problem
Broadcast tanpa limit kontak. 100k kontak di 1 request → load semua di memory.

### Requirements
- [ ] Max kontak per broadcast: 10.000 (configurable via env `BROADCAST_MAX_CONTACTS`)
- [ ] Validasi di route handler sebelum mulai
- [ ] Kalau > limit → return 400 dengan pesan jelas
- [ ] Frontend: bagi jadi multiple broadcast kalau > limit

### Acceptance Criteria
- Broadcast dengan 15.000 kontak → rejected (400)
- Broadcast dengan 5.000 kontak → accepted

---

## Task 5.6 — Docker Support

**Ref:** `issues-findings.md:8.6`
**Files:** `Dockerfile` (new), `docker-compose.yml` (new)

### Problem
No Dockerfile. User harus install Chrome + Node manual.

### Requirements
- [ ] Multi-stage Dockerfile:
  - Stage 1: `node:22-slim` + install Chrome dependencies
  - Stage 2: copy node_modules + source
- [ ] `docker-compose.yml` dengan service:
  - `waun`: app
  - `chrome`: standalone Chrome (optional, untuk puppeteer remote)
- [ ] Health check endpoint untuk orchestration
- [ ] Volume mount untuk session + data

### Acceptance Criteria
- `docker compose up` → WAUN jalan di port 3008
- Session persist setelah container restart
- Chrome ter-install di container

---

## Task 5.7 — Message Queue for Broadcast (BullMQ)

**Ref:** `issues-findings.md:6.1`, `6.2`
**Files:** `src/broadcast.js`, `src/queue.js` (new)

### Problem
Broadcast in-memory. Hilang kalau restart. Gak ada retry per-contact.

### Requirements
- [ ] Setup BullMQ (Redis-based job queue)
- [ ] Setiap broadcast di-enqueue sebagai job
- [ ] Per-contact jadi job individual (bisa retry per contact)
- [ ] Job progress tracking
- [ ] Broadcast persist walaupun server restart

### Acceptance Criteria
- Server restart saat broadcast jalan → job tetap ada di Redis
- Satu contact gagal → retry, contact lain tetap lanjut
- Progress broadcast survive restart

---

## Task 5.8 — Session Health Monitoring & Auto-Reconnect

**Ref:** `issues-findings.md:8.5`
**Files:** `src/account-manager.js`

### Problem
WhatsApp session disconnect → cuma log. Gak ada auto-recovery.

### Requirements
- [ ] `disconnected` event handler: tunggu 5 detik, coba `client.initialize()` ulang
- [ ] Max reconnect attempts: 3 (configurable)
- [ ] Kalau gagal 3x → set status `disconnected`, jangan coba lagi (biar gak ban)
- [ ] Endpoint `POST /accounts/:id/reconnect` untuk manual trigger
- [ ] Log setiap reconnect attempt

### Acceptance Criteria
- Disconnect karena network glitch → auto reconnect dalam 10 detik
- Disconnect karena session expire → set disconnected, user harus scan QR ulang
- No infinite reconnect loop
