// CLI tool buat nambah account baru — dipanggil manual dari terminal
// Contoh: node src/cli-add-account.js "My Account"
import 'dotenv/config'
import { AccountManager } from './account-manager.js'
import { initDatabase } from './db.js'

try {
  // Init database dulu sebelum pake AccountManager
  initDatabase()

  const label = process.argv[2] || `Account-${Date.now().toString(36)}`
  const am = await new AccountManager().init()
  const acc = am.addAccount({ label })
  console.log(`Account created:`)
  console.log(`  ID:     ${acc.id}`)
  console.log(`  Label:  ${acc.label}`)
  console.log(`  API Key: ${acc.apiKey}`)
  console.log(`\nSimpan API Key ini — dipakai sebagai Bearer token untuk semua request.`)
  console.log(`Scan QR: curl http://localhost:3008/accounts/${acc.id}/qr -H "Authorization: Bearer ${acc.apiKey}"`)
  process.exit(0)
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
