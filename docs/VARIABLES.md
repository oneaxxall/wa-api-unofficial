# Variables & Templates — Panduan Lengkap

> WAUN mendukung sistem template variables di beberapa fitur.
> Variable akan di-replace secara otomatis dengan nilai yang sesuai.

---

## Daftar Isi

1. [Broadcast Template Variables](#1-broadcast-template-variables)
2. [Auto-Reply Template Variables](#2-auto-reply-template-variables)
3. [Environment Variables](#3-environment-variables)
4. [Contoh Penggunaan](#4-contoh-penggunaan)

---

## 1. Broadcast Template Variables

Saat mengirim broadcast, kamu bisa pake `{{variable}}` di field `message`.
Variable akan di-replace dengan data dari masing-masing contact.

### Variable dari Field Contact

| Variable | Sumber | Contoh Output |
|----------|--------|---------------|
| `{{name}}` | `contact.name` | "Budi Santoso" |
| `{{phone}}` | `contact.phone` | "6281234567890" |
| `{{chatId}}` | `contact.chatId` | "6281234567890@s.whatsapp.net" |
| `{{...}}` | **Field lain di contact object** | Tergantung data yang dikirim |

> **Catatan:** `{{name}}` dan `{{phone}}` adalah field standar, tapi broadcast engine akan replace SEMUA `{{variable}}` dengan field yang cocok dari object contact. Kalau gak ada yang cocok, variable tetap tampil apa adanya (tidak diubah).

### Contoh

```json
{
  "message": "Halo {{name}}, ada promo spesial buat kamu! Klik: bit.ly/promo",
  "contacts": [
    {"phone": "6281234567890", "name": "Budi"},
    {"phone": "6289876543210", "name": "Siti"}
  ]
}
```

Hasil untuk masing-masing kontak:

| Kontak | Pesan yang Diterima |
|--------|-------------------|
| Budi | "Halo Budi, ada promo spesial buat kamu! Klik: bit.ly/promo" |
| Siti | "Halo Siti, ada promo spesial buat kamu! Klik: bit.ly/promo" |

### Custom Field

Kamu bisa tambah field APAPUN di object contact, dan panggil pake `{{fieldName}}`:

```json
{
  "message": "Halo {{name}}, pesanan #{{orderId}} sudah siap. Total: Rp{{total}}",
  "contacts": [
    {
      "phone": "6281234567890",
      "name": "Budi",
      "orderId": "INV-001",
      "total": "150.000"
    }
  ]
}
```

Hasil: "Halo Budi, pesanan #INV-001 sudah siap. Total: Rp150.000"

### Cara Kerja

```js
// src/broadcast.js — interpolate()
interpolate(template, contact) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
    contact[key] !== undefined ? String(contact[key]) : `{{${key}}}`
  )
}
```

Jika key tidak ditemukan di object contact, `{{variable}}` tetap tampil apa adanya (tidak diubah). Ini biar kamu bisa detect kalau ada variable yang salah ketik.

---

## 2. Auto-Reply Template Variables

Saat membuat auto-reply rule, kamu bisa pake variable di field `reply`.
Variable akan di-replace dengan data dari pesan masuk.

| Variable | Sumber | Contoh Output |
|----------|--------|---------------|
| `{{body}}` | Isi pesan yang masuk | "Halo, ada promo?" |
| `{{from}}` | Nomor pengirim (clean) | "6281234567890" |
| `{{senderName}}` | Nama kontak pengirim (pushName) | "Budi Santoso" |

### Contoh

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "halo",
    "reply": "Halo {{from}}! Terima kasih sudah menghubungi kami. Pesan kamu: {{body}}",
    "matchType": "contains"
  }'
```

**Skenario:**

| Pesan Masuk | Auto-Reply yang Dikirim |
|-------------|------------------------|
| "Halo, ada yang bisa dibantu?" | "Halo 6281234567890! Terima kasih sudah menghubungi kami. Pesan kamu: Halo, ada yang bisa dibantu?" |
| "Halo dong" | "Halo 6281234567890! Terima kasih sudah menghubungi kami. Pesan kamu: Halo dong" |

### Cara Kerja

```js
// src/account-manager.js
const replyMsg = rule.reply
  .replace(/{{body}}/g, msg.body)
  .replace(/{{from}}/g, msg.from)
```

> `{{from}}` berisi nomor **clean** (tanpa `@s.whatsapp.net` atau `@c.us`).

---

## 3. Environment Variables

Semua konfigurasi WAUN melalui file `.env`. Lihat file `.env` atau `.env.example` untuk detail lengkap.

### Server & Logging

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `PORT` | 3008 | Port HTTP server |
| `HOST` | 0.0.0.0 | Bind address |
| `NODE_ENV` | development | Environment mode |
| `DEBUG` | 0 | Debug mode (1 = verbose) |
| `LOG_LEVEL` | info | Level log |
| `LOG_FORMAT` | pretty | Format log |

### CORS

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `CORS_ORIGINS` | — | Whitelist origin (pisah koma) |

### Database

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `DB_PATH` | ./data/waun.db | Path SQLite database |
| `DB_BACKUP_DIR` | ./data/backups | Folder backup |
| `DB_BACKUP_INTERVAL` | 1800000 | Interval backup (ms) |

### WhatsApp Library

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `SESSION_DIR` | ./sessions | Folder session |
| `WA_LIBRARY` | baileys | Library: `baileys` (default) / `wwebjs` |
| `WEB_VERSION` | — | WhatsApp Web version (wwebjs only) |
| `PUPPETEER_EXECUTABLE_PATH` | — | Path Chrome (wwebjs only) |

### Anti-Ban

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `AB_MIN_DELAY` | 3000 | Delay minimal antar pesan (ms) |
| `AB_MAX_DELAY` | 12000 | Delay maksimal antar pesan (ms) |
| `AB_JITTER_FACTOR` | 0.3 | Random jitter (±30%) |
| `AB_DAILY_LIMIT` | 500 | Maksimal pesan per akun per hari |
| `AB_RESET_HOUR` | 3 | Jam reset counter |
| `AB_MAX_PER_CONTACT` | 50 | Maksimal pesan per kontak per hari |
| `AB_WARMUP_DAYS` | 7 | Lama warmup (hari) |
| `AB_WARMUP_MULTIPLIER` | 0.3 | Limit hari pertama warmup |

### Broadcast

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `BROADCAST_MAX_CONTACTS` | 10000 | Maks kontak per broadcast |

### Redis / Queue

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `QUEUE_ENABLED` | false | Aktifkan BullMQ queue |
| `REDIS_HOST` | localhost | Redis host |
| `REDIS_PORT` | 6379 | Redis port |

### Auto-Reconnect

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `RECONNECT_MAX_ATTEMPTS` | 3 | Maks reconnect |
| `RECONNECT_DELAY` | 5000 | Delay reconnect (ms) |

### Graceful Shutdown

| Variable | Default | Deskripsi |
|----------|---------|-----------|
| `SHUTDOWN_TIMEOUT` | 40000 | Total timeout shutdown (ms) |
| `SHUTDOWN_BROADCAST_TIMEOUT` | 30000 | Timeout broadcast drain (ms) |

---

## 4. Contoh Penggunaan

### 4.1 Broadcast dengan Template

```bash
curl -X POST http://localhost:3008/broadcast \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "accountId": "{ACCOUNT_ID}",
    "name": "Notifikasi Pesanan",
    "message": "Halo {{name}}, pesanan #{{orderId}} sudah dikirim. Resi: {{resi}}",
    "contacts": [
      {
        "phone": "6281234567890",
        "name": "Budi",
        "orderId": "INV-001",
        "resi": "JNE123456"
      },
      {
        "phone": "6289876543210",
        "name": "Siti",
        "orderId": "INV-002",
        "resi": "JNE789012"
      }
    ]
  }'
```

### 4.2 Auto-Reply dengan Template

```bash
curl -X POST http://localhost:3008/accounts/{ACCOUNT_ID}/auto-replies \
  -H "Authorization: Bearer {API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "keyword": "order",
    "reply": "Halo {{senderName}}! Pesanan kamu: {{body}}. Kami akan proses segera.",
    "matchType": "contains"
  }'
```

### 4.3 Kombinasi Webhook + Auto-Reply

Webhook menerima pesan:
```json
{
  "event": "message",
  "accountId": "...",
  "senderName": "Budi",
  "from": "6281234567890",
  "body": "Saya mau order produk A"
}
```

Auto-reply membalas:
```
Halo Budi! Pesanan kamu: Saya mau order produk A. Kami akan proses segera.
```

---

## Quick Reference

| Fitur | Variable | Sumber Data | Digunakan Di |
|-------|----------|-------------|--------------|
| Broadcast | `{{name}}` | `contact.name` | `POST /broadcast` |
| Broadcast | `{{phone}}` | `contact.phone` | `POST /broadcast` |
| Broadcast | `{{field}}` | `contact.field` | `POST /broadcast` |
| Auto-Reply | `{{body}}` | `msg.body` (isi pesan masuk) | `POST /accounts/:id/auto-replies` |
| Auto-Reply | `{{from}}` | `msg.from` (nomor pengirim) | `POST /accounts/:id/auto-replies` |
| Auto-Reply | `{{senderName}}` | `msg.senderName` (nama kontak) | `POST /accounts/:id/auto-replies` |
