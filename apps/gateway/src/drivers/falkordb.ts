import { Redis } from 'ioredis';
import type { Engine, GraphData, QueryResult, StructuredQuery, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions, StructuredQueryDriver } from './types';
import { DbError } from './types';
import { withQueryTimeout } from './timeout';

export interface FalkorOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  database?: string;
  ssl?: boolean;
}

type Pair = [string, unknown];

function isPairs(value: unknown): value is Pair[] {
  return Array.isArray(value) && value.every((item) => Array.isArray(item) && item.length === 2 && typeof item[0] === 'string');
}

function toProperties(value: unknown): Record<string, unknown> {
  if (!isPairs(value)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, raw] of value) out[key] = scalar(raw);
  return out;
}

function isNode(value: unknown): value is Pair[] {
  return isPairs(value) && value.some(([key]) => key === 'labels') && value.some(([key]) => key === 'properties');
}

function isEdge(value: unknown): value is Pair[] {
  return isPairs(value) && value.some(([key]) => key === 'type') && value.some(([key]) => key === 'src_node');
}

function scalar(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (isNode(value)) return nodeCell(value);
  if (isEdge(value)) return edgeCell(value);
  if (Array.isArray(value)) return JSON.stringify(value.map(scalar));
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function pairMap(value: Pair[]): Map<string, unknown> {
  return new Map(value.map(([key, raw]) => [key, raw]));
}

function nodeCell(value: Pair[]): Record<string, unknown> {
  const map = pairMap(value);
  return {
    id: String(map.get('id') ?? ''),
    labels: Array.isArray(map.get('labels')) ? map.get('labels') : [],
    properties: toProperties(map.get('properties')),
  };
}

function edgeCell(value: Pair[]): Record<string, unknown> {
  const map = pairMap(value);
  return {
    id: String(map.get('id') ?? ''),
    type: String(map.get('type') ?? ''),
    source: String(map.get('src_node') ?? ''),
    target: String(map.get('dest_node') ?? ''),
    properties: toProperties(map.get('properties')),
  };
}

function columnType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (isNode(value)) return 'node';
  if (isEdge(value)) return 'relationship';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'string';
}

function statsMessage(stats: unknown): string[] {
  return Array.isArray(stats) ? stats.map((item) => String(item)).filter((item) => /created|deleted|set|removed|index/i.test(item)) : [];
}

function collectGraph(rows: unknown[][]): GraphData | undefined {
  const nodes = new Map<string, { id: string; labels: string[]; properties: Record<string, unknown> }>();
  const edges = new Map<string, { id: string; type: string; source: string; target: string; properties: Record<string, unknown> }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      if (isNode(value)) {
        const node = nodeCell(value);
        const id = String(node.id);
        if (!nodes.has(id)) nodes.set(id, { id, labels: node.labels as string[], properties: node.properties as Record<string, unknown> });
        return;
      }
      if (isEdge(value)) {
        const edge = edgeCell(value);
        const id = String(edge.id);
        if (!edges.has(id)) {
          edges.set(id, {
            id,
            type: String(edge.type),
            source: String(edge.source),
            target: String(edge.target),
            properties: edge.properties as Record<string, unknown>,
          });
        }
        return;
      }
      value.forEach(visit);
    }
  };
  for (const row of rows) for (const cell of row) visit(cell);
  return nodes.size ? { nodes: [...nodes.values()], edges: [...edges.values()] } : undefined;
}

function cypherLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(cypherLiteral).join(', ')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, raw]) => `${key}: ${cypherLiteral(raw)}`);
    return `{${entries.join(', ')}}`;
  }
  return cypherLiteral(String(value));
}

function inlineParams(text: string, params?: Record<string, unknown>): string {
  if (!params || !Object.keys(params).length) return text;
  const prefix = Object.entries(params)
    .map(([key, value]) => `${key}=${cypherLiteral(value)}`)
    .join(' ');
  return `CYPHER ${prefix} ${text}`;
}

function replyShape(reply: unknown): { header: string[]; rows: unknown[][]; stats: unknown[] } {
  if (!Array.isArray(reply)) throw new DbError('FalkorDB 返回格式异常', { code: 'FALKOR_REPLY' });
  const header = Array.isArray(reply[0]) ? (reply[0] as unknown[]).map((name) => String(name)) : [];
  const rows = Array.isArray(reply[1]) ? (reply[1] as unknown[][]).map((row) => (Array.isArray(row) ? row : [row])) : [];
  const stats = Array.isArray(reply[2]) ? (reply[2] as unknown[]) : [];
  return { header, rows, stats };
}

export class FalkorDriver implements StructuredQueryDriver {
  engine: Engine = 'falkordb';
  private client?: Redis;

  constructor(private opts: FalkorOptions) {}

  private redis(): Redis {
    if (!this.client) {
      this.client = new Redis({
        host: this.opts.host || '127.0.0.1',
        port: this.opts.port || 6379,
        username: this.opts.username || undefined,
        password: this.opts.password || undefined,
        tls: this.opts.ssl ? {} : undefined,
        lazyConnect: true,
        connectTimeout: 8000,
        // 安全网：普通元数据调用不会无限挂住；用户查询由更短的 queryTimeoutMs 控制
        commandTimeout: 300_000,
        enableReadyCheck: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
    }
    return this.client;
  }

  private async call(command: string, ...args: string[]): Promise<unknown> {
    try {
      const client = this.redis();
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      return await client.call(command, ...args);
    } catch (err: any) {
      throw new DbError(`FalkorDB 执行失败：${err?.message ?? '未知错误'}`, {
        code: err?.message?.includes('wrong number') ? 'FALKOR_COMMAND' : 'FALKOR_QUERY',
      });
    }
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const client = this.redis();
      if (client.status === 'wait' || client.status === 'end') await client.connect();
      await client.ping();
      const info = await this.call('GRAPH.QUERY', this.opts.database || 'aidb', 'RETURN 1 AS ok');
      replyShape(info);
      return { ok: true, version: 'FalkorDB', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const reply = await this.call('GRAPH.LIST');
    const names = Array.isArray(reply) ? reply.map((name) => String(name)).filter(Boolean) : [];
    return names.length ? names : [this.opts.database || 'aidb'];
  }

  private async labels(graph: string, kind: 'node' | 'edge'): Promise<string[]> {
    const statement =
      kind === 'node'
        ? 'MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label'
        : 'MATCH ()-[r]->() UNWIND type(r) AS relType RETURN DISTINCT relType AS label ORDER BY label';
    try {
      const { rows } = replyShape(await this.call('GRAPH.QUERY', graph, statement));
      return rows.map((row) => String(row[0] ?? '')).filter(Boolean).slice(0, 200);
    } catch {
      return [];
    }
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const graph = database || this.opts.database || 'aidb';
    const [nodeLabels, edgeLabels] = await Promise.all([this.labels(graph, 'node'), this.labels(graph, 'edge')]);
    const tables: TableInfo[] = [];
    for (const label of nodeLabels) {
      const columns = await this.sampleColumns(graph, { label, edge: false });
      tables.push({ name: label, type: 'table', kind: 'node_label', schema: graph, columns, comment: '节点标签' });
    }
    for (const label of edgeLabels) {
      const columns = await this.sampleColumns(graph, { label, edge: true });
      tables.push({ name: label, type: 'table', kind: 'edge_label', schema: graph, columns, comment: '关系类型' });
    }
    return tables;
  }

  private async sampleColumns(graph: string, target: { label: string; edge: boolean }): Promise<Array<{ name: string; type: string; nullable: boolean; primaryKey: boolean }>> {
    const label = target.label.replace(/`/g, '``');
    const statement = target.edge
      ? `MATCH ()-[r:\`${label}\`]->() RETURN r LIMIT 30`
      : `MATCH (n:\`${label}\`) RETURN n LIMIT 30`;
    try {
      const { rows } = replyShape(await this.call('GRAPH.QUERY', graph, statement));
      const stats = new Map<string, { types: Set<string>; present: number }>();
      let samples = 0;
      for (const row of rows) {
        const value = row[0];
        const properties = isEdge(value) ? edgeCell(value).properties : isNode(value) ? nodeCell(value).properties : undefined;
        if (!properties) continue;
        samples += 1;
        for (const [name, raw] of Object.entries(properties as Record<string, unknown>)) {
          const entry = stats.get(name) ?? { types: new Set<string>(), present: 0 };
          entry.types.add(columnType(raw));
          entry.present += 1;
          stats.set(name, entry);
        }
      }
      return [...stats.entries()].map(([name, entry]) => ({
        name,
        type: [...entry.types].join(' | '),
        nullable: entry.present < samples,
        primaryKey: name === 'id',
      }));
    } catch {
      return [];
    }
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'cypher') throw new DbError('FalkorDB 驱动只接受 Cypher 查询', { code: 'CYPHER_ONLY' });
    const graph = opts.database || this.opts.database || 'aidb';
    const started = Date.now();
    const statement = query.text.trim();
    const reply = await withQueryTimeout(this.call('GRAPH.QUERY', graph, inlineParams(statement, query.params)), opts.timeoutMs, {
      code: 'FALKOR_TIMEOUT',
      label: 'FalkorDB 查询',
      onTimeout: () => {
        this.client?.disconnect();
        this.client = undefined;
      },
    });
    const { header, rows, stats } = replyShape(reply);
    const messages = statsMessage(stats);
    if (!header.length) {
      const created = [...messages.join(' ').matchAll(/(\d+) created/gi)].reduce((sum, match) => sum + Number(match[1]), 0);
      return {
        columns: [],
        rows: [],
        rowCount: 0,
        affected: created || undefined,
        durationMs: Date.now() - started,
        statement,
        messages,
      };
    }
    const limited = rows.slice(0, opts.maxRows && opts.maxRows > 0 ? opts.maxRows : rows.length);
    const cells = limited.map((row) => header.map((_, index) => scalar(row[index])));
    const columns = header.slice(0, 120).map((name, index) => {
      const sample = limited.map((row) => row[index]).find((value) => value !== null && value !== undefined);
      const type = columnType(sample);
      const graphLike = type === 'node' || type === 'relationship';
      return { name, type, kind: graphLike || type === 'array' ? ('json' as const) : ('scalar' as const) };
    });
    const hasGraph = columns.some((column) => column.type === 'node' || column.type === 'relationship');
    return {
      columns,
      rows: cells,
      rowCount: cells.length,
      durationMs: Date.now() - started,
      truncated: rows.length > limited.length,
      statement,
      resultKind: hasGraph ? 'graph' : 'table',
      graph: hasGraph ? collectGraph(limited) : undefined,
      messages,
    };
  }

  async run(sql: string, opts: RunOptions = {}): Promise<QueryResult> {
    return this.executeQuery({ language: 'cypher', text: sql }, opts);
  }

  async runParams(sql: string, params: unknown[], opts: RunOptions = {}): Promise<QueryResult> {
    const named: Record<string, unknown> = {};
    params.forEach((value, index) => {
      named[`p${index + 1}`] = value;
    });
    return this.executeQuery({ language: 'cypher', text: sql, params: named }, opts);
  }

  async close(): Promise<void> {
    this.client?.disconnect();
    this.client = undefined;
  }
}
