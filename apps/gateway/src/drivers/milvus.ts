import type { ColumnInfo, Engine, QueryResult, StructuredQuery, TableInfo, VectorQuery } from '@aidb/core';
import { vectorQueryFromArgs } from '@aidb/core';
import type { DocumentWriteDriver, DriverTestResult, RunOptions, VectorQueryDriver, WriteDocumentInput, WriteDocumentResult } from './types';
import { DbError } from './types';

export interface MilvusOptions {
  host: string;
  port: number;
  token?: string;
  ssl?: boolean;
}

function scalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function fieldType(field: any): string {
  const params = Array.isArray(field?.params)
    ? Object.fromEntries(field.params.map((item: any) => [item.key, item.value]))
    : field?.params ?? {};
  if (params.dim !== undefined) return `vector(${params.dim})`;
  const map: Record<number, string> = {
    1: 'bool',
    2: 'int8',
    3: 'int16',
    4: 'int32',
    5: 'int64',
    10: 'float',
    11: 'double',
    20: 'string',
    21: 'varchar',
    23: 'json',
    101: 'float_vector',
    102: 'binary_vector',
    103: 'float16_vector',
    104: 'bfloat16_vector',
    105: 'sparse_vector',
  };
  if (typeof field?.type === 'string') {
    if (/vector/i.test(field.type) && params.dim !== undefined) return `vector(${params.dim})`;
    return field.type;
  }
  return map[Number(field?.type)] ?? String(field?.type ?? 'field');
}

function resultFromRows(rows: Array<Record<string, unknown>>, started: number, statement: string, withScore: boolean): QueryResult {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const entity = (row.entity as Record<string, unknown> | undefined) ?? row;
    for (const key of Object.keys(entity)) {
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  const columns: { name: string; type?: string; kind?: 'scalar' | 'json' }[] = [
    { name: 'id', type: 'id' },
    ...(withScore ? [{ name: 'score', type: 'float' }] : []),
    ...keys.filter((key) => key !== 'id').slice(0, 100).map((key) => ({ name: key, type: 'field', kind: 'json' as const })),
  ];
  const data = rows.map((row) => {
    const entity = (row.entity as Record<string, unknown> | undefined) ?? row;
    return [
      scalar(row.id ?? entity.id),
      ...(withScore ? [row.distance ?? row.score ?? null] : []),
      ...keys.filter((key) => key !== 'id').slice(0, 100).map((key) => scalar(entity[key])),
    ];
  });
  return {
    columns,
    rows: data,
    rowCount: data.length,
    durationMs: Date.now() - started,
    statement,
    resultKind: 'vectors',
  };
}

export class MilvusDriver implements VectorQueryDriver, DocumentWriteDriver {
  engine: Engine = 'milvus';

  constructor(private opts: MilvusOptions) {}

  private base(): string {
    if (this.opts.host.startsWith('http://') || this.opts.host.startsWith('https://')) {
      return this.opts.host.replace(/\/+$/, '');
    }
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 19530}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    return headers;
  }

  private async request<T>(path: string, body: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err: any) {
      throw new DbError(`Milvus 请求失败：${err?.message ?? '网络错误'}`, { code: 'MILVUS_NETWORK' });
    }
    const payload = (await response.json().catch(() => null)) as any;
    if (!response.ok || (typeof payload?.code === 'number' && payload.code !== 0)) {
      const message = payload?.message ?? `Milvus 返回 ${response.status}`;
      throw new DbError(String(message), { code: `MILVUS_${payload?.code ?? response.status}` });
    }
    return payload as T;
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      await this.request('/v2/vectordb/collections/list', {});
      return { ok: true, version: 'Milvus', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    return ['default'];
  }

  async describe(): Promise<TableInfo[]> {
    const list = await this.request<any>('/v2/vectordb/collections/list', {});
    const names: string[] = list?.data?.collectionNames ?? list?.data ?? [];
    const tables: TableInfo[] = [];
    for (const name of names) {
      try {
        const detail = await this.request<any>('/v2/vectordb/collections/describe', { collectionName: name });
        const data = detail.data ?? {};
        const fields: any[] = data.fields ?? [];
        const columns: ColumnInfo[] = fields.map((field) => ({
          name: String(field.name),
          type: fieldType(field),
          nullable: !(field.primaryKey ?? field.is_primary),
          primaryKey: Boolean(field.primaryKey ?? field.is_primary),
          autoIncrement: Boolean(field.autoId ?? field.auto_id),
        }));
        const vector = columns.find((column) => /^vector\(/.test(column.type));
        tables.push({
          name,
          type: 'table',
          kind: 'vector_collection',
          rowEstimate: data.numEntities ?? data.num_entities,
          columns,
          comment: vector ? `${vector.type} · ${data.indexes?.[0]?.metricType ?? data.metric_type ?? 'metric'}` : 'Milvus collection',
        });
      } catch {
        tables.push({ name, type: 'table', kind: 'vector_collection' });
      }
    }
    return tables;
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'vector') throw new DbError('Milvus 驱动只接受向量查询', { code: 'VECTOR_ONLY' });
    return this.vectorSearch(query, opts);
  }

  async vectorSearch(query: VectorQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (!query.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const started = Date.now();
    const topK = Math.max(1, Math.min(opts.maxRows && opts.maxRows > 0 ? opts.maxRows : query.topK, 1000));
    const scroll = query.op === 'scroll' || (!query.vector?.length && !query.text);
    if (scroll) {
      const response = await this.request<any>(
        '/v2/vectordb/entities/query',
        { collectionName: query.collection, filter: '', outputFields: ['*'], limit: topK },
        opts.timeoutMs ?? 30000,
      );
      return resultFromRows((response.data ?? []) as Array<Record<string, unknown>>, started, JSON.stringify(query), false);
    }
    if (!query.vector?.length) throw new DbError('Milvus 检索需要 vector 或 text', { code: 'VECTOR_REQUIRED' });
    const response = await this.request<any>(
      '/v2/vectordb/entities/search',
      {
        collectionName: query.collection,
        data: [query.vector],
        annsField: query.field || 'vector',
        limit: topK,
        outputFields: ['*'],
      },
      opts.timeoutMs ?? 30000,
    );
    return resultFromRows((response.data ?? []) as Array<Record<string, unknown>>, started, JSON.stringify(query), true);
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(sql);
    } catch {
      throw new DbError('Milvus 查询需要 JSON，例如 {"collection":"docs","vector":[...],"topK":5}', { code: 'VECTOR_PARSE' });
    }
    const query = vectorQueryFromArgs((parsed ?? {}) as Record<string, unknown>);
    if (!query.op) query.op = query.vector?.length || query.text ? 'search' : 'scroll';
    return this.vectorSearch(query, opts);
  }

  async runParams(): Promise<QueryResult> {
    throw new DbError('Milvus 不支持参数化 SQL，请使用向量查询', { code: 'VECTOR_ONLY' });
  }

  async upsertDocument(input: WriteDocumentInput, opts: RunOptions = {}): Promise<WriteDocumentResult> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'VECTOR_COLLECTION' });
    const document = { ...(input.document ?? {}) };
    if (input.id && document.id === undefined) document.id = input.id;
    const response = await this.request<any>(
      '/v2/vectordb/entities/upsert',
      { collectionName: input.collection, data: [document] },
      opts.timeoutMs ?? 30000,
    );
    const data = response?.data ?? {};
    const id = String(input.id ?? data.upsertIds?.[0] ?? data.insertIds?.[0] ?? document.id ?? '');
    return { id, upserted: Number(data.upsertCount ?? data.insertCount ?? 1) };
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}
