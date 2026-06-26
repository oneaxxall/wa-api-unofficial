// entry point — Fastify server + route registration + graceful shutdown
import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import multipart from '@fastify/multipart'
import { setTimeout as sleep } from 'node:timers/promises'
import logger from './utils/logger.js'
import { initDatabase, closeDatabase, backupDatabase } from './db.js'
import { AccountManager } from './account-manager.js'
import { BroadcastEngine } from './broadcast.js'
import { Metrics } from './metrics.js'
import accountRoutes from './routes/accounts.js'
import messageRoutes from './routes/messages.js'
import broadcastRoutes from './routes/broadcasts.js'
import webhookRoutes from './routes/webhooks.js'
import autoReplyRoutes from './routes/auto-replies.js'
import webhookTesterRoutes from './routes/webhook-tester.js'
import quickQRRoutes from './routes/quick-qr.js'
import { closeQueues } from './queue.js'

const PORT = parseInt(process.env.PORT || '3008')
const HOST = process.env.HOST || '0.0.0.0'

// Init database dulu sebelum apa-apa
initDatabase()

const am = new AccountManager()
await am.init()

const be = new BroadcastEngine(am)
be.loadFromDb()
await be.initQueueWorker() // Init BullMQ worker untuk broadcast (optional)
await am.initSendQueueWorker() // Init BullMQ worker untuk send message (optional)

// ================================================================
// Metrics instance — track operasional metrics tanpa Prometheus library
// Dipass ke semua module via app.decorate() biar gak perlu singleton
// ================================================================
const metrics = new Metrics()

// ================================================================
// Fastify dengan logger Pino — support LOG_FORMAT=pretty|json
// - DEBUG=1 override log level ke debug untuk semua komponen
// - pretty: pino-pretty transport (development, human-readable)
// - json: output JSON ke stdout (production, buat log aggregation)
// - Redact req.body biar isi pesan gak tampil di log (privacy)
// ================================================================
const isDebug = process.env.DEBUG === '1' || process.env.DEBUG === 'true'
const logLevel = isDebug ? 'debug' : (process.env.LOG_LEVEL || 'info')

const app = Fastify({
  logger: {
    level: logLevel,
    ...(process.env.LOG_FORMAT !== 'json' && {
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss' },
      },
    }),
  },
})
await app.register(cors, { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : false })

// Multipart support untuk upload file di /send/media
await app.register(multipart, {
  limits: {
    fileSize: 100 * 1024 * 1024, // Max 100MB per file
    files: 1,
  },
})

// Rate limit global: 300 req/min sebagai safety net maksimal.
// Route-specific limits (lebih strict) di-set di definisi route masing-masing.
await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })

// Decorate metrics instance — bisa diakses via app.metrics di route handler
app.decorate('metrics', metrics)

// Pass metrics ke AccountManager & BroadcastEngine biar bisa inc counter
am.setMetrics(metrics)
be.setMetrics(metrics)

// ============================================================
// Swagger / OpenAPI documentation
// - /api/docs-json  →  JSON spec (OpenAPI 3.0)
// - /api/docs       →  Swagger UI (interactive documentation)
// - /api/docs yg baru   →  Ganti default /docs biar gak tabrakan
// ============================================================
await app.register(swagger, {
  openapi: {
    info: {
      title: 'WAUN API',
      description: 'WhatsApp Unofficial Gateway — Multi-Account WhatsApp API dengan broadcast, webhook, auto-reply, dan anti-ban engine.\n\nManaged by **oneaxxall**.',
      version: '2.0.0',
    },
    servers: [{ url: `http://localhost:${PORT}`, description: 'Development server' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'UUID',
          description: 'API key dari account. Header: Authorization: Bearer <apiKey>',
        },
      },
      schemas: {
        UnauthorizedError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['UNAUTHORIZED'] },
                message: { type: 'string' },
              },
            },
          },
        },
        ForbiddenError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['FORBIDDEN'] },
                message: { type: 'string' },
              },
            },
          },
        },
        NotFoundError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['NOT_FOUND'] },
                message: { type: 'string' },
              },
            },
          },
        },
        BadRequestError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['BAD_REQUEST', 'VALIDATION_ERROR'] },
                message: { type: 'string' },
              },
            },
          },
        },
        InternalError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['INTERNAL_ERROR'] },
                message: { type: 'string' },
              },
            },
          },
        },
        ServiceUnavailableError: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: {
                code: { type: 'string', enum: ['SERVICE_UNAVAILABLE'] },
                message: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
    },
    // Semua endpoint kecuali /health pakai bearer auth
    security: [{ bearerAuth: [] }],
  },
})

await app.register(swaggerUi, {
  routePrefix: '/api/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
    defaultModelsExpandDepth: 3,
  },
})

// Alias: /api/docs-json → serve OpenAPI spec JSON
// Biar konsisten dengan request user: /api/docs (UI) dan /api/docs-json (JSON)
app.get('/api/docs-json', async (req, reply) => {
  return app.swagger()
})

// ============================================================
// Middleware autentikasi — cek Bearer token di header Authorization
// - Route /health: public (gak perlu token)
// - Route lain: wajib header "Authorization: Bearer <apiKey>"
// - apiKey dicocokin ke semua account yang terdaftar
// - Kalau cocok, set request.accountId biar bisa dipake route handler
// ============================================================
// ============================================================
// Auth middleware — cek Bearer token + IP whitelist (opsional)
// - Route /health, POST /accounts, /api/docs, /ws: public
// - Route lain: wajib header "Authorization: Bearer <apiKey>"
// - IP_WHITELIST: kalo di-set, cuma IP tersebut yang bisa akses
// ============================================================

// Parse IP whitelist dari env — format: 192.168.1.1,10.0.0.0/24
const IP_WHITELIST = parseIpWhitelist(process.env.IP_WHITELIST || '')

function parseIpWhitelist(str) {
  if (!str || !str.trim()) return []
  return str.split(',').map(s => s.trim()).filter(Boolean)
}

function ipToInt(ip) {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  return ((parseInt(parts[0]) << 24) | (parseInt(parts[1]) << 16) |
          (parseInt(parts[2]) << 8) | parseInt(parts[3])) >>> 0
}

function matchCidr(ip, cidr) {
  const [rangeIp, bits] = cidr.split('/')
  const ipInt = ipToInt(ip)
  const rangeInt = ipToInt(rangeIp)
  if (ipInt === null || rangeInt === null) return false
  if (!bits) return ipInt === rangeInt
  const mask = ~(2 ** (32 - parseInt(bits)) - 1) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

function isIpAllowed(ip) {
  if (IP_WHITELIST.length === 0) return true // Whitelist kosong = allow all
  return IP_WHITELIST.some(entry => matchCidr(ip, entry))
}

app.addHook('preHandler', async function authMiddleware(req, reply) {
  // Public endpoints
  if (req.url === '/health') return
  if (req.url === '/accounts' && req.method === 'POST') return
  if (req.url.startsWith('/webhook-test')) return
  if (req.url.startsWith('/accounts/qr')) return
  if (req.url.startsWith('/api/docs')) return
  if (req.url.startsWith('/documentation')) return
  if (req.url.startsWith('/ws')) return

  // IP Whitelist check — kalo di-set, IP lain ditolak
  if (IP_WHITELIST.length > 0) {
    const clientIp = req.ip || req.connection?.remoteAddress || ''
    if (!isIpAllowed(clientIp)) {
      logger.warn(`Blocked request from ${clientIp} (not in whitelist)`)
      return reply.status(403).send({
        error: { code: 'FORBIDDEN', message: 'Access denied — IP not in whitelist' },
      })
    }
  }

  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Missing or invalid Authorization header. Gunakan format: Bearer <api-key>' },
    })
  }

  // Ambil token setelah "Bearer "
  const key = authHeader.slice(7)

  // Cek apakah ini admin key — master key yang bisa akses SEMUA endpoint
  const ADMIN_KEY = process.env.API_SECRET_KEY_ADMIN || ''
  if (ADMIN_KEY && key === ADMIN_KEY) {
    req.accountId = 'admin'
    return // Admin — akses penuh
  }

  // Cari account yang punya API key ini
  for (const [id, account] of am.accounts) {
    if (account.apiKey === key) {
      req.accountId = id // Set buat route handler kalo perlu
      return // Lanjut ke handler — auth success
    }
  }

  // API key gak cocok dengan account manapun
  return reply.status(403).send({
    error: { code: 'FORBIDDEN', message: 'Invalid API key' },
  })
})

// Periodic anti-ban persist — tiap 5 menit biar data gak ilang kalau crash
setInterval(() => {
  am.persistAllAntiBan()
}, 5 * 60 * 1000)

// Periodic database backup — tiap 30 menit (bisa di-set via env DB_BACKUP_INTERVAL)
// Backup disimpan di data/backups/, otomatis keep 7 backup terakhir
const BACKUP_INTERVAL = parseInt(process.env.DB_BACKUP_INTERVAL || String(30 * 60 * 1000))
setInterval(() => {
  backupDatabase()
}, BACKUP_INTERVAL)

app.get('/health', {
  config: { rateLimit: false },
  schema: {
    description: 'Cek status server, jumlah account, dan state anti-ban. Public endpoint — gak perlu auth.',
    tags: ['System'],
    response: {
      200: {
        type: 'object',
        properties: {
          status: { type: 'string' },
          uptime: { type: 'number' },
          accounts: { type: 'integer' },
          details: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                ready: { type: 'boolean' },
                authenticated: { type: 'boolean' },
                hasQR: { type: 'boolean' },
                antiBan: {
                  type: 'object',
                  properties: {
                    dailySent: { type: 'integer' },
                    dailyLimit: { type: 'integer' },
                    warmupLimit: { type: 'integer' },
                    warmupDay: { type: 'integer' },
                    warmupComplete: { type: 'boolean' },
                    warmupDays: { type: 'integer' },
                    resetHour: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
}, async () => {
  const accounts = am.listAccounts()
  return {
    status: 'ok',
    uptime: process.uptime(),
    accounts: accounts.length,
    details: accounts.map(a => ({
      id: a.id,
      label: a.label,
      ready: a.status?.ready || false,
      authenticated: a.status?.authenticated || false,
      hasQR: a.status?.hasQR || false,
      antiBan: a.status?.antiBan || {},
    })),
  }
})

// GET /metrics — Prometheus metrics endpoint (public, gak perlu auth)
// Format: Prometheus plain text, bisa di-scrape langsung oleh Prometheus
app.get('/metrics', {
  config: { rateLimit: false },
  schema: {
    description: 'Prometheus metrics endpoint. Public — gak perlu auth.',
    tags: ['System'],
  },
}, async (req, reply) => {
  // Set metric dinamis sebelum render:
  // - Hitung accounts_total dan accounts_ready dari state terkini
  // - Hitung broadcasts_active dari broadcast engine
  const accounts = am.listAccounts()
  metrics.set('accounts_total', accounts.length)
  metrics.set('accounts_ready', accounts.filter(a => a.status?.ready).length)
  metrics.set('broadcasts_active', be.getActiveCount())

  reply.header('Content-Type', 'text/plain; charset=utf-8')
  return metrics.render()
})

// ============================================================
// Daftarkan shared schemas buat Fastify serialization ($ref di response)
// Ini beda sama components.schemas di OpenAPI — ini buat Fastify internal
// ============================================================
app.addSchema({
  $id: 'UnauthorizedError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
})
app.addSchema({
  $id: 'ForbiddenError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
})
app.addSchema({
  $id: 'NotFoundError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
})
app.addSchema({
  $id: 'BadRequestError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
})
app.addSchema({
  $id: 'InternalError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' } },
    },
  },
})
app.addSchema({
  $id: 'ServiceUnavailableError',
  type: 'object',
  properties: {
    error: {
      type: 'object',
      properties: { code: { type: 'string' }, message: { type: 'string' }, detail: { type: 'string' } },
    },
  },
})

accountRoutes(app, am)
messageRoutes(app, am)
broadcastRoutes(app, am, be)
webhookRoutes(app, am)
autoReplyRoutes(app, am)
webhookTesterRoutes(app)
quickQRRoutes(app, am)

// ================================================================
// WebSocket endpoint untuk broadcast progress real-time
// - /ws/broadcast/:id → subscribe progress broadcast tertentu
// - Skip auth middleware (public endpoint — auth via broadcast ID)
// ================================================================
const { setupWebSocket } = await import('./ws.js')
setupWebSocket(app, be)

try {
  await app.listen({ port: PORT, host: HOST })
  logger.info(`WAUN server running on http://${HOST}:${PORT}`)
} catch (err) {
  logger.error(err)
  process.exit(1)
}

/**
 * Graceful shutdown: drain broadcast dulu, persist data, baru destroy clients + DB.
 *
 * Alasan urutan ini:
 * 1. Broadcast drain dulu — biar broadcast gak kepotong di tengah jalan
 * 2. Anti-ban persist — biar daily counter gak ilang
 * 3. Destroy clients — biar Chrome process gak orphan
 * 4. Tutup DB & HTTP server — cleanup final
 */
async function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully...`)

  // Hitung total timeout dari env (default 40 detik — lebih panjang karena broadcast drain)
  const SHUTDOWN_TIMEOUT = parseInt(process.env.SHUTDOWN_TIMEOUT || '40000')

  // Force exit kalau proses kelamaan — biar gak ada orphan Chrome process
  const forceExit = setTimeout(() => {
    logger.warn('Shutdown timeout — force exit')
    process.exit(1)
  }, SHUTDOWN_TIMEOUT)
  forceExit.unref()

  try {
    // ================================================================
    // Step 1: Broadcast drain — cek apakah ada broadcast aktif
    // ================================================================
    const activeCount = be.getActiveCount()
    if (activeCount > 0) {
      logger.warn(`Menunggu ${activeCount} broadcast selesai sebelum shutdown...`)
      const BROADCAST_TIMEOUT = parseInt(process.env.SHUTDOWN_BROADCAST_TIMEOUT || '30000')
      await waitForBroadcasts(be, BROADCAST_TIMEOUT)
    }

    // ================================================================
    // Step 2: Persist anti-ban state sebelum exit
    // ================================================================
    am.persistAllAntiBan()

    // ================================================================
    // Step 3: Destroy semua WhatsApp clients (biar gak ada orphan Chrome)
    // ================================================================
    await am.destroy()

    // ================================================================
    // Step 4: Tutup koneksi database
    // ================================================================
    closeDatabase()

    // ================================================================
    // Step 5: Tutup BullMQ queue & worker (kalo ada)
    // ================================================================
    await closeQueues()

    // ================================================================
    // Step 6: Tutup HTTP server
    // ================================================================
    await app.close()

    clearTimeout(forceExit)
    logger.info('Shutdown complete')
    process.exit(0)
  } catch (err) {
    logger.error(`Shutdown error — ${err.message}`)
    process.exit(1)
  }
}

/**
 * Tunggu broadcast aktif selesai, dengan timeout configurable.
 * - Polling tiap 1 detik cek getActiveCount()
 * - Kalau timeout → panggil drainAll() untuk pause broadcast yang tersisa
 * - Broadcast yang di-pause bisa di-resume setelah restart
 */
async function waitForBroadcasts(be, timeout) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (be.getActiveCount() === 0) {
      logger.info('Semua broadcast selesai — melanjutkan shutdown')
      return
    }
    await sleep(1000)
  }
  // Timeout — pause broadcast yang masih jalan
  const remaining = be.getActiveCount()
  if (remaining > 0) {
    logger.warn(`Broadcast drain timeout (${timeout}ms) — pausing ${remaining} broadcast(s)`)
    be.drainAll()
  }
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
