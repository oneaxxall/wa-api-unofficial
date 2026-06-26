# WhatsApp API Unofficial  — Multi-Account WhatsApp Gateway

adalah WhatsApp Gateway unofficial untuk mengelola banyak akun WhatsApp sekaligus. Dengan WAUN, Anda bisa mengirim pesan, melakukan broadcast ke ribuan kontak, mengatur auto-reply, dan menerima webhook — semuanya melalui API REST yang sederhana.

> ⚠️ **Disclaimer**: WAUN menggunakan library unofficial (`@whiskeysockets/baileys`) yang berinteraksi dengan WhatsApp Web. Penggunaan resiko ban akun tetap ada. Gunakan fitur anti-ban dengan bijak.

---

## ✨ Fitur Utama

- **Multi-Account** — Kelola banyak akun WhatsApp dari satu server
- **Broadcast Engine** — Kirim pesan massal ke ribuan kontak dengan batch processing
- **Auto-Reply** — Balas pesan otomatis berdasarkan keyword (exact, contains, regex, startsWith)
- **Webhook** — Terima event pesan masuk dan delivery status via HTTP callback
- **Anti-Ban System** — Random delay, daily limit, warmup mode, typing simulation, per-contact limit
- **Media Support** — Kirim gambar, dokumen, audio, video via URL atau file lokal
- **Real-time Progress** — Pantau progress broadcast via WebSocket
- **Prometheus Metrics** — Observability siap pakai (`/metrics`)
- **Swagger Docs** — Dokumentasi API interaktif di `/api/docs`
- **BullMQ Queue** — Opsional Redis-backed queue untuk broadcast yang lebih reliable

---

## 🛠 Tech Stack

| Komponen | Teknologi |
|----------|-----------|
| Runtime | Node.js 22+ (ESM) |
| Framework | Fastify 5 |
| WhatsApp Library | **Baileys** (default, WebSocket) / whatsapp-web.js (opsional) |
| Database | SQLite (better-sqlite3) |
| Queue (opsional) | BullMQ + Redis |
| Logging | Pino + pino-pretty |
| WebSocket | @fastify/websocket |
| Documentation | @fastify/swagger + @fastify/swagger-ui |

---

## 🚀 Quick Start (5 Langkah)

### Prerequisites
- Node.js 22+
- Redis (opsional — untuk BullMQ queue)
- Google Chrome (opsional — hanya untuk `WA_LIBRARY=wwebjs`)

### 1. Clone & Install

```bash
git clone <repository-url>
cd pds-wa-unofficial
cp .env.example .env
npm install
```

### 2. Konfigurasi

Edit `.env` sesuai environment Anda.

**Minimal** — cukup set:
```env
PORT=3008
HOST=0.0.0.0
LOG_FORMAT=pretty
```

**Default library: Baileys** — tanpa Chrome, RAM 5-10 MB per session.
**Kalau ingin fallback ke whatsapp-web.js** (butuh Chrome):
```env
WA_LIBRARY=wwebjs
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
```

### 3. Jalankan Server

```bash
npm start
```

Atau dengan watch mode (auto-restart kalau ada perubahan file):
```bash
npm run dev
```

### 4. Buat Account Pertama

Buat akun WhatsApp via CLI:
```bash
npm run add-account
```

Atau via API:
```bash
curl -X POST http://localhost:3008/accounts \
  -H "Content-Type: application/json" \
  -d '{"label": "My WhatsApp"}'
```

Response akan memberikan `apiKey` — simpan key ini sebagai Bearer token.

### 5. Scan QR Code

Dapatkan QR code untuk autentikasi:
```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID}/qr \
  -H "Authorization: Bearer {API_KEY}"
```

Scan QR dengan WhatsApp > Perangkat Tertaut > Tautkan Perangkat.

---

## 🐳 Docker Setup

### Docker Compose

```yaml
services:
  waun:
    build: .
    ports:
      - "3008:3008"
    volumes:
      - ./data:/app/data
      - ./sessions:/app/sessions
    environment:
      - PORT=3008
      - HOST=0.0.0.0
      - NODE_ENV=production
      - LOG_LEVEL=info
      - LOG_FORMAT=json
      - CORS_ORIGINS=http://localhost:3000
      - WA_LIBRARY=baileys
      - SESSION_DIR=/app/sessions
      - DB_PATH=/app/data/waun.db
```

> Tanpa Chrome — image size ~200 MB. WA_LIBRARY=baileys (default).

### Build Docker Image

```bash
# Build image (Baileys — tanpa Chrome, ~200MB)
docker build -t waun .

# Atau kalau butuh whatsapp-web.js, install Chrome manual di container
# dan set WA_LIBRARY=wwebjs

docker run -d \
  --name waun \
  -p 3008:3008 \
  -v $(pwd)/data:/app/data \
  -v $(pwd)/sessions:/app/sessions \
  waun
```

---

## 📚 API Documentation

WAUN menyediakan dokumentasi API interaktif via Swagger UI:

| Endpoint | Deskripsi |
|----------|-----------|
| `GET /api/docs` | Swagger UI — dokumentasi interaktif |
| `GET /api/docs-json` | OpenAPI spec dalam format JSON |

### Authentication

Semua endpoint (kecuali `/health`, `/metrics`, `/api/docs`) memerlukan **Bearer token authentication**:

```
Authorization: Bearer {apiKey}
```

Dapatkan `apiKey` dari response saat membuat account.

### Endpoint Overview

#### System
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/health` | Status server + jumlah account (public) |
| GET | `/metrics` | Prometheus metrics (public) |

#### Accounts
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/accounts?page=1&limit=20` | Daftar semua account (dengan pagination) |
| GET | `/accounts/:id` | Detail satu account |
| POST | `/accounts` | Buat account baru |
| DELETE | `/accounts/:id` | Hapus account |
| GET | `/accounts/:id/qr` | Dapatkan QR code |
| POST | `/accounts/:id/reconnect` | Reconnect WhatsApp client |
| POST | `/accounts/:id/rotate-key` | Rotate API key |

#### Messages
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/send` | Kirim pesan teks |
| POST | `/send-media` | Kirim media (gambar, dokumen, dll) |

#### Broadcasts
| Method | Path | Deskripsi |
|--------|------|-----------|
| POST | `/broadcast` | Mulai broadcast baru |
| GET | `/broadcasts?page=1&limit=20` | Daftar broadcast (dengan pagination) |
| GET | `/broadcast/:id` | Detail progress broadcast |
| POST | `/broadcast/:id/cancel` | Batalkan broadcast |
| POST | `/broadcast/:id/resume` | Lanjutkan broadcast yang di-pause |
| WS | `/ws/broadcast/:id` | WebSocket — real-time progress broadcast |

#### Webhooks
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/accounts/:id/webhooks` | Daftar webhook |
| POST | `/accounts/:id/webhooks` | Tambah webhook |
| DELETE | `/accounts/:id/webhooks/:wid` | Hapus webhook |

#### Auto-Replies
| Method | Path | Deskripsi |
|--------|------|-----------|
| GET | `/accounts/:id/auto-replies` | Daftar auto-reply rules |
| POST | `/accounts/:id/auto-replies` | Tambah auto-reply rule |
| DELETE | `/accounts/:id/auto-replies/:rid` | Hapus auto-reply rule |

---

## 🛡 Anti-Ban Configuration Guide

Anti-ban system adalah fitur paling kritis di WAUN. WhatsApp agresif memblokir client unofficial.

### Bagaimana Cara Kerjanya?

```
Setiap kirim pesan:
  1. Cek daily limit (default: 500/hari)
  2. Cek per-contact limit (default: 50/kontak/hari)
  3. Apply random delay (3-12 detik + jitter ±30%)
  4. Simulasi typing (200-300 WPM, sesuai panjang pesan)
  5. Increment counters
  6. Persist state tiap 10 pesan
```

### Warmup Mode

Akun baru mencurigakan buat WhatsApp. Warmup mode mengurangi volume secara bertahap:

| Hari | Multiplier | Limit Efektif (dari 500) |
|------|-----------|-------------------------|
| 1-3 | 30% | 150 pesan/hari |
| 4-5 | 50% | 250 pesan/hari |
| 6 | 75% | 375 pesan/hari |
| 7+ | 100% | 500 pesan/hari |

### Env Variables

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `AB_MIN_DELAY` | 3000 | Delay minimal antar pesan (ms) |
| `AB_MAX_DELAY` | 12000 | Delay maksimal antar pesan (ms) |
| `AB_DAILY_LIMIT` | 500 | Maksimal pesan per akun per hari |
| `AB_WARMUP_DAYS` | 7 | Lama warmup (hari) |
| `AB_WARMUP_MULTIPLIER` | 0.3 | Limit hari pertama (30%) |
| `AB_MAX_PER_CONTACT` | 50 | Maksimal pesan per kontak per hari |
| `AB_RESET_HOUR` | 3 | Jam reset counter (03:00 AM) |
| `AB_JITTER_FACTOR` | 0.3 | Random jitter (±30%) |

### Best Practices

1. **Jangan kirim > 1 pesan per 3 detik** — ini absolute floor
2. **Akun baru: < 50 pesan/hari** untuk 3 hari pertama
3. **Jangan kirim pesan identik** ke banyak kontak — gunakan template variables (`{{name}}`, `{{phone}}`)
4. **Jaga random online/offline** — biarkan WhatsApp terhubung 24/7
5. **Monitor metrics** di `/metrics` untuk lihat daily sent rate

---

## 📣 Broadcast Usage Example

### Kirim Broadcast

```bash
curl -X POST http://localhost:3008/broadcast \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "name": "Promo Akhir Tahun",
    "message": "Halo {{name}}, ada promo spesial buat kamu!",
    "contacts": [
      {"phone": "6281234567890", "name": "Budi"},
      {"phone": "6289876543210", "name": "Siti"}
    ],
    "options": {
      "batchSize": 10,
      "batchDelay": 60000,
      "shuffle": true,
      "simulateTyping": true
    }
  }'
```

Response:
```json
{
  "data": {
    "status": "accepted",
    "broadcastId": "uuid-broadcast-id"
  }
}
```

### Pantau Progress via WebSocket

```javascript
// Browser atau Node.js
const ws = new WebSocket('ws://localhost:3008/ws/broadcast/{BROADCAST_ID}')

ws.onmessage = (event) => {
  const { event: type, data } = JSON.parse(event.data)

  switch (type) {
    case 'state':
      console.log('Current state:', data)
      break
    case 'progress':
      console.log(`Progress: ${data.sent}/${data.total} (${data.failed} failed)`)
      break
    case 'complete':
      console.log('Selesai!', data)
      break
    case 'paused':
      console.log('Paused:', data.reason)
      break
  }
}
```

### Cek Status Broadcast

```bash
curl http://localhost:3008/broadcast/{BROADCAST_ID} \
  -H "Authorization: Bearer {API_KEY}"
```

---

## 🤖 Auto-Reply Setup

### Tambah Rule Auto-Reply

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "halo",
    "reply": "Halo juga {{from}}! Ada yang bisa dibantu?",
    "matchType": "contains",
    "enabled": true,
    "cooldown": 30
  }'
```

### Match Types

| Type | Deskripsi | Contoh |
|------|-----------|--------|
| `exact` | Pesan harus sama persis | `keyword: "halo"` → match "halo" |
| `contains` | Pesan mengandung keyword | `keyword: "promo"` → match "info promo dong" |
| `startsWith` | Pesan dimulai dengan keyword | `keyword: "help"` → match "help saya butuh bantuan" |
| `regex` | Regex pattern | `keyword: "^(halo|hai|hi)$"` → match "halo", "hai", "hi" |

### Template Variables di Auto-Reply

| Variable | Deskripsi |
|----------|-----------|
| `{{body}}` | Isi pesan yang masuk |
| `{{from}}` | Nomor pengirim |

### Cooldown

Default cooldown antar reply: **30 detik** per-contact per-rule. Cegah spam balasan.

---

## 🌐 Webhook Setup

### Tambah Webhook

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/webhooks \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-server.com/webhook",
    "headers": {"X-Secret": "your-secret"},
    "timeout": 10000
  }'
```

### Event Payload

**message** — saat ada pesan masuk:
```json
{
  "event": "message",
  "accountId": "uuid",
  "accountLabel": "My WhatsApp",
  "from": "6281234567890@s.whatsapp.net",
  "body": "Halo!",
  "type": "chat",
  "timestamp": 1234567890,
  "hasMedia": false,
  "isGroup": false,
  "chatId": "6281234567890@s.whatsapp.net"
}
```

> JID format tergantung library: Baileys pake `@s.whatsapp.net`, whatsapp-web.js pake `@c.us`.

**message.ack** — saat status pengiriman berubah:
```json
{
  "event": "message.ack",
  "accountId": "uuid",
  "from": "6281234567890@s.whatsapp.net",
  "id": "message-id",
  "ack": 2
}
```

> **ACK values**: 0=terkirim, 1=terkirim ke server, 2=terkirim ke perangkat, 3=dibaca

### Webhook Retry

Webhook punya retry mechanism dengan exponential backoff:
- Max 3 retries
- Backoff: 1s → 4s → 16s
- Tidak retry untuk 4xx error (client error)

---

## 📊 Prometheus Metrics

WAUN menyediakan endpoint `/metrics` dengan format Prometheus plain text:

```bash
curl http://localhost:3008/metrics
```

Output:
```
# HELP waun_accounts_total Total jumlah account yang terdaftar
# TYPE waun_accounts_total gauge
waun_accounts_total 5
# HELP waun_accounts_ready Jumlah account dengan status ready
# TYPE waun_accounts_ready gauge
waun_accounts_ready 3
# HELP waun_messages_sent_total Total pesan yang berhasil dikirim
# TYPE waun_messages_sent_total counter
waun_messages_sent_total 1250
# HELP waun_broadcasts_total Total broadcast yang pernah dimulai
# TYPE waun_broadcasts_total counter
waun_broadcasts_total 12
```

---

## 🔧 Environment Variables

| Variable | Default | Wajib | Deskripsi |
|----------|---------|-------|-----------|
| `PORT` | 3008 | ✗ | Port HTTP server |
| `HOST` | 0.0.0.0 | ✗ | Bind address |
| `NODE_ENV` | development | ✗ | Environment mode |
| `LOG_LEVEL` | info | ✗ | Level logging |
| `LOG_FORMAT` | pretty | ✗ | Format log (pretty/json) |
| `CORS_ORIGINS` | - | ✗ | CORS whitelist (comma-separated) |
| `DB_PATH` | ./data/waun.db | ✗ | Path SQLite database |
| `DB_BACKUP_DIR` | ./data/backups | ✗ | Direktori backup |
| `SESSION_DIR` | ./sessions | ✗ | Direktori session WhatsApp |
| `WA_LIBRARY` | baileys | ✗ | Library WhatsApp: `baileys` (default) atau `wwebjs` |
| `WEB_VERSION` | - | ✗ | Override version WhatsApp Web (hanya untuk wwebjs) |
| `PUPPETEER_EXECUTABLE_PATH` | - | ✗ | Path system Chrome (hanya untuk wwebjs) |
| `AB_MIN_DELAY` | 3000 | ✗ | Delay minimal antar pesan (ms) |
| `AB_MAX_DELAY` | 12000 | ✗ | Delay maksimal antar pesan (ms) |
| `AB_DAILY_LIMIT` | 500 | ✗ | Maks pesan/akun/hari |
| `AB_WARMUP_DAYS` | 7 | ✗ | Lama warmup (hari) |
| `AB_WARMUP_MULTIPLIER` | 0.3 | ✗ | Multiplier limit warmup |
| `AB_MAX_PER_CONTACT` | 50 | ✗ | Maks pesan/kontak/hari |
| `AB_RESET_HOUR` | 3 | ✗ | Jam reset counter |
| `AB_JITTER_FACTOR` | 0.3 | ✗ | Random jitter faktor |
| `BROADCAST_MAX_CONTACTS` | 10000 | ✗ | Maks kontak per broadcast |
| `QUEUE_ENABLED` | false | ✗ | Enable BullMQ queue |
| `REDIS_HOST` | localhost | ✗ | Redis host |
| `REDIS_PORT` | 6379 | ✗ | Redis port |
| `REDIS_URL` | - | ✗ | Redis connection URL |
| `RECONNECT_MAX_ATTEMPTS` | 3 | ✗ | Max reconnect attempts |
| `RECONNECT_DELAY` | 5000 | ✗ | Reconnect delay (ms) |
| `SHUTDOWN_TIMEOUT` | 40000 | ✗ | Timeout graceful shutdown (ms) |
| `SHUTDOWN_BROADCAST_TIMEOUT` | 30000 | ✗ | Timeout tunggu broadcast (ms) |

---

## 📋 CLI Commands

| Command | Deskripsi |
|---------|-----------|
| `npm start` | Jalankan server |
| `npm run dev` | Jalankan dengan watch mode |
| `npm run add-account` | Tambah account via CLI |
| `npm run list-accounts` | List semua account via CLI |
| `npm run pm2` | Jalankan via PM2 (production) |

---

## 🤝 Contributing

1. Fork repository
2. Buat branch fitur: `git checkout -b feat/amazing-feature`
3. Commit: `git commit -m 'feat: add amazing feature'`
4. Push: `git push origin feat/amazing-feature`
5. Buka Pull Request

---

## 📄 License

WAUN — WhatsApp Unofficial Gateway

Copyright (c) 2024-2026

**WAJIB:** Penggunaan WAUN sepenuhnya tanggung jawab pengguna. Proyek ini tidak bertanggung jawab atas pemblokiran akun WhatsApp yang disebabkan oleh penggunaan library unofficial ini.
