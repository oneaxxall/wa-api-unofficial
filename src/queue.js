/**
 * Message Queue — BullMQ adapter untuk WAUN.
 *
 * Queue ini opsional: kalau Redis tersedia, broadcast di-enqueue via BullMQ
 * biar lebih reliable (persist, retry per-job). Kalau Redis gak available,
 * fallback ke setImmediate (existing behavior).
 *
 * Config:
 * - REDIS_URL: URL koneksi Redis (default: redis://localhost:6379)
 * - QUEUE_ENABLED: set 'true' untuk aktifkan queue (default: false)
 *
 * Kenapa opsional?
 * - Biar user yang gak punya Redis tetep bisa pake WAUN tanpa perubahan
 * - Redis nambah dependency eksternal — gak semua orang butuh
 * - Backward compatible: kode broadcast existing gak perlu diubah
 */
import { Queue, Worker } from 'bullmq'
import logger from './utils/logger.js'

const REDIS_PASSWORD = process.env.REDIS_PASSWORD || ''
const REDIS_HOST = process.env.REDIS_HOST || 'localhost'
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379')
const QUEUE_ENABLED = process.env.QUEUE_ENABLED === 'true'

let connection = null
let connectionPromise = null
const queues = new Map()
const workers = new Map()

/**
 * Dapatkan koneksi Redis — lazy-init async biar gak connect kalo gak dipake.
 * Pake caching biar cuma 1x connect: connectionPromise di-set pas pertama kali
 * dipanggil, selanjutnya return Promise yang sama.
 */
async function getConnection() {
  if (connection) return connection
  if (!QUEUE_ENABLED) return null

  // Cegah duplicate connection attempts — pake promise caching
  if (!connectionPromise) {
    connectionPromise = (async () => {
      try {
        // Dynamic import — ESM compatible
        const { default: IORedis } = await import('ioredis')
        const conn = new IORedis({
          host: REDIS_HOST,
          port: REDIS_PORT,
          password: REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
          retryStrategy: (times) => {
            // Exponential backoff buat reconnect: 1s, 2s, 4s, 8s...
            const delay = Math.min(times * 1000, 10000)
            logger.warn(`Redis reconnect attempt ${times} in ${delay}ms`)
            return delay
          },
        })

        conn.on('connect', () => logger.info('Redis connected'))
        conn.on('error', (err) => logger.warn(`Redis error: ${err.message}`))
        conn.on('close', () => logger.warn('Redis connection closed'))

        connection = conn
        return conn
      } catch (err) {
        logger.warn(`Redis not available (${err.message}) — queue disabled, using fallback`)
        connectionPromise = null // Reset biar bisa dicoba lagi nanti
        return null
      }
    })()
  }

  return connectionPromise
}

/**
 * Buat queue baru (atau return existing).
 * @param {string} name — Nama queue (default: 'waun-broadcast')
 * @returns {Promise<Queue|null>} BullMQ Queue instance, atau null kalo Redis gak available
 */
export async function createQueue(name = 'waun-broadcast') {
  if (!QUEUE_ENABLED) {
    logger.debug(`Queue disabled — returning null for "${name}"`)
    return null
  }

  if (queues.has(name)) return queues.get(name)

  const conn = await getConnection()
  if (!conn) return null

  try {
    const queue = new Queue(name, { connection: conn })
    queues.set(name, queue)
    logger.info(`Queue created: "${name}"`)
    return queue
  } catch (err) {
    logger.warn(`Failed to create queue "${name}": ${err.message}`)
    return null
  }
}

/**
 * Buat worker untuk memproses job dari queue.
 * @param {string} name — Nama queue
 * @param {Function} processor — Async function(job) untuk proses tiap job
 * @returns {Promise<Worker|null>} BullMQ Worker instance, atau null kalo Redis gak available
 */
export async function createWorker(name, processor) {
  if (!QUEUE_ENABLED) return null

  const conn = await getConnection()
  if (!conn) return null

  // Cegah duplicate worker untuk queue yang sama
  if (workers.has(name)) {
    logger.warn(`Worker "${name}" already exists — returning existing`)
    return workers.get(name)
  }

  try {
    const worker = new Worker(name, processor, {
      connection: conn,
      concurrency: 1,
      // Lock duration — job akan diretry oleh worker lain kalo timeout
      lockDuration: 60000,
    })

    worker.on('completed', (job) => {
      logger.info(`Job ${job.id} completed for "${name}"`)
    })

    worker.on('failed', (job, err) => {
      logger.error(`Job ${job.id} failed for "${name}": ${err.message}`)
    })

    workers.set(name, worker)
    logger.info(`Worker created: "${name}"`)
    return worker
  } catch (err) {
    logger.warn(`Failed to create worker "${name}": ${err.message}`)
    return null
  }
}

/**
 * Enqueue job ke queue.
 * @param {Queue} queue — BullMQ Queue instance
 * @param {string} jobName — Nama job
 * @param {Object} data — Payload job
 * @param {Object} opts — Opsi BullMQ (opsional)
 * @returns {Promise<Object|null>} Job object atau null kalo gagal
 */
export async function enqueueJob(queue, jobName, data, opts = {}) {
  if (!queue) return null
  try {
    const job = await queue.add(jobName, data, {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
      removeOnComplete: 100,
      removeOnFail: 50,
      ...opts,
    })
    return job
  } catch (err) {
    logger.warn(`Failed to enqueue job "${jobName}": ${err.message}`)
    return null
  }
}

/**
 * Tutup semua queue dan worker — dipanggil pas shutdown.
 */
export async function closeQueues() {
  for (const [name, worker] of workers) {
    try {
      await worker.close()
      logger.info(`Worker closed: "${name}"`)
    } catch (err) {
      logger.warn(`Failed to close worker "${name}": ${err.message}`)
    }
  }
  workers.clear()

  for (const [name, q] of queues) {
    try {
      await q.close()
      logger.info(`Queue closed: "${name}"`)
    } catch (err) {
      logger.warn(`Failed to close queue "${name}": ${err.message}`)
    }
  }
  queues.clear()

  if (connection) {
    try {
      await connection.quit()
      logger.info('Redis connection closed')
    } catch (err) {
      logger.warn(`Failed to close Redis: ${err.message}`)
    }
    connection = null
  }
  connectionPromise = null
}

export function isQueueEnabled() {
  return QUEUE_ENABLED
}

export default {
  createQueue,
  createWorker,
  enqueueJob,
  closeQueues,
  isQueueEnabled,
}
