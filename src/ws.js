/**
 * WebSocket handler untuk broadcast progress real-time.
 *
 * Alasan pake @fastify/websocket (bukan library WS terpisah):
 * - Integrasi native dengan Fastify — gak perlu server terpisah
 * - Auto-handle upgrade HTTP → WS
 * - Handle error + close connection otomatis
 *
 * Endpoint: ws://host/ws/broadcast/:id
 *
 * Events dari server ke client (JSON):
 * - state      → current state pas connect
 * - progress   → { sent, total, failed } — tiap batch selesai
 * - complete   → { sent, total, failed, status } — broadcast selesai
 * - paused     → { sent, total, failed, reason } — kena daily limit
 * - cancelled  → { sent, total, failed } — di-cancel user
 * - error      → { message } — error fatal
 */

import logger from './utils/logger.js'

export function setupWebSocket(app, be) {
  // Register @fastify/websocket plugin
  // Error handling: kalau sudah ter-register, skip biar gak double-register
  try {
    app.register(import('@fastify/websocket'))
  } catch {
    // Plugin mungkin sudah di-register — skip
  }

  // WebSocket endpoint untuk subscribe progress broadcast tertentu
  // Client connect langsung subscribe — gak perlu kirim message pertama
  app.get('/ws/broadcast/:id', { websocket: true }, (socket, req) => {
    const broadcastId = req.params.id

    logger.debug(`WebSocket connected: /ws/broadcast/${broadcastId}`)

    /**
     * Kirim current state pas connect — biar client langsung tau posisi terakhir.
     * Alasan: kalo broadcast udah selesai sebelum client connect,
     * client tetep dapet state final (gak perlu nunggu event).
     */
    const rec = be.get(broadcastId)
    if (rec) {
      try {
        socket.send(JSON.stringify({ event: 'state', data: rec }))
      } catch (err) {
        logger.warn(`WebSocket send error (state): ${err.message}`)
      }
    }

    // Subscribe ke progress events dari BroadcastEngine
    // Callback dipanggil tiap ada update dari _execute()
    const unsub = be.onProgress(broadcastId, (event, data) => {
      try {
        socket.send(JSON.stringify({ event, data }))
      } catch (err) {
        // Socket mungkin udah closed — unsubscribe aja biar gak bocor
        logger.debug(`WebSocket send error (${broadcastId}): ${err.message} — unsubscribing`)
        unsub()
      }
    })

    // Cleanup pas koneksi putus — cegah memory leak
    // Event 'close' dipicu oleh @fastify/websocket otomatis
    socket.on('close', () => {
      logger.debug(`WebSocket disconnected: /ws/broadcast/${broadcastId}`)
      unsub()
    })

    // Handle error socket — unsubscribe juga biar aman
    socket.on('error', (err) => {
      logger.warn(`WebSocket error (${broadcastId}): ${err.message}`)
      unsub()
    })
  })
}
