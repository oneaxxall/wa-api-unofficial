# Phase 6: Observability, Documentation & Polish

> **Priority:** 🟢 Low (Nice to have)
> **Goal:** Developer friendly, observable, documented

---

## Task 6.1 — Metrics / Prometheus Endpoint

**Ref:** `issues-findings.md:8.2`
**Files:** `src/index.js`, `src/metrics.js` (new)

### Problem
No observability. Gak tau performance, throughput, error rate.

### Requirements
- [ ] Endpoint `GET /metrics` di port berbeda (default 9100) atau path `/metrics`
- [ ] Metrik yang di-track:
  - `waun_accounts_total` — total accounts
  - `waun_accounts_ready` — accounts with `ready: true`
  - `waun_messages_sent_total` — total messages sent (counter)
  - `waun_broadcasts_total` — total broadcasts started
  - `waun_broadcasts_active` — currently running broadcasts
  - `waun_webhook_deliveries_total` — webhook delivery attempts
  - `waun_webhook_failures_total` — failed webhook deliveries
  - `waun_anti_ban_daily_sent` — daily sent per account (gauge)
  - `waun_errors_total` — total error count
- [ ] Format: Prometheus plain text (atau pakai `@fastify/metrics`)

### Acceptance Criteria
- `curl http://localhost:3008/metrics` return Prometheus-format metrics
- Counter increment correctly after send/broadcast

---

## Task 6.2 — Request Logging (Fastify Logger)

**Ref:** `issues-findings.md:8.2`
**Files:** `src/index.js`

### Problem
Fastify `logger: false`. Zero request logs. Susah debug.

### Requirements
- [ ] Set `logger: true` di Fastify
- [ ] Pino transport: `pino-pretty` untuk development, JSON untuk production
- [ ] `LOG_FORMAT=pretty | json` di env
- [ ] Log request method, url, status code, response time
- [ ] Jangan log request body (bisa contain message content — privacy)
- [ ] Log `accountId` dari request header/path

### Acceptance Criteria
- Request `GET /health` → log `GET /health 200 5ms`
- `LOG_FORMAT=json` → output JSON (untuk log aggregation)
- No message content in logs

---

## Task 6.3 — OpenAPI / Swagger Documentation

**Ref:** `issues-findings.md:8.4`
**Files:** `src/index.js`, `swagger.yaml` (new)

### Problem
No API docs. Consumer harus baca source code.

### Requirements
- [ ] Tambah `@fastify/swagger` + `@fastify/swagger-ui`
- [ ] Anotasi setiap route dengan schema:
  - Request body schema (JSON Schema)
  - Response schema
  - Parameter descriptions
- [ ] Endpoint `GET /docs` → Swagger UI
- [ ] Endpoint `GET /docs/json` → OpenAPI spec JSON

### Acceptance Criteria
- `curl http://localhost:3008/docs` → Swagger UI page
- Each endpoint documented with request/response examples
- Schema validation built-in

---

## Task 6.4 — Pagination on List Endpoints

**Ref:** `issues-findings.md:6.4`
**Files:** `src/routes/accounts.js`, `src/routes/broadcasts.js`

### Problem
`GET /accounts` dan `GET /broadcasts` return semua data tanpa batas.

### Requirements
- [ ] Query params: `?page=1&limit=20`
- [ ] Default: `page=1, limit=20`
- [ ] Max limit: 100 (configurable)
- [ ] Response format:
```json
{
  "data": [...],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 150,
    "totalPages": 8
  }
}
```

### Acceptance Criteria
- `GET /accounts?page=2&limit=10` → 10 accounts, halaman 2
- `GET /accounts` → halaman 1, 20 accounts
- `total` di pagination sesuai jumlah seluruh data

---

## Task 6.5 — CORS Documentation & .env.example Update

**Ref:** `issues-findings.md:5.3`
**Files:** `.env.example`

### Problem
.env.example tidak update dengan konfigurasi baru.

### Requirements
- [ ] Tambah semua env vars yang ada di sistem:
  - `PORT`, `HOST`, `LOG_LEVEL`
  - `SESSION_DIR`, `DB_PATH`, `WEB_VERSION`
  - `PUPPETEER_EXECUTABLE_PATH`
  - `AB_MIN_DELAY` sampai `AB_JITTER_FACTOR`
  - `CORS_ORIGINS` (setelah implementasi phase 1)
- [ ] Tambah komentar untuk setiap var (fungsi, default)

### Acceptance Criteria
- `.env.example` mencakup semua env vars
- Tiap var punya komentar jelas

---

## Task 6.6 — Broadcast Progress WebSocket

**Ref:** `issues-findings.md:8.2`
**Files:** `src/broadcast.js`, `src/ws.js` (new)

### Problem
Broadcast progress hanya bisa di-poll via `GET /broadcast/:id`. Tidak real-time.

### Requirements
- [ ] WebSocket endpoint `ws://host/ws/broadcast/:id`
- [ ] Event: `progress` — `{ sent: 50, total: 100, failed: 2 }`
- [ ] Event: `complete` — `{ sent: 98, failed: 2, status: 'completed' }`
- [ ] Event: `error` — `{ message: '...', contact: '...' }`
- [ ] Client subscribe via URL parameter atau message pertama
- [ ] BroadcastEngine emit events yang di-subscribe oleh WebSocket handler

### Acceptance Criteria
- WebSocket connect → terima progress update real-time
- Broadcast selesai → terima event `complete`
- Koneksi putus → gak crash (handle error)

---

## Task 6.7 — README & Getting Started Guide

**Ref:** `issues-findings.md:8.4`
**Files:** `README.md`

### Problem
No README. User baru bingung cara setup.

### Requirements
- [ ] Title + description
- [ ] Prerequisites (Node 22+, Chrome, Redis optional)
- [ ] Quick start:
  1. `cp .env.example .env`
  2. `npm install`
  3. `npm start`
- [ ] API documentation overview (atau link ke `/docs`)
- [ ] Docker setup guide
- [ ] Anti-ban configuration guide
- [ ] Broadcast usage example
- [ ] Auto-reply setup example

### Acceptance Criteria
- Developer baru bisa setup dalam 5 menit dengan baca README
- All features documented with examples
