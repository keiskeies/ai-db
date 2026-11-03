import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildBusinessDemoDatabase } from '../apps/gateway/src/seedBusiness';

const force = process.argv.includes('--force');
const home = process.env.AIDB_HOME ?? join(homedir(), '.aidb');
const demoDir = join(home, 'demo');
const targets = [
  { file: join(demoDir, 'demo-retail.sqlite'), drift: false },
  { file: join(demoDir, 'demo-retail-mirror.sqlite'), drift: true },
];

for (const target of targets) {
  const started = Date.now();
  buildBusinessDemoDatabase(target.file, { drift: target.drift, force });
  const db = new DatabaseSync(target.file, { readOnly: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>;
    let total = 0;
    const lines: string[] = [];
    for (const { name } of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
      total += row.n;
      lines.push(`${name}=${row.n}`);
    }
    console.log(`\n[${target.drift ? 'mirror' : 'source'}] ${target.file}  (${Date.now() - started}ms)`);
    console.log(`objects=${tables.length} rows=${total}`);
    console.log(lines.join(' '));
  } finally {
    db.close();
  }
}
