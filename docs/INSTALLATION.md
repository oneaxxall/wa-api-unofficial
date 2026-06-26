# Instalasi WAUN — Panduan Lengkap

> **WAUN** (WhatsApp Unofficial Gateway) — Multi-account WhatsApp API dengan Baileys (default, tanpa Chrome).

---

## Daftar Isi

1. [Prasyarat](#1-prasyarat)
2. [Instalasi Bare Metal](#2-instalasi-bare-metal)
3. [Instalasi Docker](#3-instalasi-docker)
4. [Instalasi Production (PM2)](#4-instalasi-production-pm2)
5. [Konfigurasi Environment](#5-konfigurasi-environment)
6. [Verifikasi Instalasi](#6-verifikasi-instalasi)
7. [Troubleshooting Instalasi](#7-troubleshooting-instalasi)

---

## 1. Prasyarat

### 1.1 Minimum System Requirements

| Komponen | Minimal | Rekomendasi |
|----------|---------|-------------|
| CPU | 1 core | 2 core |
| RAM | 256 MB + 5 MB per akun | 1 GB + 10 MB per akun |
| Disk | 500 MB | 10 GB (untuk log + backup) |
| OS | Linux (Ubuntu 22.04+, Debian 12+) | Linux |
| Node.js | 22.x LTS | 22.x LTS |
| NPM | 10.x | 10.x |

### 1.2 Software yang Dibutuhkan

| Software | Untuk | Cara Install |
|----------|-------|-------------|
| **Node.js 22+** | Runtime WAUN | [Node.js Download](https://nodejs.org/) |
| **NPM 10+** | Package manager | Bundle dari Node.js |
| **Docker** (opsional) | Container deployment | [Docker Install](https://docs.docker.com/engine/install/) |
| **PM2** (opsional) | Process manager production | `npm install -g pm2` |
| **Redis** (opsional) | BullMQ queue | `apt install redis` |
| **Google Chrome** (opsional) | whatsapp-web.js fallback | Lihat [1.3](#13-opsional-chrome-untuk-whatsapp-webjs) |

### 1.3 Opsional: Chrome untuk whatsapp-web.js

WAUN default pake **Baileys** (WebSocket, tanpa Chrome). Hanya install Chrome kalau ingin fallback ke `WA_LIBRARY=wwebjs`:

```bash
# Ubuntu/Debian
wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | sudo apt-key add -
sudo sh -c 'echo "deb http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google-chrome.list'
sudo apt update
sudo apt install -y google-chrome-stable

# Cek versi
google-chrome --version
# Google Chrome 125.x.x
```

### 1.4 Opsional: Redis untuk Queue

WAUN pake BullMQ untuk broadcast job queue. Redis cuma dibutuhin kalau `QUEUE_ENABLED=true`:

```bash
# Ubuntu/Debian
sudo apt install -y redis-server

# Start & enable
sudo systemctl enable --now redis-server

# Cek
redis-cli ping
# PONG
```

---

## 2. Instalasi Bare Metal

### 2.1 Clone Repository

```bash
git clone https://github.com/your-repo/pds-wa-unofficial.git
cd pds-wa-unofficial
```

### 2.2 Setup Environment

```bash
# Copy environment template
cp .env.example .env

# Edit sesuai kebutuhan
nano .env
```

**Minimal config untuk Baileys (default):**
```env
PORT=3008
HOST=0.0.0.0
LOG_LEVEL=info
LOG_FORMAT=pretty
```

### 2.3 Install Dependencies

```bash
# Install semua dependencies (termasuk optional)
npm install

# Atau tanpa optional (lebih kecil, tanpa whatsapp-web.js):
npm install --no-optional
```

### 2.4 Buat Folder yang Diperlukan

```bash
# Folder untuk data, session, dan log
mkdir -p data sessions logs
```

### 2.5 Jalankan Server

```bash
# Development mode
npm start

# Atau dengan watch mode (auto-restart kalau ada perubahan)
npm run dev
```

### 2.6 Verifikasi

```bash
# Buka terminal lain
curl http://localhost:3008/health

# Response:
# { "status": "ok", "uptime": 5.23, "accounts": 0, "details": [] }
```

---

## 3. Instalasi Docker

### 3.1 Prasyarat Docker

```bash
# Cek Docker terinstall
docker --version
docker compose version
```

### 3.2 Build & Start dengan Docker Compose

```bash
# Build image (Baileys — tanpa Chrome, ~200 MB)
docker compose build

# Start container
docker compose up -d

# Cek log
docker compose logs -f

# Cek status
docker compose ps
# NAME   IMAGE   STATUS   PORTS
# waun   ...     Up     0.0.0.0:3008->3008/tcp
```

### 3.3 Verifikasi Container

```bash
# Health check
curl http://localhost:3008/health

# Cek logs
docker compose logs waun | tail -5
# [INFO] Database ready: ./data/waun.db
# [INFO] WAUN server running on http://0.0.0.0:3008
```

### 3.4 Management Container

```bash
# Stop
docker compose down

# Restart
docker compose restart

# Start ulang dengan rebuild
docker compose up -d --build

# Masuk ke container
docker compose exec waun /bin/bash

# Lihat resource usage
docker stats waun
```

### 3.5 Volume Persistence

Data yang persist meskipun container di-restart:

| Path di Host | Path di Container | Fungsi |
|-------------|-------------------|--------|
| `./data` | `/app/data` | SQLite database + backup |
| `./sessions` | `/app/sessions` | Session WhatsApp (creds.json) |
| `./logs` | `/app/logs` | Log files |

### 3.6 Environment Container

```bash
# Override env variable saat runtime
docker compose run -e WA_LIBRARY=wwebjs waun

# Atau edit .env, restart
nano .env
docker compose restart
```

### 3.7 Docker Image Size

| Library | Image Size | Keterangan |
|---------|-----------|------------|
| Baileys (default) | **~200 MB** | Tanpa Chrome, lebih ringan |
| whatsapp-web.js | ~800 MB | Butuh Chrome + dependencies |

---

## 4. Instalasi Production (PM2)

### 4.1 Install PM2

```bash
# Install global
npm install -g pm2

# Cek versi
pm2 --version
```

### 4.2 Start dengan PM2

WAUN sudah include ecosystem config:

```bash
# Start dengan config bawaan
npm run pm2

# Atau manual
pm2 start ecosystem.config.js --env production
```

### 4.3 PM2 Commands

```bash
# Status
pm2 status
# ┌─────┬──────────────────────┬─────┬─────────┐
# │ id  │ name                 │ mode│ status  │
# ├─────┼──────────────────────┼─────┼─────────┤
# │ 0   │ pds-wa-unofficial    │ fork│ online  │
# └─────┴──────────────────────┴─────┴─────────┘

# Logs
pm2 logs pds-wa-unofficial

# Restart
pm2 restart pds-wa-unofficial

# Stop
pm2 stop pds-wa-unofficial

# Monitor (realtime CPU/Memory)
pm2 monit

# Save process list (biar auto-start pas reboot)
pm2 save
pm2 startup
```

### 4.4 Ecosystem Config

```js
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'pds-wa-unofficial',
    script: './src/index.js',
    instances: 1,            // Hanya 1 instance (WhatsApp clients in-memory)
    exec_mode: 'fork',
    max_memory_restart: '500M',
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    autorestart: true,
    max_restarts: 5,
    restart_delay: 10000,
    env: {
      NODE_ENV: 'development',
      DB_PATH: './data/waun.db',
    },
    env_production: {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'json',
      DB_PATH: './data/waun.db',
    },
  }],
}
```

> **PENTING:** `instances: 1` — jangan pake `cluster` mode karena WhatsApp clients menggunakan in-memory state yang gak bisa dishare antar instance.

### 4.5 Systemd (Alternatif PM2)

```ini
# /etc/systemd/system/waun.service
[Unit]
Description=WAUN — WhatsApp Unofficial Gateway
After=network.target

[Service]
Type=simple
User=node
WorkingDirectory=/opt/waun
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
LimitNOFILE=100000
Environment=NODE_ENV=production
EnvironmentFile=/opt/waun/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now waun
sudo systemctl status waun
```

---

## 5. Konfigurasi Environment

### 5.1 File .env

Semua konfigurasi WAUN melalui file `.env`:

```bash
# Copy template
cp .env.example .env

# Isi sesuai kebutuhan
nano .env
```

### 5.2 Daftar Lengkap Environment Variables

#### Server
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PORT` | 3008 | Port HTTP server |
| `HOST` | 0.0.0.0 | Bind address |
| `NODE_ENV` | development | Environment mode (`development` / `production`) |
| `LOG_LEVEL` | info | Level log (`trace`, `debug`, `info`, `warn`, `error`, `fatal`) |
| `LOG_FORMAT` | pretty | Format log (`pretty` untuk dev, `json` untuk production) |

#### CORS
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `CORS_ORIGINS` | — | Whitelist origin (pisah pake koma: `http://a.com,http://b.com`) |

#### Database
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `DB_PATH` | ./data/waun.db | Path database SQLite |
| `DB_BACKUP_DIR` | ./data/backups | Folder backup database |
| `DB_BACKUP_INTERVAL` | 1800000 | Interval backup (ms), default 30 menit |

#### WhatsApp Session
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `SESSION_DIR` | ./sessions | Folder session WhatsApp |
| `WA_LIBRARY` | baileys | Library: `baileys` (default) atau `wwebjs` |
| `WEB_VERSION` | — | Override WhatsApp Web version (hanya wwebjs) |

#### Puppeteer (hanya untuk WA_LIBRARY=wwebjs)
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PUPPETEER_EXECUTABLE_PATH` | — | Path ke binary Chrome/Chromium |

#### Anti-Ban
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `AB_MIN_DELAY` | 3000 | Delay minimal antar pesan (ms) |
| `AB_MAX_DELAY` | 12000 | Delay maksimal antar pesan (ms) |
| `AB_DAILY_LIMIT` | 500 | Maksimal pesan per akun per hari |
| `AB_WARMUP_DAYS` | 7 | Lama warmup (hari) |
| `AB_WARMUP_MULTIPLIER` | 0.3 | Persentase limit di hari pertama |
| `AB_MAX_PER_CONTACT` | 50 | Maksimal pesan per kontak per hari |
| `AB_RESET_HOUR` | 3 | Jam reset daily counter (24h) |
| `AB_JITTER_FACTOR` | 0.3 | Random jitter ±30% dari base delay |

#### Broadcast
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `BROADCAST_MAX_CONTACTS` | 10000 | Maksimal kontak per broadcast |

#### Redis / Queue (opsional)
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `QUEUE_ENABLED` | false | Aktifkan BullMQ job queue (butuh Redis) |
| `REDIS_HOST` | localhost | Host Redis |
| `REDIS_PORT` | 6379 | Port Redis |

#### Auto-Reconnect
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `RECONNECT_MAX_ATTEMPTS` | 3 | Maksimal percobaan reconnect otomatis |
| `RECONNECT_DELAY` | 5000 | Delay antar percobaan (ms) |

#### Graceful Shutdown
| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `SHUTDOWN_TIMEOUT` | 40000 | Total waktu shutdown (ms) |
| `SHUTDOWN_BROADCAST_TIMEOUT` | 30000 | Maksimal nunggu broadcast selesai (ms) |

### 5.3 Contoh Konfigurasi

**Development (minimal):**
```env
PORT=3008
HOST=0.0.0.0
LOG_FORMAT=pretty
WA_LIBRARY=baileys
```

**Production (recommended):**
```env
PORT=3008
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=warn
LOG_FORMAT=json
CORS_ORIGINS=https://app.example.com
DB_PATH=/data/waun.db
SESSION_DIR=/data/sessions
WA_LIBRARY=baileys
AB_DAILY_LIMIT=500
BROADCAST_MAX_CONTACTS=10000
SHUTDOWN_TIMEOUT=40000
```

**Dengan whatsapp-web.js (fallback):**
```env
WA_LIBRARY=wwebjs
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
WEB_VERSION=2.3000.1019783070
AB_MIN_DELAY=5000
AB_MAX_DELAY=15000
```

**Dengan Redis queue:**
```env
QUEUE_ENABLED=true
REDIS_HOST=redis.example.com
REDIS_PORT=6379
```

---

## 6. Verifikasi Instalasi

### 6.1 Cek Server

```bash
# Endpoint health (public — gak perlu auth)
curl http://localhost:3008/health

# Response sukses:
{
  "status": "ok",
  "uptime": 5.23,
  "accounts": 0,
  "details": []
}
```

### 6.2 Cek Swagger Documentation

```bash
# Swagger UI
curl http://localhost:3008/api/docs
# → HTML page (swagger-ui)

# OpenAPI JSON spec
curl http://localhost:3008/api/docs-json | python3 -c "
import sys, json
spec = json.load(sys.stdin)
print(f'WAUN API v{spec[\"info\"][\"version\"]}')
print(f'Endpoints: {len(spec[\"paths\"])}')
"
# WAUN API v2.0.0
# Endpoints: 21
```

### 6.3 Cek Metrics

```bash
curl http://localhost:3008/metrics
# → Prometheus format
```

### 6.4 Cek Database

```bash
# Cek file database
ls -la data/waun.db
# -rw-r--r-- 1 user user 60K May 29 06:33 data/waun.db

# Cek isi database
sqlite3 data/waun.db ".tables"
# accounts  anti_ban_state  auto_replies  broadcasts  schema_version  webhooks
```

### 6.5 Cek Library yang Aktif

```bash
# Dari log startup:
grep "baileys\|wwebjs" /tmp/waun.log
# [INFO] Baileys library pre-loaded

# Atau cek dari health endpoint (status antiBan)
curl -s http://localhost:3008/health | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Server: {d[\"status\"]}')
print(f'Accounts: {d[\"accounts\"]}')
"
```

---

## 7. Troubleshooting Instalasi

### 7.1 "Cannot find package 'whatsapp-web.js'"

**Penyebab:** `WA_LIBRARY=wwebjs` tapi whatsapp-web.js gak di-install.

**Solusi:**
```bash
# Opsi 1: Install optional dependencies
npm install

# Opsi 2: Ganti ke Baileys (default)
# Edit .env:
# WA_LIBRARY=baileys

# Opsi 3: Install whatsapp-web.js manual
npm install whatsapp-web.js qrcode-terminal
```

### 7.2 "connect ECONNREFUSED 127.0.0.1:xxxxx"

**Penyebab:** whatsapp-web.js mencoba konek ke Chrome yang gak jalan.

**Solusi:**
```bash
# Opsi 1: Ganti ke Baileys (tidak butuh Chrome)
# Edit .env → WA_LIBRARY=baileys

# Opsi 2: Install & start Chrome
google-chrome --version
which google-chrome

# Opsi 3: Set path Chrome manual
# Edit .env → PUPPETEER_EXECUTABLE_PATH=/path/to/chrome
```

### 7.3 EADDRINUSE (port already in use)

**Penyebab:** Port 3008 sudah dipake proses lain.

**Solusi:**
```bash
# Cek siapa yang pake
lsof -i :3008

# Ganti port di .env
# PORT=3009

# Atau matikan proses lain
kill {PID}
```

### 7.4 Database Corruption

**Penyebab:** Crash saat write database.

**Solusi:**
```bash
# Cek backup terbaru
ls -la data/backups/
# waun-2026-05-29T06-33-29-000Z.db

# Restore backup
cp data/backups/waun-2026-05-29T06-33-29-000Z.db data/waun.db

# Atau hapus database (start fresh — akun perlu pairing ulang)
rm data/waun.db
```

### 7.5 "Protocol error (Target.setDiscoverTargets): Target closed"

**Penyebab:** whatsapp-web.js + Chrome issue. Chrome crash.

**Solusi:**
```bash
# Opsi 1: Ganti ke Baileys
WA_LIBRARY=baileys

# Opsi 2: Update Chrome
google-chrome --version
sudo apt update && sudo apt upgrade google-chrome-stable

# Opsi 3: Restart Chrome (kill semua proses)
pkill -f chrome
```

### 7.6 Session Expired / Logout

**Penyebab:** WhatsApp session expired atau user logout dari HP.

**Solusi:**
```bash
# 1. Hapus session lama
rm -rf sessions/{ACCOUNT_ID}/

# 2. Reconnect
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/reconnect \
  -H "Authorization: Bearer {API_KEY}"

# 3. Scan QR baru
curl http://localhost:3008/accounts/{ACCOUNT_ID}/qr
```

### 7.7 Docker: Container Exits Immediately

**Penyebab:** Environment variable salah atau port conflict.

**Solusi:**
```bash
# Cek log container
docker compose logs waun

# Masalah umum:
# 1. PORT conflict → ganti port mapping: "3009:3008"
# 2. Volume permission → chown -R 1000:1000 data sessions
# 3. .env file salah → pastikan semua env valid

# Fix permission
sudo chown -R 1000:1000 data sessions
```

### 7.8 npm Install Gagal (better-sqlite3)

**Penyebab:** `better-sqlite3` butuh native compilation (node-gyp).

**Solusi:**
```bash
# Install build tools
sudo apt install -y python3 make g++

# Rebuild
npm rebuild better-sqlite3

# Atau install ulang
rm -rf node_modules package-lock.json
npm install
```

---

## Referensi

| Resource | Link |
|----------|------|
| Cara Penggunaan | `docs/CARA-PENGGUNAAN.md` |
| Issues & Findings | `pr/issues-findings.md` |
| Resource Estimation | `pr/resource-estimation-1000-sessions.md` |
| SQLite Migration | `docs/sqlite-db.md` |
| Swagger Docs | `http://localhost:3008/api/docs` |
| GitHub Issues | [link-to-repo/issues] |
