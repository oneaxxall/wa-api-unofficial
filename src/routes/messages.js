// routes/messages.js — endpoint kirim pesan teks & media
import { writeFile, unlink } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, extname } from 'node:path'
import { createQueue, enqueueJob, isQueueEnabled } from '../queue.js'

const TEMP_DIR = './storage/temp'

// Pastikan folder temp ada
if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true })

// Deteksi tipe media dari extension file — biar user gak perlu kirim mediaType manual
function detectMediaType(filename) {
  if (!filename) return 'document'
  const ext = extname(filename).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext)) return 'image'
  if (['.mp4', '.avi', '.mkv', '.mov', '.webm', '.mpeg'].includes(ext)) return 'video'
  if (['.mp3', '.ogg', '.wav', '.aac', '.m4a', '.flac'].includes(ext)) return 'audio'
  return 'document'
}

export default function messageRoutes(app, am) {

  // POST /send — kirim pesan teks
  app.post('/send', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      description: 'Kirim pesan teks WhatsApp ke nomor tujuan. Anti-ban delay dan typing simulation otomatis.',
      tags: ['Messages'],
      body: {
        type: 'object',
        required: ['accountId', 'to', 'message'],
        properties: {
          accountId: { type: 'string' },
          to: { type: 'string' },
          message: { type: 'string' },
          options: {
            type: 'object',
            properties: {
              simulateTyping: { type: 'boolean' },
              skipAntiBan: { type: 'boolean' },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['sent'] },
                id: { type: 'string' },
              },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
        500: { $ref: 'InternalError' },
      },
    },
  }, async (req, reply) => {
    const { accountId, to, message, options } = req.body
    if (!accountId || !to || !message) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'accountId, to, message required' } })
    }
    try {
      // QUEUE_ENABLED=true → enqueue ke Redis, response cepet (accepted)
      // WEBHOOK message.ack bakal ngasih tau status pengiriman nantinya
      if (isQueueEnabled()) {
        const job = await am.sendViaQueue(accountId, to, message, options)
        if (job) {
          return { data: { status: 'accepted', jobId: job.id, id: `queued-${job.id}` } }
        }
        // Queue gagal (Redis down?) — fallback ke direct send
      }
      const result = await am.sendMessage(accountId, to, message, options)
      return { data: { status: 'sent', id: result.id } }
    } catch (err) {
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: err.message } })
    }
  })

  // POST /send/media — kirim media, support 3 cara:
  //   1. JSON: { mediaUrl: "https://..." }
  //   2. JSON: { mediaPath: "/path/to/file" }
  //   3. Multipart: upload file langsung via form-data
  app.post('/send/media', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const contentType = req.headers['content-type'] || ''

    // ================================================================
    // Multipart upload — file dikirim langsung via form-data
    // ================================================================
    if (contentType.includes('multipart/form-data')) {
      try {
        const data = await req.file()
        if (!data) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'No file uploaded' } })
        }

        const fields = data.fields || {}
        const accountId = fields.accountId?.value || ''
        const to = fields.to?.value || ''
        const caption = fields.caption?.value || ''
        const filename = fields.filename?.value || data.filename
        // mediaType opsional — auto-detect dari extension file kalau gak dikasih
        const mediaType = fields.mediaType?.value || detectMediaType(filename)
        let options = {}
        try { options = fields.options?.value ? JSON.parse(fields.options.value) : {} } catch {}

        if (!accountId || !to) {
          return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'accountId and to required' } })
        }

        // Simpan file upload ke temp direktori
        const ext = filename?.split('.').pop() || 'file'
        const tempFile = join(TEMP_DIR, `${randomUUID()}.${ext}`)
        const buffer = await data.toBuffer()
        await writeFile(tempFile, buffer)

        try {
          const result = await am.sendMedia(accountId, to, {
            mediaType, mediaPath: tempFile, caption, filename: filename || undefined,
          }, options)
          return { data: { status: 'sent', id: result.id } }
        } finally {
          // Hapus file temp setelah dikirim
          unlink(tempFile).catch(() => {})
        }
      } catch (err) {
        return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: err.message } })
      }
    }

    // ================================================================
    // JSON — mediaUrl atau mediaPath
    // ================================================================
    const { accountId, to, mediaType: rawMediaType, mediaUrl, mediaPath, caption, filename, options } = req.body
    if (!accountId || !to) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'accountId and to required' } })
    }
    if (!mediaUrl && !mediaPath) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: 'Salah satu dari mediaUrl, mediaPath, atau upload file wajib diisi' },
      })
    }
    // Auto-detect mediaType dari filename atau URL kalau gak dikasih
    const mediaType = rawMediaType || detectMediaType(filename || mediaUrl || mediaPath)
    try {
      const result = await am.sendMedia(accountId, to, { mediaType, mediaUrl, mediaPath, caption, filename }, options)
      return { data: { status: 'sent', id: result.id } }
    } catch (err) {
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: err.message } })
    }
  })

  // GET /queue/jobs/:jobId — cek status job yang di-enqueue via Redis
  app.get('/queue/jobs/:jobId', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      description: 'Cek status pengiriman yang di-proses via BullMQ queue. cocokin messageId dengan webhook message.ack.',
      tags: ['Queue'],
      params: {
        type: 'object',
        properties: { jobId: { type: 'string', description: 'Job ID dari response POST /send (saat queue aktif)' } },
        required: ['jobId'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                jobId: { type: 'string' },
                accountId: { type: 'string' },
                to: { type: 'string' },
                message: { type: 'string' },
                status: { type: 'string', enum: ['queued', 'sent', 'failed'] },
                messageId: { type: 'string' },
                error: { type: 'string' },
                timestamp: { type: 'string' },
                completedAt: { type: 'string' },
              },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const status = am.getJobStatus(req.params.jobId)
    if (!status) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Job not found' } })
    }
    return { data: status }
  })
}
