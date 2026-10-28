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
};
for (const [f, sections] of Object.entries(requiredSections)) {
  const text = read(f);
  for (const s of sections) text.includes(s) ? ok(`${f} § ${s}`) : fail(`${f} § ${s}`, 'section missing');
}

// 4. Agent tool inventory (30) defined in 04
const agentDoc = read('docs/04-ai-agent-design.md');
const toolRows = [...agentDoc.matchAll(/^\|\s*\d+\s*\|\s*`([a-z_]+)`\s*\|\s*(read|write|ddl|destructive|动态\*|ddl\/destructive)\s*\|/gm)].map((m) => ({ name: m[1], risk: m[2] }));
const expectedTools = ['list_connections','inspect_schema','search_objects','run_sql','run_mql','run_redis','run_cypher','run_cql','run_aql','vector_search','upsert_document','search_index','explain_sql','sample_rows','profile_column','create_table','alter_table','drop_object','manage_index','export_result','import_csv','backup_database','get_query_history','update_plan','memory_write','memory_search','audit_database','check_data_quality','render_chart','analyze_chart','forecast_chart','generate_data'];
const names = toolRows.map((t) => t.name);
if (names.length === 32) ok('32 agent tools documented'); else fail('32 agent tools documented', `found ${names.length}`);
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

// report
const passed = checks.filter((c) => c.ok).length;
console.log(`\nDocs contract: ${passed}/${checks.length} checks passed`);
for (const c of checks.filter((c) => !c.ok)) console.log(`  ✗ ${c.name} — ${c.detail}`);
console.log(failures.length ? `\nFAILED (${failures.length})` : '\nALL GREEN');
process.exit(failures.length ? 1 : 0);
