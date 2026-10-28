import neo4j from 'neo4j-driver';
import type { Driver as BoltDriver, Node as Neo4jNode, Relationship as Neo4jRelationship } from 'neo4j-driver';
import type { ColumnInfo, Engine, GraphData, QueryResult, StructuredQuery, TableInfo } from '@aidb/core';
import type { Driver, DriverTestResult, RunOptions, StructuredQueryDriver } from './types';
import { DbError } from './types';

export interface Neo4jOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  defaultDatabase?: string;
  ssl?: boolean;
}

function elementId(value: { elementId?: string; identity?: unknown }): string {
  return value.elementId ?? String(value.identity ?? '');
}

function scalarType(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (neo4j.isInt(value)) return 'integer';
  if (typeof value === 'number') return 'float';
  if (typeof value === 'boolean') return 'boolean';
  if (neo4j.isDate(value)) return 'date';
  if (neo4j.isDateTime(value) || neo4j.isLocalDateTime(value)) return 'datetime';
  if (neo4j.isDuration(value)) return 'duration';
  if (neo4j.isPoint(value)) return 'point';
  if (neo4j.isNode(value)) return 'node';
  if (neo4j.isRelationship(value)) return 'relationship';
  if (neo4j.isPath(value)) return 'path';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

function serialize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (neo4j.isInt(value)) {
    const n = value.toNumber();
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (neo4j.isDate(value) || neo4j.isDateTime(value) || neo4j.isLocalDateTime(value) || neo4j.isTime(value) || neo4j.isLocalTime(value) || neo4j.isDuration(value)) {
    return value.toString();
  }
  if (neo4j.isPoint(value)) return { x: value.x, y: value.y, z: value.z, srid: value.srid };
  if (neo4j.isNode(value)) {
    return {
      _id: elementId(value),
      _labels: value.labels,
      ...Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, serialize(child)])),
    };
  }
  if (neo4j.isRelationship(value)) {
    return {
      _id: elementId(value),
      _type: value.type,
      _start: value.startNodeElementId,
      _end: value.endNodeElementId,
      ...Object.fromEntries(Object.entries(value.properties).map(([key, child]) => [key, serialize(child)])),
    };
  }
  if (neo4j.isPath(value)) {
    return {
      _nodes: [value.start, ...value.segments.map((segment) => segment.end)].map((node) => serialize(node)),
      _relationships: value.segments.map((segment) => serialize(segment.relationship)),
    };
  }
  if (Array.isArray(value)) return value.map(serialize);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, serialize(child)]));
  }
  return value;
}

function inferColumns(nodes: Array<Neo4jNode | Neo4jRelationship>, edge: boolean): ColumnInfo[] {
  const stats = new Map<string, { present: number; types: Map<string, number> }>();
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node.properties)) {
      const entry = stats.get(key) ?? { present: 0, types: new Map<string, number>() };
      entry.present += 1;
      const type = scalarType(value);
      entry.types.set(type, (entry.types.get(type) ?? 0) + 1);
      stats.set(key, entry);
    }
  }
  const columns: ColumnInfo[] = [
    { name: '_id', type: 'string', nullable: false, primaryKey: true },
    { name: edge ? '_type' : '_labels', type: 'string', nullable: false, primaryKey: false },
  ];
  if (edge) {
    columns.push(
      { name: '_start', type: 'string', nullable: false, primaryKey: false },
      { name: '_end', type: 'string', nullable: false, primaryKey: false },
    );
  }
  for (const [name, entry] of stats) {
    columns.push({
      name,
      type: [...entry.types.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([type]) => type).join(' | '),
      nullable: entry.present < nodes.length,
      primaryKey: false,
    });
  }
  return columns;
}

function resultFromRecords(
  records: Array<{ keys: string[]; get(key: string): unknown }>,
  started: number,
  statement: string,
  maxRows: number,
  affected: number,
  graphData?: GraphData,
): QueryResult {
  const columnNames: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const key of record.keys) {
      if (seen.has(key)) continue;
      seen.add(key);
      columnNames.push(key);
    }
  }
  const ordered = columnNames.slice(0, 120);
  const rows = records.slice(0, maxRows).map((record) => ordered.map((key) => serialize(record.get(key))));
  let hasGraph = false;
  const columns = ordered.map((name) => {
    const sample = records.slice(0, maxRows).map((record) => record.get(name)).find((value) => value !== null && value !== undefined);
    const type = scalarType(sample);
    if (type === 'node' || type === 'relationship' || type === 'path') hasGraph = true;
    return {
      name,
      type,
      kind: type === 'node' || type === 'relationship' || type === 'path' || type === 'array' ? ('json' as const) : ('scalar' as const),
    };
  });
  return {
    columns,
    rows,
    rowCount: rows.length,
    durationMs: Date.now() - started,
    truncated: records.length > maxRows,
    affected: affected || undefined,
    statement,
    resultKind: hasGraph ? 'graph' : 'table',
    graph: graphData,
  };
}

function collectGraph(records: Array<{ keys: string[]; get(key: string): unknown }>): GraphData | undefined {
  const nodes = new Map<string, { id: string; labels: string[]; properties: Record<string, unknown> }>();
  const edges = new Map<string, { id: string; type: string; source: string; target: string; properties: Record<string, unknown> }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (neo4j.isNode(value)) {
      const id = elementId(value);
      if (!nodes.has(id)) {
        nodes.set(id, {
          id,
          labels: value.labels,
          properties: serialize(value.properties) as Record<string, unknown>,
        });
      }
      return;
    }
    if (neo4j.isRelationship(value)) {
      const id = elementId(value);
      if (!edges.has(id)) {
        edges.set(id, {
          id,
          type: value.type,
          source: value.startNodeElementId,
          target: value.endNodeElementId,
          properties: serialize(value.properties) as Record<string, unknown>,
        });
      }
      return;
    }
    if (neo4j.isPath(value)) {
      visit(value.start);
      for (const segment of value.segments) {
        visit(segment.start);
        visit(segment.relationship);
        visit(segment.end);
      }
    }
  };
  for (const record of records) for (const key of record.keys) visit(record.get(key));
  return nodes.size ? { nodes: [...nodes.values()], edges: [...edges.values()] } : undefined;
}

export class Neo4jDriver implements StructuredQueryDriver {
  engine: Engine;
  private bolt?: BoltDriver;

  constructor(private opts: Neo4jOptions, engine: Engine = 'neo4j') {
    this.engine = engine;
  }

  private uri(): string {
    if (this.opts.host.startsWith('neo4j://') || this.opts.host.startsWith('neo4j+s://') || this.opts.host.startsWith('bolt://') || this.opts.host.startsWith('bolt+s://')) {
      return this.opts.host;
    }
    const scheme = this.opts.ssl ? 'neo4j+s' : 'neo4j';
    const direct = this.opts.ssl ? 'bolt+s' : 'bolt';
    return `${this.engine === 'memgraph' ? direct : scheme}://${this.opts.host || '127.0.0.1'}:${this.opts.port || 7687}`;
  }

  private driver(): BoltDriver {
    if (!this.bolt) {
      const auth = this.opts.user ? neo4j.auth.basic(this.opts.user, this.opts.password ?? '') : undefined;
      this.bolt = neo4j.driver(this.uri(), auth, {
        maxConnectionPoolSize: 5,
        connectionTimeout: 8000,
        connectionAcquisitionTimeout: 8000,
      });
    }
    return this.bolt;
  }

  private database(database?: string): string {
    return database || this.opts.database || this.opts.defaultDatabase || 'neo4j';
  }

  async test(): Promise<DriverTestResult> {
    const started = Date.now();
    try {
      const driver = this.driver();
      await driver.verifyConnectivity();
      const info = await driver.getServerInfo();
      return { ok: true, version: info.agent || 'Neo4j', latencyMs: Date.now() - started };
    } catch (err: any) {
      return { ok: false, latencyMs: Date.now() - started, message: err?.message ?? '连接失败' };
    }
  }

  async listDatabases(): Promise<string[]> {
    const session = this.driver().session({ database: 'system' });
    try {
      const result = await session.run('SHOW DATABASES YIELD name RETURN name ORDER BY name');
      const names = result.records.map((record) => String(record.get('name'))).filter(Boolean);
      return names.length ? names : [this.opts.defaultDatabase ?? 'neo4j'];
    } catch {
      return [this.opts.defaultDatabase ?? 'neo4j'];
    } finally {
      await session.close();
    }
  }

  async describe(database?: string): Promise<TableInfo[]> {
    const db = this.database(database);
    const session = this.driver().session({ database: db });
    try {
      const labelsResult = await session.run(
        this.engine === 'memgraph'
          ? 'MATCH (n) UNWIND labels(n) AS label RETURN DISTINCT label ORDER BY label'
          : 'CALL db.labels() YIELD label RETURN label ORDER BY label',
      );
      const relResult = await session.run(
        this.engine === 'memgraph'
          ? 'MATCH ()-[r]->() RETURN DISTINCT type(r) AS relationshipType ORDER BY relationshipType'
          : 'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType',
      );
      const tables: TableInfo[] = [];
      for (const record of labelsResult.records.slice(0, 200)) {
        const label = String(record.get('label'));
        const table: TableInfo = { name: label, type: 'table', kind: 'node_label', comment: '节点标签' };
        try {
          const safe = label.replace(/`/g, '``');
          const sample = await session.run(`MATCH (n:\`${safe}\`) RETURN n LIMIT 30`);
          const nodes = sample.records.map((item) => item.get('n')).filter((value): value is Neo4jNode => neo4j.isNode(value));
          table.columns = inferColumns(nodes, false);
        } catch {
          table.columns = [];
        }
        tables.push(table);
      }
      for (const record of relResult.records.slice(0, 200)) {
        const type = String(record.get('relationshipType'));
        const table: TableInfo = { name: type, type: 'table', kind: 'edge_label', comment: '关系类型' };
        try {
          const safe = type.replace(/`/g, '``');
          const sample = await session.run(`MATCH ()-[r:\`${safe}\`]->() RETURN r LIMIT 30`);
          const rels = sample.records.map((item) => item.get('r')).filter((value): value is Neo4jRelationship => neo4j.isRelationship(value));
          table.columns = inferColumns(rels, true);
        } catch {
          table.columns = [];
        }
        tables.push(table);
      }
      return tables;
    } catch (err: any) {
      throw new DbError(err?.message ?? `无法读取 Neo4j 数据库 ${db}`, { code: err?.code ?? 'NEO4J_ERROR' });
    } finally {
      await session.close();
    }
  }

  async executeQuery(query: StructuredQuery, opts: RunOptions = {}): Promise<QueryResult> {
    if (query.language !== 'cypher') throw new DbError('Neo4j 驱动只接受 Cypher 查询', { code: 'CYPHER_ONLY' });
    const text = query.text.trim();
    if (!text) throw new DbError('Cypher 不能为空', { code: 'CYPHER_EMPTY' });
    const maxRows = Math.max(1, Math.min(opts.maxRows && opts.maxRows > 0 ? opts.maxRows : 200, 1000));
    const started = Date.now();
    const session = this.driver().session({ database: this.database(opts.database) });
    try {
      const result = await session.run(text, query.params ?? {}, { timeout: opts.timeoutMs });
      const updates = result.summary?.counters?.updates?.() ?? {};
      const affected = Object.values(updates).reduce((sum: number, value) => sum + Number(value ?? 0), 0);
      const records = result.records.map((record) => ({
        keys: record.keys.map(String),
        get: (key: string) => record.get(key),
      }));
      const graph = collectGraph(records);
      const plan = (result.summary as { plan?: unknown; profile?: unknown } | undefined)?.plan ?? (result.summary as { profile?: unknown } | undefined)?.profile;
      if (!records.length && plan) {
        return {
          columns: [{ name: 'plan', type: 'json', kind: 'json' }],
          rows: [[JSON.stringify(plan)]],
          rowCount: 1,
          durationMs: Date.now() - started,
          statement: text,
          resultKind: 'table',
        };
      }
      return resultFromRecords(records, started, text, maxRows, affected, graph);
    } catch (err: any) {
      if (err instanceof DbError) throw err;
      throw new DbError(err?.message ?? 'Cypher 执行失败', {
        code: err?.code ?? 'NEO4J_ERROR',
        hint: err?.code === 'Neo.ClientError.Security.Unauthorized' ? '检查 Neo4j 用户名与密码' : undefined,
      });
    } finally {
      await session.close();
    }
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
    await this.bolt?.close();
    this.bolt = undefined;
  }
}
