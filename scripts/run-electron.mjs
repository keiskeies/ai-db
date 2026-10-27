import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

function binaryFromDist(dist) {
  if (process.platform === 'win32') return join(dist, 'electron.exe');
  if (process.platform === 'darwin') return join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron');
  return join(dist, 'electron');
}

export function findElectronBinary() {
  const tools = binaryFromDist(join(root, '.tools', 'electron45', 'node_modules', 'electron', 'dist'));
  if (existsSync(tools)) return tools;
  const local = binaryFromDist(join(root, 'node_modules', 'electron', 'dist'));
  if (existsSync(local)) return local;
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && existsSync(resolved)) return resolved;
  } catch {
    /* not installed */
  }
  return undefined;
}

const binary = findElectronBinary();
if (!binary) {
  console.error('Electron binary not found. Run: npm install');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [join(root, 'apps', 'desktop'), ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
child.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
