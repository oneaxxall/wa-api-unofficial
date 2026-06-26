# Phase 4: Code Quality & Refactoring

> **Priority:** 🟡 Medium
> **Goal:** Code lebih maintainable, gak ada technical debt, naming konsisten

---

## Task 4.1 — Module-Level Mutable State Refactor

**Ref:** `issues-findings.md:7.4`
**Files:** `src/anti-ban.js:4`, `src/broadcast.js:5`

### Problem
`const clients = new Map()` dan `const broadcasts = new Map()` di module level — kalau ada 2 instance AccountManager, mereka share state yang sama.

### Requirements
- [ ] Pindahin `clients` Map ke dalam `AccountManager` instance
- [ ] Pindahin `broadcasts` Map ke dalam `BroadcastEngine` instance
- [ ] `getAntiBan()` → jangan singleton, jadikan method instance
- [ ] Pastikan test bisa buat multiple instance tanpa state conflict

### Acceptance Criteria
- `new AccountManager()` → punya Map sendiri
- `new BroadcastEngine(am1)` → punya Map sendiri
- Dua instance tidak saling pengaruh

---

## Task 4.2 — Anti-Ban Keyed by ID, Not Label

**Ref:** `issues-findings.md:7.5`
**Files:** `src/account-manager.js:44`

### Problem
Anti-ban di-key pake label. Dua account dengan label sama → share anti-ban state. Label bisa diubah.

### Requirements
- [ ] Key anti-ban pake `account.id` (UUID, immutable)
- [ ] Update `getAntiBan()` signature jadi `getAntiBan(accountId, label?)`
- [ ] Pastikan migration existing data tetap works

### Acceptance Criteria
- Dua account label sama → anti-ban state terpisah
- Account rename (ubah label) → anti-ban state tetap aman

---

## Task 4.3 — Fix ...data Overwrites Defensive Defaults

**Ref:** `issues-findings.md:7.6`
**Files:** `src/account-manager.js:142-151`

### Problem
`...data` di-spread setelah `webhooks: []`, jadi request bisa overwrite pake array sendiri.

### Requirements
- [ ] Spread `...data` SEBELUM default fields
- [ ] Atau extract hanya fields yang diizinkan: `const { label, webVersion } = data`
- [ ] Validasi: jangan simpan field yang gak dikenal

### Acceptance Criteria
- Request tanpa webhooks → `webhooks: []`
- Request dengan `webhooks: [{malicious}]` → ignored, tetap `[]`
- Request dengan `label: "foo"` → label terisi

---

## Task 4.4 — Route Handler Response Consistency

**Ref:** `issues-findings.md:7.8`
**Files:** Multiple route files

### Problem
Error response tidak konsisten. Ada yang `{ error: '...' }`, ada yang `{ status: '...' }`.

### Requirements
- [ ] Standard error response format:
  - `{ error: { code: 'NOT_FOUND', message: '...' } }`
- [ ] Standard success format:
  - `{ data: { ... } }` untuk single object
  - `{ data: [ ... ] }` untuk list
- [ ] Status code sesuai:
  - 200 success
  - 201 created
  - 400 bad request
  - 404 not found
  - 500 internal error

### Acceptance Criteria
- Semua endpoint pake format yang sama
- Client bisa predict response shape

---

## Task 4.5 — Fix Dynamic Import of node:fs

**Ref:** `issues-findings.md:7.7`
**Files:** `src/account-manager.js:21`

### Problem
Dynamic import `import('node:fs')` di runtime untuk built-in module. Unconventional dan error-prone.

### Requirements
- [ ] Tambah `import { mkdirSync } from 'node:fs'` di top of file
- [ ] Hapus `import('node:fs').then(...)` pattern
- [ ] Panggil `mkdirSync` langsung secara synchronous

### Acceptance Criteria
- No dynamic imports for `node:fs`
- Directory creation works synchronously

---

## Task 4.6 — Fix Auto-Reply Empty Regex

**Ref:** `issues-findings.md:7.9`
**Files:** `src/account-manager.js:136`

### Problem
Empty string sebagai regex → match semua input. Bisa di-exploit.

### Requirements
- [ ] Validasi `rule.keyword` tidak boleh empty string
- [ ] Kalau empty → skip rule atau reject saat addAutoReply
- [ ] Tambah length minimum (min 1 karakter)

### Acceptance Criteria
- Auto-reply dengan keyword kosong → rejected
- Keyword valid → accepted

---

## Task 4.7 — Fix msg.id Serialization

**Ref:** `issues-findings.md:9.8`
**Files:** `src/account-manager.js:109`

### Problem
Kalau `msg.id` object tanpa `_serialized`, hasil serialisasinya `[object Object]`.

### Requirements
- [ ] Pake `JSON.stringify(msg.id)` atau `String(msg.id)` untuk safe serialization
- [ ] Fallback: `msg.id?._serialized ?? (typeof msg.id === 'string' ? msg.id : JSON.stringify(msg.id))`

### Acceptance Criteria
- Webhook payload punya `id` field yang valid string
- No `[object Object]` di output

---

## Task 4.8 — Hapus Redundant _persist() Call

**Ref:** `issues-findings.md:7.3`
**Files:** `src/cli-add-account.js:11`

### Problem
`_persist()` dipanggil manual di CLI, tapi `addAccount` udah manggil. Double persist.

### Requirements
- [ ] Hapus `am._persist()` dari CLI script
- [ ] Pastikan `addAccount` tetap persist (udah ada)

### Acceptance Criteria
- `cli-add-account.js` gak panggil `_persist()` langsung
- Data tetap tersimpan
