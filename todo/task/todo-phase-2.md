# Phase 2: Data Integrity & Database

> **Priority:** 🔴 Critical
> **Goal:** Data gak corrupt, gak ilang, dan anti-ban state persist

---

## Task 2.1 — Atomic Database Writes (Temp File + Rename)

**Ref:** `issues-findings.md:4.1`
**Files:** `src/account-manager.js`

### Problem
`writeFileSync` langsung ke target file. Kalau crash mid-write, file jadi truncated/corrupt.

### Requirements
- [ ] Write ke temp file dulu (`accounts.json.tmp`)
- [ ] `renameSync` (atomic di POSIX) dari .tmp ke file target
- [ ] Error handling: kalau write gagal, jangan delete original
- [ ] Pakai `fsync` untuk flush disk cache

### Acceptance Criteria
- Crash mid-write → file original tetap utuh
- Write sukses → file terganti atomically
- No partial/corrupt data

---

## Task 2.2 — Silent Data Loss on Corrupt JSON

**Ref:** `issues-findings.md:4.2`
**Files:** `src/account-manager.js:11-16`

### Problem
Kalau JSON corrupt, balikin `[]` tanpa log. User kehilangan semua akun tanpa tau.

### Requirements
- [ ] Log error dengan path file + stack trace
- [ ] Rename corrupt file ke `accounts.json.corrupt.<timestamp>` (backup otomatis)
- [ ] Return `[]` setelah backup
- [ ] Jangan diam-diam reset data

### Acceptance Criteria
- Corrupt JSON → file di-backup ke `.corrupt.<timestamp>`, log error, start fresh
- Valid JSON → load normal

---

## Task 2.3 — Anti-Ban State Persistence

**Ref:** `issues-findings.md:3.3`, `9.10`
**Files:** `src/anti-ban.js`, `src/account-manager.js`

### Problem
`warmupDay`, `dailySent`, dll hanya di memory. Restart server = warmup balik ke day 1. Server crash di day 6 restart dari day 1.

### Requirements
- [ ] Simpan anti-ban state ke DB per account
- [ ] Fields yang di-persist: `dailySent`, `dailyReset`, `warmupDay`, `warmupComplete`
- [ ] Load state saat `getAntiBan()` dipanggil
- [ ] `contactDaily` gausah di-persist (reset tiap hari)
- [ ] Update state di DB setiap kali `checkDailyReset()` atau `incrementCounters()`
- [ ] Dedupe: jangan update DB setiap kali kirim pesan — update periodik (setiap 5 menit atau threshold)

### Acceptance Criteria
- Restart server → warmup day lanjut dari sebelumnya
- dailySent gak reset ke 0 setelah restart
- contactDaily tetap di-reset harian

---

## Task 2.4 — Schema Versioning

**Ref:** `issues-findings.md:4.4`
**Files:** `src/account-manager.js`

### Problem
JSON file tanpa `version` field. Schema future changes tidak bisa migrasi otomatis.

### Requirements
- [ ] Tambah `version: 1` di root data file
- [ ] `loadAccounts()` check version, kalau outdated, jalankan migrator
- [ ] Migrator function per version: `migrateV1ToV2(data) => data`
- [ ] Kalau version > current, log error dan return `[]`

### Acceptance Criteria
- Data file tanpa version → anggap v1, migrasi ke current
- Data file version sama → load normal
- Data file version lebih baru → log warning

---

## Task 2.5 — Database Layer Abstraction

**Ref:** `issues-findings.md:4.3`, `4.5`
**Files:** `src/account-manager.js`

### Problem
Semua I/O synchronous (`readFileSync`/`writeFileSync`). Block event loop. Gak ada backup strategy.

### Requirements
- [ ] Buat class `Database` yang handle read/write (isolasi logic)
- [ ] Opsional: implement auto-backup setiap N writes
- [ ] Kalau pake `better-sqlite3`: ganti ke SQLite (WAL mode, concurrent safe)
- [ ] Fallback: tetap JSON tapi dengan write queue (async)

### Acceptance Criteria (JSON path)
- Multiple writes dalam 1 tick → di-queue, flush sekali
- File write tidak blocking event loop (pake setImmediate queue)

### Acceptance Criteria (SQLite path)
- Concurrent read/write safe (WAL mode)
- Atomic transaction
- No blocking event loop
