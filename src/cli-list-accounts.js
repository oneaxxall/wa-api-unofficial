// CLI tool buat liat daftar account — dipanggil manual dari terminal
// Contoh: node src/cli-list-accounts.js
import 'dotenv/config'
import { AccountManager } from './account-manager.js'
import { initDatabase } from './db.js'

try {
  // Init database dulu sebelum pake AccountManager
  initDatabase()

  const am = await new AccountManager().init()
  const list = am.listAccounts()
  if (list.length === 0) {
    console.log('No accounts. Use: node src/cli-add-account.js <label>')
  } else {
    console.log('Accounts:')
    for (const a of list) {
      const s = a.status
      console.log(`  ${a.id.slice(0, 8)}... | ${a.label} | ready:${s?.ready} | auth:${s?.authenticated} | daily:${s?.antiBan?.dailySent}/${s?.antiBan?.dailyLimit}`)
    }
  }
  process.exit(0)
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
