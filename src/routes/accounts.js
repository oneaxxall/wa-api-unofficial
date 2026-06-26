/**
 * Pagination helper — potong array sesuai page & limit, return pagination metadata.
 *
 * Alasan bikin helper sendiri (gak pake library):
 * - Cuma 10 baris — gak butuh dependency terpisah
 * - Pattern umum yang dipake di semua list endpoint
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

export default function accountRoutes(app, am) {

  // GET /accounts — list semua account dengan pagination, rate limit 200 req/min
  app.get('/accounts', {
    config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    schema: {
      description: 'Ambil daftar semua account WhatsApp beserta status dan anti-ban state. Support pagination dengan query params page & limit.',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
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
                  id: { type: 'string', description: 'UUID account' },
                  label: { type: 'string', description: 'Nama akun' },
                  apiKey: { type: 'string', description: 'API key (Bearer token)' },
                  webVersion: { type: 'string', nullable: true },
                  webhooks: { type: 'array' },
                  autoReplies: { type: 'array' },
                  createdAt: { type: 'string' },
                  status: {
                    type: 'object',
                    properties: {
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
                        },
                      },
                    },
                  },
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
        401: { $ref: 'UnauthorizedError' },
        403: { $ref: 'ForbiddenError' },
      },
    },
  }, async (req) => paginate(am.listAccounts(), req.query))

  // GET /accounts/:id — detail satu account, rate limit 200 req/min
  app.get('/accounts/:id', {
    config: { rateLimit: { max: 200, timeWindow: '1 minute' } },
    schema: {
      description: 'Ambil detail account berdasarkan ID, termasuk status koneksi WhatsApp.',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
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
                label: { type: 'string' },
                apiKey: { type: 'string' },
                webVersion: { type: 'string', nullable: true },
                webhooks: { type: 'array' },
                autoReplies: { type: 'array' },
                createdAt: { type: 'string' },
                status: {
                  type: 'object',
                  properties: {
                    ready: { type: 'boolean' },
                    authenticated: { type: 'boolean' },
                    hasQR: { type: 'boolean' },
                    antiBan: { type: 'object' },
                  },
                },
              },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const acc = am.getAccount(req.params.id)
    if (!acc) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } })
    return { data: { ...acc, status: am.getStatus(req.params.id) } }
  })

  // POST /accounts — buat account baru, rate limit 60 req/min
  app.post('/accounts', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      description: 'Buat account WhatsApp baru. Account akan otomatis generate API key.',
      tags: ['Accounts'],
      body: {
        type: 'object',
        required: ['label'],
        properties: {
          label: { type: 'string', description: 'Nama akun (wajib)', minLength: 1 },
          webVersion: { type: 'string', description: 'Override version WhatsApp Web (opsional)' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                label: { type: 'string' },
                apiKey: { type: 'string', description: 'Simpan key ini — dipakai buat auth ke endpoint lain' },
                webhooks: { type: 'array' },
                autoReplies: { type: 'array' },
                createdAt: { type: 'string' },
              },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
      },
    },
  }, async (req, reply) => {
    const { label } = req.body
    if (!label) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'label is required' } })
    const acc = am.addAccount({ label })
    return reply.status(201).send({ data: acc })
  })

  // DELETE /accounts/:id — hapus account
  app.delete('/accounts/:id', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      description: 'Hapus account WhatsApp. Cascade hapus webhooks, auto-replies, dan anti-ban state.',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { status: { type: 'string', enum: ['deleted'] } },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const found = am.removeAccount(req.params.id)
    if (!found) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } })
    return { data: { status: 'deleted' } }
  })

  // GET /accounts/:id/qr — ambil QR code buat auth WhatsApp
  // Default: return JSON { qr, image (data URI) }
  // ?format=image  → return raw PNG langsung (bisa di-browser)
  app.get('/accounts/:id/qr', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    schema: {
      description: 'Ambil QR code untuk autentikasi WhatsApp. Scan dengan WhatsApp > Linked Devices.',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      querystring: {
        type: 'object',
        properties: { format: { type: 'string', enum: ['image'], description: '?format=image → return raw PNG' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: {
                qr: { type: 'string', description: 'Raw QR string — bisa di-paste ke QR generator' },
                image: { type: 'string', description: 'Data URI PNG — buka di browser, scan langsung pake HP' },
              },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
        503: { $ref: 'ServiceUnavailableError' },
      },
    },
  }, async (req, reply) => {
    const client = am.getClient(req.params.id)
    if (!client) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Account not found' } })
    if (!client.wa) return reply.status(503).send({ error: { code: 'SERVICE_UNAVAILABLE', message: 'WhatsApp client not initialized', detail: client.error } })
    const qr = client.wa.getQR()
    if (!qr) return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'No QR available. Already authenticated?' } })

    const { default: QRCode } = await import('qrcode')

    // ?format=image → return raw PNG langsung, bisa di-browser
    if (req.query.format === 'image') {
      const buffer = await QRCode.toBuffer(qr, { width: 400, margin: 2 })
      reply.header('Content-Type', 'image/png')
      reply.header('Cache-Control', 'no-store')
      return reply.send(buffer)
    }

    // Default: JSON dengan data URI
    const image = await QRCode.toDataURL(qr, { width: 400, margin: 2 })
    return { data: { qr, image } }
  })

  // POST /accounts/:id/reconnect — destroy + recreate client
  app.post('/accounts/:id/reconnect', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      description: 'Reconnect WhatsApp client. Destroy session lama, buat ulang. Butuh scan QR ulang.',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        properties: { label: { type: 'string', description: 'Nama akun (opsional)' } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { id: { type: 'string' }, label: { type: 'string' }, apiKey: { type: 'string' } },
            },
          },
        },
      },
    },
  }, async (req, reply) => {
    am.removeAccount(req.params.id)
    const label = req.body.label || `Account-${req.params.id.slice(0, 6)}`
    const acc = am.addAccount({ id: req.params.id, label })
    return { data: acc }
  })

  // POST /accounts/:id/rotate-key — generate API key baru
  app.post('/accounts/:id/rotate-key', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      description: 'Rotate API key. Generate UUID baru, key lama langsung tidak valid.',
      tags: ['Accounts'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          properties: {
            data: {
              type: 'object',
              properties: { apiKey: { type: 'string', description: 'API key baru (UUID)' } },
            },
          },
        },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    try {
      const newKey = am.rotateApiKey(req.params.id)
      return { data: { apiKey: newKey } }
    } catch (err) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } })
    }
  })
}
