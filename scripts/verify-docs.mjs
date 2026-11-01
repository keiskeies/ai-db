#!/usr/bin/env node
// Docs contract verification: structure, cross-references, platform coverage, agent tool inventory.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const checks = [];
const ok = (name, detail = '') => checks.push({ name, ok: true, detail });
const fail = (name, detail) => { checks.push({ name, ok: false, detail }); failures.push(`${name}: ${detail}`); };

const required = [
  'README.md',
  'docs/00-product-overview.md',
  'docs/01-tech-architecture.md',
  'docs/02-feature-spec.md',
  'docs/03-ui-ux-design.md',
  'docs/04-ai-agent-design.md',
  'docs/05-data-and-api.md',
  'docs/06-delivery-and-verification.md',
  'docs/08-agent-accuracy-plan.md',
  'docs/11-command-workflows.md',
  'docs/12-bots-and-mcp.md',
  'docs/13-skill-host-plan.md',
  'docs/16-capability-contract.md',
];
for (const f of required) existsSync(join(root, f)) ? ok(`exists ${f}`) : fail(`exists ${f}`, 'missing');

const read = (f) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
const all = required.map((f) => [f, read(f)]);
const corpus = all.map(([, t]) => t).join('\n');

// 1. All five platforms covered
for (const p of ['Windows', 'macOS', 'Linux', 'Android', 'iOS']) {
  corpus.includes(p) ? ok(`platform ${p}`) : fail(`platform ${p}`, 'not mentioned');
}
// 2. Navicat reference
corpus.includes('Navicat') ? ok('navicat reference') : fail('navicat reference', 'missing');

// 3. Required sections per doc
const requiredSections = {
  'docs/00-product-overview.md': ['产品定位', '平台矩阵', '范围', '成功标准'],
  'docs/01-tech-architecture.md': ['关键决策', '系统架构', '关键流程', '多端交付', '安全模型'],
  'docs/02-feature-spec.md': ['连接管理', '对象浏览器', '数据网格', 'SQL 编辑器', '表设计器', '导入导出', '备份', '快捷键'],
  'docs/03-ui-ux-design.md': ['设计令牌', 'Agent 面板', '移动端', '空状态'],
  'docs/04-ai-agent-design.md': ['运行时循环', '工具目录', '权限模型', '记忆架构', '上下文组装', 'Provider', '安全与防护', '评估场景'],
  'docs/05-data-and-api.md': ['本地元数据库', 'HTTP API', '流式事件', '移动端本地存储'],
  'docs/06-delivery-and-verification.md': ['里程碑', '测试策略', '文档二次验证', '定义完成'],
  'docs/16-capability-contract.md': ['能力契约', '字段类型', '状态汇报', '开发计划'],
};
for (const [f, sections] of Object.entries(requiredSections)) {
  const text = read(f);
  for (const s of sections) text.includes(s) ? ok(`${f} § ${s}`) : fail(`${f} § ${s}`, 'section missing');
}

// 4. Agent tool inventory (30) defined in 04
const agentDoc = read('docs/04-ai-agent-design.md');
const toolRows = [...agentDoc.matchAll(/^\|\s*\d+\s*\|\s*`([a-z_]+)`\s*\|\s*(read|write|ddl|destructive|动态\*|ddl\/destructive)\s*\|/gm)].map((m) => ({ name: m[1], risk: m[2] }));
const expectedTools = ['list_connections','inspect_schema','search_objects','run_sql','run_mql','run_redis','run_cypher','run_cql','run_aql','vector_search','upsert_document','write_line_protocol','begin_transaction','commit_transaction','rollback_transaction','delete_documents','import_documents','create_collection','delete_collection','search_index','explain_sql','sample_rows','profile_column','create_table','alter_table','drop_object','manage_index','export_result','import_csv','backup_database','get_query_history','update_plan','memory_write','memory_search','audit_database','check_data_quality','render_chart','analyze_chart','forecast_chart','generate_data','schema_diff','recon_data','transfer_data','mcp_list_tools','mcp_list_servers','mcp_call','skill_list','skill_read','skill_write','skill_run','skill_list_files','skill_worker_run'];
const names = toolRows.map((t) => t.name);
if (names.length === 52) ok('52 agent tools documented'); else fail('52 agent tools documented', `found ${names.length}`);
for (const t of expectedTools) names.includes(t) ? ok(`tool ${t}`) : fail(`tool ${t}`, 'not in tool table');
for (const t of new Set(names)) if (!expectedTools.includes(t)) fail('tool inventory', `unexpected tool ${t}`);

// 5. Permission modes
for (const m of ['readonly', 'ask', 'auto', 'full']) agentDoc.includes(`\`${m}\``) || agentDoc.includes(`| \`${m}\``) ? ok(`permission ${m}`) : fail(`permission ${m}`, 'missing');

// 6. Memory layers
for (const m of ['工作记忆', '情景记忆', '语义记忆', '程序记忆']) corpus.includes(m) ? ok(`memory ${m}`) : fail(`memory ${m}`, 'missing');

// 7. API surface: agent + pairing + sse
const apiDoc = read('docs/05-data-and-api.md');
for (const p of ['/agent/sessions', '/agent/approvals', '/pair/claim', '/query', '/memories']) apiDoc.includes(p) ? ok(`api ${p}`) : fail(`api ${p}`, 'missing');
for (const ev of ['tool_call', 'tool_result', 'approval_required', 'plan', 'memory_used', 'done', 'aborted']) apiDoc.includes(`'${ev}'`) || apiDoc.includes(ev) ? ok(`event ${ev}`) : fail(`event ${ev}`, 'missing');

// 8. Internal markdown links resolve
for (const [f, text] of all) {
  for (const m of text.matchAll(/\]\(\.\/([^)#]+\.md)\)/g)) {
    const target = join(dirname(join(root, f)), m[1]);
    existsSync(target) ? ok(`link ${f} -> ${m[1]}`) : fail(`link ${f} -> ${m[1]}`, 'broken');
  }
}

// 9. Cross-doc consistency: engines, modes, tool count
for (const token of ['node:sqlite', 'mysql2', 'pg', 'Electron', 'Expo', 'CodeMirror']) corpus.includes(token) ? ok(`stack ${token}`) : fail(`stack ${token}`, 'missing');
const mentionsFull = (read('docs/02-feature-spec.md').match(/full|全自动/g) || []).length;
mentionsFull > 0 ? ok('feature spec references full mode') : fail('feature spec references full mode', 'missing');

// 10. Code contract (if code exists): tool registry must match docs
const toolFile = join(root, 'packages/core/src/agent/tools.ts');
if (existsSync(toolFile)) {
  const src = readFileSync(toolFile, 'utf8');
  for (const t of expectedTools) src.includes(`name: '${t}'`) || src.includes(`name: "${t}"`) ? ok(`code tool ${t}`) : fail(`code tool ${t}`, 'missing in tools.ts');
  for (const n of names) if (!expectedTools.includes(n)) fail('code tool mismatch', n);
} else {
  ok('code tool registry', 'not yet implemented (docs-only phase)');
}

// 10.1 声明了工具却没实现，运行期只会得到「未实现的工具」——契约脚本必须挡住
const executorFile = join(root, 'apps/gateway/src/executor.ts');
if (existsSync(executorFile)) {
  const src = readFileSync(executorFile, 'utf8');
  const dispatched = new Set([...src.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]));
  for (const t of expectedTools) dispatched.has(t) ? ok(`executor tool ${t}`) : fail(`executor tool ${t}`, 'declared but never dispatched in executor.ts');
  for (const c of dispatched) if (!expectedTools.includes(c)) fail('executor tool inventory', `unexpected case ${c}`);
} else {
  ok('executor dispatch', 'not yet implemented (docs-only phase)');
}

// 7. Capability matrix in docs/09 must equal capabilities in packages/core/src/engines.ts.
//    能力位是 UI/Agent 的唯一判断依据，文档与代码漂移会让按钮与行为不一致。
{
  const engines = await import('../packages/core/src/engines.ts');
  const flags = ['objectLifecycle', 'documentWrite', 'indexManage', 'fieldAdd', 'recordEdit', 'lineProtocolWrite', 'transactions'];
  const multi = read('docs/09-multi-engine.md');
  for (const flag of flags) {
    const row = multi.match(new RegExp(`^\\|\\s*${flag}\\s*\\|\\s*([^|]*)\\|\\s*$`, 'm'));
    if (!row) {
      fail(`capability ${flag} documented`, 'row missing in docs/09 capability table');
      continue;
    }
    const documented = row[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    const actual = engines.ENGINE_IDS.filter((id) => engines.engineMeta(id).capabilities[flag] === true).sort();
    JSON.stringify(documented) === JSON.stringify(actual)
      ? ok(`capability ${flag} matches code`)
      : fail(`capability ${flag} matches code`, `docs=[${documented.join(',')}] code=[${actual.join(',')}]`);
  }
}

// 8. Documented risk level must equal the ToolDefinition risk — 风险标错等于把破坏性操作写成只读。
{
  const { TOOLS } = await import('../packages/core/src/agent/tools.ts');
  const byName = new Map(TOOLS.map((t) => [t.name, t.risk]));
  for (const row of toolRows) {
    const documented = row.risk === '动态*' ? 'dynamic' : row.risk.replace('/', '-');
    const actual = byName.get(row.name);
    if (actual === undefined) {
      fail(`tool risk ${row.name}`, 'documented but not defined in tools.ts');
      continue;
    }
    const normalized = actual === 'dynamic' ? 'dynamic' : String(actual);
    normalized === documented
      ? ok(`tool risk ${row.name} matches code`)
      : fail(`tool risk ${row.name}`, `docs=${row.risk} code=${actual}`);
  }
}

// 9. Transport matrix in docs/09 must use exactly the transports that exist in code —
//    transport 决定走哪个驱动，写错等于文档承诺了一个连不上的协议。
{
  const engines = await import('../packages/core/src/engines.ts');
  const codeTransports = [...new Set(engines.ENGINE_IDS.map((id) => engines.engineMeta(id).transport))].sort();
  const multi = read('docs/09-multi-engine.md');
  const documented = new Set();
  for (const line of multi.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6) continue;
    const transport = cells[3];
    if (!transport || transport === 'Transport' || /^-+$/.test(transport)) continue;
    if (/^[a-z][a-z0-9-]*$/.test(transport)) documented.add(transport);
  }
  const docList = [...documented].sort();
  JSON.stringify(docList) === JSON.stringify(codeTransports)
    ? ok('transport matrix matches code')
    : fail('transport matrix matches code', `docs=[${docList.join(',')}] code=[${codeTransports.join(',')}]`);
}

// 10. 能力契约：12 个工具箱模块必须各有契约文件，且契约本身能通过自检。
//     契约是 Agent 认识「软件自带功能」的唯一来源，缺一个就等于该功能对模型隐身。
{
  const capabilitiesDir = join(root, 'packages/core/src/capabilities');
  const capabilityFiles = existsSync(capabilitiesDir)
    ? readdirSync(capabilitiesDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort()
    : [];
  const hub = read('apps/desktop/src/components/tools/ToolsHub.tsx');
  const hubIds = [...hub.matchAll(/\{ id: '([a-z-]+)', label:/g)].map((m) => m[1]);
  if (!hubIds.length) {
    fail('capability modules', 'ToolsHub.tsx 的 TOOL_LIST 解析不到模块 id');
  } else {
    const expected = new Set(
      hubIds.map((id) => ({ builder: 'query-builder', compare: 'schema-sync', datacompare: 'compare-data', objects: 'advanced-objects', agentcontext: 'agent-context' })[id] ?? id),
    );
    const actual = new Set(capabilityFiles);
    for (const id of expected) actual.has(id) ? ok(`capability ${id}`) : fail(`capability ${id}`, '缺少契约 JSON');
    for (const id of actual) expected.has(id) ? null : fail(`capability ${id}`, '契约没有对应的工具箱模块');
    capabilityFiles.length === expected.size
      ? ok('capability count matches toolbox')
      : fail('capability count matches toolbox', `contracts=${capabilityFiles.length} modules=${expected.size}`);
  }
  if (capabilityFiles.length) {
    const { CAPABILITIES } = await import('../packages/core/src/capabilities/index.ts');
    const { assertCapabilities } = await import('../packages/core/src/capabilities/validate.ts');
    const { TOOLS } = await import('../packages/core/src/agent/tools.ts');
    try {
      assertCapabilities(CAPABILITIES, TOOLS);
      ok('capability contracts pass self-check');
    } catch (err) {
      fail('capability contracts pass self-check', err?.message ?? String(err));
    }
    for (const capability of CAPABILITIES) {
      read('docs/16-capability-contract.md').includes(capability.id)
        ? ok(`capability ${capability.id} documented`)
        : fail(`capability ${capability.id} documented`, '未出现在 docs/16');
    }
  }

  // 10b. 端点字段漂移守卫：已接契约的端点，它实际读取的 `input.*` 字段必须与契约声明一致。
  //      契约是校验的唯一来源，端点若读了契约里没有的字段，那个字段永远不会被校验（默认 undefined）；
  //      契约若声明了端点不读的字段，则是白声明、且会误导 Agent 去填。两种都是静默失败。
  const routesSource = read('apps/gateway/src/features/routes.ts');
  const routeLines = routesSource.split('\n');
  const routeCalls = [];
  routeLines.forEach((line, index) => {
    const matched = line.match(/const input = capabilityBody\('([a-z-]+)',/);
    if (matched) routeCalls.push({ id: matched[1], start: index });
  });
  if (!routeCalls.length) {
    fail('migrated endpoints match their contracts', 'routes.ts 里找不到任何 capabilityBody 调用');
  } else {
    const { getCapability } = await import('../packages/core/src/capabilities/index.ts');
    // 按端点（router. 开头）切块，避免 /transfer 与 /transfer/stream 共用契约时互相污染
    const blockStarts = routeLines.map((line, index) => (line.trimStart().startsWith('router.') ? index : -1)).filter((i) => i >= 0);
    const blockOf = (line) => {
      let best = -1;
      for (const start of blockStarts) if (start <= line) best = start;
      return best;
    };
    const readByCapability = new Map();
    for (const call of routeCalls) {
      const blockStart = blockOf(call.start);
      const nextBlock = blockStarts.find((start) => start > blockStart) ?? routeLines.length;
      const block = routeLines.slice(blockStart, nextBlock).join('\n');
      const keys = new Set([...block.matchAll(/input\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]));
      const existing = readByCapability.get(call.id) ?? new Set();
      for (const key of keys) existing.add(key);
      readByCapability.set(call.id, existing);
    }
    for (const [id, readKeys] of readByCapability) {
      const capability = getCapability(id);
      if (!capability) {
        fail(`endpoint ${id} field drift`, `引用了不存在的契约 ${id}`);
        continue;
      }
      const declared = new Set(capability.fields.map((field) => field.key));
      const undeclared = [...readKeys].filter((key) => !declared.has(key)).sort();
      const unread = [...declared].filter((key) => !readKeys.has(key)).sort();
      undeclared.length === 0 && unread.length === 0
        ? ok(`endpoint ${id} fields match its contract`)
        : fail(
            `endpoint ${id} fields match its contract`,
            [undeclared.length ? `端点读了未声明字段: ${undeclared.join(',')}` : '', unread.length ? `契约声明但端点未读: ${unread.join(',')}` : '']
              .filter(Boolean)
              .join('；'),
          );
    }
  }
}

// report
const passed = checks.filter((c) => c.ok).length;
console.log(`\nDocs contract: ${passed}/${checks.length} checks passed`);
for (const c of checks.filter((c) => !c.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
console.log(failures.length ? `\nFAILED (${failures.length})` : '\nALL GREEN');
process.exit(failures.length ? 1 : 0);
