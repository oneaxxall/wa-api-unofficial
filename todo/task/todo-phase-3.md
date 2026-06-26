# Phase 3: Error Handling & Race Conditions

> **Priority:** 🟠 High
> **Goal:** Gak ada unhandled rejection, race condition dihilangin, shutdown bersih

---

## Task 3.1 — Uncaught Promise Rejections in Event Handlers

**Ref:** `issues-findings.md:1.1`
**Files:** `src/account-manager.js:46-53`

### Problem
Async event handler (`message`, `message_ack`) return promise yang gak pernah di-catch. Kalau throw jadi unhandled rejection.

### Requirements
- [ ] Wrap handler body di try-catch
- [ ] Log error + account label
- [ ] Jangan crash process karena satu pesan gagal

### Acceptance Criteria
- `_handleIncoming` throw → logged, process lanjut
- `_handleAck` throw → logged, process lanjut
- No unhandled rejections

---

## Task 3.2 — Fix Redundant Webhook Error Catching

**Ref:** `issues-findings.md:1.2`
**Files:** `src/account-manager.js:81`, `:104`

### Problem
`.catch(() => {})` redundant — `_deliverWebhook` udah ada internal try-catch. Error dobel swallowed.

### Requirements
- [ ] Hapus `.catch(() => {})` dari panggilan `_deliverWebhook`
- [ ] Pastikan `_deliverWebhook` gak throw synchronously (wrap early return di try-catch juga)
- [ ] Tambah log warning di catch internal

### Acceptance Criteria
- Webhook gagal → log warning (sekali, bukan dobel)
- `_deliverWebhook` error → gak propagate ke caller

---

## Task 3.3 — Broadcast _execute Race Condition

**Ref:** `issues-findings.md:2.2`
**Files:** `src/broadcast.js:64-66`

### Problem
`setImmediate(() => this._execute(id))` bisa dipanggil bersamaan. Status check + set `running` tidak atomic.

### Requirements
- [ ] Set `rec.status = 'running'` SEBELUM `setImmediate`
- [ ] Atau pake `if (rec.status !== 'pending' && rec.status !== 'paused') return`
- [ ] `resume()` juga harus check status sebelum setImmediate

### Acceptance Criteria
- `resume()` dipanggil 2x berturut-turut → broadcast jalan sekali
- `cancel()` saat `resume()` pending → broadcast beneran cancel

---

## Task 3.4 — Graceful Shutdown: Destroy All WhatsApp Clients

**Ref:** `issues-findings.md:3.1`, `8.1`
**Files:** `src/index.js:55-64`, `src/account-manager.js`

### Problem
SIGINT/SIGTERM hanya close Fastify. WhatsApp/Puppeteer clients gak di-destroy — orphan Chrome process.

### Requirements
- [ ] Tambah method `AccountManager.destroy()`:
  - Iterate `this.clients.values()`
  - Panggil `client.wa.client.destroy()` untuk masing-masing
  - Log setiap destroy
  - Error handling: jangan stop karena satu client gagal destroy
- [ ] Panggil `am.destroy()` di SIGINT handler SEBELUM `app.close()`
- [ ] Timeout 10 detik untuk force exit kalau destroy lama
- [ ] Handle SIGTERM juga

### Acceptance Criteria
- `kill <pid>` → semua Chrome process mati (cek pake `ps aux | grep chrome`)
- Restart server → no "port already in use" dari Chrome leftover
- Log: "Destroying client X ... OK"

---

## Task 3.5 — Webhook Delivery Error Isolation

**Ref:** `issues-findings.md:9.7`
**Files:** `src/account-manager.js:80-82`

### Problem
Satu webhook error bisa propagate ke loop dan jadi unhandled rejection.

### Requirements
- [ ] Each webhook delivery wrapped di try-catch sendiri
- [ ] Satu webhook gagal → gak pengaruh ke webhook lain
- [ ] Log per-webhook failure

### Acceptance Criteria
- 1 dari 3 webhook error → 2 lainnya tetap terkirim
- Error logged dengan webhook URL

---

## Task 3.6 — Broadcast setImmediate Error Handling

**Ref:** `issues-findings.md:1.6`
**Files:** `src/broadcast.js:58`

### Problem
`setImmediate(() => this._execute(id))` — kalau _execute throw sync, broadcast stuck.

### Requirements
- [ ] Pake `.catch()` atau wrap di async IIFE
- [ ] Kalau error: set `rec.status = 'failed'`, simpan error message
- [ ] Jangan silent fail

### Acceptance Criteria
- Broadcast error → status jadi `failed`, bukan stuck di `pending`
- Error message tercatat di `record.errors`

---

## Task 3.7— CLI Script Error Handling

**Ref:** `issues-findings.md:1.5`
**Files:** `src/cli-add-account.js`, `src/cli-list-accounts.js`

### Problem
`AccountManager.init()` di CLI tanpa error handling. Kalau fail, unhandled rejection.

### Requirements
- [ ] Wrap di try-catch
- [ ] Print user-friendly error message
- [ ] Exit with code 1

### Acceptance Criteria
- Init gagal → "Error: <reason>" di console, exit code 1
- Init sukses → jalan normal
