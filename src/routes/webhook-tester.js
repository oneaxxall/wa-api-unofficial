// routes/webhook-tester.js — endpoint buat nangkep webhook buat testing
import { appendFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR = './logs'

export default function webhookTesterRoutes(app) {

  // POST /webhook-test — terima payload webhook, simpan ke file
  // Endpoint ini PUBLIC (tanpa auth) — khusus buat testing/demo
  app.post('/webhook-test', async (req, reply) => {
    const payload = req.body
    const timestamp = new Date().toISOString()
    const date = timestamp.slice(0, 10) // YYYY-MM-DD
    const logFile = join(LOG_DIR, `webhooks-${date}.json`)

    // Pastikan folder logs ada
    if (!existsSync(LOG_DIR)) {
      await mkdir(LOG_DIR, { recursive: true })
    }

    // Format log: tiap baris = 1 entry JSON
    const entry = JSON.stringify({
      receivedAt: timestamp,
      headers: {
        contentType: req.headers['content-type'],
        userAgent: req.headers['user-agent'],
        host: req.headers['host'],
      },
      payload,
    })

    // Append ke file — tiap baris dipisah newline
    await appendFile(logFile, entry + '\n', 'utf-8')

    return { status: 'ok', message: `Logged to ${logFile}` }
  })

  // GET /webhook-test — lihat isi file log
  app.get('/webhook-test', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const date = req.query.date || new Date().toISOString().slice(0, 10)
    const logFile = join(LOG_DIR, `webhooks-${date}.json`)

    if (!existsSync(logFile)) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `No webhooks logged for ${date}` },
      })
    }

    const { readFile } = await import('node:fs/promises')
    const content = await readFile(logFile, 'utf-8')
    const lines = content.trim().split('\n').map(line => JSON.parse(line))

    return { data: lines }
  })
}
