export default function autoReplyRoutes(app, am) {

  // GET /accounts/:id/auto-replies — daftar auto-reply rules
  app.get('/accounts/:id/auto-replies', {
    schema: {
      description: 'Ambil daftar auto-reply rules untuk satu account.',
      tags: ['Auto-Replies'],
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
                  keyword: { type: 'string' },
                  reply: { type: 'string' },
                  matchType: { type: 'string', enum: ['exact', 'contains', 'startsWith', 'regex'] },
                  enabled: { type: 'boolean' },
                  cooldown: { type: 'integer', description: 'Cooldown dalam detik' },
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
    return { data: acc.autoReplies || [] }
  })

  // POST /accounts/:id/auto-replies — tambah auto-reply rule
  app.post('/accounts/:id/auto-replies', {
    schema: {
      description: 'Tambah aturan auto-reply. Ketika ada pesan masuk yang match keyword, balas otomatis.',
      tags: ['Auto-Replies'],
      params: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Account UUID' } },
        required: ['id'],
      },
      body: {
        type: 'object',
        required: ['keyword', 'reply'],
        properties: {
          keyword: { type: 'string', description: 'Kata kunci yang dicocokkan' },
          reply: { type: 'string', description: 'Teks balasan. Support template: {{body}}, {{from}}' },
          matchType: {
            type: 'string',
            enum: ['exact', 'contains', 'startsWith', 'regex'],
            description: 'Tipe pencocokan (default: contains)',
          },
          enabled: { type: 'boolean', description: 'Aktif/nonaktif (default: true)' },
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
                keyword: { type: 'string' },
                reply: { type: 'string' },
                matchType: { type: 'string' },
                enabled: { type: 'boolean' },
                cooldown: { type: 'integer' },
              },
            },
          },
        },
        400: { $ref: 'BadRequestError' },
        404: { $ref: 'NotFoundError' },
      },
    },
  }, async (req, reply) => {
    const { keyword, reply: replyText, matchType, enabled } = req.body
    // Validasi: keyword gak boleh kosong atau cuma whitespace
    if (!keyword || !keyword.trim()) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'keyword tidak boleh kosong' } })
    if (!replyText) return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'reply required' } })
    try {
      const r = am.addAutoReply(req.params.id, { keyword: keyword.trim(), reply: replyText, matchType, enabled })
      return reply.status(201).send({ data: r })
    } catch (err) {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: err.message } })
    }
  })

  // DELETE /accounts/:id/auto-replies/:rid — hapus auto-reply rule
  app.delete('/accounts/:id/auto-replies/:rid', {
    schema: {
      description: 'Hapus aturan auto-reply.',
      tags: ['Auto-Replies'],
      params: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Account UUID' },
          rid: { type: 'string', description: 'Auto-reply rule UUID' },
        },
        required: ['id', 'rid'],
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
    if (!am.removeAutoReply(req.params.id, req.params.rid)) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Auto-reply not found' } })
    }
    return { data: { status: 'deleted' } }
  })
}
