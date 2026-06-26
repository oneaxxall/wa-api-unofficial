// database layer — SQLite dengan WAL mode, handle migration dari JSON lama
import Database from 'better-sqlite3'
import { existsSync, readFileSync, renameSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import logger from './utils/logger.js'

const DB_PATH = process.env.DB_PATH || './data/waun.db'
const BACKUP_DIR = process.env.DB_BACKUP_DIR || './data/backups'
const SCHEMA_VERSION = 4 // Current schema version

let db = null

/**
 * Inisialisasi koneksi SQLite + buat tabel kalau belum ada.
 * WAL mode: concurrent read aman, write gak blocking read.
 * Foreign key ON: cascade delete otomatis.
 */
export function initDatabase() {
  if (db) return db

  // Pastikan directory tujuan ada sebelum buka koneksi
  const dir = DB_PATH.substring(0, DB_PATH.lastIndexOf('/'))
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  db = new Database(DB_PATH)

  // WAL mode — performance + concurrent safety
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  createTables()

  // Jalankan migrasi schema setelah tabel dibuat
  runMigrations()

  // Migrasi dari JSON file lama (kalo ada)
  migrateFromJson()

  // Backup database di startup — fire & forget biar gak nahan startup
  backupDatabase().catch(err => logger.warn(`Startup backup: ${err.message}`))

  logger.info(`Database ready: ${DB_PATH}`)
  return db
}

/**
 * Buat semua tabel yang dibutuhkan WAUN.
 * IF NOT EXISTS biar aman dipanggil berulang (misal pas restart).
 */
function createTables() {
  db.exec(`
    -- Schema version tracker: catat semua migration yang udah dijalanin
    -- Biar kita tau database ini di version berapa
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Akun WhatsApp: multi-account, tiap account punya session Puppeteer sendiri
    CREATE TABLE IF NOT EXISTS accounts (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      api_key     TEXT,
      web_version TEXT,
      phone       TEXT,
      notes       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Webhook: tujuan forwarding pas ada pesan masuk atau ACK
    CREATE TABLE IF NOT EXISTS webhooks (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      url        TEXT NOT NULL,
      headers    TEXT,
      timeout    INTEGER DEFAULT 10000,
      enabled    INTEGER DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Auto-reply: aturan balasan otomatis berdasarkan keyword
    CREATE TABLE IF NOT EXISTS auto_replies (
      id         TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      keyword    TEXT NOT NULL,
      reply      TEXT NOT NULL,
      match_type TEXT DEFAULT 'contains',
      enabled    INTEGER DEFAULT 1,
      cooldown   INTEGER DEFAULT 30,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Anti-ban state: persist biar warmup progress gak hilang tiap restart
    CREATE TABLE IF NOT EXISTS anti_ban_state (
      account_id      TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      daily_sent      INTEGER DEFAULT 0,
      daily_reset     TEXT,
      warmup_day      INTEGER DEFAULT 1,
      warmup_complete INTEGER DEFAULT 0,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Broadcast log: riwayat + progress pengiriman massal
    CREATE TABLE IF NOT EXISTS broadcasts (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name         TEXT,
      message      TEXT NOT NULL,
      total        INTEGER DEFAULT 0,
      sent         INTEGER DEFAULT 0,
      failed       INTEGER DEFAULT 0,
      status       TEXT DEFAULT 'pending',
      contacts     TEXT,
      errors       TEXT,
      options      TEXT,
      created_at   TEXT DEFAULT (datetime('now')),
      started_at   TEXT,
      completed_at TEXT
    );

    -- Index biar query filter by account_id gak full scan
    CREATE INDEX IF NOT EXISTS idx_webhooks_account ON webhooks(account_id);
    CREATE INDEX IF NOT EXISTS idx_auto_replies_account ON auto_replies(account_id);
    CREATE INDEX IF NOT EXISTS idx_broadcasts_account ON broadcasts(account_id);
    CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);

    -- Quick QR sessions: tracking pairing via DB, bukan memory doang
    -- Biar user tetep bisa polling meskipun server restart
    CREATE TABLE IF NOT EXISTS quick_qr_sessions (
      temp_id     TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      status      TEXT DEFAULT 'waiting',
      result      TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      updated_at  TEXT DEFAULT (datetime('now'))
    );
  `)
}

/**
 * Ambil version schema terakhir yang teraplikasi.
 * Returns 0 kalo belum ada migration sama sekali.
 */
function getSchemaVersion() {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_version').get()
    return row?.version || 0
  } catch {
    // Tabel schema_version mungkin belum ada — return 0
    return 0
  }
}

/**
 * Jalankan migration yang belum dijalanin, urut berdasarkan version.
 * Migration berisi perubahan schema SQL yang harus dijalanin sekali aja.
 *
 * Alasan pake system ini:
 * - Biar kita bisa nambah kolom / tabel baru tanpa khawatir break database existing
 * - Setiap migration cuma dijalanin sekali (tracked di schema_version)
 * - Kalo ada error di satu migration, kita bisa debug tanpa kehilangan data
 */
function runMigrations() {
  const currentVersion = getSchemaVersion()

  if (currentVersion >= SCHEMA_VERSION) {
    logger.debug(`Schema is up to date (v${SCHEMA_VERSION})`)
    return // Udah up to date — skip
  }

  logger.info(`Schema migration: current=${currentVersion}, target=${SCHEMA_VERSION}`)

  // Migration v1: initial schema — tabel udah dibuat sama createTables()
  // Tapi kita catet version-nya biar track record lengkap
  if (currentVersion < 1) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(1)
    logger.info('Migration v1: initial schema recorded')
  }

  // Migration v1 → v2: tambah kolom notes ke accounts
  // Pake PRAGMA table_info buat cek apakah kolom udah ada (safety check)
  if (currentVersion < 2) {
    try {
      const tableInfo = db.prepare("PRAGMA table_info('accounts')").all()
      const hasNotes = tableInfo.some(col => col.name === 'notes')
      if (!hasNotes) {
        db.exec('ALTER TABLE accounts ADD COLUMN notes TEXT DEFAULT NULL')
        logger.info('Migration v2: added notes column to accounts')
      } else {
        logger.info('Migration v2: notes column already exists, skipping ALTER TABLE')
      }
    } catch (err) {
      // Kalau error karena column udah ada (race condition), skip aja
      if (!err.message.includes('duplicate column')) {
        logger.warn(`Migration v2 ALTER TABLE error (non-critical): ${err.message}`)
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(2)
    logger.info('Migration v2: schema version recorded')
  }

  // Migration v2 → v3: tambah kolom phone ke accounts
  // Phone number disimpan otomatis pas account pertama kali connected
  // Biar gak ada duplikat registrasi nomor yang sama
  if (currentVersion < 3) {
    try {
      const tableInfo = db.prepare("PRAGMA table_info('accounts')").all()
      const hasPhone = tableInfo.some(col => col.name === 'phone')
      if (!hasPhone) {
        db.exec('ALTER TABLE accounts ADD COLUMN phone TEXT DEFAULT NULL')
        logger.info('Migration v3: added phone column to accounts')
      } else {
        logger.info('Migration v3: phone column already exists, skipping ALTER TABLE')
      }
    } catch (err) {
      if (!err.message.includes('duplicate column')) {
        logger.warn(`Migration v3 ALTER TABLE error (non-critical): ${err.message}`)
      }
    }
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(3)
    logger.info('Migration v3: schema version recorded')
  }

  // Migration v3 → v4: tabel quick_qr_sessions
  if (currentVersion < 4) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS quick_qr_sessions (
        temp_id     TEXT PRIMARY KEY,
        account_id  TEXT NOT NULL,
        status      TEXT DEFAULT 'waiting',
        result      TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `)
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(4)
    logger.info('Migration v4: created quick_qr_sessions table')
  }

  logger.info(`Schema migration complete: v${SCHEMA_VERSION}`)
}

/**
 * Migrasi dari JSON file lama (accounts.json) ke SQLite.
 * - Baca file JSON
 * - Insert ke tabel yang sesuai
 * - Rename file JSON jadi .migrated biar gak di-proses ulang
 * - Semua dalam 1 transaction biar atomic
 */
function migrateFromJson() {
  const jsonPath = DB_PATH.replace('.db', '.json')
  if (!existsSync(jsonPath)) return

  const count = db.prepare('SELECT COUNT(*) as c FROM accounts').get()
  if (count.c > 0) {
    logger.info('Database already has data, skipping JSON migration')
    return
  }

  try {
    const raw = readFileSync(jsonPath, 'utf-8')
    const accounts = JSON.parse(raw)
    if (!Array.isArray(accounts) || accounts.length === 0) return

    const insertAccount = db.prepare(`
      INSERT OR IGNORE INTO accounts (id, label, web_version, api_key, created_at, updated_at)
      VALUES (@id, @label, @webVersion, @apiKey, @createdAt, @createdAt)
    `)
    const insertWebhook = db.prepare(`
      INSERT OR IGNORE INTO webhooks (id, account_id, url, headers, timeout, enabled)
      VALUES (@id, @accountId, @url, @headers, @timeout, @enabled)
    `)
    const insertAutoReply = db.prepare(`
      INSERT OR IGNORE INTO auto_replies (id, account_id, keyword, reply, match_type, enabled, cooldown)
      VALUES (@id, @accountId, @keyword, @reply, @matchType, @enabled, @cooldown)
    `)

    // Transaction: kalau error di tengah, rollback semua
    const migrate = db.transaction(() => {
      for (const acc of accounts) {
        insertAccount.run({
          id: acc.id,
          label: acc.label || 'Unnamed',
          webVersion: acc.webVersion || null,
          apiKey: acc.apiKey || null,
          createdAt: acc.createdAt || new Date().toISOString(),
        })

        if (Array.isArray(acc.webhooks)) {
          for (const wh of acc.webhooks) {
            insertWebhook.run({
              id: wh.id || randomUUID(),
              accountId: acc.id,
              url: wh.url || '',
              headers: wh.headers ? JSON.stringify(wh.headers) : null,
              timeout: wh.timeout || 10000,
              enabled: wh.enabled !== false ? 1 : 0,
            })
          }
        }

        if (Array.isArray(acc.autoReplies)) {
          for (const ar of acc.autoReplies) {
            insertAutoReply.run({
              id: ar.id || randomUUID(),
              accountId: acc.id,
              keyword: ar.keyword || '',
              reply: ar.reply || '',
              matchType: ar.matchType || 'contains',
              enabled: ar.enabled !== false ? 1 : 0,
              cooldown: ar.cooldown || 30,
            })
          }
        }
      }
    })

    migrate()
    logger.info(`Migrated ${accounts.length} accounts from ${jsonPath}`)

    // Backup JSON biar gak di-proses ulang
    const backupPath = jsonPath + '.migrated'
    renameSync(jsonPath, backupPath)
    logger.info(`JSON file backed up to ${backupPath}`)
  } catch (err) {
    logger.error(`Migration failed: ${err.message}`)
  }
}

/**
 * Backup database SQLite ke folder data/backups/.
 * - Format nama: waun-YYYY-MM-DD-HH-mm-ss.db
 * - Keep 7 backup terakhir aja (hapus yang lama otomatis)
 * - Pake better-sqlite3 backup API yang atomic & consistent
 *
 * Alasan pake better-sqlite3 backup API (bukan copy file):
 * - SQLite backup API menjamin konsistensi walau ada write concurrent
 * - Gak perlu locking / VACUUM manual
 * - File hasil backup langsung usable tanpa WAL recovery
 */
export async function backupDatabase() {
  if (!db) {
    logger.warn('Backup skipped: database not initialized')
    return null
  }

  // Pastikan folder backup ada
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true })
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `waun-${timestamp}.db`
  const backupPath = `${BACKUP_DIR}/${filename}`

  try {
    // better-sqlite3 backup API — async, atomic, consistent
    await db.backup(backupPath)

    // Bersihin backup lama — keep 7 terbaru doang
    cleanupOldBackups()

    logger.info(`Database backed up: ${filename}`)
    return backupPath
  } catch (err) {
    logger.error(`Database backup failed: ${err.message}`)
    return null
  }
}

/**
 * Hapus backup lama, keep N backup terbaru.
 * Biar storage gak penuh — kita cuma perlu beberapa backup terakhir.
 */
function cleanupOldBackups() {
  let files
  try {
    // Baca semua file backup di directory, urut dari newest ke oldest
    files = readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('waun-') && f.endsWith('.db'))
      .map(f => ({
        name: f,
        path: `${BACKUP_DIR}/${f}`,
        mtime: statSync(`${BACKUP_DIR}/${f}`).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime) // Descending: newest dulu
  } catch {
    // Directory mungkin belum ada (pas pertama kali jalan)
    return
  }

  const KEEP = 7
  if (files.length <= KEEP) return // Masih dikit, gak perlu cleanup

  // Hapus yang lebih dari KEEP terbaru
  const toDelete = files.slice(KEEP)
  for (const f of toDelete) {
    try {
      unlinkSync(f.path)
      logger.info(`Deleted old backup: ${f.name}`)
    } catch (err) {
      logger.warn(`Failed to delete old backup ${f.name}: ${err.message}`)
    }
  }
}

export function closeDatabase() {
  if (db) {
    db.close()
    db = null
    logger.info('Database connection closed')
  }
}

export function getDatabase() {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.')
  return db
}
