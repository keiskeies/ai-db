import type { ColumnInfo, Engine, QueryResult, SearchQuery, StructuredQuery, TableInfo } from '@aidb/core';
import { searchQueryFromArgs } from '@aidb/core';
import type {
  CreateFieldInput,
  CreateObjectInput,
  DeleteDocumentsInput,
  DocumentWriteDriver,
  DriverTestResult,
  FieldAddDriver,
  ObjectCreateDriver,
  RunOptions,
  WriteDocumentInput,
  WriteDocumentResult,
} from './types';
import { DbError } from './types';
import { mapLimit } from './concurrency';
import { tlsDispatcher } from './ssl';
import type { Agent } from 'undici';

/** 一次 _mapping 请求带多少个索引；几千索引的集群不该用一次 _all/_mapping 换回上百 MB。 */
const MAPPING_BATCH = 60;

export interface ElasticsearchOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  /** ES 8 的 API Key（`Authorization: ApiKey <token>`）；很多安全集群只发 Key，不发密码。 */
  apiKey?: string;
  ssl?: boolean;
  sslInsecure?: boolean;
}

interface ServerInfo {
  label: string;
  number: string;
  major: number | null;
  /** OpenSearch 版本号从 1.x 起算，但 API 基线是 ES 7.10；不能按 ES 主版本判断。 */
  trackTotalHits: boolean;
}

function parseServerInfo(info: Record<string, any> | undefined): ServerInfo {
  const distribution = String(info?.version?.distribution ?? '');
  const number = String(info?.version?.number ?? '');
  const major = Number.parseInt(number, 10);
  const openSearch = /opensearch/i.test(distribution);
  return {
    label: openSearch ? 'OpenSearch' : 'Elasticsearch',
    number,
    major: Number.isFinite(major) ? major : null,
    trackTotalHits: openSearch || (Number.isFinite(major) && major >= 7),
  };
}

/**
 * ES 6 及更早版本的 mapping 仍然带类型层：mappings.doc.properties。
 * 7.x 之后是 mappings.properties；两种都要能读出字段。
 */
function mappingProperties(entry: Record<string, any> | undefined): Record<string, any> | undefined {
  const mappings = entry?.mappings;
  if (!mappings || typeof mappings !== 'object') return undefined;
  if (mappings.properties && typeof mappings.properties === 'object') return mappings.properties;
  for (const [name, value] of Object.entries(mappings)) {
    if (name.startsWith('_')) continue;
    const properties = (value as Record<string, any> | undefined)?.properties;
    if (properties && typeof properties === 'object') return properties;
  }
  return undefined;
}

function flattenProperties(properties: Record<string, any> | undefined, prefix = '', out: ColumnInfo[] = []): ColumnInfo[] {
  for (const [name, value] of Object.entries(properties ?? {})) {
    const field = prefix ? `${prefix}.${name}` : name;
    if (value?.properties) {
      flattenProperties(value.properties, field, out);
      continue;
    }
    out.push({
      name: field,
      type: String(value?.type ?? (Array.isArray(value?.fields) ? 'multi_field' : 'object')),
      nullable: true,
      primaryKey: false,
    });
  }
  return out;
}

function valueOf(hit: Record<string, any>, key: string): unknown {
  if (key === '_id') return hit._id;
  if (key === '_score') return hit._score;
  let current: any = hit._source;
  for (const part of key.split('.')) {
    if (current === null || current === undefined) return null;
    current = current[part];
  }
  if (current === null || current === undefined) return null;
  if (typeof current === 'object') return JSON.stringify(current);
  return current;
}

const ES_TYPES = new Set(['text', 'keyword', 'boolean', 'long', 'integer', 'short', 'double', 'float', 'date', 'ip', 'nested', 'object', 'geo_point', 'binary']);

function hitsToResult(hits: Array<Record<string, any>>, started: number, statement: string, truncated: boolean, total = hits.length): QueryResult {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const source = (hit._source ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(source)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const ordered = keys.slice(0, 100);
  const columns = [
    { name: '_id', type: 'string' },
    { name: '_score', type: 'float' },
    ...ordered.map((key) => ({ name: key, type: 'field', kind: 'json' as const })),
  ];
  const rows = hits.map((hit) => [hit._id ?? null, hit._score ?? null, ...ordered.map((key) => valueOf(hit, key))]);
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated,
    messages: [`total=${total}`],
    statement,
    resultKind: 'documents',
  };
}

export class ElasticsearchDriver implements DocumentWriteDriver, ObjectCreateDriver, FieldAddDriver {
  engine: Engine;
  /** 版本只用于选择请求参数，不参与功能矩阵；失败时按“未知版本”走保守路径。 */
  private serverInfo?: Promise<ServerInfo | undefined>;
  private dispatcher?: Agent;
  private dispatcherChecked = false;

  constructor(private opts: ElasticsearchOptions, engine: Engine = 'elasticsearch') {
    this.engine = engine;
  }

  private info(): Promise<ServerInfo | undefined> {
    if (!this.serverInfo) {
      this.serverInfo = this.request<Record<string, any>>('/')
        .then((info) => parseServerInfo(info))
        .catch(() => undefined);
    }
    return this.serverInfo;
  }

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 9200}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    // API Key 优先：ES 8 的安全集群常只下发 Key，而 username 会残留成默认值。
    if (this.opts.apiKey) headers.authorization = `ApiKey ${this.opts.apiKey}`;
    else if (this.opts.user) {
      headers.authorization = `Basic ${Buffer.from(`${this.opts.user}:${this.opts.password ?? ''}`).toString('base64')}`;
    }
    return headers;
  }

  /** 自签 HTTPS 服务需要跳过证书校验；dispatcher 只在真的开了 SSL 时才建。 */
  private get agent(): Agent | undefined {
    if (this.dispatcher === undefined && !this.dispatcherChecked) {
      this.dispatcher = tlsDispatcher(this.opts);
      this.dispatcherChecked = true;
    }
    return this.dispatcher;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
        ...(this.agent ? { dispatcher: this.agent } : {}),
      } as RequestInit);
    } catch (err: any) {
      throw new DbError(`${this.engine === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} 请求失败：${err?.message ?? '网络错误'}`, {
        code: 'SEARCH_NETWORK',
      });
    }
    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      const message = payload?.error?.reason ?? payload?.error?.root_cause?.[0]?.reason ?? `搜索服务返回 ${response.status}`;
      throw new DbError(String(message), { code: `SEARCH_${response.status}` });
    }
    return payload as T;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const info = await this.request<Record<string, any>>('/');
      this.serverInfo = Promise.resolve(parseServerInfo(info));
      const parsed = parseServerInfo(info);
      return { ok: true, version: `${parsed.label} ${parsed.number}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['default'];
  }

  async describe(): Promise<TableInfo[]> {
    const { indices, mapping } = await this.indexSnapshot();
    return indices.map((index) => {
      const name = String(index.index);
      const properties = mappingProperties(mapping?.[name]);
      return {
        name,
        type: 'table',
        kind: 'index',
        rowEstimate: index['docs.count'] === undefined ? undefined : Number(index['docs.count']),
        columns: [
          { name: '_id', type: 'string', nullable: false, primaryKey: true },
          ...flattenProperties(properties),
        ],
        comment: index.health ? `health=${index.health}` : undefined,
      } satisfies TableInfo;
    });
  }

  /**
   * 索引列表优先走 _cat/indices；某些 8.x 安全角色没有 cluster monitor，
   * cat 会被 403，但索引级 mapping 权限仍然可读，此时从 mapping 的键还原索引。
   */
  private async indexSnapshot(): Promise<{ indices: Array<Record<string, any>>; mapping: Record<string, any> }> {
    let catError: unknown;
    let indices: Array<Record<string, any>> | undefined;
    try {
      // ES 7.6 及更早版本不认识 cat 接口的 expand_wildcards 参数（会回 400），默认就只列 open 索引。
      const response = await this.request<Array<Record<string, any>>>('/_cat/indices?format=json');
      if (Array.isArray(response)) indices = response;
    } catch (err) {
      catError = err;
    }
    if (indices) {
      // mapping 只是补充列信息；受权限限制或体量过大时不能连带索引列表一起失败。
      const names = indices.map((index) => String(index.index)).filter(Boolean);
      return { indices, mapping: await this.mappingsFor(names) };
    }
    const mapping = await this.request<Record<string, any>>('/_all/_mapping?filter_path=*.mappings').catch(
      (): Record<string, any> => ({}),
    );
    const names = Object.keys(mapping ?? {});
    if (names.length) return { indices: names.map((name) => ({ index: name })), mapping };
    throw catError instanceof Error ? catError : new DbError('无法读取索引列表', { code: 'SEARCH_INDICES' });
  }

  /**
   * 分批取 mapping，并只保留 mappings 字段（settings/aliases 对列信息没用）。
   * 单次 _all/_mapping 在几千索引的集群上会一次换回上百 MB。
   */
  private async mappingsFor(names: string[]): Promise<Record<string, any>> {
    if (!names.length) return {};
    const batches: string[][] = [];
    for (let i = 0; i < names.length; i += MAPPING_BATCH) batches.push(names.slice(i, i + MAPPING_BATCH));
    const parts = await mapLimit(batches, 4, async (batch) => {
      const path = `/${batch.map((name) => encodeURIComponent(name)).join(',')}/_mapping?filter_path=*.mappings`;
      return this.request<Record<string, any>>(path).catch((): Record<string, any> => ({}));
    });
    return Object.assign({}, ...parts);
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'search') throw new DbError('搜索驱动只接受 JSON DSL 查询', { code: 'SEARCH_ONLY' });
    return this.search(query, opts);
  }

  async search(query: SearchQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (!query.index) throw new DbError('index 不能为空', { code: 'SEARCH_INDEX' });
    const started = Date.now();
    const size = Math.max(1, Math.min(query.size ?? opts.maxRows ?? 100, 10000));
    const info = await this.info();
    const body: Record<string, unknown> = { ...(query.body ?? {}), size };
    // track_total_hits 是 7.x 才稳定支持的参数；6.x 只能在响应里读到数字形态的 hits.total。
    // 版本未知时先试，服务端明确不认识该参数再退回不带参数的请求。
    if (body.track_total_hits === undefined && (!info || info.trackTotalHits)) body.track_total_hits = true;
    if (!body.query) body.query = { match_all: {} };
    const path = `/${encodeURIComponent(query.index)}/_search`;
    const init = { method: 'POST', body: JSON.stringify(body) };
    let response: any;
    try {
      response = await this.request<any>(path, init, opts.timeoutMs ?? 30000);
    } catch (err: any) {
      const retryable =
        body.track_total_hits === true &&
        info === undefined &&
        /track_total_hits/i.test(String(err?.message ?? ''));
      if (!retryable) throw err;
      delete body.track_total_hits;
      response = await this.request<any>(path, { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs ?? 30000);
    }
    const hits = response?.hits?.hits ?? [];
    // 7.x+ 是 { value, relation }；6.x 及更早是数字。两种都要按真实总数判断截断。
    const rawTotal = response?.hits?.total;
    const total = typeof rawTotal === 'number' ? rawTotal : Number(rawTotal?.value ?? hits.length);
    const relation = typeof rawTotal === 'number' ? 'eq' : String(rawTotal?.relation ?? 'eq');
    const truncated = relation === 'gte' ? hits.length >= size : total > hits.length;
    return hitsToResult(hits, started, JSON.stringify({ ...query, size }), truncated, total);
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sql);
    } catch {
      throw new DbError('搜索查询需要 JSON，例如 {"index":"logs","query":{"match_all":{}},"size":20}', { code: 'SEARCH_PARSE' });
    }
    const query = searchQueryFromArgs((parsed ?? {}) as Record<string, unknown>);
    return this.search(query, opts);
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('搜索驱动不支持参数化 SQL', { code: 'SEARCH_ONLY' });
  }

  async getDocument(collection: string, id: string, _database?: string): Promise<{ id: string; document: string }> {
    const index = collection.trim();
    if (!index) throw new DbError('索引名不能为空', { code: 'SEARCH_INDEX' });
    // 文档不存在时 ES 回 404 + found:false，不能按网络错误处理。
    let response: Response;
    try {
      response = await fetch(`${this.base()}/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(30000),
        ...(this.agent ? { dispatcher: this.agent } : {}),
      } as RequestInit);
    } catch (err: any) {
      throw new DbError(`${this.engine === 'opensearch' ? 'OpenSearch' : 'Elasticsearch'} 请求失败：${err?.message ?? '网络错误'}`, {
        code: 'SEARCH_NETWORK',
      });
    }
    const hit = (await response.json().catch(() => null)) as any;
    if (response.status === 404 && hit?.found === false) {
      throw new DbError(`文档不存在：${id}`, { code: 'SEARCH_DOC_NOT_FOUND', status: 404 });
    }
    if (!response.ok) {
      const message = hit?.error?.reason ?? hit?.error?.root_cause?.[0]?.reason ?? `搜索服务返回 ${response.status}`;
      throw new DbError(String(message), { code: `SEARCH_${response.status}` });
    }
    if (!hit?.found) throw new DbError(`文档不存在：${id}`, { code: 'SEARCH_DOC_NOT_FOUND', status: 404 });
    return { id: String(hit._id ?? id), document: JSON.stringify({ _id: hit._id ?? id, ...(hit._source ?? {}) }) };
  }

  async upsertDocuments(input: WriteDocumentInput, opts: RunOptions = {}): Promise<WriteDocumentResult> {
    if (!input.collection) throw new DbError('index 不能为空', { code: 'SEARCH_INDEX' });
    if (!input.documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    const lines: string[] = [];
    for (const document of input.documents) {
      const { _id, ...rest } = document;
      const id = typeof _id === 'string' ? _id : undefined;
      lines.push(JSON.stringify(id ? { index: { _index: input.collection, _id: id } } : { index: { _index: input.collection } }));
      lines.push(JSON.stringify(rest));
    }
    const response = await this.request<any>(
      '/_bulk?refresh=true',
      { method: 'POST', body: `${lines.join('\n')}\n`, headers: { 'content-type': 'application/x-ndjson' } },
      opts.timeoutMs ?? 30000,
    );
    const items = Array.isArray(response?.items) ? response.items : [];
    const failed = items.find((item: any) => item?.index?.error);
    if (failed) {
      const error = failed.index.error;
      throw new DbError(String(error?.reason ?? error?.type ?? '批量写入失败'), { code: 'SEARCH_BULK' });
    }
    return { ids: items.map((item: any) => String(item?.index?._id ?? '')), upserted: items.length };
  }

  async dropObject(name: string, opts: RunOptions = {}): Promise<{ name: string; dropped: boolean }> {
    const target = name.trim();
    if (!target) throw new DbError('索引名不能为空', { code: 'SEARCH_INDEX' });
    await this.request(`/${encodeURIComponent(target)}`, { method: 'DELETE' }, opts.timeoutMs ?? 30000);
    return { name: target, dropped: true };
  }

  /** mapping 可以追加字段；已存在字段由 ES 自行判定是否冲突。 */
  async createField(input: CreateFieldInput, opts: RunOptions = {}): Promise<{ name: string; type: string; added: boolean }> {
    const target = input.object.trim();
    const name = input.name.trim();
    if (!target) throw new DbError('索引名不能为空', { code: 'SEARCH_INDEX' });
    if (!name) throw new DbError('字段名不能为空', { code: 'SEARCH_FIELD' });
    const type = ES_TYPES.has(String(input.type).toLowerCase()) ? String(input.type).toLowerCase() : 'keyword';
    await this.request(
      `/${encodeURIComponent(target)}/_mapping`,
      { method: 'PUT', body: JSON.stringify({ properties: { [name]: { type } } }) },
      opts.timeoutMs ?? 30000,
    );
    return { name, type, added: true };
  }

  async deleteDocuments(input: DeleteDocumentsInput, opts: RunOptions = {}): Promise<{ deleted: number }> {
    if (!input.collection) throw new DbError('index 不能为空', { code: 'SEARCH_INDEX' });
    if (!input.ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS' });
    const response = await this.request<any>(
      `/${encodeURIComponent(input.collection)}/_delete_by_query?refresh=true`,
      { method: 'POST', body: JSON.stringify({ query: { ids: { values: input.ids } } }) },
      opts.timeoutMs ?? 30000,
    );
    return { deleted: Number(response?.deleted ?? input.ids.length) };
  }

  async createObject(input: CreateObjectInput, opts: RunOptions = {}): Promise<{ name: string; kind: string }> {
    const name = input.name.trim();
    if (!name) throw new DbError('索引名不能为空', { code: 'SEARCH_INDEX' });
    const properties: Record<string, unknown> = {};
    for (const field of input.fields ?? []) {
      const field_ = field.name.trim();
      if (!field_) continue;
      properties[field_] = { type: ES_TYPES.has(String(field.type).toLowerCase()) ? String(field.type).toLowerCase() : 'keyword' };
    }
    await this.request(
      `/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify(Object.keys(properties).length ? { mappings: { properties } } : {}) },
      opts.timeoutMs ?? 30000,
    );
    return { name, kind: 'index' };
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
    await this.dispatcher?.close().catch(() => undefined);
    this.dispatcher = undefined;
    this.dispatcherChecked = false;
  }
}
