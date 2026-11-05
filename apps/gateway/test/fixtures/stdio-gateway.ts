import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createGateway } from '../../src/server';
import { listenRandom } from '../helpers';

const home = process.env.AIDB_STDIO_HOME!;
const gateway = await createGateway({
  home,
  dbPath: join(home, 'aidb.db'),
  secret: 'aidb-mcp-stdio-secret',
  token: process.env.AIDB_STDIO_TOKEN ?? 't',
  demoDir: join(home, 'demo'),
  exportDir: join(home, 'exports'),
  importDir: join(home, 'imports'),
  backupDir: join(home, 'backups'),
  attachmentDir: join(home, 'attachments'),
  staticDir: join(home, 'static-missing'),
  port: 0,
  host: '127.0.0.1',
  production: false,
});
const port = await listenRandom(gateway.server);
writeFileSync(process.env.AIDB_STDIO_PORT_FILE!, String(port));
process.on('SIGTERM', () => { gateway.close().then(() => process.exit(0)); });
