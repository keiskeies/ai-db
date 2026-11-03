import { loadConfig } from '../apps/gateway/src/config';
import { ensureDemoDatabase } from '../apps/gateway/src/seed';
import { ensureBusinessDemoDatabases } from '../apps/gateway/src/seedBusiness';
import { Store } from '../apps/gateway/src/store';

const config = loadConfig();
const store = new Store(config.dbPath, config.secret);
try {
  const conn = ensureDemoDatabase(config, store);
  console.log(`Demo database ready: ${config.demoDir}`);
  console.log(`Connection: ${conn.name} (${conn.id})`);
  console.log(`SQLite file: ${conn.database}`);
  for (const business of ensureBusinessDemoDatabases(config, store, { force: process.argv.includes('--force') })) {
    console.log(`Connection: ${business.name} (${business.id}) → ${business.database}`);
  }
} finally {
  store.close();
}
