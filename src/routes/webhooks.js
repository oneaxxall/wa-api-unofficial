export default function webhookRoutes(app, am) {

  // GET /accounts/:id/webhooks — daftar webhook
  app.get('/accounts/:id/webhooks', {
    schema: {
      description: 'Ambil daftar webhook yang terdaftar untuk satu account.',
      tags: ['Webhooks'],
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
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  url: { type: 'string' },
                  headers: { type: 'object', nullable: true },
                  timeout: { type: 'integer' },
                  enabled: { type: 'boolean' },
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
    return { data: acc.webhooks || [] }
  })

  // POST /accounts/:id/webhooks — tambah webhook baru
  app.post('/accounts/:id/webhooks', {
    schema: {
      description: 'Tambah webhook untuk forwarding pesan masuk. WAJIB HTTPS (kecuali development).',
      tags: ['Webhooks'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'Webhook URL. Hanya https:// (http:// hanya di development)' },
          headers: { type: 'object', description: 'Custom headers (contoh: {"Authorization":"Bearer xxx"})' },
          timeout: { type: 'integer', description: 'Timeout dalam ms (default: 10000)' },
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
                url: { type: 'string' },
                headers: { type: 'object', nullable: true },
                timeout: { type: 'integer' },
                enabled: { type: 'boolean' },
              },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const { url, headers, timeout } = req.body
    if (!url) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'url required' } })
    try {
      const wh = am.addWebhook(req.params.id, { url, headers, timeout })
      return reply.status(201).send({ data: wh })
    } catch (err) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: err.message } })
    }
  })

  // GET /accounts/:id/failed-webhooks — daftar webhook yang gagal dikirim
  // Opsional: buat retry manual via API
  app.get('/accounts/:id/failed-webhooks', {
    schema: {
      description: 'Ambil daftar webhook yang gagal dikirim (setelah retry habis).',
      tags: ['Webhooks'],
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
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  webhookId: { type: 'string' },
                  url: { type: 'string' },
                  event: { type: 'string', description: 'Event type: message, message.ack, connection.status' },
                  payload: { type: 'object', description: 'Full webhook payload yang gagal dikirim' },
                  error: { type: 'string' },
                  timestamp: { type: 'string' },
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
    return { data: am.getFailedWebhooks(req.params.id) }
  })

  // DELETE /accounts/:id/webhooks/:wid — hapus webhook
  app.delete('/accounts/:id/webhooks/:wid', {
    schema: {
      description: 'Hapus webhook dari account.',
      tags: ['Webhooks'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Account UUID' },
          wid: { type: 'string', description: 'Webhook UUID' },
        },
        required: ['id', 'wid'],
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
    if (!am.removeWebhook(req.params.id, req.params.wid)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Webhook not found' } })
    }
    return { data: { status: 'deleted' } }
  })
}
