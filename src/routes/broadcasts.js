/**
 * Pagination helper — potong array sesuai page & limit, return pagination metadata.
 * Duplikasi dari routes/accounts.js biar self-contained (gak perlu shared import).
 */
function paginate(list, query) {
  const page = Math.max(1, parseInt(query.page) || 1)
  const limit = Math.min(100, Math.max(1, parseInt(query.limit) || 20))
  const total = list.length
  const totalPages = Math.ceil(total / limit)
  const start = (page - 1) * limit
  const data = list.slice(start, start + limit)
  return { data, pagination: { page, limit, total, totalPages } }
}

export default function broadcastRoutes(app, am, be) {

  // POST /broadcast — mulai broadcast baru
  app.post('/broadcast', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      description: 'Mulai broadcast (kirim pesan massal) ke banyak kontak. Maksimum 10.000 kontak per broadcast (configurable via BROADCAST_MAX_CONTACTS).',
      tags: ['Broadcasts'],
      body: {
        type: 'object',
        required: ['accountId', 'message', 'contacts'],
        properties: {
          accountId: { type: 'string', description: 'Account UUID pengirim' },
          name: { type: 'string', description: 'Nama broadcast (untuk identifikasi)' },
          message: { type: 'string', description: 'Teks pesan. Support template: {{name}}, {{phone}}' },
          contacts: {
            type: 'array',
            description: 'Daftar kontak tujuan (max 10.000)',
            items: {
              type: 'object',
              required: ['phone'],
              properties: {
                phone: { type: 'string', description: 'Nomor telepon (628xxx)' },
                name: { type: 'string', description: 'Nama kontak (buat template {{name}})' },
                chatId: { type: 'string', description: 'Override chat ID (format: 628xxx@c.us)' },
              },
            },
          },
          options: {
            type: 'object',
            properties: {
              batchSize: { type: 'integer', description: 'Jumlah kontak per batch (default: 10)' },
              batchDelay: { type: 'integer', description: 'Delay antar batch dalam ms (default: 60000)' },
              shuffle: { type: 'boolean', description: 'Acak urutan kontak (default: true)' },
              simulateTyping: { type: 'boolean', description: 'Simulasi typing delay (default: true)' },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['accepted'] },
                broadcastId: { type: 'string', description: 'UUID broadcast — dipakai buat track progress' },
              },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
      },
    },
  }, async (req, reply) => {
    const { accountId, name, message, contacts, options } = req.body
    if (!accountId || !message || !contacts?.length) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'accountId, message, contacts required' } })
    }
    try {
      const id = await be.start(accountId, { name, message, contacts, options })
      return { data: { status: 'accepted', broadcastId: id } }
    } catch (err) {
      // Bedakan antara validation error (400) vs internal error (500)
      if (err.message.includes('melebihi batas') || err.message.includes('tidak boleh kosong')) {
        return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message, limit: be.getMaxContacts() } })
      }
      return reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: err.message } })
    }
  })

  // GET /broadcasts — list semua broadcast dengan pagination
  app.get('/broadcasts', {
    config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    schema: {
      description: 'Ambil daftar semua broadcast (termasuk yang sedang berjalan). Support pagination dengan query params page & limit.',
      tags: ['Broadcasts'],
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', default: 1, minimum: 1, description: 'Halaman (default: 1)' },
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: 'Item per halaman (default: 20, max: 100)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  accountId: { type: 'string' },
                  name: { type: 'string' },
                  message: { type: 'string' },
                  total: { type: 'integer' },
                  sent: { type: 'integer' },
                  failed: { type: 'integer' },
                  status: { type: 'string', enum: ['pending', 'running', 'paused', 'completed', 'cancelled', 'failed'] },
                  createdAt: { type: 'string' },
                  startedAt: { type: 'string', nullable: true },
                  completedAt: { type: 'string', nullable: true },
                },
              },
            },
            pagination: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                limit: { type: 'integer' },
                total: { type: 'integer' },
                totalPages: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (req) => paginate(be.list(), req.query))

  // GET /broadcast/:id — detail satu broadcast
  app.get('/broadcast/:id', {
    config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    schema: {
      description: 'Ambil detail broadcast termasuk progress (sent, failed, errors).',
      tags: ['Broadcasts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Broadcast UUID' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                accountId: { type: 'string' },
                name: { type: 'string' },
                message: { type: 'string' },
                total: { type: 'integer' },
                sent: { type: 'integer' },
                failed: { type: 'integer' },
                status: { type: 'string' },
                createdAt: { type: 'string' },
                startedAt: { type: 'string', nullable: true },
                completedAt: { type: 'string', nullable: true },
                errors: { type: 'array' },
              },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const b = be.get(req.params.id)
    if (!b) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Broadcast not found' } })
    return { data: b }
  })

  // POST /broadcast/:id/cancel — batalkan broadcast
  app.post('/broadcast/:id/cancel', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      description: 'Batalkan broadcast yang sedang berjalan atau di-pause.',
      tags: ['Broadcasts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Broadcast UUID' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['cancelled'] } },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    if (!be.cancel(req.params.id)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found or cannot cancel' } })
    }
    return { data: { status: 'cancelled' } }
  })

  // POST /broadcast/:id/resume — lanjutkan broadcast yang di-pause
  app.post('/broadcast/:id/resume', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      description: 'Lanjutkan broadcast yang ter-pause (misal karena daily limit).',
      tags: ['Broadcasts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Broadcast UUID' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['resumed'] } },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
      },
    },
  }, async (req, reply) => {
    if (!be.resume(req.params.id)) {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'Not found or not paused' } })
    }
    return { data: { status: 'resumed' } }
  })
}
