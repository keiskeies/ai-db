import { loadConfig } from '../apps/gateway/src/config';
import { ensureDemoDatabase } from '../apps/gateway/src/seed';
import { Store } from '../apps/gateway/src/store';

const config = loadConfig();
const store = new Store(config.dbPath, config.secret);
try {
  const conn = ensureDemoDatabase(config, store);
  console.log(`Demo database ready: ${config.demoDir}`);
  console.log(`Connection: ${conn.name} (${conn.id})`);
  console.log(`SQLite file: ${conn.database}`);
} finally {
  store.close();
}
