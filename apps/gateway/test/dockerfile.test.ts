import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const dockerfile = readFileSync(join(repoRoot, 'apps/gateway/Dockerfile'), 'utf8');
const dockerignore = readFileSync(join(repoRoot, '.dockerignore'), 'utf8');
const dockerSmoke = readFileSync(join(repoRoot, 'apps/gateway/scripts/docker-smoke.mjs'), 'utf8');
const runtimeStage = dockerfile.split(/\nFROM\s+/).at(-1) ?? '';

test('gateway image installs locked workspace dependencies with npm ci', () => {
  assert.match(dockerfile, /npm ci --workspace apps\/gateway --include-workspace-root --no-audit --no-fund/);
  assert.match(dockerfile, /npm ci --workspace apps\/gateway --include-workspace-root --omit=dev --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /npm install/);
  for (const manifest of [
    'packages/core/package.json',
    'packages/client/package.json',
    'packages/aidb-mcp/package.json',
    'apps/gateway/package.json',
    'apps/desktop/package.json',
    'apps/mobile/package.json',
  ]) {
    assert.ok(dockerfile.includes(`COPY ${manifest} ${manifest}`), `missing workspace manifest ${manifest}`);
  }
});

test('gateway runtime includes bundled output, complete external dependencies, and workspaces', () => {
  assert.match(dockerfile, /COPY --from=build --chown=node:node \/repo\/apps\/gateway\/dist \.\/dist/);
  assert.match(dockerfile, /COPY --from=production-dependencies --chown=node:node \/repo\/node_modules \.\/node_modules/);
  assert.match(dockerfile, /@duckdb\/node-bindings/);
  assert.match(dockerfile, /detect-libc/);
  assert.match(dockerfile, /COPY --chown=node:node packages\/core packages\/core/);
  assert.match(dockerfile, /COPY --chown=node:node packages\/client packages\/client/);
  assert.doesNotMatch(dockerfile, /COPY --from=build \/repo\/node_modules\/ssh2/);
});

test('gateway runtime is non-root, timezone-aware, and exposes a real healthcheck', () => {
  assert.match(runtimeStage, /^USER node$/m);
  assert.match(runtimeStage, /install -d -m 0700 -o node -g node \/data/);
  assert.match(runtimeStage, /^VOLUME \["\/data"\]$/m);
  assert.match(runtimeStage, /^ENV[\s\S]*?AIDB_HOME=\/data/m);
  assert.match(runtimeStage, /TZ=Asia\/Shanghai/);
  assert.match(runtimeStage, /apt-get install -y --no-install-recommends tzdata/);
  assert.match(runtimeStage, /HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3/);
  assert.match(runtimeStage, /\/api\/health/);
  assert.match(runtimeStage, /body\.ok !== true/);
  assert.match(runtimeStage, /AbortSignal\.timeout\(4000\)/);
});

test('gateway CMD probes OpenSSL support and always executes Node directly', () => {
  assert.match(runtimeStage, /node --openssl-legacy-provider --version >\/dev\/null 2>&1/);
  assert.match(runtimeStage, /then exec node --openssl-legacy-provider dist\/index\.js/);
  assert.match(runtimeStage, /else exec node dist\/index\.js/);
});

test('build-only compilers do not ship in the runtime stage', () => {
  assert.match(dockerfile.split(/\nFROM\s+/)[1] ?? '', /apt-get install -y --no-install-recommends python3 make g\+\+/);
  assert.doesNotMatch(runtimeStage, /python3|make|g\+\+/);
  assert.doesNotMatch(runtimeStage, /npm ci/);
});

test('Docker smoke command exercises a read-only non-root container and native DuckDB binding', () => {
  assert.match(dockerSmoke, /'--read-only'/);
  assert.match(dockerSmoke, /'--cap-drop', 'ALL'/);
  assert.match(dockerSmoke, /'--security-opt', 'no-new-privileges'/);
  assert.match(dockerSmoke, /AIDB_SECRET_CANARY/);
  assert.match(dockerSmoke, /AIDB_TOKEN/);
  assert.match(dockerSmoke, /\/api\/health\/ready/);
  assert.match(dockerSmoke, /authorization: 'Bearer ' \+ process\.env\.AIDB_SMOKE_TOKEN/);
  assert.match(dockerSmoke, /process\.getuid\(\)/);
  assert.match(dockerSmoke, /Asia\/Shanghai/);
  assert.match(dockerSmoke, /DuckDBInstance\.create\(':memory:'\)/);
  assert.match(dockerSmoke, /body\.checks\.backups !== 'ok'/);
});

test('Docker build context excludes secrets, host dependencies, and unrelated app sources', () => {
  for (const pattern of [
    '.npmrc',
    '**/node_modules/**',
    '**/.env',
    '**/.env.*',
    '**/*.keystore',
    '**/*.jks',
    '**/*.p12',
    '**/credentials.json',
    '**/local.properties',
    '**/.xcode.env.local',
    '**/secrets/**',
    'apps/mobile/**',
    '!apps/mobile/package.json',
    'apps/desktop/**',
    '!apps/desktop/package.json',
    'docs/**',
    'apps/gateway/test/**',
  ]) {
    assert.ok(dockerignore.split(/\r?\n/).includes(pattern), `missing .dockerignore rule ${pattern}`);
  }
  assert.ok(!dockerignore.split(/\r?\n/).includes('package-lock.json'));
  assert.ok(!dockerignore.split(/\r?\n/).includes('packages/client/**'));
});
