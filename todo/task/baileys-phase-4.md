# Baileys Migration — Phase 4: Dual Library Support & Cleanup

> **Priority:** 🟠 High
> **Goal:** Konfigurasi dual-library (env), cleanup old deps, final testing

---

## Latar Belakang

Phase 3 bikin BaileysAdapter yang fungsional. Sekarang kita pastikan:
1. User bisa pilih library via env (`WA_LIBRARY`)
2. whatsapp-web.js masih bisa dipake sebagai fallback
3. Semua kode lama di-cleanup
4. Dokumentasi di-update
5. Resource estimation di-revisi

## Goal Phase 4

- `WA_LIBRARY=baileys` (default) → pake BaileysAdapter
- `WA_LIBRARY=wwebjs` → pake WwebAdapter (fallback)
- Hapus `qrcode-terminal` dari dependencies
- `whatsapp-web.js` jadi `optionalDependencies` (gak wajib di-install)
- Update `.env.example` dengan konfigurasi baru
- Update resource estimation docs

## Files affected

| File | Action |
|------|--------|
| `src/client.js` | **MODIFY** — Factory: return WwebAdapter atau BaileysAdapter based on env |
| `package.json` | **MODIFY** — `whatsapp-web.js` → `optionalDependencies`, hapus `qrcode-terminal` |
| `.env` | **MODIFY** — Tambah `WA_LIBRARY=baileys`, hapus `PUPPETEER_*` |
| `.env.example` | **MODIFY** — Same |
| `ecosystem.config.js` | **MODIFY** — Update env vars |
| `pr/resource-estimation-1000-sessions.md` | **MODIFY** — Revisi dengan angka Baileys |
| `docs/sqlite-db.md` | **MODIFY** — Hapus referensi Puppeteer/Chrome yg gak relevan |

## Detail Implementasi

### 4.1 — Library Selector

```js
// src/client.js — factory function
import { WwebAdapter } from './adapters/wweb-adapter.js'
import { BaileysAdapter } from './adapters/baileys-adapter.js'

const LIBRARY = process.env.WA_LIBRARY || 'baileys'

export function createWAClient(account) {
  const sessionDir = process.env.SESSION_DIR || './sessions'

  switch (LIBRARY) {
    case 'wwebjs':
      return new WwebAdapter(account, sessionDir)
    case 'baileys':
    default:
      return new BaileysAdapter(account, sessionDir)
  }
}
```

### 4.2 — Directory Structure After Cleanup

```
src/
├── adapters/
│   ├── wa-adapter.js         # Abstract class (dari Phase 1)
│   ├── wweb-adapter.js       # whatsapp-web.js implementation
│   └── baileys-adapter.js    # Baileys implementation
├── client.js                 # Factory — pilih adapter based on env
└── ...                       # Sisanya tetap
```

### 4.3 — Package.json Changes

```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "^7.0.0-rc13",
    "@fastify/cors": "^10.0.0",
    // ... sisanya tetap
  },
  "optionalDependencies": {
    "whatsapp-web.js": "^1.26.0"
  }
}
```

**Alasan `optionalDependencies`:** whatsapp-web.js butuh Chromium + native deps berat. Di production (Baileys), gak perlu di-install. Tapi masih available untuk development atau fallback.

### 4.4 — Env Vars Update

```env
# WhatsApp Library — pilih backend
WA_LIBRARY=baileys            # baileys (default) | wwebjs

# Baileys (default) — no config needed

# whatsapp-web.js (fallback) — cuma dipake kalo WA_LIBRARY=wwebjs
# PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome
# WEB_VERSION=2.3000.1019783070
```

### 4.5 — Dockerfile Update

Chrome dulu diperlukan untuk `whatsapp-web.js`. Dengan Baileys sebagai default:

```dockerfile
# Sebelum — install Chrome (600MB+)
RUN apt-get install -y google-chrome-stable

# Sesudah — Chrome optional (cuma kalo WA_LIBRARY=wwebjs)
# Bisa hapus dari Dockerfile, atau pindahin ke stage terpisah
```

**Rekomendasi:** Pertahankan Chrome di Dockerfile tapi sebagai `apt-get` optional. Atau split jadi 2 Dockerfile:
- `Dockerfile.baileys` — tanpa Chrome (small, ~200MB)
- `Dockerfile.wwebjs` — dengan Chrome (large, ~800MB)

### 4.6 — Resource Estimation Revisi

**Dengan Baileys (default):**

| Resource | Per Session | 1000 Sessions |
|----------|-------------|---------------|
| RAM | 5-10 MB | **5-10 GB** ✅ |
| CPU | <0.5% idle | 5-10 cores ✅ |
| Storage | 1-5 KB | 5-50 MB ✅ |
| Network | 1-3 Mbps | 1-3 Gbps ✅ |

**Kesimpulan:** 1000 sessions muat di **1 server** dengan 32-64 GB RAM.

Detail lengkap di `pr/resource-estimation-1000-sessions.md` (akan di-update).

## Acceptance Criteria

- `WA_LIBRARY=baileys` → server pake BaileysAdapter
- `WA_LIBRARY=wwebjs` → server pake WwebAdapter (fallback)
- Ganti env, restart server → library berubah tanpa ubah kode
- `npm install` — Baileys ter-install, whatsapp-web.js optional
- `npm install --no-optional` — cuma Baileys (smaller install)
- Docker image size: ~200 MB (Baileys) vs ~800 MB (wwebjs)
- Resource estimation docs di-revisi dengan angka baru
- `qrcode-terminal` dihapus (Baileys pake `printQRInTerminal` built-in)

## Verification

```bash
# Test Baileys (default)
WA_LIBRARY=baileys node src/index.js
# → "Using WhatsApp library: baileys"
# → RAM: ~50 MB untuk 10 accounts (vs 1.5GB sebelumnya)

# Test WwebJS (fallback)
WA_LIBRARY=wwebjs node src/index.js
# → "Using WhatsApp library: wwebjs"

# Test all API endpoints tetap berfungsi
curl http://localhost:3008/health
curl -s http://localhost:3008/api/docs-json

# Test Docker build (Baileys)
docker build -t waun:baileys -f Dockerfile.baileys .
docker images waun:baileys
# → ~200 MB

# Test storage per session
du -sh sessions/*/
# Baileys: ~5K per session
# WwebJS: ~20-50M per session
```
