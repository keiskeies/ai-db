import type { ColumnInfo, Engine, IndexInfo, QueryResult, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';
import { randomUUID } from 'node:crypto';
import { vectorQueryFromArgs } from '@aidb/core';
import type {
  CollectionIndexDriver,
  CollectionIndexInput,
  CreateObjectInput,
  DeleteDocumentsInput,
  DocumentWriteDriver,
  DriverTestResult,
  ObjectCreateDriver,
  RunOptions,
  VectorQueryDriver,
  WriteDocumentInput,
  WriteDocumentResult,
} from './types';
import { DbError } from './types';

export interface QdrantOptions {
  host: string;
  port: number;
  apiKey?: string;
  ssl?: boolean;
}

function scalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function payloadColumns(points: Array<{ payload?: Record<string, unknown> }>): ColumnInfo[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const point of points) {
    for (const key of Object.keys(point.payload ?? {})) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names.slice(0, 100).map((name) => ({ name, type: 'payload', nullable: true, primaryKey: false }));
}

function pointsToResult(
  points: Array<{ id?: unknown; score?: number; payload?: Record<string, unknown> }>,
  withScore: boolean,
  started: number,
  statement: string,
  truncated = false,
): QueryResult {
  const payloads = payloadColumns(points);
  const columns: { name: string; type?: string; kind?: 'scalar' | 'json' }[] = [
    { name: 'id', type: 'id' },
    ...(withScore ? [{ name: 'score', type: 'float' }] : []),
    ...payloads.map((column) => ({ name: column.name, type: column.type, kind: 'json' as const })),
  ];
  const rows = points.map((point) => [
    scalar(point.id),
    ...(withScore ? [point.score ?? null] : []),
    ...payloads.map((column) => scalar(point.payload?.[column.name])),
  ]);
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated,
    statement,
    resultKind: 'vectors',
  };
}

export class QdrantDriver implements VectorQueryDriver, DocumentWriteDriver, ObjectCreateDriver, CollectionIndexDriver {
  engine: Engine = 'qdrant';

  constructor(private opts: QdrantOptions) {}

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 6333}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.apiKey) headers['api-key'] = this.opts.apiKey;
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
      throw new DbError(`Qdrant 请求失败：${err?.message ?? '网络错误'}`, { code: 'QDRANT_NETWORK' });
    }
    const body = (await response.json().catch(() => null)) as any;
    if (!response.ok) {
      const message = typeof body?.status?.error === 'string' ? body.status.error : `Qdrant 返回 ${response.status}`;
      throw new DbError(message, { code: `QDRANT_${response.status}` });
    }
    return body as T;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      await this.request('/collections');
      return { ok: true, version: 'Qdrant', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['default'];
  }

  async describe(): Promise<TableInfo[]> {
    const response = await this.request<{ result: { collections: Array<{ name: string }> } }>('/collections');
    const tables: TableInfo[] = [];
    for (const collection of response.result.collections ?? []) {
      try {
        const detail = await this.request<any>(`/collections/${encodeURIComponent(collection.name)}`);
        const result = detail.result ?? {};
        const config = result.config?.params?.vectors;
        const columns: ColumnInfo[] = [{ name: 'id', type: 'id', nullable: false, primaryKey: true }];
        const attrs: Record<string, string | number> = {};
        if (config && typeof config.size === 'number') {
          columns.push({ name: 'vector', type: `vector(${config.size})`, nullable: false, primaryKey: false });
          attrs.dimension = config.size;
          attrs.metric = String(config.distance ?? '');
        } else if (config && typeof config === 'object') {
          for (const [name, value] of Object.entries(config as Record<string, any>)) {
            if (typeof value?.size === 'number') {
              columns.push({ name, type: `vector(${value.size})`, nullable: false, primaryKey: false });
              attrs[`${name}.dimension`] = value.size;
              attrs[`${name}.metric`] = String(value.distance ?? '');
            }
          }
        }
        const payloadIndexes: IndexInfo[] = [];
        for (const [name, schema] of Object.entries(result.payload_schema ?? {})) {
          const type = String((schema as any)?.data_type ?? 'payload');
          columns.push({ name, type, nullable: true, primaryKey: false });
          payloadIndexes.push({ name, columns: [name], unique: false, method: type });
        }
        try {
          const sample = await this.request<any>(`/collections/${encodeURIComponent(collection.name)}/points/scroll`, {
            method: 'POST',
            body: JSON.stringify({ limit: 20, with_payload: true, with_vector: false }),
          });
          const known = new Set(columns.map((column) => column.name));
          for (const point of sample.result?.points ?? []) {
            for (const key of Object.keys(point.payload ?? {})) {
              if (known.has(key)) continue;
              known.add(key);
              columns.push({ name: key, type: 'payload', nullable: true, primaryKey: false });
            }
          }
        } catch {
          /* sampling is best effort */
        }
        attrs.points = Number(result.points_count ?? 0);
        tables.push({
          name: collection.name,
          type: 'table',
          kind: 'vector_collection',
          rowEstimate: Number(result.points_count ?? 0),
          columns,
          indexes: payloadIndexes,
          comment: attrs.dimension ? `vector(${attrs.dimension}) · ${attrs.metric}` : 'Qdrant collection',
        });
      } catch {
        tables.push({ name: collection.name, type: 'table', kind: 'vector_collection' });
      }
    }
    return tables;
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'vector') throw new DbError('Qdrant 驱动只接受向量查询', { code: 'VECTOR_ONLY' });
    return this.vectorSearch(query, opts);
  }

  async vectorSearch(query: VectorQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (!query.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const started = Date.now();
    // 查询自带的 topK 优先，maxRows 只是服务端上限；否则 /query 的默认 maxRows 会把 topK=1 放大成 1000。
    const requested = Number(query.topK) > 0 ? Number(query.topK) : 10;
    const cap = opts.maxRows && opts.maxRows > 0 ? Math.min(opts.maxRows, 1000) : 1000;
    const topK = Math.max(1, Math.min(requested, cap));
    const scroll = query.op === 'scroll' || (!query.vector?.length && !query.text);
    const path = `/collections/${encodeURIComponent(query.collection)}/points/${scroll ? 'scroll' : 'search'}`;
    const body: Record<string, unknown> = { limit: topK, with_payload: true, with_vector: false };
    if (scroll) {
      if (query.filter) body.filter = query.filter;
    } else {
      if (!query.vector?.length) throw new DbError('Qdrant 检索需要 vector 或 text', { code: 'VECTOR_REQUIRED' });
      body.vector = query.field ? { name: query.field, vector: query.vector } : query.vector;
      if (query.filter) body.filter = query.filter;
    }
    const response = await this.request<any>(path, { method: 'POST', body: JSON.stringify(body) }, opts.timeoutMs ?? 30000);
    const points = (scroll ? response.result?.points : response.result) ?? [];
    // scroll 的 next_page_offset 非空说明还有未返回的点；search 接口不提供剩余量，只能如实置 false。
    const truncated = scroll && response.result?.next_page_offset != null;
    return pointsToResult(points, !scroll, started, JSON.stringify(query), truncated);
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sql);
    } catch {
      throw new DbError('Qdrant 查询需要 JSON，例如 {"collection":"docs","vector":[...],"topK":5}', { code: 'VECTOR_PARSE' });
    }
    const query = vectorQueryFromArgs((parsed ?? {}) as Record<string, unknown>);
    if (!query.op) query.op = query.vector?.length || query.text ? 'search' : 'scroll';
    return this.vectorSearch(query, opts);
  }

  async getDocument(collection: string, id: string, _database?: string): Promise<{ id: string; document: string }> {
    const target = collection.trim();
    if (!target) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const pointId = /^\d+$/.test(id) ? Number(id) : id;
    const response = await this.request<any>(
      `/collections/${encodeURIComponent(target)}/points/${encodeURIComponent(String(pointId))}?with_vector=true&with_payload=true`,
    );
    const point = response?.result;
    if (!point) throw new DbError(`向量点不存在：${id}`, { code: 'VECTOR_POINT_NOT_FOUND', status: 404 });
    return {
      id: String(point.id ?? id),
      document: JSON.stringify({ id: point.id ?? id, vector: point.vector ?? null, payload: point.payload ?? {} }, null, 2),
    };
  }

  async upsertDocuments(input: WriteDocumentInput, opts: RunOptions = {}): Promise<WriteDocumentResult> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    if (!input.documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    const points = input.documents.map((document) => {
      const vector = document.vector;
      if (!Array.isArray(vector) && !(vector && typeof vector === 'object')) {
        throw new DbError('Qdrant 写入需要 document.vector（数组或命名向量对象）', { code: 'VECTOR_REQUIRED' });
      }
      const rawId = document.id ?? randomUUID();
      const payload =
        document.payload && typeof document.payload === 'object' && !Array.isArray(document.payload)
          ? (document.payload as Record<string, unknown>)
          : Object.fromEntries(Object.entries(document).filter(([key]) => !['id', 'vector', 'payload'].includes(key)));
      return { id: typeof rawId === 'string' && /^\d+$/.test(rawId) ? Number(rawId) : rawId, vector, payload };
    });
    await this.request(
      `/collections/${encodeURIComponent(input.collection)}/points?wait=true`,
      { method: 'PUT', body: JSON.stringify({ points }) },
      opts.timeoutMs ?? 30000,
    );
    return { ids: points.map((point) => String(point.id)), upserted: points.length };
  }

  async dropObject(name: string, opts: RunOptions = {}): Promise<{ name: string; dropped: boolean }> {
    const target = name.trim();
    if (!target) throw new DbError('集合名不能为空', { code: 'VECTOR_COLLECTION' });
    await this.request(`/collections/${encodeURIComponent(target)}`, { method: 'DELETE' }, opts.timeoutMs ?? 30000);
    return { name: target, dropped: true };
  }

  /** payload 索引按字段建，Qdrant 一次只接受一个字段。 */
  async createIndex(input: CollectionIndexInput, opts: RunOptions = {}): Promise<{ name: string; created: boolean }> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const fields = input.columns.map((column) => column.trim()).filter(Boolean);
    if (fields.length !== 1) throw new DbError('Qdrant 的 payload 索引一次只能建一个字段', { code: 'VECTOR_INDEX' });
    const allowed = ['keyword', 'integer', 'float', 'geo', 'text', 'bool', 'datetime', 'uuid'];
    const type = allowed.includes(String(input.type)) ? String(input.type) : 'keyword';
    await this.request(
      `/collections/${encodeURIComponent(input.collection)}/index?wait=true`,
      { method: 'PUT', body: JSON.stringify({ field_name: fields[0], field_schema: { type } }) },
      opts.timeoutMs ?? 30000,
    );
    return { name: fields[0], created: true };
  }

  async dropIndex(input: { collection: string; name: string }, opts: RunOptions = {}): Promise<{ name: string; dropped: boolean }> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const field = input.name.trim();
    if (!field) throw new DbError('索引名不能为空', { code: 'VECTOR_INDEX' });
    await this.request(
      `/collections/${encodeURIComponent(input.collection)}/index/${encodeURIComponent(field)}?wait=true`,
      { method: 'DELETE' },
      opts.timeoutMs ?? 30000,
    );
    return { name: field, dropped: true };
  }

  async deleteDocuments(input: DeleteDocumentsInput, opts: RunOptions = {}): Promise<{ deleted: number }> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    if (!input.ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS' });
    const points = input.ids.map((id) => (/^\d+$/.test(id) ? Number(id) : id));
    await this.request(
      `/collections/${encodeURIComponent(input.collection)}/points/delete?wait=true`,
      { method: 'POST', body: JSON.stringify({ points }) },
      opts.timeoutMs ?? 30000,
    );
    return { deleted: points.length };
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('Qdrant 不支持参数化 SQL，请使用向量查询', { code: 'VECTOR_ONLY' });
  }

  async createObject(input: CreateObjectInput, opts: RunOptions = {}): Promise<{ name: string; kind: string }> {
    const name = input.name.trim();
    if (!name) throw new DbError('集合名不能为空', { code: 'VECTOR_COLLECTION' });
    const dimension = Math.trunc(Number(input.dimension ?? 0));
    if (!Number.isFinite(dimension) || dimension < 1 || dimension > 65536) {
      throw new DbError('向量维度需要在 1-65536 之间', { code: 'VECTOR_DIMENSION' });
    }
    const distance = ['Cosine', 'Euclid', 'Dot', 'Manhattan'].includes(String(input.distance)) ? String(input.distance) : 'Cosine';
    await this.request(
      `/collections/${encodeURIComponent(name)}`,
      { method: 'PUT', body: JSON.stringify({ vectors: { size: dimension, distance } }) },
      opts.timeoutMs ?? 30000,
    );
    return { name, kind: 'collection' };
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}
