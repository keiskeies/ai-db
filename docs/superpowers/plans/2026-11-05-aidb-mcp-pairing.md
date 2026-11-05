# @aidb/mcp One-Time Pairing with Read-Only Scope — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the shared gateway token in Claude Code's MCP config with a one-time-paired, revocable, read-only device credential.

**Architecture:** Extend the existing mobile pairing protocol (6-digit code → device token, hash stored in SQLite) with a `scope` column; enforce `mcp:readonly` at the API auth middleware so the token can only reach the read-only `/agent/tools` bridge; ship a standalone npm package whose `pair` subcommand performs the one-time interactive step and whose default subcommand runs the existing stdio MCP server headlessly from a local `0600` credentials file.

**Tech Stack:** TypeScript 5.7 / Node.js ≥ 22.5 (repo floor), Express 4 router, `node:sqlite` `DatabaseSync`, `node:crypto`, `node:test` + `tsx`, plain ESM `.mjs` for the published package (zero runtime dependencies).

**Spec:** The design doc agreed in this session (A 方案, 2026-11-05), reproduced as the Global Constraints and Task interfaces below. No separate spec file was written; this plan is its own authority for values.

## Global Constraints

- Node.js `>=22.5`; repo `package.json` `engines.node` is `>=22.5` — the new package MUST declare the same.
- The published package MUST have **zero runtime dependencies** (only Node built-ins); it is plain ESM `.mjs`.
- The published package MUST live in `packages/aidb-mcp/` with its own `package.json` (`private` absent, `name`: `@aidb/mcp`, `version`: `0.1.0`), `files`: `["bin/","README.md","LICENSE"]`, `bin`: `{"aidb-mcp":"./bin/aidb-mcp.mjs"}`, `type`: `"module"`, `license`: `"MIT"`, `publishConfig`: `{"access":"public","registry":"https://registry.npmjs.org"}`.
- Root `.npmrc` points at `https://registry.npmmirror.com`; every publish command in docs MUST pass `--registry=https://registry.npmjs.org`.
- `devices.scope` values: `'full'` (existing mobile behavior, DEFAULT for old rows) and `'mcp:readonly'`.
- Scope allowlist for `mcp:readonly` is exactly: `GET /health`, `GET /agent/tools`, `POST /agent/tools/:name`, `GET /capabilities`. Everything else `403 SCOPE_DENIED`.
- The existing read-only bridge rule (`risk !== 'read' → 403 TOOL_READ_ONLY` at `apps/gateway/src/routes.ts:2214`) MUST remain; scope is an additional gate, not a replacement.
- Credentials file: `%APPDATA%\aidb-mcp\credentials.json` on Windows, `$XDG_CONFIG_HOME/aidb-mcp/credentials.json` or `~/.config/aidb-mcp/credentials.json` elsewhere; file mode `0600`, dir mode `0700`; overridable by `AIDB_MCP_CREDENTIALS`.
- Credentials JSON shape: `{ "url": string, "token": string, "deviceId": string, "pairedAt": string }`. Token MUST NOT appear in Claude Code config, env vars, stdout, or logs.
- Legacy `AIDB_TOKEN` env support is retained as a fallback in the server (documented as not recommended).
- All MCP server diagnostics go to **stderr**; stdout carries only line-delimited JSON-RPC.
- Tests use `node --import tsx --test` (repo convention). Run `npm --workspace @aidb/gateway run test` and `npm --workspace @aidb/core run test` for verification.
- Do not modify the 52 tool definitions, drivers, Agent runtime, or the `/agent/tools/:name` read-only enforcement logic.

## Review Focus

1. **Scope bypass via other routes** — a `mcp:readonly` token hitting `POST /query`, `GET /connections`, `GET /settings`, `POST /mcp/servers` must be 403, not silently allowed. Test: Task 3.
2. **Scope bypass via WebSocket** — the same token connecting to `/ws` must be rejected (4401). Test: Task 4.
3. **Scope bypass via tool risk** — the same token calling a write tool through the bridge must remain 403 `TOOL_READ_ONLY`. Test: Task 3.
4. **Revocation** — `DELETE /devices/:id` immediately invalidates the credential. Test: Task 3.
5. **Old database upgrade** — an existing `aidb.db` without the `scope` column migrates automatically and existing mobile devices keep `'full'`. Test: Task 2.
6. **Pairing code single-use / expiry / rate limit** — unchanged behavior must not regress; `/pair/claim` with `scope` still consumes the code. Test: Task 3.
7. **Package tarball contents** — `npm pack --dry-run` must contain only `bin/`, `README.md`, `LICENSE` (no `.tools/`, no `release-v*/`). Test: Task 6.
8. **stdio cleanliness** — `pair` writes human text to stdout; `server` writes only JSON-RPC to stdout, diagnostics to stderr. Test: Task 6.

---

### Task 1: DeviceInfo type + devices.scope column

**Files:**
- Modify: `packages/core/src/types.ts:829-836`
- Modify: `apps/gateway/src/store.ts:106-109` (DDL), `:590-678` (`migrate`), `:2484-2512` (device CRUD)
- Test: `apps/gateway/test/device-scope-store.test.ts` (new)

**Interfaces:**
- Consumes: `SecretBox`/`DatabaseSync` store already constructed with `dbPath` + `secret` (see `apps/gateway/test/pairing.test.ts:12-42` for the harness pattern).
- Produces: `DeviceInfo.scope: 'full' | 'mcp:readonly'`; `Store.createDevice(input: { name: string; platform: string; tokenHash: string; scope?: 'full' | 'mcp:readonly' }): DeviceInfo`; `Store.findDeviceByTokenHash(hash: string): DeviceInfo | undefined` (now includes `scope`); `Store.listDevices(): DeviceInfo[]` (now includes `scope`).

- [ ] **Step 1: Write the failing test**

`apps/gateway/test/device-scope-store.test.ts`: construct a `Store` on a temp `aidb.db`; call `createDevice({name:'mcp',platform:'mcp',tokenHash:'h1',scope:'mcp:readonly'})` and assert `result.scope === 'mcp:readonly'`; call `createDevice({name:'phone',platform:'ios',tokenHash:'h2'})` and assert `result.scope === 'full'`; `findDeviceByTokenHash('h1').scope === 'mcp:readonly'`; `listDevices()` contains both with correct scopes; `revokeDevice(id)` then `findDeviceByTokenHash('h1')` is `undefined`. Also open a **second** `Store` over a database file created with a hand-written `CREATE TABLE devices (...)` lacking `scope`, pre-insert one row, and assert `listDevices()[0].scope === 'full'` and `findDeviceByTokenHash` returns `'full'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="device-scope-store"`
Expected: FAIL — `scope` is `undefined` / column does not exist.

- [ ] **Step 3: Implement**

Add `scope: 'full' | 'mcp:readonly'` to `DeviceInfo`. Add `scope TEXT NOT NULL DEFAULT 'full'` to the `devices` DDL. In `migrate()` add `this.ensureColumn('devices', 'scope', "TEXT NOT NULL DEFAULT 'full'")` (the helper at `store.ts:681` handles old DBs; keep `PRAGMA user_version = 9` unchanged). Extend `createDevice` to accept optional `scope` (default `'full'`) and insert it; map `scope` in `findDeviceByTokenHash` and `listDevices` (use `row.scope ?? 'full'` for robustness).

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="device-scope-store"`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add packages/core/src/types.ts apps/gateway/src/store.ts apps/gateway/test/device-scope-store.test.ts && git commit -m "feat(store): add devices.scope for paired credential scopes"`

---

### Task 2: /pair/claim accepts scope

**Files:**
- Modify: `apps/gateway/src/routes.ts:2571-2596`
- Test: `apps/gateway/test/pairing.test.ts` (append)

**Interfaces:**
- Consumes: `Store.createDevice` from Task 1.
- Produces: `POST /api/pair/claim` body accepts optional `scope: 'mcp:readonly'`; response `device.scope` reflects it; default `scope` is `'full'`.

- [ ] **Step 1: Write the failing test**

Append to `pairing.test.ts`: `/pair/start` → `/pair/claim` with `{ code, deviceName:'Claude Code', platform:'claude-code', scope:'mcp:readonly' }` → assert `claimed.body.device.scope === 'mcp:readonly'`; then `GET /devices` shows that device with `scope:'mcp:readonly'`. Add a second case: claim without `scope` → `device.scope === 'full'`, and the existing test at `:84-98` (device token can read `/connections`) still passes.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="pairing"`
Expected: FAIL — `device.scope` is `undefined`.

- [ ] **Step 3: Implement**

In `/pair/claim`, read `const scope = str(body.scope) === 'mcp:readonly' ? 'mcp:readonly' : 'full';` and pass it to `store.createDevice`. Keep `name`/`platform` handling and `randomToken(32)`/`hashToken` unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="pairing"`
Expected: PASS (including the pre-existing 4 tests).

- [ ] **Step 5: Commit**

`git add apps/gateway/src/routes.ts apps/gateway/test/pairing.test.ts && git commit -m "feat(pairing): allow claiming a mcp:readonly scoped device"`

---

### Task 3: Enforce scope in API auth middleware

**Files:**
- Modify: `apps/gateway/src/routes.ts:210-222`
- Test: `apps/gateway/test/mcp-readonly-scope.test.ts` (new)

**Interfaces:**
- Consumes: `DeviceInfo.scope` from Task 1, `/pair/claim scope` from Task 2.
- Produces: request-scoped flag `res.locals.mcpReadonly: boolean`; `403` body `{ error: { code: 'SCOPE_DENIED', message: string } }` for disallowed routes.

- [ ] **Step 1: Write the failing test**

New test file using the `pairing.test.ts` harness: pair with `scope:'mcp:readonly'`, then assert with that token:
  - `GET /agent/tools?for=mcp` → 200
  - `POST /agent/tools/run_sql` with `{args:{sql:'SELECT 1'}}` → 200 (the bridge itself may return a result; only status asserted)
  - `POST /agent/tools/create_table` → 403 with `error.code === 'TOOL_READ_ONLY'`
  - `GET /connections` → 403 `SCOPE_DENIED`
  - `GET /settings` → 403 `SCOPE_DENIED`
  - `POST /query` → 403 `SCOPE_DENIED`
  - `GET /mcp/servers` → 403 `SCOPE_DENIED`
  - `GET /health` → 200 (open route)
  - `GET /capabilities` → 200
  - `DELETE /devices/:id` with the **main** token → 204; then `GET /agent/tools?for=mcp` with the MCP token → 401.
  Also assert a `'full'` device token still gets 200 on `GET /connections` (no regression).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="mcp-readonly-scope"`
Expected: FAIL — `GET /connections` returns 200 instead of 403.

- [ ] **Step 3: Implement**

In the `router.use` auth middleware (`routes.ts:210`), replace `if (device) return next();` with: if `device.scope === 'mcp:readonly'`, compute `const p = req.path` and allow only `GET /health`, `GET /capabilities`, `GET /agent/tools`, and `POST` on `/agent/tools/` prefix; otherwise `403 SCOPE_DENIED`; set `res.locals.mcpReadonly = true` when scoped. Keep the open-paths line and main-token branch unchanged. Do not touch `/agent/tools/:name` risk filtering.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="mcp-readonly-scope"`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/gateway/src/routes.ts apps/gateway/test/mcp-readonly-scope.test.ts && git commit -m "feat(auth): enforce mcp:readonly device scope at the API boundary"`

---

### Task 4: Reject mcp:readonly on WebSocket

**Files:**
- Modify: `apps/gateway/src/server.ts:149-153`
- Test: `apps/gateway/test/mcp-readonly-ws.test.ts` (new)

**Interfaces:**
- Consumes: `DeviceInfo.scope` from Task 1.
- Produces: `authorized(token: string): boolean` returns `false` for `mcp:readonly` devices.

- [ ] **Step 1: Write the failing test**

Using `createGateway` + `listenRandom`, open a `ws` client to `ws://127.0.0.1:<port>/ws?token=<mcp:readonly token>` and assert the socket closes with code `4401`. Also assert a `'full'` device token connects successfully (close with a normal code afterwards).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="mcp-readonly-ws"`
Expected: FAIL — MCP token connects (close code not 4401).

- [ ] **Step 3: Implement**

In `authorized()`, replace `return Boolean(store.findDeviceByTokenHash(hashToken(token)));` with a lookup whose result must exist and `scope !== 'mcp:readonly'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace @aidb/gateway run test -- --test-name-pattern="mcp-readonly-ws"`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/gateway/src/server.ts apps/gateway/test/mcp-readonly-ws.test.ts && git commit -m "feat(auth): reject read-only MCP credentials on WebSocket"`

---

### Task 5: Desktop device list shows scope badge

**Files:**
- Modify: `apps/desktop/src/components/SettingsModal.tsx:1066-1076`
- Test: `apps/gateway/test/pairing.test.ts` already asserts `GET /devices` returns `scope` (Task 2); desktop UI has no test harness — verification is `npm run typecheck`.

**Interfaces:**
- Consumes: `DeviceInfo.scope` from Task 1, `useApp((s) => s.devices)` already typed as `DeviceInfo[]` (`apps/desktop/src/lib/api.ts:853`).
- Produces: a visible badge `只读 MCP` when `device.scope === 'mcp:readonly'`.

- [ ] **Step 1: Write the failing check**

No UI test framework exists; the failing condition is a typecheck error if the badge references a non-existent field. Add the badge markup first (Step 3 counts as both red and green here since `DeviceInfo.scope` exists from Task 1). Record in the ledger that this task's verification is `npm run typecheck` + visual inspection of the rendered row.

- [ ] **Step 2: Run typecheck to confirm baseline**

Run: `npm run typecheck` → expected PASS before the change (baseline).

- [ ] **Step 3: Implement**

In the device row (`SettingsModal.tsx:1068-1075`), next to the name/platform, render `<span className="badge">只读 MCP</span>` when `device.scope === 'mcp:readonly'`. Keep the existing revoke button and `已吊销` badge unchanged. Follow the surrounding `tr(...)`/`t(...)` i18n style used in that block.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck` → expected PASS.

- [ ] **Step 5: Commit**

`git add apps/desktop/src/components/SettingsModal.tsx && git commit -m "feat(ui): show read-only MCP badge in paired devices"`

---

### Task 6: @aidb/mcp package (pair CLI + server + publish metadata)

**Files:**
- Create: `packages/aidb-mcp/package.json`, `packages/aidb-mcp/LICENSE`, `packages/aidb-mcp/README.md`, `packages/aidb-mcp/bin/aidb-mcp.mjs`, `packages/aidb-mcp/bin/pair.mjs`, `packages/aidb-mcp/bin/server.mjs`, `packages/aidb-mcp/bin/credentials.mjs`, `packages/aidb-mcp/test/credentials.test.mjs`, `packages/aidb-mcp/test/stdio.test.mjs`
- Modify: `scripts/aidb-mcp-server.mjs` (replace with a thin deprecation wrapper that imports `../packages/aidb-mcp/bin/server.mjs` so the two cannot drift; keep its own test `apps/gateway/test/mcp-server.test.ts` passing)
- Modify: `docs/12-bots-and-mcp.md:159-178` (rewrite §4.5 for the pairing flow)
- Test: `apps/gateway/test/mcp-server.test.ts` (must still pass)

**Interfaces:**
- Consumes: `/api/pair/claim` (Task 2), `GET /api/agent/tools?for=mcp` + `POST /api/agent/tools/:name` (existing), `AIDB_URL` default `http://127.0.0.1:8787`.
- Produces:
  - CLI `aidb-mcp pair` — interactive, reads a 6-digit code from stdin, `POST /api/pair/claim` with `{code, deviceName:'Claude Code', platform:'claude-code', scope:'mcp:readonly'}`, writes credentials via `credentials.mjs`.
  - CLI `aidb-mcp` (no args) — headless stdio MCP server, identical JSON-RPC behavior to `scripts/aidb-mcp-server.mjs`.
  - `credentials.mjs` exports `credentialsPath(): string`, `readCredentials(): {url,token,deviceId,pairedAt}`, `writeCredentials(c): void` (atomic write, `0600`), honoring `AIDB_MCP_CREDENTIALS`.
  - `server.mjs` reads credentials (fallback `AIDB_TOKEN` env), writes diagnostics only to stderr.

- [ ] **Step 1: Write the failing tests**

`test/credentials.test.mjs`: with `AIDB_MCP_CREDENTIALS` pointed at a temp path, `writeCredentials({url:'http://x',token:'t',deviceId:'d',pairedAt:'p'})` → `readCredentials()` deep-equals it; on non-Windows assert file mode `0o600`; `readCredentials()` throws a clear error when missing.
`test/stdio.test.mjs`: spawn `bin/aidb-mcp.mjs` with `AIDB_MCP_CREDENTIALS` = a temp file containing a valid token, start a real `createGateway` on a random port (reuse `apps/gateway/test/helpers` pattern), send `initialize` and `tools/list` over stdin, assert `serverInfo.name === 'aidb-studio'` and that `run_sql` is listed while `create_table` is not; assert stdout contains only JSON-RPC lines.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test packages/aidb-mcp/test/*.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

  - `package.json` per Global Constraints; `LICENSE` = standard MIT text (© 2026 AiDB Studio contributors); `README.md` documents `npx -y @aidb/mcp pair`, the `mcpServers` config block with no secrets, revocation via desktop 设置→设备, and publish commands with `--registry=https://registry.npmjs.org`.
  - `credentials.mjs`: path resolution (Windows `APPDATA`, else `XDG_CONFIG_HOME`/`~/.config`), `mkdirSync({recursive:true, mode:0o700})`, `writeFileSync(..., {mode:0o600})`, JSON parse with validation, clear error messages to stderr via the caller.
  - `pair.mjs`: `readline` prompt `输入 AiDB 桌面端 设置→Bridge→为移动端配对 显示的 6 位配对码: `; validate `/^\d{6}$/`; `AIDB_URL` prompt/default; `fetch` claim; on failure print the server's `error.message`; on success write credentials and print `配对成功，设备: <deviceId>。现在可以在 Claude Code 中使用 npx -y @aidb/mcp`.
  - `server.mjs`: copy the current `scripts/aidb-mcp-server.mjs` logic (`initialize`, `ping`, `tools/list`, `tools/call`, `callTool`), but obtain `base`/`token` from `readCredentials()` (or `AIDB_URL`/`AIDB_TOKEN` env fallback); on missing/invalid credentials write one stderr line `Run: npx -y @aidb/mcp pair` and `exit(1)`; never write non-JSON-RPC to stdout.
  - `aidb-mcp.mjs`: shebang + dispatch `process.argv[2] === 'pair' ? import('./pair.mjs') : import('./server.mjs')`; unknown subcommand → usage on stderr, exit 1.
  - Replace `scripts/aidb-mcp-server.mjs` with a 3-line ESM wrapper re-exporting `../packages/aidb-mcp/bin/server.mjs` (keep the shebang and the `AIDB_TOKEN` env compatibility) so `apps/gateway/test/mcp-server.test.ts:65` keeps passing.
  - Rewrite `docs/12-bots-and-mcp.md` §4.5: pairing flow, scope allowlist, revocation, legacy `AIDB_TOKEN` note.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test packages/aidb-mcp/test/*.test.mjs && npm --workspace @aidb/gateway run test -- --test-name-pattern="mcp-server"`
Expected: PASS.

- [ ] **Step 5: Verify packaging**

Run: `cd packages/aidb-mcp && npm pack --dry-run --json` → assert the file list contains only `bin/*`, `README.md`, `LICENSE`, `package.json`. Then `npm pack` + `npm install -g ./aidb-mcp-0.1.0.tgz` is NOT executed (global install is a side effect outside the worktree); instead `node bin/aidb-mcp.mjs` with a bad credentials path is spawned and its stderr is asserted to contain `npx -y @aidb/mcp pair`.

- [ ] **Step 6: Commit**

`git add packages/aidb-mcp scripts/aidb-mcp-server.mjs docs/12-bots-and-mcp.md && git commit -m "feat(mcp): publishable @aidb/mcp package with one-time pairing"`

---

### Task 7: Full verification + docs/API table update

**Files:**
- Modify: `docs/05-data-and-api.md` (device/scope column in the API table, if it lists `/devices`)
- Test: whole suite

**Interfaces:**
- Consumes: everything above.
- Produces: green suite.

- [ ] **Step 1: Run the full verification**

Run: `npm run typecheck && npm test && npm --workspace @aidb/core run test && npm --workspace @aidb/gateway run test`. Record any pre-existing failure by name; do not fix unrelated failures, report them.
Also run `node --test packages/aidb-mcp/test/*.test.mjs` explicitly.

- [ ] **Step 2: Update the API doc**

Add `scope` to the `/devices` response description and note the `mcp:readonly` restriction. Only if `docs/05-data-and-api.md` actually documents devices; otherwise note "no doc change needed" in the ledger.

- [ ] **Step 3: Commit**

`git add -A && git commit -m "docs: document read-only MCP device scope"` (only if Step 2 changed a file).

---

## Self-Review notes

- **Spec coverage:** §2 data model → Task 1; §3 scope enforcement → Task 3 + Task 4; §4 pairing → Task 2; §5 CLI/credentials → Task 6; §6 sequence → Task 6 stdio test; §7 file list → Tasks 1–6; §8 acceptance tests → Tasks 1–4, 6; §9 publish metadata → Task 6. All covered.
- **Type consistency:** `DeviceInfo.scope` (Task 1) is consumed by Tasks 2, 3, 4, 5 under the same name/type; `createDevice` signature is defined once in Task 1 and used in Tasks 2/3.
- **Proportion:** code bodies are limited to the signature-level descriptions; the one place with real logic (scope allowlist) is specified as an exact 4-item list, not transcribed as a program.
- **Rulings:** (1) `GET /capabilities` added to the allowlist because MCP clients may probe it; it is read-only metadata with no secrets. (2) `GET /health` is already an open route but listed for clarity. (3) No `user_version` bump: `ensureColumn` is idempotent and this repo already uses it for additive columns (`store.ts:612-620`), avoiding a migration for existing installs. (4) The desktop UI task has no automated UI test (no harness exists) — verification is typecheck plus the API-level test from Task 2 that proves `scope` reaches the UI's data source.
