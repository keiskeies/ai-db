import type { ColumnInfo, Engine, GraphData, IndexInfo, QueryResult, StructuredQuery, TableInfo } from '@aidb/core';
import type {
  CollectionIndexDriver,
  CollectionIndexInput,
  CreateObjectInput,
  DeleteDocumentsInput,
  DocumentWriteDriver,
  Driver,
  DriverTestResult,
  ObjectCreateDriver,
  RunOptions,
  StructuredQueryDriver,
  WriteDocumentInput,
  WriteDocumentResult,
} from './types';
import { DbError } from './types';

export interface ArangoOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

interface CursorReply {
  result?: unknown[];
  hasMore?: boolean;
  id?: string;
  error?: boolean;
  errorMessage?: string;
  errorNum?: number;
  code?: number;
  extra?: { stats?: Record<string, number> };
}

interface CollectionMeta {
  name: string;
  type: 2 | 3;
  isSystem?: boolean;
}

/** ArangoDB 的索引条目转成对象树用的 IndexInfo。 */
function toIndexInfo(raw: any): IndexInfo {
  const fields = Array.isArray(raw?.fields)
    ? raw.fields.map((field: any) => (typeof field === 'string' ? field : String(field?.name ?? ''))).filter(Boolean)
    : [];
  const id = String(raw?.id ?? '');
  const suffix = id.includes('/') ? id.slice(id.indexOf('/') + 1) : '';
  return {
    name: String(raw?.name ?? suffix ?? ''),
    columns: fields,
    unique: Boolean(raw?.unique),
    primary: String(raw?.type ?? '') === 'primary' || suffix === '0',
    method: String(raw?.type ?? 'index'),
    comment: raw?.sparse ? 'sparse' : raw?.expireAfter !== undefined ? `TTL ${raw.expireAfter}` : undefined,
  };
}

function baseType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return 'string';
}

function cell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

function isPathDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.vertices) && Array.isArray(record.edges);
}

/** 把 AQL 结果里的边、路径与顶点汇总成图视图数据；没有边时返回 undefined。 */
function collectGraph(docs: unknown[]): { nodes: GraphData['nodes']; edges: GraphData['edges'] } | undefined {
  const nodes = new Map<string, GraphData['nodes'][number]>();
  const edges = new Map<string, GraphData['edges'][number]>();
  const addNode = (doc: unknown) => {
    if (!doc || typeof doc !== 'object') return;
    const record = doc as Record<string, unknown>;
    const id = typeof record._id === 'string' ? record._id : typeof record._key === 'string' ? record._key : '';
    if (!id) return;
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        labels: [id.split('/')[0]].filter(Boolean),
        properties: Object.fromEntries(Object.entries(record).filter(([key]) => !key.startsWith('_'))),
      });
    }
  };
  const addEdge = (doc: unknown) => {
    if (!doc || typeof doc !== 'object') return;
    if (!('_from' in (doc as object) && '_to' in (doc as object))) return;
    const record = doc as Record<string, unknown>;
    const id = String(record._id ?? `${record._from}->${record._to}`);
    if (edges.has(id)) return;
    const source = String(record._from ?? '');
    const target = String(record._to ?? '');
    edges.set(id, {
      id,
      type: id.split('/')[0] || 'edge',
      source,
      target,
      properties: Object.fromEntries(Object.entries(record).filter(([key]) => !['_from', '_to', '_id', '_key', '_rev'].includes(key))),
    });
    for (const ref of [source, target]) {
      const [collection, key] = ref.split('/');
      if (collection && key) nodes.set(ref, nodes.get(ref) ?? { id: ref, labels: [collection], properties: { _key: key } });
    }
  };
  for (const doc of docs) {
    if (isPathDocument(doc)) {
      for (const vertex of doc.vertices as unknown[]) addNode(vertex);
      for (const edge of doc.edges as unknown[]) addEdge(edge);
    } else {
      addEdge(doc);
    }
  }
  if (!edges.size) return undefined;
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

function screenColumns(docs: unknown[]): { columns: ColumnInfo[]; keys: string[] } {
  const seen = new Map<string, Set<string>>();
  let sampled = 0;
  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    sampled += 1;
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      const types = seen.get(key) ?? new Set<string>();
      types.add(baseType(value).replace(/^-?\d+(\.\d+)?$/, 'number'));
      seen.set(key, types);
    }
  }
  const keys = [...seen.keys()];
  const columns = keys.map((name) => ({
    name,
    type: [...(seen.get(name) ?? [])].filter((type) => type !== 'null').join(' | ') || 'null',
    nullable: (seen.get(name)?.size ?? 0) > 0 && sampled > 0,
    primaryKey: name === '_key',
  }));
  return { columns, keys };
}

export class ArangoDriver implements Driver, StructuredQueryDriver, ObjectCreateDriver, DocumentWriteDriver, CollectionIndexDriver {
  engine: Engine = 'arangodb';

  constructor(private opts: ArangoOptions) {}

  private base(): string {
    if (/^https?:\/\//i.test(this.opts.host)) return this.opts.host.replace(/\/+$/, '');
    return `${this.opts.ssl ? 'https' : 'http'}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 8529}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'content-type': 'application/json', connection: 'close' };
    const user = this.opts.user ?? 'root';
    const token = `${user}:${this.opts.password ?? ''}`;
    headers.authorization = `Basic ${Buffer.from(token, 'utf8').toString('base64')}`;
    return headers;
  }

  /** ArangoDB 把库放进 URL 前缀；数据库名必须转义，避免路径穿越到别的库。 */
  private dbPath(database?: string): string {
    const db = database || this.opts.database || '_system';
    return `/_db/${encodeURIComponent(db)}`;
  }

  private async send(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<{ status: number; body: any }> {
    let response: Response;
    try {
      response = await fetch(`${this.base()}${path}`, {
        method: init.method ?? 'GET',
        headers: this.headers(),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs ?? 30000),
      });
    } catch (err: any) {
      throw new DbError(`ArangoDB 请求失败：${err?.message ?? '网络错误'}`, { code: 'ARANGO_NETWORK' });
    }
    const text = await response.text();
    const body = text ? (JSON.parse(text) as CursorReply) : {};
    if (!response.ok || body?.error) {
      throw new DbError(`ArangoDB 执行失败：${body?.errorMessage ?? `HTTP ${response.status}`}`, {
        code: `ARANGO_${body?.errorNum ?? response.status}`,
      });
    }
    return { status: response.status, body };
  }

  private async cursor(database: string | undefined, query: string, bindVars?: Record<string, unknown>, maxRows?: number): Promise<{ docs: unknown[]; truncated: boolean; stats?: Record<string, number> }> {
    const batchSize = maxRows && maxRows > 0 ? Math.min(1000, Math.max(1, maxRows)) : 1000;
    const first = await this.send(`${this.dbPath(database)}/_api/cursor`, {
      method: 'POST',
      body: { query, bindVars: bindVars ?? {}, batchSize, count: true },
    });
    let docs: unknown[] = Array.isArray(first.body.result) ? first.body.result : [];
    let hasMore = Boolean(first.body.hasMore);
    let id = typeof first.body.id === 'string' ? first.body.id : undefined;
    const limit = maxRows && maxRows > 0 ? maxRows : Infinity;
    while (hasMore && id && docs.length < limit) {
      const next = await this.send(`${this.dbPath(database)}/_api/cursor/${encodeURIComponent(id)}`);
      docs = docs.concat(Array.isArray(next.body.result) ? next.body.result : []);
      hasMore = Boolean(next.body.hasMore);
      if (!next.body.id) id = undefined;
    }
    if (id && hasMore) {
      await this.send(`${this.dbPath(database)}/_api/cursor/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);
    }
    return { docs: docs.slice(0, limit), truncated: hasMore || docs.length > limit, stats: first.body.extra?.stats };
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const version = await this.send('/_api/version');
      await this.send(`${this.dbPath()}/_api/cursor`, { method: 'POST', body: { query: 'RETURN 1', batchSize: 1 } });
      return {
        ok: true,
        version: version.body?.version ? `ArangoDB ${version.body.version}` : 'ArangoDB',
        latencyMs: Date.now() - started,
      };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const { body } = await this.send('/_api/database');
    return Array.isArray(body.result) ? body.result.map((name: unknown) => String(name)).filter(Boolean) : [];
  }

  private async collections(database?: string): Promise<CollectionMeta[]> {
    const { body } = await this.send(`${this.dbPath(database)}/_api/collection`);
    const list = Array.isArray(body.result) ? body.result : [];
    return list
      .map((item: any) => ({ name: String(item.name ?? ''), type: Number(item.type) === 3 ? 3 : 2, isSystem: Boolean(item.isSystem) }))
      .filter((item: CollectionMeta) => item.name && (!item.isSystem || item.name === '_graphs'));
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const db = database || this.opts.database || '_system';
    const collections = await this.collections(db);
    const result: TableInfo[] = [];
    for (const collection of collections) {
      const table: TableInfo = {
        name: collection.name,
        type: 'table',
        kind: collection.type === 3 ? 'edge_label' : 'collection',
        schema: db,
        comment: collection.type === 3 ? '边集合' : '文档集合',
      };
      try {
        const { docs } = await this.cursor(db, `FOR d IN @@collection LIMIT 30 RETURN d`, { '@collection': collection.name }, 30);
        table.columns = screenColumns(docs).columns;
      } catch {
        table.columns = [];
      }
      try {
        table.indexes = (await this.indexList(db, collection.name)).map(toIndexInfo);
      } catch {
        /* 索引读取失败不影响对象树 */
      }
      result.push(table);
    }
    return result;
  }

  async createObject(input: CreateObjectInput, opts: RunOptions = {}): Promise<{ name: string; kind: string }> {
    const target = input.name.trim();
    if (!target) throw new DbError('集合名不能为空', { code: 'AQL_COLLECTION' });
    if (target.startsWith('_')) throw new DbError('不能创建以 _ 开头的系统集合', { code: 'AQL_COLLECTION' });
    await this.send(`${this.dbPath(opts.database)}/_api/collection`, {
      method: 'POST',
      // type 只能写在请求体里：ArangoDB 会忽略同名查询参数
      body: { name: target, type: input.edge ? 3 : 2 },
      timeoutMs: opts.timeoutMs,
    });
    return { name: target, kind: input.edge ? 'edge_label' : 'collection' };
  }

  async dropObject(name: string, opts: RunOptions = {}): Promise<{ name: string; dropped: boolean }> {
    const target = name.trim();
    if (!target) throw new DbError('集合名不能为空', { code: 'AQL_COLLECTION' });
    if (target.startsWith('_')) throw new DbError('系统集合不允许删除', { code: 'AQL_COLLECTION' });
    await this.send(`${this.dbPath(opts.database)}/_api/collection/${encodeURIComponent(target)}`, {
      method: 'DELETE',
      timeoutMs: opts.timeoutMs,
    });
    return { name: target, dropped: true };
  }

  /** 读取单文档：文档句柄（collection/key）分成两段走文档接口，未命中回 404 而不是通用错误。 */
  async getDocument(collection: string, id: string, database?: string): Promise<{ id: string; document: string }> {
    const collectionName = collection.trim();
    const key = id.trim();
    if (!collectionName || !key) throw new DbError('集合名与文档键必填', { code: 'AQL_COLLECTION' });
    const handle = `${encodeURIComponent(collectionName)}/${encodeURIComponent(key)}`;
    let response: Response;
    try {
      response = await fetch(
        `${this.base()}${this.dbPath(database)}/_api/document/${handle}`,
        { headers: this.headers(), signal: AbortSignal.timeout(30000) },
      );
    } catch (err: any) {
      throw new DbError(`ArangoDB 请求失败：${err?.message ?? '网络错误'}`, { code: 'ARANGO_NETWORK' });
    }
    if (response.status === 404) throw new DbError(`文档不存在：${collectionName}/${key}`, { code: 'ARANGO_DOC_NOT_FOUND', status: 404 });
    const body = (await response.json().catch(() => null)) as any;
    if (!response.ok || body?.error) {
      throw new DbError(`ArangoDB 执行失败：${body?.errorMessage ?? `HTTP ${response.status}`}`, {
        code: `ARANGO_${body?.errorNum ?? response.status}`,
      });
    }
    return { id: String(body?._key ?? id), document: JSON.stringify(body ?? {}) };
  }

  /** 批量写入走文档接口：overwriteMode=replace 让带 _key 的文档替换、其余插入。 */
  async upsertDocuments(input: WriteDocumentInput, opts: RunOptions = {}): Promise<WriteDocumentResult> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'AQL_COLLECTION' });
    if (!input.documents.length) throw new DbError('至少需要一个文档', { code: 'WRITE_DOCUMENT' });
    const docs = input.documents.map((document) => {
      const clone = { ...document };
      delete clone._id;
      delete clone._rev;
      return clone;
    });
    const reply = await this.send(
      `${this.dbPath(opts.database)}/_api/document/${encodeURIComponent(input.collection)}?overwriteMode=replace`,
      { method: 'POST', body: docs, timeoutMs: opts.timeoutMs ?? 30000 },
    );
    const items = Array.isArray(reply.body) ? reply.body : [];
    const failed = items.find((item: any) => item?.error);
    if (failed) {
      throw new DbError(String(failed.errorMessage ?? '写入失败'), { code: `ARANGO_${failed.errorNum ?? 0}` });
    }
    return { ids: items.map((item: any) => String(item._key ?? '')), upserted: items.length };
  }

  async deleteDocuments(input: DeleteDocumentsInput, opts: RunOptions = {}): Promise<{ deleted: number }> {
    if (!input.collection) throw new DbError('collection 不能为空', { code: 'AQL_COLLECTION' });
    if (!input.ids.length) throw new DbError('ids 不能为空', { code: 'WRITE_IDS' });
    const { docs } = await this.cursor(
      opts.database,
      `FOR d IN @@collection FILTER d._key IN @ids REMOVE d IN @@collection RETURN OLD._key`,
      { '@collection': input.collection, ids: input.ids },
      input.ids.length,
    );
    return { deleted: docs.length };
  }

  /** 3.12 起索引接口靠查询参数定位集合，路径里带集合名反而被拒绝。 */
  private async indexList(database: string | undefined, collection: string): Promise<any[]> {
    const { body } = await this.send(`${this.dbPath(database)}/_api/index?collection=${encodeURIComponent(collection)}`);
    return Array.isArray(body?.indexes) ? body.indexes : [];
  }

  async createIndex(input: CollectionIndexInput, opts: RunOptions = {}): Promise<{ name: string; created: boolean }> {
    const target = input.collection.trim();
    if (!target) throw new DbError('集合名不能为空', { code: 'AQL_COLLECTION' });
    const fields = input.columns.map((column) => column.trim()).filter(Boolean);
    if (!fields.length) throw new DbError('索引至少需要一个字段', { code: 'AQL_INDEX' });
    // 不给名字的话 ArangoDB 会生成 idx_<数字>，在面板里既难认也难手输确认
    const name = input.name?.trim() || fields.join('_');
    const { body } = await this.send(`${this.dbPath(opts.database)}/_api/index?collection=${encodeURIComponent(target)}`, {
      method: 'POST',
      // 这一版只接受 inverted 索引；unique / ttl 等类型名会被判定为非法类型
      body: { type: 'inverted', fields, name },
      timeoutMs: opts.timeoutMs ?? 30000,
    });
    return { name: String(body?.name ?? name), created: true };
  }

  async dropIndex(input: { collection: string; name: string }, opts: RunOptions = {}): Promise<{ name: string; dropped: boolean }> {
    const target = input.collection.trim();
    const name = input.name.trim();
    if (!target) throw new DbError('集合名不能为空', { code: 'AQL_COLLECTION' });
    if (!name) throw new DbError('索引名不能为空', { code: 'AQL_INDEX' });
    const indexes = await this.indexList(opts.database, target);
    const match = indexes.find((index) => toIndexInfo(index).name === name);
    if (!match) throw new DbError(`索引不存在：${name}`, { code: 'AQL_INDEX_NOT_FOUND', status: 404 });
    if (toIndexInfo(match).primary) throw new DbError('主键索引不能删除', { code: 'AQL_INDEX' });
    const id = String(match.id ?? '');
    const [owner, number] = id.includes('/') ? [id.slice(0, id.indexOf('/')), id.slice(id.indexOf('/') + 1)] : [target, id];
    await this.send(
      `${this.dbPath(opts.database)}/_api/index/${encodeURIComponent(owner || target)}/${encodeURIComponent(number)}`,
      { method: 'DELETE', timeoutMs: opts.timeoutMs ?? 30000 },
    );
    return { name, dropped: true };
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'aql') throw new DbError('ArangoDB 驱动只接受 AQL 查询', { code: 'AQL_ONLY' });
    const started = Date.now();
    const statement = query.text.trim();
    if (!statement) throw new DbError('AQL 不能为空', { code: 'AQL_EMPTY' });
    const { docs, truncated, stats } = await this.cursor(opts.database, statement, query.params, opts.maxRows);
    const { columns, keys } = screenColumns(docs.slice(0, 50));
    if (!docs.length) {
      const written = stats?.writesExecuted ?? 0;
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affected: written || undefined,
        durationMs: Date.now() - started,
        statement,
      };
    }
    const rows = docs.map((doc) => {
      if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
        const record = doc as Record<string, unknown>;
        return keys.map((key) => cell(record[key]));
      }
      return [cell(doc)];
    });
    const graphData = collectGraph(docs);
    return {
      columns: columns.length ? columns : [{ name: 'value', type: 'json', nullable: true, primaryKey: false }],
      rows,
      rowCount: rows.length,
      durationMs: Date.now() - started,
      truncated,
      statement,
      resultKind: graphData ? 'graph' : 'table',
      graph: graphData,
    };
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.executeQuery({ language: 'aql', text: sql }, opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const named: Record<string, unknown> = {};
    params.forEach((value, index) => {
      named[`p${index + 1}`] = value;
    });
    return this.executeQuery({ language: 'aql', text: sql, params: named }, opts);
  }

  async close(): Promise<void> {
    /* fetch has no persistent connection */
  }
}