// client.js — WhatsApp client factory, return WAAdapter instance.
// Pilih adapter berdasarkan env WA_LIBRARY:
//   baileys (default) → BaileysAdapter (WebSocket murni, tanpa browser)
//   wwebjs           → WwebAdapter (whatsapp-web.js, Chromium-based)
import logger from './utils/logger.js'
import { WwebAdapter } from './adapters/wweb-adapter.js'
import { BaileysAdapter } from './adapters/baileys-adapter.js'

const LIBRARY = (process.env.WA_LIBRARY || 'baileys').toLowerCase()

/**
 * Factory function — bikin WAAdapter instance sesuai library yang aktif.
 * @param {Object} account - { id, label, webVersion }
 * @returns {WAAdapter} Instance adapter untuk library WhatsApp yang dipilih
 */
export function createWAClient(account) {
  if (LIBRARY === 'wwebjs') {
    logger.debug(`Using WhatsApp library: wwebjs (${account.label})`)
    return new WwebAdapter(account)
  }

  logger.debug(`Using WhatsApp library: baileys (${account.label})`)
  return new BaileysAdapter(account)
}
