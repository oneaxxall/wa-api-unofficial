# WAUN API — Bruno Collection

> **Bruno** adalah API client open-source (alternatif Postman/Insomnia).
> Download: https://www.usebruno.com/

## Cara Pakai

### 1. Buka Bruno
```bash
# Install Bruno (Ubuntu/Debian)
wget https://github.com/usebruno/bruno/releases/latest/download/bruno_{version}_amd64.deb
sudo dpkg -i bruno_*.deb

# Atau download dari website: https://www.usebruno.com/downloads
```

### 2. Import Collection
1. Buka Bruno
2. File > Open Collection
3. Pilih folder `bruno/` ini

### 3. Pilih Environment

Bruno udah include 2 environment di folder `environments/`:

| Environment | File | BASE_URL |
|-------------|------|----------|
| **Local** | `environments/Local.bru` | `http://localhost:3008` |
| **Production** | `environments/Production.bru` | `https://your-domain.com` |

**Cara aktivasi environment:**
1. Di Bruno, buka koleksi WAUN API
2. Lihat pojok kanan atas → dropdown **"No Environment"**
3. Klik dropdown → pilih **Local** atau **Production**

> ⚠️ **Kalau environment tidak muncul di dropdown:**
> Klik dropdown → **Configure** → **Add** → isi nama "Local" → tambah variable satu per satu.
> Atau pastikan folder `environments/` ada di root koleksi, lalu restart Bruno.

### 4. Set Variables

Setelah pilih environment, isi variable yang kosong:

| Variable | Contoh Value | Deskripsi |
|----------|-------------|-----------|
| `API_KEY` | `abc123...` | API key dari Create Account |
| `ACCOUNT_ID` | `a1b2c3d4-...` | UUID account |
| `BROADCAST_ID` | `b1c2d3e4-...` | UUID broadcast |
| `WEBHOOK_ID` | `w1e2b3h4-...` | UUID webhook |
| `RULE_ID` | `r1u2l3e4-...` | UUID auto-reply rule |

### 6. Run Requests (Urutan)

1. **Create Account** (Accounts → Create Account)
   - ✅ **Tidak perlu auth** — endpoint ini public
   - Copy `apiKey` dari response
2. Set `API_KEY` di **Environment Variables** → isi dengan apiKey dari langkah 1
3. **Get QR Code** → scan QR via WhatsApp (butuh auth)
4. **Send Text** → kirim pesan test (butuh auth)
5. **Start Broadcast** → kirim massal (butuh auth)

> 💡 **Cuma Create Account yang tanpa auth.** Semua endpoint lain butuh `Authorization: Bearer {{API_KEY}}`.

## Struktur

```
bruno/
├── bruno.json                    ← Konfigurasi collection
├── bruno-collection.bru          ← Collection metadata
├── System/                       ← Public endpoints
│   ├── Health.bru
│   ├── Metrics.bru
│   ├── Swagger UI.bru
│   └── OpenAPI Spec.bru
├── Admin/                          ← Admin-only endpoints (pake API_SECRET_KEY_ADMIN)
│   └── QR Sessions.bru
├── Accounts/                     ← Manajemen akun
│   ├── List Accounts.bru
│   ├── Get Account.bru
│   ├── Create Account.bru
│   ├── Delete Account.bru
│   ├── Get QR Code.bru
│   ├── Reconnect Account.bru
│   └── Rotate API Key.bru
├── Messages/                     ← Kirim pesan
│   ├── Send Text.bru
│   └── Send Media.bru
├── Broadcasts/                   ← Broadcast massal
│   ├── Start Broadcast.bru
│   ├── List Broadcasts.bru
│   ├── Get Broadcast.bru
│   ├── Cancel Broadcast.bru
│   └── Resume Broadcast.bru
├── Webhooks/                     ← Webhook management
│   ├── List Webhooks.bru
│   ├── Add Webhook.bru
│   ├── Delete Webhook.bru
│   └── Failed Webhooks.bru
├── Queue/                        ← Cek status job queue (BullMQ)
│   └── Get Job Status.bru
├── WebhookTester/                 ← Webhook testing endpoint
│   ├── Send Test Webhook.bru
│   └── View Webhook Logs.bru
    ├── List Auto-Replies.bru
    ├── Add Auto-Reply.bru
    └── Delete Auto-Reply.bru
```

## Total Request: 23 Endpoints
