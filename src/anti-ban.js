import { setTimeout as sleep } from 'node:timers/promises'
import logger from './utils/logger.js'

export class AntiBan {
  // TODO: konstruktor pake account ID (bukan label) biar anti-ban state terikat ke ID yang immutable
  constructor(id) {
    this.id = id
    this.dailySent = 0
    this.dailyReset = Date.now()
    this.contactDaily = new Map()
    this.lastAction = 0
    this.warmupDay = 1
    this.warmupComplete = false
  }

  getConfig() {
    return {
      minDelay: parseInt(process.env.AB_MIN_DELAY || '3000'),
      maxDelay: parseInt(process.env.AB_MAX_DELAY || '12000'),
      dailyLimit: parseInt(process.env.AB_DAILY_LIMIT || '500'),
      warmupDays: parseInt(process.env.AB_WARMUP_DAYS || '7'),
      warmupMultiplier: parseFloat(process.env.AB_WARMUP_MULTIPLIER || '0.3'),
      maxPerContact: parseInt(process.env.AB_MAX_PER_CONTACT || '50'),
      resetHour: parseInt(process.env.AB_RESET_HOUR || '3'),
      jitterFactor: parseFloat(process.env.AB_JITTER_FACTOR || '0.3'),
    }
  }

  getWarmupLimit(cfg) {
    if (this.warmupComplete) return cfg.dailyLimit
    const fraction = Math.min(this.warmupDay / cfg.warmupDays, 1)
    return Math.floor(cfg.dailyLimit * fraction * cfg.warmupMultiplier)
  }

  checkDailyReset(cfg) {
    const now = new Date()
    const last = new Date(this.dailyReset)
    if (now.getHours() >= cfg.resetHour && last.getHours() < cfg.resetHour) {
      this.dailySent = 0
      this.contactDaily.clear()
      this.dailyReset = now
      logger.info(`${this.id}: daily counters reset`)
    }
    if (now.getDate() !== last.getDate() || now.getMonth() !== last.getMonth()) {
      this.warmupDay = Math.min(this.warmupDay + 1, cfg.warmupDays + 1)
      if (this.warmupDay > cfg.warmupDays) {
        this.warmupComplete = true
        logger.info(`${this.id}: warmup complete`)
      }
    }
  }

  getRandomDelay(cfg) {
    const base = cfg.minDelay + Math.random() * (cfg.maxDelay - cfg.minDelay)
    const jitter = base * cfg.jitterFactor * (Math.random() * 2 - 1)
    return Math.max(500, Math.floor(base + jitter))
  }

  getTypingDelay(message) {
    const chars = typeof message === 'string' ? message.length : 100
    const wpm = 200 + Math.floor(Math.random() * 100)
    const base = (chars / (wpm * 5)) * 60000
    return Math.max(800, Math.min(base, 8000))
  }

  async enforceRateLimit(cfg) {
    this.checkDailyReset(cfg)
    const limit = this.getWarmupLimit(cfg)
    if (this.dailySent >= limit) {
      const nextReset = new Date()
      nextReset.setHours(cfg.resetHour, 0, 0, 0)
      if (nextReset <= new Date()) nextReset.setDate(nextReset.getDate() + 1)
      const err = new Error(`Daily limit (${this.dailySent}/${limit})`)
      err.name = 'DailyLimitError'
      err.resetAt = nextReset.toISOString()
      throw err
    }
  }

  checkContactLimit(contactId, cfg) {
    const sent = this.contactDaily.get(contactId) || 0
    return sent < cfg.maxPerContact
  }

  incrementCounters(contactId) {
    this.dailySent++
    this.contactDaily.set(contactId, (this.contactDaily.get(contactId) || 0) + 1)
  }

  async preSend(contactId) {
    const cfg = this.getConfig()
    await this.enforceRateLimit(cfg)
    if (!this.checkContactLimit(contactId, cfg)) {
      const err = new Error(`Contact ${contactId} hit daily limit (${cfg.maxPerContact})`)
      err.name = 'ContactLimitError'
      throw err
    }
    const elapsed = Date.now() - this.lastAction
    const delay = this.getRandomDelay(cfg)
    if (elapsed < delay) {
      await sleep(delay - elapsed)
    }
    this.lastAction = Date.now()
  }

  async simulateTyping(message) {
    await sleep(this.getTypingDelay(message))
  }

  getState() {
    const cfg = this.getConfig()
    return {
      dailySent: this.dailySent,
      dailyLimit: cfg.dailyLimit,
      warmupLimit: this.getWarmupLimit(cfg),
      warmupDay: this.warmupDay,
      warmupComplete: this.warmupComplete,
      warmupDays: cfg.warmupDays,
      resetHour: cfg.resetHour,
    }
  }
}

/**
 * Load anti-ban state dari database.
 * Dipanggil pas init biar warmup progress gak hilang setelah restart.
 */
AntiBan.fromDb = function (accountId, db) {
  const row = db.prepare('SELECT * FROM anti_ban_state WHERE account_id = ?').get(accountId)
  const ab = new AntiBan(accountId)
  if (row) {
    ab.dailySent = row.daily_sent || 0
    ab.dailyReset = row.daily_reset ? new Date(row.daily_reset).getTime() : Date.now()
    ab.warmupDay = row.warmup_day || 1
    ab.warmupComplete = !!row.warmup_complete
  }
  return ab
}
