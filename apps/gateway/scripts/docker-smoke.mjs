#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

const repoRoot = new URL('../../../', import.meta.url);
const providedImage = process.env.AIDB_DOCKER_IMAGE?.trim();
const image = providedImage || `aidb-gateway-smoke:${process.pid}-${Date.now()}`;
const container = `aidb-gateway-smoke-${process.pid}-${Date.now()}`;
const volume = `${container}-data`;
let containerCreated = false;
let volumeCreated = false;
let imageBuilt = false;

function fail(message) {
  throw new Error(message);
}

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    windowsHide: true,
    timeout: options.timeout ?? 120_000,
  });
  if (result.error?.code === 'ENOENT') fail('Docker is not installed or is not on PATH; the container smoke test cannot run.');
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    const detail = options.capture ? `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() : '';
    fail(`docker ${args[0]} exited with status ${result.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function canaryFor(secret) {
  const key = createHash('sha256').update('aidb:secretbox:v2\0').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify({ canary: 'aidb-master-key-v2', version: 2 }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return ['v2', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

async function waitForHealth() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const running = run(['inspect', '--format', '{{.State.Running}}', container], { capture: true });
    if (running !== 'true') {
      run(['logs', container]);
      fail('The smoke-test container exited before becoming healthy.');
    }
    const health = run(['inspect', '--format', '{{.State.Health.Status}}', container], { capture: true });
    if (health === 'healthy') return;
    if (health === 'unhealthy') {
      run(['logs', container]);
      fail('The smoke-test container reported an unhealthy state.');
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  run(['logs', container]);
  fail('Timed out waiting for /api/health to become healthy.');
}

try {
  if (!providedImage) {
    run(['build', '--file', 'apps/gateway/Dockerfile', '--tag', image, '.'], { cwd: repoRoot, timeout: 600_000 });
    imageBuilt = true;
  }

  const secret = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  run(['volume', 'create', volume], { capture: true });
  volumeCreated = true;
  run([
    'run', '--detach',
    '--name', container,
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--mount', `type=volume,src=${volume},dst=/data`,
    '--env', `AIDB_SECRET=${secret}`,
    '--env', `AIDB_SECRET_CANARY=${canaryFor(secret)}`,
    '--env', `AIDB_TOKEN=${token}`,
    image,
  ], { capture: true });
  containerCreated = true;

  await waitForHealth();

  const uid = run(['exec', container, 'node', '-p', 'process.getuid()'], { capture: true });
  if (uid !== '1000') fail(`Expected non-root UID 1000, received ${uid}.`);

  const readOnly = run(['inspect', '--format', '{{.HostConfig.ReadonlyRootfs}}', container], { capture: true });
  if (readOnly !== 'true') fail('Container was not started with a read-only root filesystem.');

  run(['exec', container, 'node', '-e', `
    const fs = require('node:fs');
    fs.writeFileSync('/data/.docker-smoke', 'ok');
    fs.unlinkSync('/data/.docker-smoke');
    fs.writeFileSync('/tmp/.docker-smoke', 'ok');
    fs.unlinkSync('/tmp/.docker-smoke');
    if (Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Shanghai') process.exit(1);
    if (!fs.existsSync('/app/packages/client/package.json')) process.exit(1);
  `], { capture: true });

  run(['exec', container, 'node', '--input-type=module', '-e', `
    await import('ssh2');
    const libc = (await import('detect-libc')).default;
    if (libc.family !== 'glibc') throw new Error('Expected Debian glibc detection');
    const { DuckDBInstance } = await import('@duckdb/node-api');
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    try {
      const reader = await connection.runAndReadAll('SELECT 42 AS value');
      const row = reader.getRowObjects()[0];
      if (!row || Number(row.value) !== 42) throw new Error('DuckDB native binding smoke query failed');
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  `], { capture: true });

  run(['exec', '-e', 'AIDB_SMOKE_TOKEN', container, 'node', '-e', `
    fetch('http://127.0.0.1:8787/api/health/ready', {
      headers: { authorization: 'Bearer ' + process.env.AIDB_SMOKE_TOKEN },
      signal: AbortSignal.timeout(4000),
    })
      .then(async (response) => {
        if (!response.ok) process.exit(1);
        const body = await response.json();
        if (body.ok !== true || body.checks.sqlite !== 'ok' || body.checks.backups !== 'ok') process.exit(1);
      })
      .catch(() => process.exit(1));
  `], { capture: true, env: { AIDB_SMOKE_TOKEN: token } });

  console.log('[docker-smoke] Read-only, non-root, health, timezone, /data capacity/writability, client workspace, ssh2, detect-libc, and DuckDB checks passed.');
} catch (error) {
  console.error(`[docker-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (containerCreated) run(['rm', '--force', container], { capture: true });
  if (volumeCreated) run(['volume', 'rm', volume], { capture: true });
  if (imageBuilt) run(['image', 'rm', image], { capture: true });
}
