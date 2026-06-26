# Webhook Incoming Format — Payload Reference

> WAUN mengirimkan HTTP POST ke URL webhook yang terdaftar ketika ada event tertentu.
> Format payload adalah JSON, dikirim dengan `Content-Type: application/json`.

---

## Daftar Isi

1. [Cara Setup Webhook](#cara-setup-webhook)
2. [Event: `message`](#event-message)
3. [Event: `message.ack`](#event-messageack)
4. [Retry Mechanism](#retry-mechanism)
5. [Failed Webhooks](#failed-webhooks)
6. [Contoh Integrasi](#contoh-integrasi)

---

## Event Overview

WAUN mengirimkan 3 jenis event ke webhook:

| Event | Dipicu Saat |
|-------|-------------|
| `message` | Ada pesan masuk |
| `message.ack` | Status pengiriman berubah |
| `connection.status` | Koneksi WhatsApp terhubung/terputus |

---

## Cara Setup Webhook

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

Parameter:

| Field | Wajib | Default | Deskripsi |
|-------|-------|---------|-----------|
| `url` | ✅ Ya | — | URL endpoint yang menerima webhook |
| `headers` | ✗ | `{}` | Custom HTTP headers (contoh: API key) |
| `timeout` | ✗ | 10000 | Timeout request dalam ms |

---

## Event: `message`

Dikirim saat ada **pesan masuk** ke akun WhatsApp.

### Contoh Payload

```json
{
  "event": "message",
  "accountId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "accountLabel": "Marketing",
  "senderName": "Budi Santoso",
  "from": "6281234567890",
  "fromMe": false,
  "body": "Halo, ada promo terbaru?",
  "type": "chat",
  "timestamp": 1712345678,
  "hasMedia": false,
  "isGroup": false,
  "chatId": "6281234567890"
}
```

### Field Reference

| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `event` | string | `"message"` — identifier event |
| `accountId` | string (UUID) | ID akun WhatsApp yang menerima pesan |
| `accountLabel` | string | **Label / nama akun WA** (yang didaftarin pas create account). Contoh: "Marketing", "CS 1" |
| `senderName` | string | **Nama kontak pengirim** (pushName dari WhatsApp). Bisa kosong kalau nomor gak punya nama |
| `from` | string | Nomor pengirim (clean, tanpa domain). Contoh: `6281234567890` |
| `fromMe` | boolean | `false` — pesan dari orang lain |
| `body` | string | Isi/teks pesan |
| `type` | string | Tipe pesan: `chat`, `image`, `document`, `audio`, `video`, `sticker`, dll |
| `timestamp` | number | Unix timestamp (detik) saat pesan dikirim |
| `hasMedia` | boolean | Apakah pesan mengandung media |
| `isGroup` | boolean | Apakah pesan dari grup |
| `chatId` | string | Sama dengan `from` — nomor pengirim (clean) |

### Catatan Penting

1. **Nomor sudah clean**: Webhook field `from` dan `chatId` sudah dalam format nomor murni (contoh: `6281234567890`). Tidak ada suffix `@s.whatsapp.net` atau `@c.us`.
2. **Gunakan untuk reply**: Kalau ingin membalas via API `POST /send`, WAUN otomatis akan memformat nomor sesuai library yang dipake (Baileys: `@s.whatsapp.net`, wwebjs: `@c.us`). Cukup kirim nomor clean saja.
3. **`body` untuk media**: Kalau `type` adalah `image`/`document`/`video`, field `body` berisi `caption` (jika ada). Kalau tidak ada caption, `body` akan kosong.
3. **`hasMedia`**: Untuk mengecek apakah ada media attachment, gunakan field ini.
4. **Group chat**: `isGroup: true` → `from` akan berisi JID grup (contoh: `6281234567890-1234567890@g.us`).
5. **Timestamp**: Dalam satuan **detik** (Unix epoch time). Kalau perlu milidetik, kalikan dengan 1000.

### Contoh Webhook Server (Node.js/Express)

```javascript
app.post('/webhook-wa', (req, res) => {
  const { event, accountId, from, body, type } = req.body

  if (event === 'message') {
    console.log(`[${accountLabel}] Pesan dari ${from}: ${body}`)

    // Balas otomatis via API WAUN
    if (body.toLowerCase().includes('halo')) {
      await axios.post('http://localhost:3008/send', {
        accountId,
        to: from,
        message: 'Halo! Ada yang bisa dibantu?'
      }, {
        headers: { 'Authorization': `Bearer ${API_KEY}` }
      })
    }
  }

  res.sendStatus(200)
})
```

---

## Event: `message.ack`

Dikirim saat **status pengiriman pesan berubah**. Event ini terjadi untuk pesan yang KITA kirim (outgoing), bukan pesan masuk.

### Contoh Payload

```json
{
  "event": "message.ack",
  "accountId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "accountLabel": "Marketing",
  "from": "6281234567890",
  "id": "3EB0C25B9B1A2D4F5C",
  "ack": 2,
  "jobId": "3"
}
```

### Field Reference

| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `event` | string | `"message.ack"` — identifier event |
| `accountId` | string (UUID) | ID akun WhatsApp |
| `accountLabel` | string | Label akun |
| `from` | string | Nomor penerima (clean, tanpa domain) |
| `id` | string | ID pesan WhatsApp (dari response send) |
| `ack` | number | Status pengiriman (lihat tabel di bawah) |
| `jobId` | string/null | Job ID dari queue BullMQ. `null` kalo dikirim langsung (bukan via queue) |

### ACK Values

| Value | Arti | Kapan Terjadi |
|-------|------|---------------|
| `0` | **Error / tidak terkirim** | Pesan gagal dikirim (banned, nomor tidak valid) |
| `1` | **Pending / terkirim ke server** | Pesan sudah sampai server WhatsApp |
| `2` | **Terkirim ke perangkat** | Pesan sudah sampai ke HP tujuan |
| `3` | **Dibaca** | Penerima sudah membaca pesan (centang biru) |
| `4` | **Dibalas** | Penerima membalas pesan (jika diaktifkan) |

> **Catatan:** ACK value tergantung pada pengaturan privasi penerima. Kalau penerima nonaktifkan centang biru, ACK 3 tidak akan pernah terkirim.

### Contoh Penggunaan ACK

```javascript
app.post('/webhook-wa', (req, res) => {
  const { event, id, from, ack } = req.body

  if (event === 'message.ack') {
    console.log(`Pesan ${id} ke ${from}: status ${ack}`)

    if (ack >= 2) {
      // Pesan berhasil terkirim
      updateStatusKirim(id, 'terkirim')
    }

    if (ack === 3) {
      // Pesan sudah dibaca
      updateStatusKirim(id, 'dibaca')
    }
  }

  res.sendStatus(200)
})
```

---

## Retry Mechanism

WAUN punya retry otomatis untuk webhook yang gagal:

```
Attempt 1 → gagal → tunggu 1 detik
Attempt 2 → gagal → tunggu 8 detik
Attempt 3 → gagal → tercatat sebagai failed
```

### Kebijakan Retry

| Status Code | Di-retry? | Keterangan |
|-------------|-----------|------------|
| `200-299` | ❌ Tidak | Sukses |
| `400-499` | ❌ Tidak | Client error — URL salah / server tolak |
| `500-599` | ✅ Ya | Server error — mungkin temporary |
| Network error (ECONNREFUSED, ETIMEDOUT, dll) | ✅ Ya | Mungkin server down sementara |

### Log di Server

```
⚠ Webhook https://server-anda.com/webhook attempt 1/3 failed — retry in 1000ms: connect ECONNREFUSED
⚠ Webhook https://server-anda.com/webhook attempt 2/3 failed — retry in 8000ms: connect ECONNREFUSED
✗ Webhook https://server-anda.com/webhook failed after 3 attempts: connect ECONNREFUSED
```

---

## Event: `connection.status`

Dikirim saat **status koneksi WhatsApp berubah** (terhubung atau terputus).

### Contoh Payload

```json
{
  "event": "connection.status",
  "accountId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "accountLabel": "Marketing",
  "status": "disconnected",
  "reason": "LOGOUT",
  "timestamp": 1712345678
}
```

### Field Reference

| Field | Tipe | Deskripsi |
|-------|------|-----------|
| `event` | string | `"connection.status"` — identifier event |
| `accountId` | string (UUID) | ID akun WhatsApp |
| `accountLabel` | string | Label akun |
| `status` | string | `"connected"` atau `"disconnected"` |
| `reason` | string | Alasan (kalo disconnected): `LOGOUT`, `SESSION_EXPIRED`, `TIMED_OUT`, `CONNECTION_REPLACED`, dll |
| `timestamp` | number | Unix timestamp (detik) |

### Contoh Monitoring

```javascript
app.post('/webhook-wa', (req, res) => {
  const { event, accountLabel, status, reason } = req.body

  if (event === 'connection.status') {
    if (status === 'disconnected') {
      console.log(`⚠️ ${accountLabel} disconnected: ${reason}`)
      sendAlert(`WhatsApp ${accountLabel} offline!`)
    } else {
      console.log(`✅ ${accountLabel} connected`)
    }
  }

  res.sendStatus(200)
})
```

---

## Failed Webhooks

Cek webhook yang gagal total (setelah semua retry):

```bash
curl http://localhost:3008/accounts/{ACCOUNT_ID}/failed-webhooks \
  -H "Authorization: Bearer {API_KEY}"
```

Response:
```json
{
  "data": [
    {
      "webhookId": "wh-123",
      "url": "https://server-anda.com/webhook",
      "payload": {
        "event": "message",
        "from": "62812...",
        "body": "Halo"
      },
      "error": "connect ECONNREFUSED",
      "timestamp": "2026-05-29T10:00:00.000Z"
    }
  ]
}
```

---

## Contoh Integrasi

### 1. Python / Flask

```python
@app.route('/webhook-wa', methods=['POST'])
def webhook_wa():
    data = request.json
    
    if data['event'] == 'message':
        print(f"Pesan dari {data['from']}: {data['body']}")
        
        if 'promo' in data['body'].lower():
            # Balas via API WAUN
            requests.post('http://localhost:3008/send', 
                json={
                    'accountId': data['accountId'],
                    'to': data['from'],
                    'message': 'Ada promo spesial! Cek website kami.'
                },
                headers={'Authorization': f'Bearer {API_KEY}'}
            )
    
    return 'OK', 200
```

### 2. PHP

```php
<?php
$payload = json_decode(file_get_contents('php://input'), true);

if ($payload['event'] === 'message') {
    $from = $payload['from'];
    $body = $payload['body'];
    $accountId = $payload['accountId'];
    
    file_put_contents('wa_messages.log', "[$from] $body\n", FILE_APPEND);
    
    // Auto-reply via WAUN API
    $ch = curl_init('http://localhost:3008/send');
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'accountId' => $accountId,
        'to' => $from, 
        'message' => 'Terima kasih pesannya!'
    ]));
    curl_setopt($ch, CURLOPT_HTTPHEADER, [
        'Content-Type: application/json',
        'Authorization: Bearer ' . API_KEY
    ]);
    curl_exec($ch);
}

http_response_code(200);
```

### 3. Google Apps Script

```javascript
function doPost(e) {
  const data = JSON.parse(e.postData.contents);
  
  if (data.event === 'message') {
    const sheet = SpreadsheetApp.getActiveSheet();
    sheet.appendRow([
      data.from,
      data.body,
      new Date(data.timestamp * 1000),
      data.isGroup ? 'Grup' : 'Personal'
    ]);
  }
  
  return ContentService.createTextOutput('OK');
}
```

### 4. Node.js (WebSocket ke Broadcast)

```javascript
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.post('/webhook-wa', async (req, res) => {
  const data = req.body;
  
  if (data.event === 'message' && !data.isGroup) {
    // Forward ke group Telegram atau sistem notifikasi
    await sendTelegram(`WA dari ${data.from}: ${data.body}`);
    
    // Simpan ke database
    await db.query(
      'INSERT INTO messages (from_number, body, received_at) VALUES (?, ?, NOW())',
      [data.from, data.body]
    );
  }
  
  res.status(200).json({ status: 'ok' });
});
```

---

## Best Practices

1. **Respond with 200 ASAP** — Jangan tunggu proses selesai. Balik `200 OK` langsung, proses di background.
2. **Idempotency** — Webhook bisa dikirim ulang (retry). Pastikan handler kamu idempotent.
3. **Verify signature** — Gunakan `X-Secret` header untuk verifikasi bahwa webhook benar-benar dari WAUN.
4. **Timeout** — Set timeout handler kamu < 10 detik (sesuai webhook timeout WAUN).
5. **Logging** — Log semua incoming webhook buat debugging.

### Contoh Verifikasi Signature

```javascript
const SECRET = 'rahasia123';

app.post('/webhook-wa', (req, res) => {
  const signature = req.headers['x-secret'];
  
  if (signature !== SECRET) {
    return res.status(403).json({ error: 'Invalid signature' });
  }
  
  // Process webhook...
  res.sendStatus(200);
});
```
