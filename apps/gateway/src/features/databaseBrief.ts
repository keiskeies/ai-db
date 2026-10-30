import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AgentContextBundle,
  ColumnInfo,
  ConnectionConfig,
  DatabaseSchema,
  LlmProvider,
  Memory,
  TableInfo,
} from '@aidb/core';

/**
 * AI_DB.md 是一份“老员工交接手册”，不是数据字典：
 * - 清单必须全量、确定性生成；模型只能加注，不能删表。
 * - schema / 工具结果是事实，本文件只是提示；因此不存在“没写=不存在”。
 * - 自动段落每次重跑全量刷新；只有 dataflow / custom 两个 manual 段落保留。
 * - 段落仍带内容哈希，用于自检写盘字节是否与生成内容一致，不作为“保留旧内容”的依据。
 */

export interface BriefTableAnnotation {
  table: string;
  purpose?: string;
  grain?: string;
  notes?: string;
}

export interface BriefJoinAnnotation {
  leftTable: string;
  leftColumn: string;
  rightTable: string;
  rightColumn: string;
  cardinality?: '1:1' | '1:N' | 'N:1' | 'N:M';
  note?: string;
}

export interface BriefMetricAnnotation {
  name: string;
  definition?: string;
  sql?: string;
}

export interface BriefRecipeAnnotation {
  question: string;
  sql?: string;
  tables?: string[];
}

export interface BriefAnnotations {
  business?: string;
  tables: BriefTableAnnotation[];
  joins: BriefJoinAnnotation[];
  metrics: BriefMetricAnnotation[];
  recipes: BriefRecipeAnnotation[];
  pitfalls: string[];
  performance: string[];
}

export interface TableFact {
  displayName: string;
  name: string;
  schemaName?: string;
  table: TableInfo;
  fingerprint: string;
}

export interface JoinEdge {
  from: string;
  fromColumn: string;
  to: string;
  toColumn: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  source: 'fk' | 'context' | 'model';
  note?: string;
}

export interface BriefMeta {
  generatedAt?: string;
  schemaHash?: string;
  annotations?: 'model' | 'none';
  reviewed?: boolean;
  tableCount?: number;
  coreTables?: number;
  connection?: string;
  database?: string;
  engine?: string;
}

export interface BriefDrift {
  added: string[];
  removed: string[];
  changed: string[];
  unknown: boolean;
}

export interface LoadedBrief {
  path: string;
  markdown: string;
  digest: string;
  meta: BriefMeta;
  drift: BriefDrift;
  inventory: string[];
}

export interface BriefInput {
  connection: ConnectionConfig;
  schemas: DatabaseSchema[];
  bundle?: AgentContextBundle;
  glossary?: Memory[];
  sqlExamples?: Memory[];
  history?: Array<{ sql: string; status?: string }>;
  provider?: LlmProvider;
  providerLabel?: string;
  signal?: AbortSignal;
  home: string;
  /** 用户在 /init 后面指定的目录或文件。 */
  requestedPath?: string;
  /** 上一次保存的路径（注册表），未指定目录时沿用。 */
  storedPath?: string;
  existing?: string;
}

export interface BriefResult {
  markdown: string;
  path: string;
  schemaHash: string;
  stats: {
    tables: number;
    views: number;
    coreTables: string[];
    joins: number;
    metrics: number;
    recipes: number;
    annotations: 'model' | 'none';
    annotationError?: string;
    preservedSections: string[];
    tableNames: string[];
  };
}

const KEY_TABLE = /(order|user|customer|product|item|payment|pay|refund|account|transaction|invoice|inventory|stock|shipment|delivery|cart|member|tenant|org|company)/i;
const MAX_CORE_TABLES = 20;
const ANNOTATION_TIMEOUT_MS = 120_000;
const DIGEST_CHARS = 12_000;

function hash(value: string, length = 12): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function cell(value: unknown): string {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

function normalizeType(type: string): string {
  return String(type ?? '').trim().toLowerCase();
}

function stripQuote(name: string): string {
  return name.replace(/^["`[]|["`\]]$/g, '').trim();
}

function lastSegment(name: string): string {
  const parts = stripQuote(name).split('.');
  return stripQuote(parts[parts.length - 1] ?? name);
}

export function tableSignature(table: TableInfo): string {
  const columns = [...(table.columns ?? [])]
    .map((column) => `${column.name}:${normalizeType(column.type)}:${column.nullable ? 'null' : 'notnull'}:${column.primaryKey ? 'pk' : ''}`)
    .sort()
    .join(';');
  const foreignKeys = [...(table.foreignKeys ?? [])]
    .map((fk) => `${fk.columns.join('+')}>${fk.refTable}.${fk.refColumns.join('+')}`)
    .sort()
    .join(';');
  const indexes = [...(table.indexes ?? [])]
    .map((index) => `${index.name}:${index.columns.join('+')}:${index.unique ? 'u' : ''}`)
    .sort()
    .join(';');
  return hash(`${table.type}|${columns}|${foreignKeys}|${indexes}`);
}

export function schemaFingerprint(schemas: DatabaseSchema[]): string {
  const parts = flattenTables(schemas)
    .map((fact) => `${fact.displayName}:${fact.fingerprint}`)
    .sort();
  return hash(parts.join('|'), 16);
}

export function flattenTables(schemas: DatabaseSchema[]): TableFact[] {
  const multiDb = schemas.length > 1;
  const facts: TableFact[] = [];
  for (const schema of schemas) {
    for (const table of schema.tables ?? []) {
      const schemaName = table.schema || (multiDb ? schema.name : undefined);
      facts.push({
        displayName: schemaName ? `${schemaName}.${table.name}` : table.name,
        name: table.name,
        schemaName,
        table,
        fingerprint: tableSignature(table),
      });
    }
  }
  return facts;
}

export function tableMentionsFromSql(sql: string): string[] {
  const cleaned = String(sql ?? '')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ');
  const out = new Set<string>();
  const pattern = /\b(?:from|join)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][\w$]*))?)/gi;
  for (const match of cleaned.matchAll(pattern)) {
    const name = lastSegment(match[1] ?? '');
    if (name && !/^select$/i.test(name)) out.add(name);
  }
  return [...out];
}

export function historyTableCounts(history: Array<{ sql: string; status?: string }> = []): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of history) {
    if (item.status && !/^(ok|success|succeeded|done)$/i.test(item.status)) continue;
    for (const name of tableMentionsFromSql(item.sql)) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function relationsFor(bundle: AgentContextBundle | undefined, table: string): number {
  if (!bundle) return 0;
  return bundle.relations.filter((relation) => relation.leftTable === table || relation.rightTable === table).length;
}

/** 核心表只决定叙事深度，不决定是否存在；附录始终全量。 */
export function selectCoreTables(
  schemas: DatabaseSchema[],
  bundle?: AgentContextBundle,
  historyCounts: Map<string, number> = new Map(),
  limit = MAX_CORE_TABLES,
): TableFact[] {
  const facts = flattenTables(schemas);
  if (!facts.length) return [];
  const incoming = new Map<string, number>();
  for (const fact of facts) {
    for (const fk of fact.table.foreignKeys ?? []) {
      const target = lastSegment(fk.refTable);
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
    }
  }
  const scored = facts.map((fact) => {
    const table = fact.table;
    const meta = bundle?.tableMeta[fact.name] ?? bundle?.tableMeta[fact.displayName];
    let score = 0;
    score += Math.min(8, (table.foreignKeys?.length ?? 0) * 1.5);
    score += Math.min(8, (incoming.get(fact.name) ?? 0) * 1.5);
    score += table.rowEstimate ? Math.min(5, Math.log10(table.rowEstimate + 1)) : 0;
    score += Math.min(8, (historyCounts.get(fact.name) ?? 0) * 2);
    score += meta ? 6 : 0;
    score += Math.min(3, relationsFor(bundle, fact.name) * 0.75);
    if (KEY_TABLE.test(fact.name)) score += 1.5;
    if (table.comment) score += 1;
    if (table.type === 'view') score -= 1;
    return { fact, score };
  });
  scored.sort((a, b) => b.score - a.score || a.fact.displayName.localeCompare(b.fact.displayName));
  const picked: TableFact[] = [];
  // 人工在上下文里配置过的表优先进入核心表，不受打分上限影响。
  for (const item of scored) {
    if (bundle?.tableMeta[item.fact.name] || bundle?.tableMeta[item.fact.displayName]) picked.push(item.fact);
  }
  for (const item of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(item.fact)) picked.push(item.fact);
  }
  return picked.slice(0, limit);
}

function isUniqueColumns(table: TableInfo, columns: string[]): boolean {
  const target = columns.map((column) => column.toLowerCase()).sort().join(',');
  const pk = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name.toLowerCase()).sort().join(',');
  if (pk && pk === target) return true;
  return (table.indexes ?? []).some((index) => index.unique && index.columns.map((column) => column.toLowerCase()).sort().join(',') === target);
}

export function joinEdges(
  facts: TableFact[],
  bundle?: AgentContextBundle,
  annotations?: BriefAnnotations,
): JoinEdge[] {
  const edges: JoinEdge[] = [];
  const seen = new Map<string, number>();
  const known = (name: string) => Boolean(resolveTableName(name, facts));
  const add = (edge: JoinEdge) => {
    const key = `${edge.from}.${edge.fromColumn}>${edge.to}.${edge.toColumn}`.toLowerCase();
    if (edge.from.toLowerCase() === edge.to.toLowerCase()) return;
    if (!known(edge.from) || !known(edge.to)) return;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // 外键已经有了这条边，模型补的业务说明仍然有价值，合并进 note 而不是丢弃。
      const note = edge.note?.trim();
      if (note && !edges[existing].note?.includes(note)) {
        edges[existing].note = edges[existing].note ? `${edges[existing].note}；${note}` : note;
      }
      return;
    }
    seen.set(key, edges.length);
    edges.push(edge);
  };
  for (const fact of facts) {
    for (const fk of fact.table.foreignKeys ?? []) {
      if (!fk.columns.length || !fk.refColumns.length) continue;
      add({
        from: fact.name,
        fromColumn: fk.columns[0],
        to: lastSegment(fk.refTable),
        toColumn: fk.refColumns[0],
        cardinality: isUniqueColumns(fact.table, fk.columns) ? '1:1' : 'N:1',
        source: 'fk',
      });
    }
  }
  for (const relation of bundle?.relations ?? []) {
    add({
      from: relation.leftTable,
      fromColumn: relation.leftColumn,
      to: relation.rightTable,
      toColumn: relation.rightColumn,
      cardinality: 'N:1',
      source: 'context',
      note: relation.description,
    });
  }
  for (const join of annotations?.joins ?? []) {
    add({
      from: join.leftTable,
      fromColumn: join.leftColumn,
      to: join.rightTable,
      toColumn: join.rightColumn,
      cardinality: join.cardinality ?? 'N:1',
      source: 'model',
      note: join.note,
    });
  }
  return edges;
}

function resolvePath(input: BriefInput): string {
  const requested = input.requestedPath?.trim().replace(/^["']|["']$/g, '');
  if (requested) {
    let raw = requested;
    if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) raw = join(homedir(), raw.slice(1));
    const absolute = resolve(raw);
    return /\.md$/i.test(absolute) ? absolute : join(absolute, 'AI_DB.md');
  }
  if (input.storedPath) return input.storedPath;
  return defaultBriefPath(input.home, input.connection);
}

function databaseSegment(connection: ConnectionConfig): string {
  if (!connection.database) return 'default';
  // SQLite/DuckDB 的 database 是文件路径，取文件名做目录，别把整条路径塞进文件夹名。
  const base = basename(connection.database);
  return safeSegment(base.replace(/\.(sqlite3?|db|duckdb)$/i, '')) || 'default';
}

function safeSegment(value: string): string {
  return String(value || 'default').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'default';
}

function annotationFacts(
  facts: TableFact[],
  core: TableFact[],
  bundle: AgentContextBundle | undefined,
  glossary: Memory[],
  sqlExamples: Memory[],
  history: Array<{ sql: string; status?: string }>,
): string {
  const lines: string[] = [];
  // 核心表列放前面：超长 schema 被截断时，模型仍有足够事实注解核心表。
  lines.push('### Core table columns');
  for (const fact of core) {
    lines.push(`#### ${fact.displayName}`);
    for (const column of fact.table.columns ?? []) {
      lines.push(`- ${column.name} ${column.type}${column.primaryKey ? ' PK' : ''}${column.nullable ? '' : ' NOT NULL'}${column.comment ? ` — ${clip(column.comment, 120)}` : ''}`);
    }
    for (const index of fact.table.indexes ?? []) {
      lines.push(`- index ${index.name} (${index.columns.join(', ')}${index.unique ? ', unique' : ''})`);
    }
  }
  lines.push('', '### All tables (complete inventory)');
  for (const fact of facts) {
    const table = fact.table;
    const pk = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
    const fks = (table.foreignKeys ?? []).map((fk) => `${fk.columns.join('+')} -> ${fk.refTable}.${fk.refColumns.join('+')}`);
    lines.push(
      `- ${fact.displayName} [${table.type}${table.schema ? `, schema=${table.schema}` : ''}] rows≈${table.rowEstimate ?? '?'} cols=${table.columns?.length ?? 0} pk=${pk.join('+') || '—'}${fks.length ? ` fks=${fks.join(', ')}` : ''}${table.comment ? ` comment=${JSON.stringify(clip(table.comment, 160))}` : ''}`,
    );
  }
  if (bundle) {
    lines.push('', '### User-maintained context (authoritative)');
    for (const [table, meta] of Object.entries(bundle.tableMeta)) {
      lines.push(`- table ${table}${meta.alias ? ` alias=${meta.alias}` : ''}${meta.description ? `: ${meta.description}` : ''}`);
    }
    for (const relation of bundle.relations) {
      lines.push(`- relation ${relation.leftTable}.${relation.leftColumn} -> ${relation.rightTable}.${relation.rightColumn}${relation.description ? `: ${relation.description}` : ''}`);
    }
    for (const [table, columns] of Object.entries(bundle.columnMeta)) {
      for (const [column, meta] of Object.entries(columns)) {
        if (meta.alias || meta.description) lines.push(`- column ${table}.${column}${meta.alias ? ` alias=${meta.alias}` : ''}${meta.description ? `: ${meta.description}` : ''}`);
      }
    }
    if (bundle.disabledTables.length) lines.push(`- disabled tables (never use): ${bundle.disabledTables.join(', ')}`);
  }
  if (glossary.length) {
    lines.push('', '### Glossary (verified)');
    for (const memory of glossary) lines.push(`- ${memory.title}: ${clip(memory.content, 300)}`);
  }
  if (sqlExamples.length) {
    lines.push('', '### Canonical SQL examples (verified)');
    for (const memory of sqlExamples) lines.push(`- ${memory.title}: ${clip(memory.content, 500)}`);
  }
  const recent = history.filter((item) => !item.status || /^(ok|success|succeeded|done)$/i.test(item.status)).slice(0, 8);
  if (recent.length) {
    lines.push('', '### Recently executed SQL (verified runs)');
    for (const item of recent) lines.push(`- ${clip(item.sql, 500)}`);
  }
  return lines.join('\n');
}

function systemPromptForAnnotations(): string {
  return `You are a senior database engineer writing AI_DB.md, an onboarding handoff document for a teammate who has never seen this database.
Use ONLY the supplied schema facts, user-maintained context, glossary, and executed SQL. Never invent a table, column, join, metric, or business fact. If unsure, omit it.

Return STRICT JSON, no markdown fences:
{
  "business": "3-5 sentences describing what this database is for and the main business flow",
  "tables": [{"table":"...", "purpose":"...", "grain":"one row per ...", "notes":"pitfalls/semantics"}],
  "joins": [{"leftTable":"...","leftColumn":"...","rightTable":"...","rightColumn":"...","cardinality":"1:1|1:N|N:1|N:M","note":"..."}],
  "metrics": [{"name":"...", "definition":"...", "sql":"SELECT ..."}],
  "recipes": [{"question":"what the teammate wants to do", "sql":"SELECT ...", "tables":["..."]}],
  "pitfalls": ["concrete trap, e.g. amount is stored in cents"],
  "performance": ["concrete query/performance note"]
}

Rules:
- "tables" may only annotate the core tables listed; use their exact names.
- "joins" may only use columns that appear in the facts; state cardinality and fan-out risk.
- "metrics" only when the definition is grounded in the glossary/canonical SQL; keep SQL executable and only use known tables/columns.
- "recipes" 3-6 common end-to-end tasks, only known tables/columns.
- "pitfalls"/"performance": concrete, evidence-based, no generic BI advice.
- Write prose in Simplified Chinese (the product UI language); keep table/column names and SQL identifiers unchanged.
- Keep each string concise. Empty arrays are allowed.`;
}

function parseJson(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sanitizeAnnotations(raw: any, facts: TableFact[], core: TableFact[]): BriefAnnotations {
  const byName = new Map<string, TableFact>();
  for (const fact of facts) {
    byName.set(fact.name.toLowerCase(), fact);
    byName.set(fact.displayName.toLowerCase(), fact);
  }
  const tableByName = (name: unknown): TableFact | undefined => {
    const key = String(name ?? '').trim().toLowerCase();
    return byName.get(key) ?? byName.get(lastSegment(key).toLowerCase());
  };
  const columnOf = (fact: TableFact, name: unknown): string | undefined => {
    const key = String(name ?? '').trim().toLowerCase();
    return (fact.table.columns ?? []).find((column) => column.name.toLowerCase() === key)?.name;
  };
  const coreNames = new Set(core.map((fact) => fact.name.toLowerCase()));
  const tables: BriefTableAnnotation[] = [];
  for (const item of Array.isArray(raw?.tables) ? raw.tables : []) {
    const fact = tableByName(item?.table);
    if (!fact || !coreNames.has(fact.name.toLowerCase())) continue;
    const purpose = clip(String(item?.purpose ?? ''), 500);
    const grain = clip(String(item?.grain ?? ''), 300);
    const notes = clip(String(item?.notes ?? ''), 500);
    if (!purpose && !grain && !notes) continue;
    tables.push({ table: fact.name, ...(purpose ? { purpose } : {}), ...(grain ? { grain } : {}), ...(notes ? { notes } : {}) });
  }
  const joins: BriefJoinAnnotation[] = [];
  for (const item of Array.isArray(raw?.joins) ? raw.joins : []) {
    const left = tableByName(item?.leftTable);
    const right = tableByName(item?.rightTable);
    if (!left || !right) continue;
    const leftColumn = columnOf(left, item?.leftColumn);
    const rightColumn = columnOf(right, item?.rightColumn);
    if (!leftColumn || !rightColumn) continue;
    const cardinality = ['1:1', '1:N', 'N:1', 'N:M'].includes(String(item?.cardinality)) ? (String(item.cardinality) as BriefJoinAnnotation['cardinality']) : 'N:1';
    joins.push({
      leftTable: left.name,
      leftColumn,
      rightTable: right.name,
      rightColumn,
      cardinality,
      ...(item?.note ? { note: clip(String(item.note), 300) } : {}),
    });
  }
  const knownTable = (name: string) => Boolean(tableByName(name));
  const validSql = (sql: string) => tableMentionsFromSql(sql).every(knownTable);
  const metrics: BriefMetricAnnotation[] = [];
  for (const item of Array.isArray(raw?.metrics) ? raw.metrics : []) {
    const name = clip(String(item?.name ?? ''), 80);
    if (!name) continue;
    const definition = clip(String(item?.definition ?? ''), 600);
    const sql = typeof item?.sql === 'string' ? item.sql.trim().slice(0, 4000) : '';
    if (sql && !validSql(sql)) continue;
    if (!definition && !sql) continue;
    metrics.push({ name, ...(definition ? { definition } : {}), ...(sql ? { sql } : {}) });
  }
  const recipes: BriefRecipeAnnotation[] = [];
  for (const item of Array.isArray(raw?.recipes) ? raw.recipes : []) {
    const question = clip(String(item?.question ?? ''), 200);
    if (!question) continue;
    const sql = typeof item?.sql === 'string' ? item.sql.trim().slice(0, 4000) : '';
    if (sql && !validSql(sql)) continue;
    const mentioned = Array.isArray(item?.tables) ? item.tables.map((name: unknown) => tableByName(name)?.name).filter((name: string | undefined): name is string => Boolean(name)) : [];
    recipes.push({ question, ...(sql ? { sql } : {}), ...(mentioned.length ? { tables: mentioned } : {}) });
  }
  const strings = (value: unknown, max: number, size = 300): string[] =>
    (Array.isArray(value) ? value : [])
      .map((item) => clip(String(item ?? ''), size))
      .filter(Boolean)
      .slice(0, max);
  return {
    ...(typeof raw?.business === 'string' && raw.business.trim() ? { business: clip(raw.business, 1500) } : {}),
    tables,
    joins,
    metrics,
    recipes,
    pitfalls: strings(raw?.pitfalls, 8),
    performance: strings(raw?.performance, 6),
  };
}

export async function annotateBrief(
  input: BriefInput,
  facts: TableFact[],
  core: TableFact[],
): Promise<{ annotations: BriefAnnotations; error?: string }> {
  const empty: BriefAnnotations = { tables: [], joins: [], metrics: [], recipes: [], pitfalls: [], performance: [] };
  if (!facts.length) return { annotations: empty, error: '当前库没有可注解的表' };
  if (!input.provider || input.provider.id === 'local') {
    return { annotations: empty, error: '离线模式未调用模型，仅生成确定性内容' };
  }
  const factsText = annotationFacts(facts, core, input.bundle, input.glossary ?? [], input.sqlExamples ?? [], input.history ?? []);
  const payload = factsText.length > 80_000
    ? `${factsText.slice(0, 80_000)}\n\n[TRUNCATED] The facts above were cut. Do not invent tables/columns that are not shown; omit any annotation that would require them.`
    : factsText;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ANNOTATION_TIMEOUT_MS);
  timer.unref?.();
  const onAbort = () => controller.abort();
  input.signal?.addEventListener('abort', onAbort, { once: true });
  let text = '';
  try {
    for await (const event of input.provider.stream(
      {
        system: systemPromptForAnnotations(),
        messages: [{ role: 'user', content: payload }],
        tools: [],
        temperature: 0.2,
        maxTokens: 3500,
      },
      controller.signal,
    )) {
      if (event.type === 'text') text += event.text;
    }
  } catch (err: any) {
    return { annotations: empty, error: `模型注解失败：${clip(err?.message ?? String(err), 180)}` };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }
  const parsed = parseJson(text);
  if (!parsed) return { annotations: empty, error: '模型注解不是有效 JSON，已跳过' };
  return { annotations: sanitizeAnnotations(parsed, facts, core) };
}

interface ParsedDocument {
  frontmatter: Record<string, string>;
  auto: Map<string, { hash: string; block: string; body: string }>;
  manual: Map<string, string>;
  leftover: string;
}

function parseDocument(markdown: string): ParsedDocument {
  const doc: ParsedDocument = { frontmatter: {}, auto: new Map(), manual: new Map(), leftover: '' };
  let rest = markdown;
  const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown);
  if (front) {
    for (const line of front[1].split(/\r?\n/)) {
      const match = /^([\w-]+):\s*(.*)$/.exec(line);
      if (match) doc.frontmatter[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
    rest = markdown.slice(front[0].length);
  }
  const autoPattern = /<!-- aidb:auto:([a-z-]+) hash=([a-f0-9]+) -->([\s\S]*?)<!-- \/aidb:auto:\1 -->/g;
  for (const match of rest.matchAll(autoPattern)) {
    doc.auto.set(match[1], { hash: match[2], block: match[0], body: match[3] });
  }
  rest = rest.replace(autoPattern, '');
  const manualPattern = /<!-- aidb:manual:([a-z-]+) -->([\s\S]*?)<!-- \/aidb:manual:\1 -->/g;
  for (const match of rest.matchAll(manualPattern)) {
    doc.manual.set(match[1], match[0]);
  }
  rest = rest.replace(manualPattern, '');
  doc.leftover = rest.trim();
  return doc;
}

function autoBlock(name: string, body: string): string {
  // 哈希与写盘必须基于同一份文本；之前整篇再压缩空行会让每段实际内容与 hash 不一致，
  // 下一轮就会把自动段落误判成“用户改过”而永久保留旧内容。
  const clean = body.trim().replace(/\n{3,}/g, '\n\n');
  return `<!-- aidb:auto:${name} hash=${hash(clean)} -->\n${clean}\n<!-- /aidb:auto:${name} -->`;
}

function manualBlock(name: string, body: string): string {
  return `<!-- aidb:manual:${name} -->\n${body.trim()}\n<!-- /aidb:manual:${name} -->`;
}

function tableCandidates(fact: TableFact): string[] {
  return [fact.name, fact.displayName];
}

function resolveTableName(name: string, facts: TableFact[]): TableFact | undefined {
  const key = name.toLowerCase();
  return facts.find((fact) => tableCandidates(fact).some((candidate) => candidate.toLowerCase() === key)) ??
    facts.find((fact) => fact.name.toLowerCase() === lastSegment(key).toLowerCase());
}

function isImportantColumn(column: ColumnInfo): boolean {
  return column.primaryKey || /(^|_)(id|status|state|type|kind|amount|price|total|gmv|fee|cost|cents|created_at|updated_at|paid_at|deleted_at|is_deleted|tenant_id|org_id|company_id)($|_)/i.test(column.name) || Boolean(column.comment);
}

function keyColumns(table: TableInfo, bundle: AgentContextBundle | undefined): ColumnInfo[] {
  const columns = table.columns ?? [];
  const picked: ColumnInfo[] = [];
  const add = (column: ColumnInfo | undefined) => {
    if (column && !picked.includes(column)) picked.push(column);
  };
  for (const column of columns) if (column.primaryKey) add(column);
  for (const fk of table.foreignKeys ?? []) {
    for (const column of fk.columns) add(columns.find((item) => item.name === column));
  }
  for (const column of columns) {
    const meta = bundle?.columnMeta[table.name]?.[column.name];
    if (meta?.alias || meta?.description) add(column);
  }
  for (const column of columns) if (isImportantColumn(column)) add(column);
  for (const column of columns) if (picked.length < 10) add(column);
  return picked.slice(0, 14);
}

function tableDisableNotes(bundle: AgentContextBundle | undefined, table: string): string[] {
  if (!bundle) return [];
  const notes: string[] = [];
  if (bundle.disabledTables.includes(table)) notes.push('该表已被用户在 Agent 上下文中禁用，不要查询。');
  for (const column of bundle.disabledColumns[table] ?? []) notes.push(`列 \`${column}\` 已被禁用，不要读取或聚合。`);
  return notes;
}

function autoPitfalls(facts: TableFact[], bundle?: AgentContextBundle): string[] {
  const out: string[] = [];
  const cents: string[] = [];
  const softDelete: string[] = [];
  const tenant: string[] = [];
  const statusColumns: string[] = [];
  for (const fact of facts) {
    for (const column of fact.table.columns ?? []) {
      if (/cents?$/i.test(column.name)) cents.push(`${fact.name}.${column.name}`);
      if (/(^|_)(deleted_at|is_deleted|delete_flag|is_removed)($|_)/i.test(column.name)) softDelete.push(`${fact.name}.${column.name}`);
      if (/(^|_)(tenant_id|org_id|company_id)($|_)/i.test(column.name)) tenant.push(`${fact.name}.${column.name}`);
      if (/(^|_)(status|state|type|kind)($|_)/i.test(column.name)) statusColumns.push(`${fact.name}.${column.name}`);
    }
  }
  if (cents.length) out.push(`金额列名含 cents：${cents.slice(0, 8).join('、')}。展示/比较前先确认单位，通常需要 /100。`);
  if (softDelete.length) out.push(`存在软删除标记：${softDelete.slice(0, 8).join('、')}。默认查询要过滤已删除行，除非用户明确要求包含。`);
  if (tenant.length) out.push(`多租户列：${tenant.slice(0, 8).join('、')}。查询必须带租户条件，否则会跨租户串数据。`);
  if (statusColumns.length) out.push(`状态/类型列（如 ${statusColumns.slice(0, 5).join('、')}）的具体枚举值以列注释与实际数据为准，不要猜测。`);
  if (bundle?.disabledTables.length) out.push(`用户已禁用表：${bundle.disabledTables.join('、')}。不要查询这些表。`);
  const disabledColumns = Object.entries(bundle?.disabledColumns ?? {}).flatMap(([table, columns]) => columns.map((column) => `${table}.${column}`));
  if (disabledColumns.length) out.push(`用户已禁用列：${disabledColumns.slice(0, 10).join('、')}。不要读取或聚合。`);
  const noPk = facts.filter((fact) => fact.table.type === 'table' && !(fact.table.columns ?? []).some((column) => column.primaryKey)).map((fact) => fact.name);
  if (noPk.length) out.push(`没有主键的表：${noPk.slice(0, 10).join('、')}。按行更新/去重前先确认唯一键。`);
  return out;
}

function mermaidLine(edge: JoinEdge, facts: TableFact[]): string | null {
  const safe = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const from = resolveTableName(edge.from, facts);
  const to = resolveTableName(edge.to, facts);
  if (!from || !to || !safe.test(from.name) || !safe.test(to.name)) return null;
  const relation = edge.cardinality === '1:1' ? '||--||' : edge.cardinality === 'N:M' ? '}o--o{' : '||--o{';
  return `  ${to.name} ${relation} ${from.name} : "${cell(edge.fromColumn)}"`;
}

function joinLine(edge: JoinEdge, perspective: string): string {
  const note = edge.source === 'model' ? '推断' : edge.source === 'context' ? '人工配置' : '外键';
  const reverse = edge.to.toLowerCase() === perspective.toLowerCase() && edge.cardinality === 'N:1';
  return `  - \`${edge.from}.${edge.fromColumn}\` → \`${edge.to}.${edge.toColumn}\`（${edge.cardinality}，${note}${reverse ? '；从本表看是 1:N 反向，先聚合子表再 JOIN' : ''}${edge.note ? `：${clip(edge.note, 160)}` : ''}）`;
}

function columnLine(column: ColumnInfo): string {
  return `- \`${column.name}\` ${column.type}${column.primaryKey ? ' PK' : ''}${column.nullable ? '' : ' NOT NULL'}${column.comment ? ` — ${clip(column.comment, 120)}` : ''}`;
}

function buildSections(
  input: BriefInput,
  facts: TableFact[],
  core: TableFact[],
  edges: JoinEdge[],
  annotations: BriefAnnotations,
  annotationsLabel: 'model' | 'none',
  schemaHash: string,
  existing: ParsedDocument,
): { sections: Array<{ name: string; block: string }>; preserved: string[]; manualBlocks: Array<{ name: string; block: string }> } {
  const { connection } = input;
  const tables = facts.filter((fact) => fact.table.type === 'table');
  const views = facts.filter((fact) => fact.table.type === 'view');
  const biggest = [...facts].sort((a, b) => (b.table.rowEstimate ?? 0) - (a.table.rowEstimate ?? 0)).slice(0, 5);
  const coreNames = core.map((fact) => fact.name);
  const annotationByTable = new Map(annotations.tables.map((item) => [item.table.toLowerCase(), item]));
  // 自动段落每次 /init 都刷新：新增/删除表、改列、关系变化必须反映到业务地图和核心表手册。
  // 需要长期保留的文字放在 manual 段落（数据流、人工补充），不要直接改自动段落。
  const preserved: string[] = [];
  const emit = (name: string, heading: string, body: string) => ({ name, block: autoBlock(name, `${heading}\n\n${body}`) });
  const sections: Array<{ name: string; block: string }> = [];

  sections.push(
    emit(
      'overview',
      '## 0. 一页速览',
      [
        '> 自动段落每次 `/init` 都会刷新；需要长期保留的说明请写在文末“人工补充”，不要直接改自动段落。',
        '',
        '| 项 | 值 |',
        '|---|---|',
        `| 连接 | ${cell(connection.name)}（\`${cell(connection.id)}\`） |`,
        `| 引擎 | ${cell(connection.engine)} |`,
        `| 数据库 | ${cell(connection.database || '（连接默认库）')} |`,
        `| 环境 / 只读 | ${cell(connection.environment)} / ${connection.readonly ? '是' : '否'} |`,
        `| 规模 | ${tables.length} 张表、${views.length} 个视图${biggest[0]?.table.rowEstimate ? `；最大表 ${cell(biggest[0].name)}（约 ${biggest[0].table.rowEstimate.toLocaleString()} 行）` : ''} |`,
        `| 文档覆盖 | ${facts.length}/${facts.length} 张表/视图进入全量清单；${core.length} 张核心表有详细注解 |`,
        `| 模型注解 | ${annotationsLabel === 'model' ? '已生成（inferred，待人工校对）' : '未生成（仅确定性内容）'} |`,
        `| 结构指纹 | \`${schemaHash}\` |`,
        `| 生成时间 | ${new Date().toISOString()} |`,
      ].join('\n'),
    ),
  );

  const business = annotations.business?.trim();
  sections.push(
    emit(
      'business',
      '## 1. 这个库是干什么的',
      [
        business ? `${business}\n\n> 来源：模型推断（inferred），请人工校对后把 reviewed 改为 true。` : '尚未生成业务说明。可以配置模型后重跑 `/init`，或直接在文末“人工补充”里写清业务背景。',
        '',
        '### 核心实体（自动）',
        ...(core.length
          ? core.slice(0, 12).map((fact) => {
              const meta = input.bundle?.tableMeta[fact.name] ?? input.bundle?.tableMeta[fact.displayName];
              const annotation = annotationByTable.get(fact.name.toLowerCase());
              const purpose = meta?.description || annotation?.purpose || fact.table.comment || '未注解';
              return `- \`${fact.name}\`（${fact.table.type === 'view' ? '视图' : '表'}）：${clip(purpose, 180)}`;
            })
          : ['- 当前库没有可识别的表。']),
        '',
        '> 未列在上面的表仍存在于全量清单与 schema 中；没写进本文档不等于不重要。',
      ].join('\n'),
    ),
  );

  const coreSet = new Set(core.map((fact) => fact.name.toLowerCase()));
  const diagram = edges.filter((edge) => coreSet.has(edge.from.toLowerCase()) && coreSet.has(edge.to.toLowerCase()));
  const mermaid = [...new Set(diagram.map((edge) => mermaidLine(edge, facts)).filter((line): line is string => Boolean(line)))];
  const edgeRows = edges.filter((edge) => coreSet.has(edge.from.toLowerCase()) || coreSet.has(edge.to.toLowerCase()));
  sections.push(
    emit(
      'map',
      '## 2. 数据地图与关联',
      [
        mermaid.length ? '```mermaid\nerDiagram' : '',
        ...mermaid,
        mermaid.length ? '```' : '',
        '',
        '### 关联清单（核心表相关）',
        edgeRows.length
          ? ['| 子表 / 引用方 | ON | 被引用表 | 基数 | 来源 |', '|---|---|---|---|---|',
              ...edgeRows.slice(0, 80).map((edge) => `| ${cell(edge.from)}.\`${cell(edge.fromColumn)}\` | = | ${cell(edge.to)}.\`${cell(edge.toColumn)}\` | ${edge.cardinality} | ${edge.source === 'fk' ? '外键' : edge.source === 'context' ? '人工配置' : '模型推断'} |`),
            ].join('\n')
          : '（没有外键或人工配置的关联；可在 Agent 上下文中补充 relation。）',
      ].filter(Boolean).join('\n'),
    ),
  );

  const coreBlocks: string[] = [];
  for (const fact of core) {
    const table = fact.table;
    const meta = input.bundle?.tableMeta[fact.name] ?? input.bundle?.tableMeta[fact.displayName];
    const annotation = annotationByTable.get(fact.name.toLowerCase());
    const purpose = meta?.description || annotation?.purpose || table.comment;
    const grain = annotation?.grain;
    const pk = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
    const tableEdges = edges.filter((edge) => edge.from.toLowerCase() === fact.name.toLowerCase() || edge.to.toLowerCase() === fact.name.toLowerCase());
    const notes = [
      ...tableDisableNotes(input.bundle, fact.name),
      ...(annotation?.notes ? [annotation.notes] : []),
      ...autoPitfalls([fact], undefined),
    ];
    coreBlocks.push(
      [
        `### \`${fact.displayName}\`${meta?.alias ? ` — ${meta.alias}` : ''}`,
        `- 用途：${purpose ? clip(purpose, 240) : '未注解（建议人工补一句业务含义）'}${!meta?.description && annotation?.purpose ? '（模型推断）' : ''}`,
        `- 粒度：${grain ? clip(grain, 200) : '未注解（一行代表什么？建议人工确认）'}`,
        `- 主键：${pk.length ? pk.join(', ') : '没有主键'}`,
        `- 行数估算：${table.rowEstimate ?? '未知'}`,
        `- 关键字段：`,
        ...keyColumns(table, input.bundle).map((column) => `  ${columnLine(column)}`),
        tableEdges.length ? '- 查询时通常关联：' : '- 查询时通常关联：暂无外键/人工关联；需要 JOIN 时先在 Agent 上下文补 relation。',
        ...tableEdges.slice(0, 20).map((edge) => joinLine(edge, fact.name)),
        notes.length ? '- 注意：' : '',
        ...notes.map((note) => `  - ${note}`),
      ].filter(Boolean).join('\n'),
    );
  }
  sections.push(
    emit(
      'core',
      '## 3. 核心表手册',
      [
        '> 这一节只写常用表；未出现的表在附录全量清单里，Agent 仍可通过 schema 检查。',
        '',
        ...(coreBlocks.length ? coreBlocks : ['当前库没有表可注解。']),
      ].join('\n\n'),
    ),
  );

  const verifiedExamples = input.sqlExamples ?? [];
  const glossary = input.glossary ?? [];
  const metricBlocks: string[] = [];
  for (const memory of verifiedExamples) {
    metricBlocks.push(`### ${memory.title}\n${clip(memory.content, 700)}\n\n> 来源：人工确认的 sql_example 记忆。`);
  }
  if (glossary.length) {
    metricBlocks.push('### 术语表（人工确认）', ...glossary.map((memory) => `- **${memory.title}**：${clip(memory.content, 400)}`));
  }
  if (annotations.metrics.length) {
    metricBlocks.push('### 模型草案（inferred，执行前先验证）');
    for (const metric of annotations.metrics) {
      metricBlocks.push(`#### ${metric.name}`);
      if (metric.definition) metricBlocks.push(metric.definition);
      if (metric.sql) metricBlocks.push('```sql\n' + metric.sql + '\n```');
    }
  }
  const recent = (input.history ?? []).filter((item) => !item.status || /^(ok|success|succeeded|done)$/i.test(item.status)).slice(0, 5);
  if (recent.length) {
    metricBlocks.push('### 近期实际执行成功的 SQL（可作口径参考）');
    for (const item of recent) metricBlocks.push('```sql\n' + clip(item.sql, 800) + '\n```');
  }
  sections.push(
    emit(
      'metrics',
      '## 4. 指标口径与标准 SQL',
      metricBlocks.length
        ? metricBlocks.join('\n\n')
        : '（暂无已确认的指标口径。可以在 Agent 记忆里维护 glossary / sql_example，或直接编辑本文档。）',
    ),
  );

  const noPk = facts.filter((fact) => fact.table.type === 'table' && !(fact.table.columns ?? []).some((column) => column.primaryKey));
  const fkNoIndex: string[] = [];
  for (const fact of facts) {
    for (const fk of fact.table.foreignKeys ?? []) {
      const first = fk.columns[0];
      if (!first) continue;
      const indexed = (fact.table.indexes ?? []).some((index) => index.columns[0] === first);
      if (!indexed) fkNoIndex.push(`${fact.name}.${first}`);
    }
  }
  const performanceLines = [
    '### 自动事实',
    `- 最大的表：${biggest.length ? biggest.map((fact) => `${fact.name}（约 ${(fact.table.rowEstimate ?? 0).toLocaleString()} 行）`).join('、') : '无'}`,
    `- 视图：${views.length ? views.map((fact) => fact.name).join('、') : '无'}`,
    noPk.length ? `- 无主键表：${noPk.slice(0, 10).map((fact) => fact.name).join('、')}` : '- 所有表都有主键。',
    fkNoIndex.length ? `- 外键列首列未建索引：${fkNoIndex.slice(0, 12).join('、')}` : '- 外键列首列都有索引。',
    '',
    '### 查询规则',
    '- 探索性 SELECT 必须带 LIMIT；大表先按时间/租户列过滤。',
    '- 明细表先聚合再和主表 JOIN，避免 1:N 行放大导致金额/计数翻倍。',
    '- 不确定表或列时先 inspect_schema / sample_rows，不要凭命名猜。',
    ...(annotations.performance.length ? ['', '### 模型补充（inferred）', ...annotations.performance.map((item) => `- ${item}`)] : []),
  ];
  sections.push(emit('performance', '## 6. 查询须知与性能', performanceLines.join('\n')));

  const recipeBlocks = annotations.recipes.map((recipe) => [
    `### ${recipe.question}`,
    recipe.tables?.length ? `涉及表：${recipe.tables.map((table) => `\`${table}\``).join('、')}` : '',
    recipe.sql ? '```sql\n' + recipe.sql + '\n```' : '',
    recipe.sql ? '> 模型推断，执行前先验证。' : '',
  ].filter(Boolean).join('\n'));
  if (recent.length) {
    recipeBlocks.push('### 近期的实际查询（可直接复用）', ...recent.map((item) => '```sql\n' + clip(item.sql, 800) + '\n```'));
  }
  sections.push(
    emit(
      'recipes',
      '## 7. 常见任务 Recipe',
      recipeBlocks.length ? recipeBlocks.join('\n\n') : '（暂无 Recipe。配置模型后重跑 `/init`，或把常用任务写进人工补充区。）',
    ),
  );

  const pitfalls = [...autoPitfalls(facts, input.bundle), ...annotations.pitfalls.map((item) => `${item}（模型推断）`)];
  sections.push(
    emit(
      'pitfalls',
      '## 8. 坑与已知问题',
      pitfalls.length ? pitfalls.map((item) => `- ${item}`).join('\n') : '（尚未发现确定性陷阱；人工补充已知问题最有价值。）',
    ),
  );

  const inventory = Object.fromEntries(facts.map((fact) => [fact.displayName, fact.fingerprint]));
  const appendix = [
    `全量清单（${facts.length} 个对象，生成时间 ${new Date().toISOString()}）：`,
    '',
    '| 表 / 视图 | 类型 | 行数估算 | 主键 | 外键数 | 列数 | 备注 |',
    '|---|---|---|---|---|---|---|',
    ...facts
      .slice()
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
      .map((fact) => {
        const pk = (fact.table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name).join(', ');
        return `| \`${cell(fact.displayName)}\` | ${fact.table.type} | ${fact.table.rowEstimate ?? '—'} | ${cell(pk || '—')} | ${fact.table.foreignKeys?.length ?? 0} | ${fact.table.columns?.length ?? 0} | ${cell(clip(fact.table.comment ?? '', 80))} |`;
      }),
    '',
    '<!-- aidb:inventory',
    JSON.stringify({ tables: inventory }),
    '-->',
  ].join('\n');
  sections.push(emit('appendix', '## 9. 附录：全量表清单', appendix));

  const manualBlocks: Array<{ name: string; block: string }> = [];
  const dataflowPlaceholder = [
    '## 5. 数据流与新鲜度',
    '> 以下内容由人工维护，`/init` 不会覆盖。',
    '- 上游系统：待补充',
    '- 同步方式（ETL / CDC / API）：待补充',
    '- 更新频率与延迟：待补充',
    '- 归档、只读副本、历史库：待补充',
  ].join('\n');
  manualBlocks.push({ name: 'dataflow', block: existing.manual.get('dataflow') ?? manualBlock('dataflow', dataflowPlaceholder) });
  if (existing.manual.has('dataflow')) preserved.push('dataflow');

  const customFallback = [
    '## 人工补充',
    '> 这里的文字不会被 `/init` 覆盖；适合写业务背景、口径变更、历史坑和待办。',
  ].join('\n\n');
  manualBlocks.push({ name: 'custom', block: existing.manual.get('custom') ?? manualBlock('custom', customFallback) });
  if (existing.manual.has('custom')) preserved.push('custom');
  // 兼容旧格式或用户在标记之外新增的内容：单独保留，绝不静默丢弃。
  if (existing.leftover) {
    manualBlocks.push({ name: 'extra', block: manualBlock('extra', existing.leftover) });
    preserved.push('extra');
  }

  return { sections, preserved, manualBlocks };
}

function frontmatter(input: BriefInput, meta: BriefMeta): string {
  const reviewed = meta.reviewed ? 'true' : 'false';
  const quote = (value: string) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  return [
    '---',
    'aidb: database-brief',
    'version: 1',
    `connection: ${quote(input.connection.name)}`,
    `connection_id: ${quote(input.connection.id)}`,
    `database: ${quote(input.connection.database || '')}`,
    `engine: ${quote(input.connection.engine)}`,
    `generated_at: "${new Date().toISOString()}"`,
    `schema_hash: "${meta.schemaHash ?? ''}"`,
    `table_count: ${meta.tableCount ?? 0}`,
    `core_tables: ${meta.coreTables ?? 0}`,
    `annotations: "${meta.annotations ?? 'none'}"`,
    `reviewed: ${reviewed}`,
    '---',
  ].join('\n');
}

export async function composeDatabaseBrief(input: BriefInput): Promise<BriefResult> {
  const facts = flattenTables(input.schemas);
  const historyCounts = historyTableCounts(input.history ?? []);
  const core = selectCoreTables(input.schemas, input.bundle, historyCounts);
  const existing: ParsedDocument = input.existing
    ? parseDocument(input.existing)
    : { frontmatter: {}, auto: new Map(), manual: new Map(), leftover: '' };
  const { annotations, error } = await annotateBrief(input, facts, core);
  const edges = joinEdges(facts, input.bundle, annotations);
  const schemaHash = schemaFingerprint(input.schemas);
  const annotationsLabel: 'model' | 'none' = annotations.business || annotations.tables.length || annotations.joins.length || annotations.metrics.length ? 'model' : 'none';
  const { sections, preserved, manualBlocks } = buildSections(input, facts, core, edges, annotations, annotationsLabel, schemaHash, existing);
  const reviewed = existing.frontmatter.reviewed === 'true';
  const meta: BriefMeta = {
    schemaHash,
    tableCount: facts.length,
    coreTables: core.length,
    annotations: annotationsLabel,
    reviewed,
  };
  const parts = [
    frontmatter(input, meta),
    '',
    ...sections.flatMap((section) => [section.block, '']),
    ...manualBlocks.flatMap((manual) => [manual.block, '']),
  ];
  return {
    markdown: parts.join('\n').trimEnd() + '\n',
    path: resolvePath(input),
    schemaHash,
    stats: {
      tables: facts.filter((fact) => fact.table.type === 'table').length,
      views: facts.filter((fact) => fact.table.type === 'view').length,
      coreTables: core.map((fact) => fact.name),
      joins: edges.length,
      metrics: (input.sqlExamples?.length ?? 0) + annotations.metrics.length,
      recipes: annotations.recipes.length,
      annotations: annotationsLabel,
      ...(error ? { annotationError: error } : {}),
      preservedSections: preserved,
      tableNames: facts.map((fact) => fact.displayName),
    },
  };
}

export async function writeDatabaseBrief(path: string, markdown: string, existing?: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 老文件如果没有 aidb 标记，说明是用户自己的文档：先备份，避免第一次 /init 直接覆盖。
  if (existing && !/<!-- aidb:(?:auto|manual):/.test(existing)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(`${path}.bak-${stamp}`, existing, 'utf8');
  }
  await writeFile(path, markdown, 'utf8');
}

export async function readBrief(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export function parseBriefMeta(markdown: string): BriefMeta {
  const frontmatter = parseDocument(markdown).frontmatter;
  return {
    generatedAt: frontmatter.generated_at,
    schemaHash: frontmatter.schema_hash,
    annotations: frontmatter.annotations === 'model' ? 'model' : 'none',
    reviewed: frontmatter.reviewed === 'true',
    tableCount: Number(frontmatter.table_count ?? 0) || undefined,
    coreTables: Number(frontmatter.core_tables ?? 0) || undefined,
    connection: frontmatter.connection,
    database: frontmatter.database,
    engine: frontmatter.engine,
  };
}

function inventoryOf(markdown: string): Map<string, string> | null {
  const match = /<!-- aidb:inventory\s*\n([\s\S]*?)\n-->/.exec(markdown);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]);
    const tables = parsed?.tables;
    if (!tables || typeof tables !== 'object') return null;
    return new Map(Object.entries(tables).map(([name, value]) => [name, String(value)]));
  } catch {
    return null;
  }
}

export function briefDrift(markdown: string, schemas: DatabaseSchema[]): BriefDrift {
  const facts = flattenTables(schemas);
  const inventory = inventoryOf(markdown);
  if (!inventory) return { added: facts.map((fact) => fact.displayName), removed: [], changed: [], unknown: true };
  const current = new Map(facts.map((fact) => [fact.displayName, fact.fingerprint]));
  const added = [...current.keys()].filter((name) => !inventory.has(name));
  const removed = [...inventory.keys()].filter((name) => !current.has(name));
  const changed = [...current.entries()].filter(([name, fingerprint]) => inventory.has(name) && inventory.get(name) !== fingerprint).map(([name]) => name);
  return { added, removed, changed, unknown: false };
}

function digestOf(markdown: string): string {
  const parsed = parseDocument(markdown);
  // 预算优先给核心表：map 可能很长，不能把“查表要关联谁”挤出摘要。
  const order = ['overview', 'business', 'core', 'map', 'metrics', 'performance', 'pitfalls', 'recipes'];
  const parts: string[] = [];
  let used = 0;
  for (const name of order) {
    const section = parsed.auto.get(name);
    if (!section) continue;
    const body = section.body.replace(/<!--[\s\S]*?-->/g, '').trim();
    if (!body) continue;
    if (used + body.length > DIGEST_CHARS) {
      const remain = Math.max(0, DIGEST_CHARS - used);
      if (remain > 200) parts.push(body.slice(0, remain) + '…');
      break;
    }
    parts.push(body);
    used += body.length;
  }
  return parts.join('\n\n');
}

export function loadBrief(markdown: string, path: string, schemas: DatabaseSchema[]): LoadedBrief {
  const drift = briefDrift(markdown, schemas);
  const inventory = [...(inventoryOf(markdown)?.keys() ?? [])];
  return {
    path,
    markdown,
    digest: digestOf(markdown),
    meta: parseBriefMeta(markdown),
    drift,
    inventory,
  };
}

export function briefPromptBlock(brief: LoadedBrief): string {
  const { meta, drift } = brief;
  const ageDays = meta.generatedAt ? Math.floor((Date.now() - new Date(meta.generatedAt).getTime()) / 86_400_000) : null;
  const stale = drift.added.length || drift.removed.length || drift.changed.length || drift.unknown;
  const driftText = stale
    ? `STALE — ${drift.unknown ? '缺少机器可读的清单，无法比对。' : [
        drift.added.length ? `新增 ${drift.added.slice(0, 8).join('、')}${drift.added.length > 8 ? ` 等 ${drift.added.length} 张` : ''}` : '',
        drift.removed.length ? `已删除/重命名 ${drift.removed.slice(0, 8).join('、')}` : '',
        drift.changed.length ? `结构变化 ${drift.changed.slice(0, 8).join('、')}` : '',
      ].filter(Boolean).join('；')}。重跑 /init 更新；在此之前以 schema 为准。`
    : 'up to date';
  const rules = [
    'This file is explanatory, not a whitelist: a table missing from it still exists in ## Schema. Never conclude a table/column does not exist from this brief.',
    'If the brief conflicts with ## Schema, inspect_schema, sample_rows or a query result, the tool result wins; mention the discrepancy.',
    'Sections marked inferred/model draft are suggestions: verify with a query before quoting them as fact.',
    'Never treat SQL or numbers in the brief as executed results; run the SQL to get current numbers.',
  ];
  const parts = [
    '## Database brief (AI_DB.md — onboarding notes, advisory)',
    `Path: ${brief.path}`,
    `Generated: ${meta.generatedAt ?? 'unknown'}${ageDays !== null ? ` (${ageDays} days ago)` : ''}; annotations: ${meta.annotations ?? 'none'}; reviewed: ${meta.reviewed ? 'yes' : 'no'}.`,
    `Coverage: ${meta.tableCount ?? brief.inventory.length} tables/views in the full inventory; ${meta.coreTables ?? '?'} core tables documented.`,
    `Schema check: ${driftText}`,
    'Rules for this brief:',
    ...rules.map((rule) => `- ${rule}`),
  ];
  if (brief.digest.trim()) parts.push('', brief.digest);
  return parts.join('\n');
}

export function briefPathFromRegistry(input: {
  home: string;
  connection: ConnectionConfig;
  storedPath?: string;
  requestedPath?: string;
}): string {
  return resolvePath({
    home: input.home,
    connection: input.connection,
    schemas: [],
    requestedPath: input.requestedPath,
    storedPath: input.storedPath,
  });
}

/** 默认路径存在但注册表还没记录时（例如用户手动放了一份），也允许自动加载。 */
export function defaultBriefPath(home: string, connection: ConnectionConfig): string {
  return join(home, 'context', safeSegment(connection.id), databaseSegment(connection), 'AI_DB.md');
}

export function briefExists(path: string): boolean {
  return existsSync(path);
}

export interface BriefInitSummary {
  path: string;
  stats: BriefResult['stats'];
  schemaHash: string;
}

export function summarizeInit(result: BriefResult): string {
  const { stats } = result;
  const lines = [
    '## AI_DB.md 已生成',
    '',
    `- 文件：\`${result.path}\``,
    `- 覆盖：${stats.tables} 张表、${stats.views} 个视图；${stats.coreTables.length} 张核心表、${stats.joins} 条关联`,
    `- 模型注解：${stats.annotations === 'model' ? '已生成（inferred，需人工校对）' : '未生成（离线或模型不可用，仅确定性内容）'}`,
    stats.annotationError ? `- 注解说明：${stats.annotationError}` : '',
    `- 结构指纹：\`${result.schemaHash}\``,
    stats.preservedSections.length ? `- 保留了人工段落：${stats.preservedSections.join('、')}` : '',
    '',
    '后续对话会自动加载这份文档；修改文件后重跑 `/init` 可更新自动段落，人工段落会保留。',
  ];
  return lines.join('\n');
}
