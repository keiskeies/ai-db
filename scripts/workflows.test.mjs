#!/usr/bin/env node
// Static governance for service wiring, support metadata and delivery claims.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const json = (file) => JSON.parse(read(file));
const workflow = (file) => yaml.load(read(file));
const sorted = (values) => [...values].sort();
const actionPins = (job) => new Map(
  job.steps.filter((step) => step.uses).map((step) => {
    const [name, sha] = step.uses.split('@');
    return [name, sha];
  }),
);

const ci = workflow('.github/workflows/ci.yml');
const external = workflow('.github/workflows/external-engines.yml');
const liveJob = external.jobs.contracts;
const liveStep = liveJob.steps.find((step) => step.name === 'Run live engine contracts');
const selectedFiles = sorted([...liveStep.run.matchAll(/apps\/gateway\/test\/[a-z0-9-]+\.test\.ts/g)].map((match) => match[0]));

const expectedServices = {
  mysql: { image: 'mysql:8.4.6', port: '3306:3306', health: 'mysqladmin ping' },
  postgres: { image: 'postgres:17.6-alpine', port: '5432:5432', health: 'pg_isready' },
  mongodb: { image: 'mongo:8.0.4', port: '27017:27017', health: 'mongosh' },
  'redis-stack': { image: 'redis/redis-stack-server:7.4.0-v10', port: '6379:6379', health: 'redis-cli ping' },
};
const expectedLiveFiles = sorted([
  'apps/gateway/test/agent-transaction.test.ts',
  'apps/gateway/test/external-engine-readonly.test.ts',
  'apps/gateway/test/mysql-transaction.test.ts',
  'apps/gateway/test/tx-reclaim.test.ts',
  'apps/gateway/test/nosql.test.ts',
  'apps/gateway/test/nosql-http.test.ts',
  'apps/gateway/test/redis-stack.test.ts',
  'apps/gateway/test/redis-key.test.ts',
  'apps/gateway/test/redis-keys-delete.test.ts',
]);

test('normal CI stays service-free while static wiring checks run', () => {
  assert.deepEqual(sorted(Object.keys(ci.on)), ['pull_request', 'push', 'workflow_call']);
  assert.equal(ci.jobs.quality.services, undefined);
  assert.equal(ci.permissions.contents, 'read');
  assert.equal(ci.jobs.quality.permissions.contents, 'read');
  const pkg = json('package.json');
  assert.match(pkg.scripts['verify:ci'], /npm run test:workflows/);
  assert.equal(pkg.scripts['test:workflows'], 'node --test scripts/workflows.test.mjs');
  const audit = ci.jobs.quality.steps.find((step) => step.name === 'Audit production and build dependencies');
  assert.equal(audit?.run, 'npm run audit:all');
  assert.match(pkg.scripts['audit:all'], /^npm audit --audit-level=low /);
  assert.doesNotMatch(pkg.scripts['audit:all'], /--omit=dev/);
});

test('external engines are manual, least-privilege and use pinned services', () => {
  assert.deepEqual(Object.keys(external.on), ['workflow_dispatch']);
  assert.deepEqual(external.permissions, { contents: 'read' });
  assert.deepEqual(liveJob.permissions, { contents: 'read' });
  assert.equal(liveJob['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(sorted(Object.keys(liveJob.services)), sorted(Object.keys(expectedServices)));
  for (const [name, expected] of Object.entries(expectedServices)) {
    const service = liveJob.services[name];
    assert.equal(service.image, expected.image, `${name} image must stay version-pinned`);
    assert.deepEqual(service.ports, [expected.port], `${name} host port must match test env`);
    assert.match(service.options, new RegExp(`--health-cmd=.*${expected.health.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(service.options, /--health-interval=/);
    assert.match(service.options, /--health-timeout=/);
    assert.match(service.options, /--health-retries=/);
  }
  assert.doesNotMatch(JSON.stringify(liveJob.services), /:latest(?:"|\\|\s|$)/);
});

test('every selected live test has a non-empty wired gate', () => {
  assert.deepEqual(selectedFiles, expectedLiveFiles);
  assert.match(liveStep.run, /--test-concurrency=1/);
  assert.match(liveStep.run, /--test-timeout=120000/);
  const requiredEnv = new Set();
  for (const file of selectedFiles) {
    const source = read(file);
    assert.ok(existsSync(join(root, file)), `${file} must exist`);
    assert.match(source, /\{\s*skip:/, `${file} must remain explicitly environment-gated`);
    for (const match of source.matchAll(/AIDB_TEST_[A-Z0-9_]+/g)) requiredEnv.add(match[0]);
  }
  assert.deepEqual(sorted(Object.keys(liveJob.env)), sorted(requiredEnv));
  for (const [name, value] of Object.entries(liveJob.env)) {
    assert.ok(String(value).trim(), `${name} must not be empty or silently skip its test`);
  }
  assert.equal(liveJob.env.AIDB_TEST_MYSQL_PASSWORD, liveJob.services.mysql.env.MYSQL_ROOT_PASSWORD);
  assert.equal(liveJob.env.AIDB_TEST_PG_TX_PASSWORD, liveJob.services.postgres.env.POSTGRES_PASSWORD);
  assert.equal(liveJob.env.AIDB_TEST_MYSQL_PORT, liveJob.services.mysql.ports[0].split(':')[0]);
  assert.equal(liveJob.env.AIDB_TEST_PG_TX_PORT, liveJob.services.postgres.ports[0].split(':')[0]);
  assert.equal(liveJob.env.AIDB_TEST_MONGO_PORT, liveJob.services.mongodb.ports[0].split(':')[0]);
  assert.equal(liveJob.env.AIDB_TEST_REDIS_PORT, liveJob.services['redis-stack'].ports[0].split(':')[0]);
  assert.equal(liveJob.env.AIDB_TEST_REDIS_STACK_PORT, liveJob.services['redis-stack'].ports[0].split(':')[0]);
});

test('action pins match normal CI and checkout does not persist credentials', () => {
  const normalPins = actionPins(ci.jobs.quality);
  const livePins = actionPins(liveJob);
  for (const action of ['actions/checkout', 'actions/setup-node']) {
    assert.match(livePins.get(action), /^[0-9a-f]{40}$/);
    assert.equal(livePins.get(action), normalPins.get(action), `${action} pin drifted from CI`);
  }
  const checkout = liveJob.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkout.with['persist-credentials'], false);
});

test('root, MCP and release metadata agree without duplicating mobile versions', () => {
  const pkg = json('package.json');
  const mcp = json('packages/aidb-mcp/package.json');
  assert.equal(mcp.version, pkg.version);
  assert.equal(mcp.engines.node, pkg.engines.node);
  assert.equal(pkg.engines.node, '>=22.13');
  const mcpReadme = read('packages/aidb-mcp/README.md');
  assert.ok(mcpReadme.includes(`Node.js ≥ ${pkg.engines.node.replace('>=', '')}`));
  assert.doesNotMatch(mcpReadme, /Node\.js ≥ 22\.(?!13\b)\d+/, 'MCP runtime documentation must match the package engine');

  const release = read('README.md').match(/releases\/tag\/(v\d+\.\d+\.\d+)"><img alt="Release (v\d+\.\d+\.\d+)"/);
  assert.ok(release, 'release link and image alt must be paired');
  assert.equal(release[1], `v${pkg.version}`);
  assert.equal(release[2], release[1]);

  const matrix = read('docs/09-multi-engine.md');
  assert.ok(matrix.includes(`版本基线：${pkg.version}`));
  assert.ok(matrix.includes(`Node.js ≥ ${pkg.engines.node.replace('>=', '')}`));
  assert.ok(read('SUPPORT.md').includes(pkg.version));
  assert.ok(read('SUPPORT.md').includes(pkg.engines.node.replace('>=', '')));
});

test('support matrix accounts for every external-instance gate and mocked boundary', () => {
  const matrix = read('docs/09-multi-engine.md');
  const testDir = join(root, 'apps/gateway/test');
  const gated = readdirSync(testDir).filter((file) => file.endsWith('.test.ts') && /AIDB_TEST_[A-Z0-9_]+/.test(readFileSync(join(testDir, file), 'utf8')));
  for (const file of gated) assert.ok(matrix.includes(`\`${file}\``), `support matrix omits ${file}`);
  assert.ok(matrix.includes('`recon-redis.test.ts`'), 'legacy Redis recon gate must be documented separately');
  for (const file of ['mysql-metadata.test.ts', 'postgres-metadata.test.ts', 'oracle-metadata.test.ts', 'redis-cluster.test.ts', 'cassandra-legacy.test.ts', 'clickhouse-timeout.test.ts']) {
    assert.ok(matrix.includes(`\`${file}\``), `mocked boundary omits ${file}`);
  }
  for (const token of ['workflow_dispatch', '真实', 'mock', 'opt-in', '未覆盖', 'Oracle', 'DM8', 'SSH']) {
    assert.ok(matrix.includes(token), `support matrix lacks ${token}`);
  }
});

test('commercial governance policies exist without invented contacts or guarantees', () => {
  const security = read('SECURITY.md');
  const support = read('SUPPORT.md');
  const privacy = read('PRIVACY.md');
  for (const [name, text] of Object.entries({ SECURITY: security, SUPPORT: support, PRIVACY: privacy })) {
    assert.ok(text.length > 500, `${name} must contain a substantive policy`);
  }
  assert.match(security, /GitHub[\s\S]*private vulnerability reporting/i);
  assert.match(security, /private reporting is unavailable/i);
  assert.match(security, /not a guaranteed SLA/i);
  assert.doesNotMatch(security, /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i, 'do not invent a security email');
  assert.match(support, /not a guaranteed SLA/i);
  assert.match(support, /latest published/i);
  for (const boundary of ['local', 'telemetry', 'model and embedding providers', 'pairing', 'SecureStore', 'backup', 'export', 'AES-256-GCM']) {
    assert.ok(privacy.toLowerCase().includes(boundary.toLowerCase()), `privacy policy lacks ${boundary} boundary`);
  }
});
