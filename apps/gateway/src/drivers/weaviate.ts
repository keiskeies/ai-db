import type { ColumnInfo, Engine, QueryResult, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';
import { vectorQueryFromArgs } from '@aidb/core';
import type { DeleteDocumentsInput, DocumentWriteDriver, DriverTestResult, RunOptions, VectorQueryDriver, WriteDocumentInput, WriteDocumentResult } from './types';
import { DbError } from './types';

export interface WeaviateOptions {
  host: string;
  port: number;
  apiKey?: string;
  ssl?: boolean;
}

function scalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function objectProperties(object: { properties?: Record<string, unknown>; [key: string]: unknown }): Record<string, unknown> {
  if (object.properties) return object.properties;
  return Object.fromEntries(Object.entries(object).filter(([key]) => key !== 'id' && key !== '_additional' && key !== 'vector'));
}

function objectsToResult(
  objects: Array<{ id?: string; properties?: Record<string, unknown>; _additional?: { id?: string; distance?: number }; [key: string]: unknown }>,
  withScore: boolean,
  started: number,
  statement: string,
): QueryResult {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const object of objects) {
    for (const key of Object.keys(objectProperties(object))) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const columns: { name: string; type?: string; kind?: 'scalar' | 'json' }[] = [
    { name: 'id', type: 'id' },
    ...(withScore ? [{ name: 'score', type: 'float' }] : []),
    ...keys.slice(0, 100).map((key) => ({ name: key, type: 'property', kind: 'json' as const })),
  ];
  const rows = objects.map((object) => [
    scalar(object.id ?? object._additional?.id),
    ...(withScore ? [object._additional?.distance === undefined ? null : 1 - object._additional.distance] : []),
    ...keys.slice(0, 100).map((key) => scalar(objectProperties(object)[key])),
  ]);
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    statement,
    resultKind: 'vectors',
  };
}

export class WeaviateDriver implements VectorQueryDriver, DocumentWriteDriver {
  engine: Engine = 'weaviate';

  constructor(private opts: WeaviateOptions) {}

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 8080}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
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
      throw new DbError(`Weaviate 请求失败：${err?.message ?? '网络错误'}`, { code: 'WEAVIATE_NETWORK' });
    }
    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      const message = payload?.error?.[0]?.message ?? payload?.message ?? `Weaviate 返回 ${response.status}`;
      throw new DbError(String(message), { code: `WEAVIATE_${response.status}` });
    }
    return payload as T;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const meta = await this.request<any>('/v1/meta');
      return { ok: true, version: `Weaviate ${meta?.version ?? ''}`.trim(), latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['default'];
  }

  async describe(): Promise<TableInfo[]> {
    const schema = await this.request<any>('/v1/schema');
    return (schema.classes ?? []).map((klass: any) => {
      const columns: ColumnInfo[] = [
        { name: 'id', type: 'id', nullable: false, primaryKey: true },
        { name: 'vector', type: 'vector', nullable: true, primaryKey: false },
        ...(klass.properties ?? []).map((property: any) => ({
          name: String(property.name),
          type: Array.isArray(property.dataType) ? property.dataType.join(' | ') : String(property.dataType ?? ''),
          nullable: true,
          primaryKey: false,
        })),
      ];
      return {
        name: klass.class,
        type: 'table',
        kind: 'vector_collection',
        columns,
        comment: `vectorizer=${klass.vectorizer ?? 'none'}`,
      } satisfies TableInfo;
    });
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'vector') throw new DbError('Weaviate 驱动只接受向量查询', { code: 'VECTOR_ONLY' });
    return this.vectorSearch(query, opts);
  }

  async vectorSearch(query: VectorQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (!query.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const started = Date.now();
    const topK = Math.max(1, Math.min(opts.maxRows && opts.maxRows > 0 ? opts.maxRows : query.topK, 1000));
    const scroll = query.op === 'scroll' || (!query.vector?.length && !query.text);
    if (scroll) {
      const response = await this.request<any>(
        `/v1/objects?class=${encodeURIComponent(query.collection)}&limit=${topK}`,
        {},
        opts.timeoutMs ?? 30000,
      );
      return objectsToResult(response.objects ?? [], false, started, JSON.stringify(query));
    }
    if (!query.vector?.length) throw new DbError('Weaviate 检索需要 vector 或 text', { code: 'VECTOR_REQUIRED' });
    const schema = await this.request<any>('/v1/schema');
    const klass = (schema.classes ?? []).find((item: any) => item.class === query.collection);
    if (!klass) throw new DbError(`集合不存在：${query.collection}`, { code: 'WEAVIATE_CLASS' });
    const properties = (klass.properties ?? []).map((property: any) => property.name).filter(Boolean);
    const fields = ['_additional { id distance }', ...properties].join(' ');
    const graphql = `{ Get { ${query.collection}(nearVector: { vector: [${query.vector.join(',')}] }, limit: ${topK}) { ${fields} } } }`;
    const response = await this.request<any>(
      '/v1/graphql',
      { method: 'POST', body: JSON.stringify({ query: graphql }) },
      opts.timeoutMs ?? 30000,
    );
    const objects = response?.data?.Get?.[query.collection] ?? [];
    return objectsToResult(objects, true, started, graphql);
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sql);
    } catch {
      throw new DbError('Weaviate 查询需要 JSON，例如 {"collection":"Docs","vector":[...],"topK":5}', { code: 'VECTOR_PARSE' });
    }
    const query = vectorQueryFromArgs((parsed ?? {}) as Record<string, unknown>);
    if (!query.op) query.op = query.vector?.length || query.text ? 'search' : 'scroll';
    return this.vectorSearch(query, opts);
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('Weaviate 不支持参数化 SQL，请使用向量查询', { code: 'VECTOR_ONLY' });
  }

  async upsertDocuments(input: WriteDocumentInput, opts: RunOptions = {}): Promise<WriteDocumentResult> {
    if (!input.collection) throw new DbError('class 不能为空', { code: 'VECTOR_COLLECTION' });
    if (!input.documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    const objects = input.documents.map((document) => {
      const vector = Array.isArray(document.vector) ? document.vector : undefined;
      const properties =
        document.properties && typeof document.properties === 'object' && !Array.isArray(document.properties)
          ? (document.properties as Record<string, unknown>)
          : Object.fromEntries(Object.entries(document).filter(([key]) => !['id', 'vector', 'properties'].includes(key)));
      const id = typeof document.id === 'string' ? document.id : undefined;
      return { class: input.collection, properties, ...(vector ? { vector } : {}), ...(id ? { id } : {}) };
    });
    const response = await this.request<any>(
      '/v1/batch/objects',
      { method: 'POST', body: JSON.stringify({ objects }) },
      opts.timeoutMs ?? 30000,
    );
    const created = Array.isArray(response) ? response : [];
    const failed = created.find((item: any) => item?.result?.error);
    if (failed) throw new DbError(String(failed.result.error?.message ?? '批量写入失败'), { code: 'WEAVIATE_BATCH' });
    return { ids: created.map((item: any) => String(item?.id ?? '')), upserted: created.length || objects.length };
  }

  async deleteDocuments(input: DeleteDocumentsInput, opts: RunOptions = {}): Promise<{ deleted: number }> {
    if (!input.collection) throw new DbError('class 不能为空', { code: 'VECTOR_COLLECTION' });
    if (!input.ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS' });
    let deleted = 0;
    for (const id of input.ids) {
      await this.request(
        `/v1/objects/${encodeURIComponent(input.collection)}/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        opts.timeoutMs ?? 30000,
      );
      deleted += 1;
    }
    return { deleted };
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}
