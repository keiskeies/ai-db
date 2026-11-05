# MCP Pairing Isolation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans (inline) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split MCP read-only credential pairing from mobile full-credential pairing into two non-crossing flows with independent endpoints, code pools, and server-hardcoded scopes.

**Architecture:** Add `/pair/mcp/start` (main-token gated) and `/pair/mcp/claim` (open) backed by a new `mcpPairCodes` Map; hardcode `mcp:readonly` on the MCP claim and `full` on the existing `/pair/claim`, ignoring any caller-supplied `scope`. Desktop gets a second pairing card; CLI posts to the new endpoint.

**Tech Stack:** TypeScript 5.7 / Node ≥22.5, Express 4, `node:test` + `tsx`, plain ESM `.mjs`, React 18 desktop.

**Spec:** Design doc agreed in-session ("MCP 配对与移动端配对彻底隔离", 2026-11-05), reproduced below as Global Constraints. No separate spec file exists; this plan is its own authority.

## Global Constraints

- Node `>=22.5`; `@aidb/mcp` declares the same.
- `devices.scope` values remain `'full'` and `'mcp:readonly'`; no migration needed.
- Endpoint table:
  | Endpoint | Auth | Code pool | Scope emitted |
  |---|---|---|---|
  | `POST /pair/start` | main token (existing) | `pairCodes` | — |
  | `POST /pair/claim` | open (existing) | `pairCodes` | `'full'` HARDCODED, ignore `body.scope` |
  | `POST /pair/mcp/start` | main token (NEW) | `mcpPairCodes` (NEW) | — |
  | `POST /pair/mcp/claim` | open (NEW) | `mcpPairCodes` | `'mcp:readonly'` HARDCODED |
- Both claim endpoints look up ONLY their own pool; cross-pool codes → `401 PAIR_INVALID`.
- Both start endpoints: `pairingCode()` (CSPRNG), `expiresIn: 300`, 5-min expiry, single-use, expiry cleanup on start.
- Rate-limit buckets: `start`, `claim`, `mcp-start`, `mcp-claim`; all via `allowPairHit` on `req.socket.remoteAddress`.
- `features.mcp === false` → both MCP endpoints `403 FEATURE_DISABLED`.
- `ApiDeps` gains `mcpPairCodes: Map<string, { expiresAt: number }>`; `createGateway` creates and injects it.
- Desktop: NEW state `mcpPairing` separate from `pairing`; NEW `startMcpPairing()`; NEW `api.pairMcpStart()`; NEW card in SettingsModal; all new strings via `t()`/`tr()` and added to en.json + legacy.ts.
- `@aidb/mcp` CLI: `runPair` posts to `/api/pair/mcp/claim`, body has NO `scope` field. Local-URL storage, token validation, credential file unchanged.
- Mobile `claimPairing()` unchanged (still `/pair/claim`, now hardcoded full).
- Breaking change (accepted): old `@aidb/mcp` posting `scope:'mcp:readonly'` to `/pair/claim` now silently receives a `full` token. Document it; package is unpublished.
- All MCP server diagnostics stay on stderr; stdout only JSON-RPC.
- Verification: `npm run typecheck`, `npm --workspace @aidb/gateway run test`, `npm --workspace @aidb/core run test`, `node --test packages/aidb-mcp/test/*.test.mjs`, `npm run verify:docs`, `npm run verify:i18n`.

## Review Focus

1. Cross-pool code redemption — MCP code at mobile claim and vice versa must be `401 PAIR_INVALID`. Test: Task 1.
2. Scope forgery — `scope:'full'` on MCP claim and `scope:'mcp:readonly'` on mobile claim must be ignored. Test: Task 1.
3. MCP start requires the main token. Test: Task 1.
4. `features.mcp` gate. Test: Task 1.
5. Old mobile flow unregressed (existing pairing.test.ts stays green). Test: Task 1 + Task 6.
6. CLI end-to-end against a live gateway using the new endpoint. Test: Task 5.
7. i18n completeness for the new desktop strings. Test: Task 4.

---

### Task 1: Gateway — independent MCP endpoints and hardcoded scopes

**Files:**
- Modify: `apps/gateway/src/routes.ts` (ApiDeps interface, new `MCP_*` endpoints, `/pair/claim` scope hardcode, open-path list)
- Modify: `apps/gateway/src/server.ts` (create + inject `mcpPairCodes`)
- Test: `apps/gateway/test/pair-mcp-isolation.test.ts` (new)

**Interfaces:**
- Consumes: `pairingCode()`, `pairCodes`, `allowPairHit`, `pairRateLimited`, `randomToken`, `hashToken`, `store.createDevice`, `pairingOrigin`.
- Produces: `POST /pair/mcp/start` → `{code, expiresIn, url, host, port}`; `POST /pair/mcp/claim` → `{token, device, bridge}`; `ApiDeps.mcpPairCodes`.

- [ ] **Step 1: Write failing test** (`pair-mcp-isolation.test.ts`, harness mirrors `pairing.test.ts`):
  - no-token `POST /pair/mcp/start` → 401
  - `/pair/mcp/start` (main token) → 200 with 6-digit code
  - MCP code → `POST /pair/mcp/claim` → 200, `device.scope === 'mcp:readonly'`
  - MCP code → `POST /pair/claim` → 401 `PAIR_INVALID`
  - mobile `/pair/start` code → `POST /pair/mcp/claim` → 401 `PAIR_INVALID`
  - `/pair/mcp/claim` with `scope:'full'` → still `mcp:readonly`
  - `/pair/claim` with `scope:'mcp:readonly'` → still `full`
  - both codes single-use (second claim → 401)
  - `features.mcp=false` (via `POST /settings`) → both MCP endpoints 403; restore after
  - mobile claim still returns a working `full` token (`GET /connections` → 200)

- [ ] **Step 2: Run it, expect FAIL** (endpoints 404 / scope forgery succeeds)

- [ ] **Step 3: Implement**
  - Add `mcpPairCodes: Map<string,{expiresAt:number}>` to `ApiDeps`; create in `createGateway` next to `pairCodes` and pass in deps.
  - Add `/pair/mcp/start` (main token via existing middleware; it is NOT in the open list), `/pair/mcp/claim` (add to open list).
  - Extract the shared claim body into a helper or duplicate ~25 lines; each endpoint uses its own pool and hardcodes its scope. Gate MCP endpoints on `store.getSettings().features.mcp`.
  - Change `/pair/claim` to `scope = 'full'` unconditionally; delete the `body.scope` read.
  - Open-path list: `req.path === '/pair/mcp/claim'` added; `/pair/mcp/start` NOT added (stays behind main token).

- [ ] **Step 4: Run test, expect PASS**; then run all existing `pairing.test.ts` + `mcp-readonly-scope.test.ts` + `mcp-server.test.ts` for regressions.

- [ ] **Step 5: Commit** `feat(pairing): isolate MCP pairing endpoints and hardcode device scopes`

### Task 2: CLI posts to the new MCP endpoint

**Files:**
- Modify: `packages/aidb-mcp/bin/pair.mjs`
- Test: `packages/aidb-mcp/test/pair.test.mjs`, `packages/aidb-mcp/test/pair-e2e.test.mjs`

**Interfaces:**
- Consumes: `runPair(io)` with injectable `fetch`; `credentialsFromClaim`.
- Produces: `runPair` POSTs to `${url}/api/pair/mcp/claim` with body `{code, deviceName, platform}` (NO scope).

- [ ] **Step 1: Update `pair.test.mjs`** harness to assert `fetch` was called with a URL ending `/api/pair/mcp/claim` and body without `scope`; add a test for that. Run → FAIL.
- [ ] **Step 2: Implement** — change the URL and drop `scope` from the JSON body.
- [ ] **Step 3: Update `pair-e2e.test.mjs`** — it uses a real gateway; after Task 1 the new endpoint exists, so it should pass unchanged (verify). If it posts directly, switch it.
- [ ] **Step 4: Run all package tests, expect PASS.**
- [ ] **Step 5: Commit** `feat(mcp): pair against the isolated MCP endpoint`

### Task 3: Desktop MCP pairing card + api/store

**Files:**
- Modify: `apps/desktop/src/lib/api.ts`, `apps/desktop/src/store.ts`, `apps/desktop/src/i18n/legacy.ts`, `apps/desktop/src/i18n/locales/en.json`
- Test: `npm run typecheck` + `npm run verify:i18n`

**Interfaces:**
- Produces: `api.pairMcpStart(): Promise<{code,expiresIn,host,port,url?}>`; store state `mcpPairing?: {code,expiresIn,host,port,url?}`; `startMcpPairing(): Promise<void>`.

- [ ] **Step 1: Add api + store** — `pairMcpStart` posts `/pair/mcp/start`; `mcpPairing` state + `startMcpPairing` mirroring `startPairing` but setting `mcpPairing`.
- [ ] **Step 2: Add i18n keys** to legacy.ts (zh + en sections) and en.json: `mcpPairing`, `startMcpPairing`, `mcpPairHint`, `mcpPairingCode` / hint strings used by the card. Use `tr()` for inline Chinese so `scan-unwrapped.mjs --strict` passes.
- [ ] **Step 3: Run typecheck + verify:i18n**, expect PASS.

### Task 4: Desktop UI card

**Files:**
- Modify: `apps/desktop/src/components/SettingsModal.tsx`

**Interfaces:**
- Consumes: `mcpPairing`, `startMcpPairing` from store, `t`/`tr`.
- Produces: a card below the existing mobile pairing card with a generate button, 6-digit code, 5-min badge, copy button, hint text pointing at `npx -y @aidb/mcp pair`. No QR.

- [ ] **Step 1: Add JSX** — reuse `setting-card` / `pair-panel` styles; separate state so generating one code does not clear the other.
- [ ] **Step 2: Run typecheck + verify:i18n**, expect PASS.
- [ ] **Step 3: Commit Tasks 3+4** `feat(desktop): add dedicated Claude Code pairing card`

### Task 5: Docs

**Files:**
- Modify: `docs/05-data-and-api.md`, `docs/12-bots-and-mcp.md` §4.5, `packages/aidb-mcp/README.md`

- [ ] **Step 1: Update** all three: new endpoint table, hardcoded scopes, code-pool isolation, `features.mcp` gate, explicit breaking-change note for old CLI, remove the stale `/pair/claim` `scope?` parameter from the API table.
- [ ] **Step 2: Run `npm run verify:docs`**, expect 391/391 (or note if the count legitimately changes).
- [ ] **Step 3: Commit** `docs: document isolated MCP pairing endpoints`

### Task 6: Full verification

- [ ] **Step 1: Run** `npm run typecheck`, `npm test` (gateway+core), `node --test packages/aidb-mcp/test/*.test.mjs`, `npm run verify:docs`, `npm run verify:i18n`, `cd packages/aidb-mcp && npm pack --dry-run --json`.
- [ ] **Step 2: Record** any pre-existing failure by name; all must be green.
- [ ] **Step 3: Commit** any leftover; confirm clean tree.

## Self-Review

- Spec coverage: endpoint table → Task 1; hardcoded scopes → Task 1; code-pool isolation → Task 1; features gate → Task 1; desktop card → Tasks 3/4; CLI → Task 2; mobile unchanged → Task 1 regression; breaking-change note → Task 5; tests → Tasks 1/2/6. All covered.
- Type consistency: `mcpPairCodes` defined once in Task 1 and used in the same task; `mcpPairing`/`startMcpPairing`/`pairMcpStart` defined in Task 3 and consumed in Task 4.
- Review Focus items 1-7 map to Tasks 1, 2, 3/4, 6.
- Rulings: (1) No QR on the MCP card — CLI has no scanner; costs visual parity with mobile only. (2) `/pair/mcp/start` reuses the main-token middleware rather than a separate secret (option A, not B) — the user chose A. (3) Old CLI silently getting `full` is accepted as an intentional breaking change since the package is unpublished. (4) Desktop MCP card shows no `bridge.url` in a QR but does display the address for the CLI prompt.
