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

export interface ElasticsearchOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  ssl?: boolean;
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

function hitsToResult(hits: Array<Record<string, any>>, started: number, statement: string, truncated: boolean): QueryResult {
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
    statement,
    resultKind: 'documents',
  };
}

export class ElasticsearchDriver implements DocumentWriteDriver, ObjectCreateDriver, FieldAddDriver {
  engine: Engine;

  constructor(private opts: ElasticsearchOptions, engine: Engine = 'elasticsearch') {
    this.engine = engine;
  }

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 9200}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.user) {
      headers.authorization = `Basic ${Buffer.from(`${this.opts.user}:${this.opts.password ?? ''}`).toString('base64')}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        ...init,
        headers: { ...this.headers(), ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
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
      const info = await this.request<any>('/');
      return { ok: true, version: `${info?.version?.distribution ?? 'Elasticsearch'} ${info?.version?.number ?? ''}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['default'];
  }

  async describe(): Promise<TableInfo[]> {
    const [indices, mapping] = await Promise.all([
      this.request<Array<Record<string, any>>>('/_cat/indices?format=json&expand_wildcards=open'),
      this.request<Record<string, any>>('/_all/_mapping'),
    ]);
    return (indices ?? []).map((index) => {
      const name = String(index.index);
      const properties = mapping?.[name]?.mappings?.properties;
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

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'search') throw new DbError('搜索驱动只接受 JSON DSL 查询', { code: 'SEARCH_ONLY' });
    return this.search(query, opts);
  }

  async search(query: SearchQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (!query.index) throw new DbError('index 不能为空', { code: 'SEARCH_INDEX' });
    const started = Date.now();
    const size = Math.max(1, Math.min(query.size ?? opts.maxRows ?? 100, 10000));
    const body: Record<string, unknown> = { ...(query.body ?? {}), size, track_total_hits: true };
    if (!body.query) body.query = { match_all: {} };
    const response = await this.request<any>(
      `/${encodeURIComponent(query.index)}/_search`,
      { method: 'POST', body: JSON.stringify(body) },
      opts.timeoutMs ?? 30000,
    );
    const hits = response?.hits?.hits ?? [];
    return hitsToResult(hits, started, JSON.stringify({ ...query, size }), hits.length >= size);
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
  }
}
