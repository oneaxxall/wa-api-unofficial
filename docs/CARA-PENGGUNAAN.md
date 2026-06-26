# Cara Penggunaan WAUN — Panduan Lengkap

> **WAUN** (WhatsApp Unofficial) adalah gateway multi-akun WhatsApp dengan broadcast, auto-reply, webhook, dan anti-ban engine.

---

## Daftar Isi

1. [Instalasi & Setup](#1-instalasi--setup)
2. [Mengelola Akun WhatsApp](#2-mengelola-akun-whatsapp)
3. [Autentikasi API](#3-autentikasi-api)
4. [Mengirim Pesan](#4-mengirim-pesan)
5. [Broadcast Massal](#5-broadcast-massal)
6. [Auto-Reply](#6-auto-reply)
7. [Webhook](#7-webhook)
8. [Anti-Ban Configuration](#8-anti-ban-configuration)
9. [Monitoring & Observability](#9-monitoring--observability)
10. [Docker Deployment](#10-docker-deployment)
11. [Production Tuning](#11-production-tuning)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Instalasi & Setup

### 1.1 Prasyarat

| Komponen | Minimal | Rekomendasi |
|----------|---------|-------------|
| Node.js | 22.x | 22.x LTS |
| RAM | 256 MB + 5 MB per akun | 1 GB + 10 MB per akun |
| CPU | 1 core | 2 core |
| Disk | 100 MB | 10 GB (untuk logs + backup) |
| OS | Linux, macOS, Windows | Ubuntu 22.04 / Debian 12 |

### 1.2 Instalasi Cepat

```bash
# 1. Clone project
git clone <repository-url>
cd pds-wa-unofficial

# 2. Copy konfigurasi
cp .env.example .env

# 3. Install dependencies
npm install

# 4. Start server
npm start
```

Server akan jalan di `http://localhost:3008`.

### 1.3 Verifikasi Instalasi

```bash
# Cek status server
curl http://localhost:3008/health

# Response:
{
  "status": "ok",
  "uptime": 5.23,
  "accounts": 0,
  "details": []
}
```

### 1.4 Struktur Folder

```
pds-wa-unofficial/
├── src/                  # Source code
├── sessions/             # Session WhatsApp (masing-masing akun punya folder sendiri)
├── data/
│   ├── waun.db           # Database SQLite
│   └── backups/          # Backup database otomatis
├── logs/                 # Log files (kalo pake PM2)
├── .env                  # Konfigurasi environment
├── Dockerfile            # Docker build
└── docker-compose.yml    # Docker compose
```

---

## 2. Mengelola Akun WhatsApp

### 2.1 Membuat Akun Baru

Ada 2 cara: via CLI atau API.

**Cara 1: CLI**

```bash
npm run add-account
```

Output:
```
Account created:
  ID:    a1b2c3d4-e5f6-7890-abcd-ef1234567890
  Label: Account-a1b2c3
```

**Cara 2: API**

```bash
curl -X POST http://localhost:3008/accounts \
  -H "Content-Type: application/json" \
  -d '{"label": "Marketing"}'
```

Response:
```json
{
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "label": "Marketing",
    "apiKey": "abc123def456...",  // ← SIMPAN KEY INI!
    "webhooks": [],
    "autoReplies": [],
    "createdAt": "2026-05-29T..."
  }
}
```

> **PENTING:** `apiKey` cuma muncul sekali. Simpan baik-baik — ini dipakai sebagai Bearer token untuk semua request API.

### 2.2 Autentikasi WhatsApp (Scan QR)

Setelah akun dibuat, WhatsApp butuh autentikasi:

```bash
# 1. Ganti ACCOUNT_ID dengan ID akun dari langkah sebelumnya
# 2. Ganti API_KEY dengan apiKey dari response

curl http://localhost:3008/accounts/{ACCOUNT_ID}/qr \
  -H "Authorization: Bearer {API_KEY}"
```

Response `qr` akan muncul di terminal server (QR code ASCII). Scan QR tersebut dengan:

1. Buka WhatsApp di HP
2. Menu (⋮) > Perangkat Tertaut
3. Tautkan Perangkat
4. Arahkan kamera ke QR code di terminal

Setelah scan, status akun berubah jadi `ready: true`:

```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID} \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{
  "data": {
    "id": "...",
    "label": "Marketing",
    "status": {
      "ready": true,         // ✅ Siap dipake
      "authenticated": true, // ✅ Sudah auth
      "hasQR": false
    }
  }
}
```

### 2.3 Melihat Daftar Akun

```bash
curl http://localhost:3008/accounts \
  -H "Authorization: Bearer {API_KEY}"
```

Response:
```json
{
  "data": [
    {
      "id": "a1b2c3d4-...",
      "label": "Marketing",
      "apiKey": "abc123...",
      "status": {
        "ready": true,
        "authenticated": true,
        "antiBan": {
          "dailySent": 0,
          "dailyLimit": 500,
          "warmupDay": 1
        }
      }
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

### 2.4 Rotate API Key

Kalau API key bocor, rotate segera:

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/rotate-key \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{
  "data": {
    "apiKey": "new-api-key-here"
  }
}
```

> Key lama langsung tidak valid. Jangan lupa update key di semua aplikasi yang terhubung.

### 2.5 Menghapus Akun

```bash
curl -X DELETE http://localhost:3008/accounts/{ACCOUNT_ID} \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{
  "data": { "status": "deleted" }
}
```

Semua data terkait (webhooks, auto-replies, anti-ban state, session) ikut terhapus.

### 2.6 Reconnect / Reset Session

Kalau session bermasalah (disconnect, error):

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/reconnect \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"label": "Marketing (new)"}'

# Response:
{
  "data": {
    "id": "...",
    "label": "Marketing (new)",
    "apiKey": "new-api-key"
  }
}
```

> Account ID tetap sama, tapi session di-reset. Wajib scan QR ulang.

---

## 3. Autentikasi API

### 3.1 Cara Kerja

Semua endpoint (kecuali `/health`, `/metrics`, `/api/docs`) butuh **Bearer token authentication**:

```
Authorization: Bearer {apiKey}
```

### 3.2 Header yang Didukung

| Header | Wajib | Contoh |
|--------|-------|--------|
| `Authorization` | ✅ Ya | `Authorization: Bearer abc123...` |
| `Content-Type` | ✅ Ya (POST/PUT) | `Content-Type: application/json` |

### 3.3 Error Auth

```bash
# Tanpa header → 401
curl http://localhost:3008/accounts
# → { "error": { "code": "UNAUTHORIZED", "message": "..." } }

# Header salah → 403
curl http://localhost:3008/accounts \
  -H "Authorization: Bearer wrong-key"
# → { "error": { "code": "FORBIDDEN", "message": "Invalid API key" } }
```

### 3.4 Public Endpoints (Tidak Perlu Auth)

| Endpoint | Kegunaan |
|----------|----------|
| `GET /health` | Status server |
| `GET /metrics` | Prometheus metrics |
| `GET /api/docs` | Swagger UI |
| `GET /api/docs-json` | OpenAPI spec |
| `GET /api/docs/json` | OpenAPI JSON (alternatif) |

---

## 4. Mengirim Pesan

### 4.1 Kirim Teks

```bash
curl -X POST http://localhost:3008/send \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "to": "6281234567890",
    "message": "Halo! Ini pesan dari WAUN."
  }'
```

Response:
```json
{
  "data": {
    "status": "sent",
    "id": "AB12C34D5E6F7890..."
  }
}
```

### 4.2 Format Nomor Tujuan

Nomor tujuan bisa dikirim dalam berbagai format:

| Input | Diproses Sebagai |
|-------|-----------------|
| `6281234567890` | ✅ Otomatis diformat |
| `6281234567890@c.us` | ✅ Dipakai langsung (wwebjs) |
| `6281234567890@s.whatsapp.net` | ✅ Dipakai langsung (Baileys) |

> Library menentukan format JID: Baileys pake `@s.whatsapp.net`, wwebjs pake `@c.us`.

### 4.3 Kirim Media

```bash
curl -X POST http://localhost:3008/send/media \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "to": "6281234567890",
    "mediaType": "image",
    "mediaUrl": "https://example.com/foto-produk.jpg",
    "caption": "Foto produk terbaru"
  }'
```

### 4.4 Tipe Media yang Didukung

| mediaType | Contoh | Catatan |
|-----------|--------|---------|
| `image` | JPG, PNG, GIF | Caption didukung |
| `document` | PDF, DOC, XLS | Wajib isi `filename` |
| `audio` | MP3, OGG, AAC | Tanpa caption |
| `video` | MP4, AVI, MOV | Caption didukung |

### 4.5 Kirim dari File Lokal

```bash
curl -X POST http://localhost:3008/send/media \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "to": "6281234567890",
    "mediaType": "document",
    "mediaPath": "/path/to/file.pdf",
    "filename": "laporan.pdf",
    "caption": "Laporan bulanan"
  }'
```

### 4.6 Rate Limit

| Endpoint | Limit | Reset |
|----------|-------|-------|
| `POST /send` | 30 request/menit | Per menit |
| `POST /send/media` | 30 request/menit | Per menit |

---

## 5. Broadcast Massal

### 5.1 Memulai Broadcast

```bash
curl -X POST http://localhost:3008/broadcast \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "name": "Promo Akhir Tahun",
    "message": "Halo {{name}}, ada promo spesial buat kamu! Klik link: bit.ly/promo",
    "contacts": [
      {"phone": "6281234567890", "name": "Budi"},
      {"phone": "6289876543210", "name": "Siti"},
      {"phone": "6285551234567", "name": "Ahmad"}
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
    "broadcastId": "b1c2d3e4-f5a6-7890-abcd-ef1234567890"
  }
}
```

### 5.2 Parameter Broadcast

| Parameter | Default | Deskripsi |
|-----------|---------|-----------|
| `accountId` | — (wajib) | Akun WhatsApp pengirim |
| `name` | Auto | Nama broadcast (buat identifikasi) |
| `message` | — (wajib) | Teks pesan. Support template `{{name}}`, `{{phone}}` |
| `contacts` | — (wajib) | Array kontak tujuan. Max 10.000 |
| `batchSize` | 10 | Jumlah pesan per batch |
| `batchDelay` | 60000 | Delay antar batch (ms) |
| `shuffle` | true | Acak urutan kontak |
| `simulateTyping` | true | Simulasi typing delay |

### 5.3 Template Variables

Variable di `message` akan di-replace dengan data dari masing-masing contact:

| Variable | Dari Field Contact | Contoh Output |
|----------|-------------------|---------------|
| `{{name}}` | `contact.name` | "Budi" |
| `{{phone}}` | `contact.phone` | "6281234567890" |

### 5.4 Memantau Broadcast

**Via REST (polling):**

```bash
curl http://localhost:3008/broadcast/{BROADCAST_ID} \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{
  "data": {
    "id": "b1c2d3e4-...",
    "status": "running",
    "total": 100,
    "sent": 45,
    "failed": 2,
    "createdAt": "2026-05-29T10:00:00",
    "errors": [
      {"phone": "628xxx", "error": "Daily limit error"}
    ]
  }
}
```

**Via WebSocket (real-time):**

```javascript
// Browser atau Node.js
const ws = new WebSocket('ws://localhost:3008/ws/broadcast/{BROADCAST_ID}')

ws.onmessage = (event) => {
  const { event: type, data } = JSON.parse(event.data)

  switch (type) {
    case 'state':
      console.log('State awal:', data)
      break
    case 'progress':
      console.log(`Progress: ${data.sent}/${data.total} (${data.failed} gagal)`)
      break
    case 'complete':
      console.log('✅ Selesai!', data)
      ws.close()
      break
    case 'paused':
      console.log('⏸️ Paused:', data.reason)
      break
    case 'cancelled':
      console.log('⛔ Dibatalakan')
      ws.close()
      break
    case 'error':
      console.error('❌ Error:', data.message)
      break
  }
}

ws.onerror = (err) => console.error('WebSocket error:', err)
```

### 5.5 Membatalkan Broadcast

```bash
curl -X POST http://localhost:3008/broadcast/{BROADCAST_ID}/cancel \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{ "data": { "status": "cancelled" } }
```

### 5.6 Melanjutkan Broadcast yang Ter-pause

Broadcast bisa ter-pause otomatis kalau kena daily limit. Lanjutkan besok:

```bash
curl -X POST http://localhost:3008/broadcast/{BROADCAST_ID}/resume \
  -H "Authorization: Bearer {API_KEY}"

# Response:
{ "data": { "status": "resumed" } }
```

### 5.7 Broadcast Limit

| Batasan | Nilai | Env |
|---------|-------|-----|
| Max kontak per broadcast | 10.000 | `BROADCAST_MAX_CONTACTS` |
| Max POST /broadcast | 10 request/menit | (built-in) |

---

## 6. Auto-Reply

### 6.1 Menambah Rule Auto-Reply

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "halo",
    "reply": "Halo {{from}}! Ada yang bisa dibantu?",
    "matchType": "contains",
    "enabled": true,
    "cooldown": 30
  }'
```

Response:
```json
{
  "data": {
    "id": "ar-12345",
    "keyword": "halo",
    "reply": "Halo {{from}}! Ada yang bisa dibantu?",
    "matchType": "contains",
    "enabled": true,
    "cooldown": 30
  }
}
```

### 6.2 Match Types

| Type | Cara Kerja | Contoh |
|------|-----------|--------|
| `exact` | Pesan harus **sama persis** dengan keyword | `keyword: "halo"` → match "halo", tidak match "halo juga" |
| `contains` | Pesan **mengandung** keyword | `keyword: "promo"` → match "info promo dong" |
| `startsWith` | Pesan **diawali** keyword | `keyword: "help"` → match "help saya butuh bantuan" |
| `regex` | Keyword adalah **regex pattern** | `keyword: "^(halo\|hai)$"` → match "halo" atau "hai" |

### 6.3 Template Variables di Auto-Reply

| Variable | Diganti Dengan |
|----------|---------------|
| `{{body}}` | Isi pesan yang masuk |
| `{{from}}` | Nomor pengirim |

### 6.4 Cooldown

Cooldown mencegah spam balasan:

```bash
# Dalam 30 detik, kontak yang sama cuma dapat 1 auto-reply
# Kalau cooldown = 0, reply selalu dikirim (no cooldown)
```

### 6.5 Melihat Daftar Auto-Reply

```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies \
  -H "Authorization: Bearer {API_KEY}"
```

### 6.6 Menghapus Auto-Reply

```bash
curl -X DELETE http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies/{RULE_ID} \
  -H "Authorization: Bearer {API_KEY}"
```

---

## 7. Webhook

### 7.1 Menambah Webhook

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/webhooks \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://server-anda.com/webhook-wa",
    "headers": {
      "X-Secret": "rahasia123"
    },
    "timeout": 10000
  }'
```

> **Catatan:** URL harus `https://` di production. `http://` hanya di development.

### 7.2 Event Payload

**Event: `message`** — terkirim saat ada pesan masuk:

```json
{
  "event": "message",
  "accountId": "uuid-account",
  "accountLabel": "Marketing",
  "from": "6281234567890@s.whatsapp.net",
  "fromMe": false,
  "body": "Halo, ada yang bisa dibantu?",
  "type": "chat",
  "timestamp": 1712345678,
  "hasMedia": false,
  "isGroup": false,
  "chatId": "6281234567890@s.whatsapp.net"
}
```

**Event: `message.ack`** — terkirim saat status pengiriman berubah:

```json
{
  "event": "message.ack",
  "accountId": "uuid-account",
  "accountLabel": "Marketing",
  "from": "6281234567890@s.whatsapp.net",
  "id": "WAMESSAGEID123",
  "ack": 2
}
```

**ACK values:**

| Value | Arti |
|-------|------|
| 0 | Error / tidak terkirim |
| 1 | Terkirim ke server WhatsApp |
| 2 | Terkirim ke perangkat tujuan |
| 3 | Dibaca |
| 4 | Dibalas |

### 7.3 Webhook Retry Mechanism

Webhook punya retry otomatis:

```
Attempt 1 → gagal → tunggu 1 detik
Attempt 2 → gagal → tunggu 8 detik
Attempt 3 → gagal → tercatat sebagai failed
```

> 4xx error (Bad Request, Not Found) **tidak di-retry** — karena error di sisi URL, bukan jaringan.

### 7.4 Failed Webhooks

Cek webhook yang gagal:

```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID}/failed-webhooks \
  -H "Authorization: Bearer {API_KEY}"
```

### 7.5 Menghapus Webhook

```bash
curl -X DELETE http://localhost:3008/accounts/{ACCOUNT_ID}/webhooks/{WEBHOOK_ID} \
  -H "Authorization: Bearer {API_KEY}"
```

---

## 8. Anti-Ban Configuration

### 8.1 Cara Kerja

Setiap kali mengirim pesan, sistem anti-ban menjalankan:

```
1. CEK daily limit → udah 500 hari ini? → throw DailyLimitError
2. CEK per-contact limit → udah 50 ke kontak ini? → throw ContactLimitError
3. TUNGGU random delay → 3-12 detik + jitter ±30%
4. SIMULASI typing → delay sesuai panjang pesan (200-300 WPM)
5. KIRIM pesan
6. INCREMENT counters
7. PERSIST state tiap 10 pesan
```

### 8.2 Warmup Mode

Akun baru mencurigakan. Warmup menaikkan limit secara bertahap:

| Hari | Multiplier | Contoh (limit 500) |
|------|-----------|-------------------|
| 1 | 30% | 150 pesan/hari |
| 2 | 30% | 150 pesan/hari |
| 3 | 40% | 200 pesan/hari |
| 4 | 50% | 250 pesan/hari |
| 5 | 60% | 300 pesan/hari |
| 6 | 75% | 375 pesan/hari |
| 7+ | 100% | 500 pesan/hari |

> **PENTING:** Warmup state di-persist ke database. Restart server gak reset warmup!

### 8.3 Konfigurasi Env

```env
# Delay antar pesan (ms)
AB_MIN_DELAY=3000           # Minimal 3 detik
AB_MAX_DELAY=12000          # Maksimal 12 detik
AB_JITTER_FACTOR=0.3        # Tambah random ±30% dari delay

# Daily limit
AB_DAILY_LIMIT=500          # Maksimal 500 pesan/hari/akun
AB_RESET_HOUR=3             # Reset jam 3 pagi

# Per-contact limit
AB_MAX_PER_CONTACT=50       # Maks 50 pesan ke kontak yang sama/hari

# Warmup
AB_WARMUP_DAYS=7            # Lama warmup
AB_WARMUP_MULTIPLIER=0.3    # Limit hari pertama (30%)
```

### 8.4 Best Practices

1. **Jangan kirim > 1 pesan per 3 detik** — ini absolute floor
2. **Akun baru: < 50 pesan/hari** untuk 3 hari pertama
3. **Gunakan template variables** — jangan kirim pesan identik ke banyak kontak
4. **Jaga koneksi tetap online** 24/7 — biar kelihatan natural
5. **Pantau `GET /health`** — lihat daily sent rate biar tau逼近 limit
6. **Jangan kirim broadcast** ke nomor yang gak aktif / salah format

---

## 9. Monitoring & Observability

### 9.1 Health Check

```bash
curl http://localhost:3008/health
```

Cek:
- Status server
- Jumlah account + status masing-masing
- Anti-ban state per account (dailySent, warmupDay)

### 9.2 Prometheus Metrics

```bash
curl http://localhost:3008/metrics
```

Output:
```
# HELP waun_accounts_total Total jumlah account yang terdaftar
# TYPE waun_accounts_total gauge
waun_accounts_total 5

# HELP waun_messages_sent_total Total pesan yang berhasil dikirim
# TYPE waun_messages_sent_total counter
waun_messages_sent_total 1250

# HELP waun_broadcasts_total Total broadcast yang pernah dimulai
# TYPE waun_broadcasts_total counter
waun_broadcasts_total 12

# HELP waun_webhook_failures_total Total webhook yang gagal
# TYPE waun_webhook_failures_total counter
waun_webhook_failures_total 3
```

### 9.3 Logs

WAUN pake Pino:

```bash
# Pretty format (development)
LOG_FORMAT=pretty npm start
# Output: [14:32:15] INFO: GET /health 200 5ms

# JSON format (production — buat log aggregation)
LOG_FORMAT=json npm start
# Output: {"level":30,"time":...,"msg":"GET /health 200 5ms"}
```

### 9.4 Request Logging

Fastify logger aktif — log semua request:
```
[14:32:15] INFO: GET /health 200 5ms
[14:32:16] INFO: POST /send 201 1200ms
[14:32:17] ERROR: Webhook https://example.com failed: connect ECONNREFUSED
```

### 9.5 Swagger Documentation

| Endpoint | Fungsi |
|----------|--------|
| `http://localhost:3008/api/docs` | Swagger UI (interactive) |
| `http://localhost:3008/api/docs-json` | OpenAPI spec (JSON) |

---

## 10. Docker Deployment

### 10.1 Build & Run

```bash
# Build image
docker compose build

# Start
docker compose up -d

# Cek log
docker compose logs -f

# Stop
docker compose down
```

### 10.2 Health Check

Docker Compose sudah include health check:

```bash
# Cek status container
docker compose ps

# Tunggu sampai healthy
watch docker compose ps
```

### 10.3 Volume Persistence

Data yang persist di luar container:

| Volume | Isi |
|--------|-----|
| `./data` | SQLite database + backup |
| `./sessions` | Session WhatsApp (creds.json) |
| `./logs` | Log files |

### 10.4 Resource Limits

```yaml
deploy:
  resources:
    limits:
      memory: 1G       # Max memory
      cpus: "2"         # Max CPU cores
    reservations:
      memory: 256M     # Guaranteed memory
```

---

## 11. Production Tuning

### 11.1 PM2 Process Manager

WAUN include ecosystem config buat PM2:

```bash
# Install PM2 global
npm install -g pm2

# Start via PM2
npm run pm2

# Atau manual:
pm2 start ecosystem.config.js --env production

# Cek status
pm2 status

# Logs
pm2 logs pds-wa-unofficial

# Restart
pm2 restart pds-wa-unofficial
```

### 11.2 System Limits

```bash
# /etc/sysctl.conf — untuk banyak akun
fs.file-max = 200000
net.ipv4.ip_local_port_range = 1024 65535

# /etc/security/limits.conf
*       soft    nofile  100000
*       hard    nofile  100000
```

### 11.3 Backup Strategy

SQLite auto-backup:
- Backup tiap startup
- Backup periodik tiap 30 menit (configurable via `DB_BACKUP_INTERVAL`)
- Keep 7 backup terakhir
- Lokasi: `data/backups/waun-{timestamp}.db`

```bash
# Cek backup
ls -la data/backups/
# waun-2026-05-29T06-33-29-000Z.db
# waun-2026-05-29T06-03-29-000Z.db
```

### 11.4 Graceful Shutdown

WAUN handle SIGINT/SIGTERM dengan:
1. Persist anti-ban state
2. Drain / pause broadcast aktif (max 30 detik)
3. Destroy semua WhatsApp clients
4. Close database
5. Exit

---

## 12. Troubleshooting

### 12.1 "client not ready"

```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID}
# Cek status.ready = false → belum scan QR
# Cek status.hasQR = true → ada QR yang siap di-scan

curl http://localhost:3008/accounts/{ACCOUNT_ID}/qr \
  -H "Authorization: Bearer {API_KEY}"
# Dapatkan QR code, scan dengan WhatsApp
```

### 12.2 "Daily limit reached"

Broadcast ter-pause karena mencapai daily limit. Solusi:

```bash
# 1. Cek status
curl http://localhost:3008/broadcast/{BROADCAST_ID}

# 2. Lanjutkan besok (setelah reset jam 3 pagi)
curl -X POST http://localhost:3008/broadcast/{BROADCAST_ID}/resume \
  -H "Authorization: Bearer {API_KEY}"
```

### 12.3 QR Code Tidak Muncul

```bash
# 1. Cek apakah session masih valid
curl http://localhost:3008/accounts/{ACCOUNT_ID}

# 2. Kalau authenticated = false, reconnect
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/reconnect \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"label": "Same Label"}'

# 3. Ambil QR baru
curl http://localhost:3008/accounts/{ACCOUNT_ID}/qr
```

### 12.4 Webhook Gagal

```bash
# Cek failed webhooks
curl http://localhost:3008/accounts/{ACCOUNT_ID}/failed-webhooks
# → [{ url: "https://...", error: "connect ECONNREFUSED", timestamp: "..." }]

# Perbaiki URL webhook, lalu webhook baru akan otomatis dicoba
```

### 12.5 Server Tidak Start

```bash
# Cek error di console atau log
cat /tmp/waun.log | tail -20

# Masalah umum:
# 1. Port 3008 sudah dipake → ganti PORT di .env
# 2. Folder data/ gak ada → mkdir -p data sessions
# 3. Database corrupt → hapus data/waun.db, backup ada di data/backups/

# Restart dengan debug
LOG_LEVEL=debug npm start
```

### 12.6 Error: whatsapp-web.js not installed

Kalau pake `WA_LIBRARY=wwebjs` tapi whatsapp-web.js belum di-install:

```bash
npm install
```

Atau install manual:
```bash
npm install whatsapp-web.js qrcode-terminal
```

> **Rekomendasi:** Pake `WA_LIBRARY=baileys` (default) — tanpa Chrome, tanpa repot.

---

## Referensi

| Resource | Link |
|----------|------|
| Swagger UI | `http://localhost:3008/api/docs` |
| Health Check | `GET /health` |
| Metrics | `GET /metrics` |
| Database | `data/waun.db` |
| Session | `sessions/{accountId}/` |
| Backup | `data/backups/` |
| Issues & Findings | `pr/issues-findings.md` |
| Resource Estimation | `pr/resource-estimation-1000-sessions.md` |
| SQLite Migration | `docs/sqlite-db.md` |
