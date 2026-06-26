// quick-qr.js — Quick QR Pairing dengan DB persistence
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import logger from '../utils/logger.js'
import { getDatabase } from '../db.js'

const QR_TTL = parseInt(process.env.QR_TEMP_TTL || '120000')
const CLEANUP_INTERVAL = 30000
const LOG_DIR = './logs'
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true })

function qrLog(entry) {
  const date = new Date().toISOString().slice(0, 10)
  appendFileSync(join(LOG_DIR, `quick-qr-${date}.json`), JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n', 'utf-8')
}

// Simpan/update session ke database
function dbSaveSession(tempId, accountId, status, result = null) {
  try {
    const db = getDatabase()
    db.prepare(`
      INSERT INTO quick_qr_sessions (temp_id, account_id, status, result, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(temp_id) DO UPDATE SET
        status = excluded.status,
        result = COALESCE(excluded.result, quick_qr_sessions.result),
        updated_at = excluded.updated_at
    `).run(tempId, accountId, status, result ? JSON.stringify(result) : null)
  } catch {}
}

// Baca session dari database
function dbGetSession(tempId) {
  try {
    const db = getDatabase()
    return db.prepare('SELECT * FROM quick_qr_sessions WHERE temp_id = ?').get(tempId)
  } catch { return null }
}

export default function quickQRRoutes(app, am) {

  // Background cleanup — hapus temp account yg expired
  setInterval(() => {
    const now = Date.now()
    const maxAge = QR_TTL * 2

    for (const [tempId, session] of am._pendingQRSessions) {
      if (session.status === 'completed') continue
      if (now - session.createdAt > maxAge) {
        qrLog({ event: 'cleanup.expired', tempId, tempAccountId: session.tempAccountId })
        dbSaveSession(tempId, session.tempAccountId, 'expired')
        am.removeAccount(session.tempAccountId)
        am._pendingQRSessions.delete(tempId)
      }
    }

    // Cleanup orphaned __quickqr_* accounts
    try {
      const db = getDatabase()
      const orphans = db.prepare("SELECT id, label FROM accounts WHERE label LIKE '__quickqr_%'").all()
      for (const row of orphans) {
        const isPending = Array.from(am._pendingQRSessions.values()).some(s => s.tempAccountId === row.id)
        if (!isPending) {
          qrLog({ event: 'cleanup.orphaned', accountId: row.id, label: row.label })
          am.removeAccount(row.id)
        }
      }

      // Cleanup DB rows — hapus session ready/expired yg udah > 1 hari
      const deleted = db.prepare(`
        DELETE FROM quick_qr_sessions 
        WHERE status IN ('ready', 'expired') 
          AND datetime(updated_at) < datetime('now', '-1 day')
      `).run()
      if (deleted.changes > 0) {
        logger.info(`QuickQR cleanup: removed ${deleted.changes} old session rows from DB`)
      }
    } catch {}
  }, CLEANUP_INTERVAL)

  // POST /accounts/qr — generate QR
  app.post('/accounts/qr', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      description: 'Quick QR pairing — scan → auto link/create account.',
      tags: ['Accounts'],
      response: {
        200: { type: 'object', properties: { data: { type: 'object', properties: {
          tempId: { type: 'string' }, qr: { type: 'string' }, image: { type: 'string' }, expiresIn: { type: 'integer' },
        } } } },
        408: { $ref: 'BadRequestError' },
        500: { $ref: 'InternalError' },
      },
    },
  }, async (req, reply) => {
    const tempId = randomUUID().slice(0, 8)
    qrLog({ event: 'generate.start', tempId })

    const tempLabel = `__quickqr_${tempId}`
    const tempAccount = am.addAccount({ label: tempLabel })
    qrLog({ event: 'generate.account_created', tempId, tempAccountId: tempAccount.id })

    // Simpan ke DB sejak awal — status = waiting
    dbSaveSession(tempId, tempAccount.id, 'waiting')

    const client = am.getClient(tempAccount.id)
    if (!client || !client.wa) {
      qrLog({ event: 'generate.failed', tempId })
      am.removeAccount(tempAccount.id)
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create temp client' } })
    }

    let qrReceived = null
    try {
      qrReceived = await new Promise((resolve) => {
        client.wa.onQR((qr) => resolve(qr))
        setTimeout(() => resolve(null), QR_TTL)
      })
    } catch {}

    if (!qrReceived) {
      qrLog({ event: 'generate.qr_timeout', tempId })
      dbSaveSession(tempId, tempAccount.id, 'expired')
      am.removeAccount(tempAccount.id)
      return reply.status(408).send({ error: { code: 'TIMEOUT', message: `QR not generated within ${QR_TTL / 1000}s` } })
    }

    const { default: QRCode } = await import('qrcode')
    const image = await QRCode.toDataURL(qrReceived, { width: 400, margin: 2 })

    am._pendingQRSessions.set(tempId, {
      tempAccountId: tempAccount.id,
      tempLabel,
      createdAt: Date.now(),
      status: 'waiting',
    })

    qrLog({ event: 'generate.qr_ready', tempId, tempAccountId: tempAccount.id, expiresIn: QR_TTL })
    return { data: { tempId, qr: qrReceived, image, expiresIn: QR_TTL } }
  })

  // GET /accounts/qr/status/:tempId — cek status QR scan
  app.get('/accounts/qr/status/:tempId', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['Accounts'],
      params: { type: 'object', properties: { tempId: { type: 'string' } }, required: ['tempId'] },
      response: {
        200: { type: 'object', properties: { data: { type: 'object', properties: {
          status: { type: 'string', enum: ['waiting', 'ready', 'expired'] },
          accountId: { type: 'string' }, label: { type: 'string' }, apiKey: { type: 'string' }, message: { type: 'string' },
        } } } },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const tempId = req.params.tempId

    // 1. Cek DB DULU — kalo udah ready, return langsung tanpa proses
    const dbRow = dbGetSession(tempId)
    if (dbRow) {
      if (dbRow.status === 'ready' && dbRow.result) {
        qrLog({ event: 'status.db_ready', tempId })
        return { data: JSON.parse(dbRow.result) }
      }
      if (dbRow.status === 'expired') {
        qrLog({ event: 'status.db_expired', tempId })
        return { data: { status: 'expired', message: 'QR expired — generate ulang' } }
      }
    }

    // 2. Cek memory
    const session = am._pendingQRSessions.get(tempId)
    if (!session) {
      qrLog({ event: 'status.not_found', tempId })
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Sesi tidak ditemukan' } })
    }

    if (session.status === 'completed') {
      return { data: session.result }
    }

    const age = Date.now() - session.createdAt
    qrLog({ event: 'status.check', tempId, tempAccountId: session.tempAccountId, age })

    // 3. Cek auth — kalo connected, proses
    const client = am.getClient(session.tempAccountId)
    if (client?.wa?.authenticated) {
      const credsFile = join(process.env.SESSION_DIR || './sessions', session.tempAccountId, 'creds.json')

      let meId = '', pushName = ''
      if (existsSync(credsFile)) {
        try {
          const creds = JSON.parse(readFileSync(credsFile, 'utf-8'))
          meId = creds.me?.id || ''
          pushName = creds.me?.name || ''
          qrLog({ event: 'status.auth_creds_read', tempId, meId, pushName })
        } catch {}
      }

      if (meId) {
        const phone = meId.split('@')[0].split(':')[0]
        pushName = pushName || `User-${phone.slice(-6)}`
        qrLog({ event: 'status.processing', tempId, phone, pushName })

        const existing = am.findAccountByPhone(phone)
        if (existing && existing.id !== session.tempAccountId) {
          qrLog({ event: 'status.linking_existing', tempId, existingId: existing.id })
          am.removeAccount(session.tempAccountId)
          const result = { status: 'ready', accountId: existing.id, label: existing.label, apiKey: existing.apiKey, message: 'Linked to existing account' }
          dbSaveSession(tempId, existing.id, 'ready', result)
          session.status = 'completed'
          session.result = result
          return { data: result }
        }

        qrLog({ event: 'status.renaming', tempId, newLabel: pushName })
        const db = getDatabase()
        db.prepare('UPDATE accounts SET label = ? WHERE id = ?').run(pushName, session.tempAccountId)
        const acc = am.getAccount(session.tempAccountId)
        if (acc) acc.label = pushName

        const result = { status: 'ready', accountId: session.tempAccountId, label: pushName, apiKey: acc?.apiKey || '', message: 'New account created' }
        dbSaveSession(tempId, session.tempAccountId, 'ready', result)
        session.status = 'completed'
        session.result = result

        qrLog({ event: 'status.ready', tempId, accountId: session.tempAccountId, label: pushName })
        return { data: result }
      }
    }

    // 4. Cek expired
    if (age > QR_TTL * 2) {
      qrLog({ event: 'status.expired', tempId, age })
      dbSaveSession(tempId, session.tempAccountId, 'expired')
      am.removeAccount(session.tempAccountId)
      am._pendingQRSessions.delete(tempId)
      return { data: { status: 'expired', message: 'QR expired — generate ulang' } }
    }

    // 5. Masih nunggu
    qrLog({ event: 'status.waiting', tempId, age })
    return { data: { status: 'waiting', message: 'Scan QR with WhatsApp' } }
  })

  // GET /admin/qr-sessions — lihat semua QR sessions (admin only)
  app.get('/admin/qr-sessions', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      description: 'Lihat daftar QR sessions. Admin only — butuh API_SECRET_KEY_ADMIN.',
      tags: ['Admin'],
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tempId: { type: 'string' },
                  accountId: { type: 'string' },
                  status: { type: 'string' },
                  result: { type: 'object' },
                  createdAt: { type: 'string' },
                  updatedAt: { type: 'string' },
                },
              },
            },
          },
        },
        403: { $ref: 'ForbiddenError' },
      },
    },
  }, async (req, reply) => {
    if (req.accountId !== 'admin') {
      return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Admin only — gunakan API_SECRET_KEY_ADMIN' } })
    }

    const db = getDatabase()
    const rows = db.prepare('SELECT * FROM quick_qr_sessions ORDER BY updated_at DESC').all()

    return {
      data: rows.map(r => ({
        tempId: r.temp_id,
        accountId: r.account_id,
        status: r.status,
        result: r.result ? JSON.parse(r.result) : null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
    }
  })
}
