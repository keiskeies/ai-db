const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { execFileSync, spawn } = require('node:child_process');
const { SshKeyImportError } = require('./ssh-key-import.cjs');

const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');

function sourceBetween(startMarker, endMarker) {
  const start = main.indexOf(startMarker);
  const end = main.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing source block: ${startMarker}`);
  return main.slice(start, end);
}

function loadReadiness() {
  const context = { http, URL, Date, Promise, setTimeout, clearTimeout };
  vm.runInNewContext(`${sourceBetween('function waitForBridgeReady', '// spawnSync')}\nthis.wait = waitForBridgeReady;`, context);
  return context.wait;
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    await run(server.address().port);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test('Bridge readiness only accepts authenticated /api/health/ready, never public liveness', async () => {
  const wait = loadReadiness();
  const calls = [];
  await withServer((req, res) => {
    calls.push({ path: req.url, authorization: req.headers.authorization });
    if (req.url === '/api/health/ready' && req.headers.authorization === 'Bearer local-secret') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true,"status":"alive"}');
      return;
    }
    res.writeHead(req.url === '/api/health' ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{}');
  }, async (port) => {
    await wait(port, 'local-secret', 1500);
  });
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.path === '/api/health/ready'));
  assert.ok(calls.every((call) => call.authorization === 'Bearer local-secret'));
});

test('Bridge readiness fails closed on 401/503 and does not expose the token in errors', async () => {
  const wait = loadReadiness();
  const paths = [];
  await withServer((req, res) => {
    paths.push(req.url);
    if (req.url === '/api/health') {
      res.writeHead(200);
      res.end('{"ok":true,"status":"alive"}');
      return;
    }
    res.writeHead(req.headers.authorization === 'Bearer expected-token' ? 503 : 401);
    res.end('{}');
  }, async (port) => {
    for (const token of ['wrong-token', 'expected-token']) {
      await assert.rejects(wait(port, token, 350), (err) => {
        assert.match(err.message, /authenticated ready/);
        assert.equal(err.message.includes(token), false);
        return true;
      });
    }
  });
  assert.ok(paths.length >= 2);
  assert.ok(paths.every((value) => value === '/api/health/ready'));
});

test('Bridge readiness retries a failed readiness check but never falls back to /api/health', async () => {
  const wait = loadReadiness();
  const paths = [];
  await withServer((req, res) => {
    paths.push(req.url);
    res.writeHead(paths.filter((value) => value === '/api/health/ready').length === 1 ? 503 : 200);
    res.end('{}');
  }, async (port) => {
    await wait(port, 'retry-token', 1500);
  });
  assert.deepEqual(paths, ['/api/health/ready', '/api/health/ready']);
});

test('Bridge readiness has a bounded timeout when the socket accepts but never responds', async () => {
  const wait = loadReadiness();
  const started = Date.now();
  await withServer(() => undefined, async (port) => {
    await assert.rejects(wait(port, 'hung-token', 180), /authenticated ready/);
  });
  assert.ok(Date.now() - started < 1500, 'timeout must cover the complete retry loop');
});

test('Bridge readiness rejects malformed credentials before issuing an HTTP request', async () => {
  const wait = loadReadiness();
  let requests = 0;
  await withServer((_req, res) => {
    requests += 1;
    res.writeHead(200);
    res.end('{}');
  }, async (port) => {
    const started = Date.now();
    await assert.rejects(wait(port, 'bad\nheader', 1000), (err) => {
      assert.equal(err.message.includes('bad\nheader'), false);
      return true;
    });
    assert.ok(Date.now() - started < 500, 'malformed credentials must not wait for the deadline');
    await assert.rejects(wait(0, 'token', 1000), /credentials are invalid/);
  });
  assert.equal(requests, 0);
});

test('Bridge startup and reuse both pass local credentials and discard a half-started process', () => {
  const block = sourceBetween('async function startEmbeddedGateway', 'async function createWindow');
  assert.equal((block.match(/waitForBridgeReady\(/g) || []).length, 2);
  assert.match(block, /waitForBridgeReady\(gatewayInfo\.port, gatewayInfo\.token\)/);
  assert.match(block, /waitForBridgeReady\(port, token\)/);
  assert.doesNotMatch(block, /waitForHealth\(|\/api\/health[`'"]/);
  assert.match(block, /gatewayProcess = null;\s*gatewayInfo = null;\s*child\.kill\(\)/);
  assert.doesNotMatch(sourceBetween('function waitForBridgeReady', '// spawnSync'), /console\.(?:log|error|warn)/);
});

function loadNavigation() {
  const opened = [];
  const context = {
    URL,
    Promise,
    shell: { openExternal: async (url) => { opened.push(url); } },
  };
  vm.runInNewContext(`${sourceBetween('const EXTERNAL_HTTPS_HOSTS', 'function readOpenTableArg')}\nthis.trusted = isTrustedAppUrl; this.guard = guardMainFrameNavigation;`, context);
  return { trusted: context.trusted, guard: context.guard, opened };
}

test('Main-frame navigation is locked to the exact local app origin, including dev origin', () => {
  const { trusted, guard } = loadNavigation();
  const origin = 'http://127.0.0.1:43127';
  for (const target of [origin, `${origin}/`, '/studio?view=data#table', `${origin}/studio`]) {
    assert.equal(trusted(target, origin), true, target);
  }
  const devOrigin = 'http://localhost:5180';
  assert.equal(trusted(`${devOrigin}/src/main.tsx`, devOrigin), true);
  for (const target of [
    'http://127.0.0.1:43128/',
    'http://localhost:43127/',
    'https://127.0.0.1:43127/',
    'http://evil.test/',
    'http://user@127.0.0.1:43127/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/system32/calc.exe',
    `blob:${origin}/id`,
    'about:blank',
  ]) {
    assert.equal(trusted(target, origin), false, target);
    let prevented = 0;
    assert.equal(guard({ preventDefault() { prevented += 1; } }, target, origin), false);
    assert.equal(prevented, 1, target);
  }
  let prevented = 0;
  assert.equal(guard({ preventDefault() { prevented += 1; } }, '/studio', origin), true);
  assert.equal(prevented, 0);
});

test('New windows are always denied; only allowlisted HTTPS links reach the shell', () => {
  const { opened } = loadNavigation();
  const handlerBody = main.match(/setWindowOpenHandler\(\(\{ url: target \}\) => \{([\s\S]*?)\n  \}\);/)?.[1];
  assert.ok(handlerBody);
  const handler = vm.runInNewContext(`({ url: target }) => {${handlerBody}}`, {
    URL,
    openAllowedExternalUrl(url) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') return false;
      opened.push(url);
      return true;
    },
  });
  for (const url of ['http://127.0.0.1:43127/', 'about:blank', 'file:///C:/secret', 'javascript:alert(1)']) {
    assert.equal(handler({ url }).action, 'deny');
  }
  assert.deepEqual(opened, []);
  assert.equal(handler({ url: 'https://github.com/keiskeies/ai-db' }).action, 'deny');
  assert.deepEqual(opened, ['https://github.com/keiskeies/ai-db']);
});

test('Navigation, redirect, webview and child-window guards are installed before the first load', () => {
  const create = sourceBetween('async function createWindow', '// 启动健康检查超时');
  const loadAt = create.indexOf('mainWindow.loadURL(url)');
  for (const marker of ["on('will-navigate'", "on('will-redirect'", "on('will-attach-webview'", 'setWindowOpenHandler']) {
    const at = create.indexOf(marker);
    assert.ok(at >= 0 && at < loadAt, `${marker} must precede loadURL`);
  }
  assert.match(create, /guardMainFrameNavigation\(event, target, trustedOrigin\)/);
  assert.match(create, /return \{ action: 'deny' \}/);
  assert.match(create, /trustedOrigin = devUrl\.origin/);
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

function loadAcl(options = {}) {
  const calls = [];
  const logs = [];
  const context = {
    URL,
    Promise,
    path,
    process: { platform: options.platform || 'win32', env: options.env || { SystemRoot: 'C:\\Windows' } },
    fs: options.fs || fs,
    SshKeyImportError,
    sshKeyImport: options.sshKeyImport || {},
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    console: { log(...args) { logs.push(args); }, warn(...args) { logs.push(args); }, error(...args) { logs.push(args); } },
    spawn(...args) {
      calls.push(args);
      if (options.realSpawn) return spawn(...args);
      if (options.spawnError) throw new Error('spawn detail must not be logged');
      const child = fakeChild();
      if (!options.neverClose) {
        setImmediate(() => {
          if (options.childError) child.emit('error', new Error('child detail must not be logged'));
          else child.emit('close', options.closeCode ?? 0);
        });
      }
      return child;
    },
  };
  const block = sourceBetween('const WINDOWS_ACL_TIMEOUT_MS', '// 渲染层生成菜单树');
  vm.runInNewContext(`${block}\nthis.harden = hardenWindowsPrivateKeyPath; this.hardenExisting = hardenExistingPrivateKeys; this.importKey = importPrivateKeyFile;`, context);
  return Object.assign(context, { calls, logs });
}

test('Windows ACL hardening removes inheritance, grants only three SIDs and verifies the result', async () => {
  const acl = loadAcl();
  await acl.harden('C:\\Users\\test\\AppData\\ssh-keys', 'Directory');
  await acl.harden('C:\\Users\\test\\AppData\\ssh-keys\\generated.key', 'File');
  assert.equal(acl.calls.length, 2);
  for (const [executable, args, spawnOptions] of acl.calls) {
    assert.match(executable, /powershell\.exe$/);
    assert.deepEqual(Array.from(args.slice(0, 4)), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    assert.match(args[4], /SetAccessRuleProtection\(\$true, \$false\)/);
    assert.match(args[4], /Get-Acl/);
    assert.match(args[4], /S-1-5-18/);
    assert.match(args[4], /S-1-5-32-544/);
    assert.doesNotMatch(args[4], /S-1-1-0|S-1-5-32-545|S-1-5-11/);
    assert.equal(spawnOptions.windowsHide, true);
    assert.equal(spawnOptions.env.AIDB_TOKEN, undefined);
  }
  assert.deepEqual(acl.calls.map((call) => call[2].env.AIDB_SSH_ACL_KIND), ['Directory', 'File']);
  assert.deepEqual(acl.logs, []);
});

test('Windows ACL hardening fails closed on nonzero exit, spawn error and timeout', async () => {
  for (const options of [{ closeCode: 1 }, { childError: true }, { spawnError: true }]) {
    const acl = loadAcl(options);
    await assert.rejects(acl.harden('C:\\keys\\generated.key', 'File'), (err) => {
      assert.equal(err.code, 'SSH_KEY_ACL_UNAVAILABLE');
      return true;
    });
    assert.deepEqual(acl.logs, []);
  }
  const timed = loadAcl({
    neverClose: true,
    setTimeout(fn, ms) {
      if (ms === 10_000) {
        queueMicrotask(fn);
        return -1;
      }
      return setTimeout(fn, ms);
    },
    clearTimeout() {},
  });
  await assert.rejects(timed.harden('C:\\keys\\generated.key', 'File'), (err) => {
    assert.equal(err.code, 'SSH_KEY_ACL_UNAVAILABLE');
    return true;
  });
});

test('Windows import hardens the directory before writing and removes a file whose ACL cannot be verified', async () => {
  const events = [];
  const removed = [];
  const directory = 'C:\\user-data\\ssh-keys';
  const imported = { path: `${directory}\\generated.key`, fileName: 'generated.key' };
  const acl = loadAcl({
    closeCode: 0,
    fs: { promises: { readdir: async () => [], unlink: async (file) => { removed.push(file); } } },
    sshKeyImport: {
      ensurePrivateKeyDirectory: async () => { events.push('ensure'); return directory; },
      importPrivateKeyFile: async () => { events.push('write'); return imported; },
    },
  });
  const originalSpawn = acl.spawn;
  acl.spawn = (...args) => {
    events.push(`acl:${args[2].env.AIDB_SSH_ACL_KIND}`);
    return originalSpawn(...args);
  };
  assert.equal(await acl.importKey('C:\\picked\\id_ed25519', 'C:\\user-data'), imported);
  assert.deepEqual(events, ['ensure', 'acl:Directory', 'write', 'acl:File']);
  assert.deepEqual(removed, []);

  events.length = 0;
  removed.length = 0;
  const failing = loadAcl({
    fs: { promises: { readdir: async () => [], unlink: async (file) => { removed.push(file); } } },
    sshKeyImport: {
      ensurePrivateKeyDirectory: async () => directory,
      importPrivateKeyFile: async () => imported,
    },
  });
  failing.spawn = (...args) => {
    const child = fakeChild();
    setImmediate(() => child.emit('close', args[2].env.AIDB_SSH_ACL_KIND === 'Directory' ? 0 : 1));
    return child;
  };
  await assert.rejects(failing.importKey('C:\\picked\\id_ed25519', 'C:\\user-data'), (err) => {
    assert.equal(err.code, 'SSH_KEY_ACL_UNAVAILABLE');
    return true;
  });
  assert.deepEqual(removed, [imported.path]);
});

test('POSIX import keeps the existing 0600/0700 path without invoking Windows ACL tooling', async () => {
  const events = [];
  const directory = '/user-data/ssh-keys';
  const imported = { path: `${directory}/generated.key` };
  const acl = loadAcl({
    platform: 'linux',
    fs: { promises: { unlink: async () => { throw new Error('unexpected cleanup'); } } },
    sshKeyImport: {
      ensurePrivateKeyDirectory: async () => { events.push('ensure'); return directory; },
      importPrivateKeyFile: async () => { events.push('import'); return imported; },
    },
  });
  assert.equal(await acl.importKey('/picked/id_ed25519', '/user-data'), imported);
  assert.deepEqual(events, ['ensure', 'import']);
  assert.deepEqual(acl.calls, []);
});

test('Windows startup refuses a symlinked existing private key', async () => {
  const acl = loadAcl({
    closeCode: 0,
    fs: {
      promises: {
        readdir: async () => [{ name: 'old.key' }],
        lstat: async () => ({ isSymbolicLink: () => true, isFile: () => false }),
      },
    },
    sshKeyImport: { ensurePrivateKeyDirectory: async () => 'C:\\user-data\\ssh-keys' },
  });
  await assert.rejects(acl.hardenExisting('C:\\user-data\\ssh-keys'), (err) => {
    assert.equal(err.code, 'SSH_KEY_STORE_FAILED');
    return true;
  });
});

test('Windows applies and verifies real restrictive ACLs on a temporary private-key directory and file', { skip: process.platform !== 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'aidb-electron-acl-'));
  const directory = path.join(root, 'ssh-keys');
  const file = path.join(directory, 'generated.key');
  try {
    fs.mkdirSync(directory);
    fs.writeFileSync(file, 'TEST-ONLY-PRIVATE-KEY');
    const acl = loadAcl({ env: process.env, realSpawn: true });
    await acl.harden(directory, 'Directory');
    await acl.harden(file, 'File');
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const verify = String.raw`
$ErrorActionPreference = 'Stop'
$actual = Get-Acl -LiteralPath $env:AIDB_VERIFY_PATH
$rules = @($actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$sids = @($rules | ForEach-Object { $_.IdentityReference.Value })
if (-not $actual.AreAccessRulesProtected -or $rules.Count -ne 3) { throw 'ACL is not restrictive' }
foreach ($broad in @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545')) { if ($sids -contains $broad) { throw 'broad ACL principal' } }
foreach ($rule in $rules) { if ($rule.IsInherited -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or $rule.FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'unexpected ACL rule' } }
`;
    for (const target of [directory, file]) {
      execFileSync(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', verify], {
        env: { ...process.env, AIDB_VERIFY_PATH: target },
        windowsHide: true,
        stdio: 'pipe',
      });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
