/**
 * Metrics — Prometheus plain-text metrics exporter tanpa library tambahan.
 *
 * Alasan gak pake @fastify/metrics:
 * - Dependency berat (butuh @fastify/metrics yang pull opentelemetry)
 * - Untuk use case WAUN, cukup metric dasar: counter + gauge
 * - Format Prometheus text sederhana bisa di-render manual
 *
 * Metrik yang di-track:
 * - waun_accounts_total            (gauge)
 * - waun_accounts_ready            (gauge)
 * - waun_messages_sent_total       (counter)
 * - waun_broadcasts_total          (counter)
 * - waun_broadcasts_active         (gauge)
 * - waun_webhook_deliveries_total  (counter)
 * - waun_webhook_failures_total    (counter)
 * - waun_errors_total              (counter)
 */

export class Metrics {
  constructor() {
    // Inisialisasi semua counter/gauge dengan nilai awal 0
    this._metrics = {
      accounts_total: 0,
      accounts_ready: 0,
      messages_sent_total: 0,
      broadcasts_total: 0,
      broadcasts_active: 0,
      webhook_deliveries_total: 0,
      webhook_failures_total: 0,
      errors_total: 0,
    }
  }

  /**
   * Increment sebuah counter metric.
   * @param {string} name - Nama metric (tanpa prefix 'waun_')
   * @param {number} [by=1] - Jumlah increment (default 1)
   */
  inc(name, by = 1) {
    if (this._metrics[name] !== undefined) {
      this._metrics[name] += by
    }
  }

  /**
   * Set sebuah gauge metric ke nilai tertentu.
   * @param {string} name - Nama metric
   * @param {number} value - Nilai yang di-set
   */
  set(name, value) {
    if (this._metrics[name] !== undefined) {
      this._metrics[name] = value
    }
  }

  /**
   * Render semua metric dalam format Prometheus plain text.
   * Format: # HELP <name> <description>\n# TYPE <name> <type>\n<name> <value>
   *
   * Alasan format ini:
   * - Prometheus native format — langsung bisa di-scrape oleh Prometheus server
   * - Gak perlu library tambahan — cukup string concatenation
   * - Human-readable — bisa di-cek manual via curl
   *
   * @returns {string} Prometheus-format metrics
   */
  render() {
    // Definisikan metadata tiap metric: tipe + deskripsi
    const definitions = [
      { name: 'waun_accounts_total', type: 'gauge', help: 'Total jumlah account yang terdaftar' },
      { name: 'waun_accounts_ready', type: 'gauge', help: 'Jumlah account dengan status ready (terkoneksi WhatsApp)' },
      { name: 'waun_messages_sent_total', type: 'counter', help: 'Total pesan yang berhasil dikirim' },
      { name: 'waun_broadcasts_total', type: 'counter', help: 'Total broadcast yang pernah dimulai' },
      { name: 'waun_broadcasts_active', type: 'gauge', help: 'Jumlah broadcast yang sedang berjalan (running/pending)' },
      { name: 'waun_webhook_deliveries_total', type: 'counter', help: 'Total pengiriman webhook (termasuk retry)' },
      { name: 'waun_webhook_failures_total', type: 'counter', help: 'Total webhook yang gagal setelah semua retry' },
      { name: 'waun_errors_total', type: 'counter', help: 'Total error yang terjadi (general)' },
    ]

    const lines = []

    for (const def of definitions) {
      // Ambil key dari _metrics dengan strip prefix 'waun_'
      // Misal: 'waun_accounts_total' → key '_metrics.accounts_total'
      const key = def.name.replace('waun_', '')
      const value = this._metrics[key] ?? 0

      lines.push(`# HELP ${def.name} ${def.help}`)
      lines.push(`# TYPE ${def.name} ${def.type}`)
      lines.push(`${def.name} ${value}`)
    }

    // EOF newline biar Prometheus gak komplen
    lines.push('')
    return lines.join('\n')
  }

  /**
   * Ambil snapshot metric untuk keperluan debugging / health check.
   * @returns {object} Plain object dengan semua metric
   */
  snapshot() {
    return { ...this._metrics }
  }
}
