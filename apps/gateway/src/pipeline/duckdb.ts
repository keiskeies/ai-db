import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PipelineError } from './types';

/**
 * SQL 步骤的执行环境：一次运行一个内存 DuckDB。
 *
 * 上一步的行集写成 JSON 文件，再用 read_json_auto 注册成 `input` 视图——
 * 这样 SQL 步骤能直接用窗口函数、group by、join 处理任意来源的数据，
 * 而不用把数据塞回业务库。node 绑定自带 JSON 读法，不需要联网装扩展。
 */

const MAX_STATEMENT_BYTES = 200_000;

export interface DuckQueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
}

export class DuckdbSession {
  private instance?: DuckDBInstance;
  private connection?: DuckDBConnection;
  private opening?: Promise<DuckDBConnection>;
  private seq = 0;

  constructor(private readonly dir: string) {}

  private async connect(): Promise<DuckDBConnection> {
    if (this.connection) return this.connection;
    if (!this.opening) {
      this.opening = DuckDBInstance.create(':memory:')
        .then(async (instance) => {
          this.instance = instance;
          this.connection = await instance.connect();
          return this.connection;
        })
        .catch((err) => {
          this.opening = undefined;
          throw new PipelineError(`DuckDB 初始化失败：${err?.message ?? err}`, 'PIPELINE_DUCKDB_OPEN');
        });
    }
    return this.opening;
  }

  /**
   * 把行集注册为 input 视图。
   *
   * 空行集不建视图：read_json_auto 对 `[]` 会报「没有可读的行」，
   * 而「上一步没数据」是可预期的状态，应该由调用方短路而不是抛驱动错误。
   */
  async loadRows(rows: Record<string, unknown>[]): Promise<boolean> {
    if (!rows.length) return false;
    const connection = await this.connect();
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `input-${(this.seq += 1)}.json`);
    await writeFile(file, JSON.stringify(rows), 'utf8');
    const literal = file.replace(/\\/g, '/').replace(/'/g, "''");
    try {
      await connection.run(`CREATE OR REPLACE VIEW input AS SELECT * FROM read_json_auto('${literal}', union_by_name => true)`);
    } catch (err: any) {
      throw new PipelineError(`上一步数据无法建为 input 表：${err?.message ?? err}`, 'PIPELINE_DUCKDB_LOAD', '行里混用了不兼容的类型时，先在 map 步骤里把字段投影成一致的形状');
    }
    return true;
  }

  async query(sql: string, maxRows: number): Promise<DuckQueryResult> {
    const statement = singleStatement(sql);
    const connection = await this.connect();
    try {
      const reader = await connection.runAndReadAll(statement);
      const columns = reader.columnNames();
      const raw = reader.getRows();
      const limit = Math.min(raw.length, maxRows);
      const rows: Record<string, unknown>[] = [];
      for (let index = 0; index < limit; index += 1) {
        const record: Record<string, unknown> = {};
        columns.forEach((name, position) => {
          record[name] = normalizeValue(raw[index][position]);
        });
        rows.push(record);
      }
      return { columns, rows };
    } catch (err: any) {
      throw new PipelineError(`DuckDB 执行失败：${cleanDriverMessage(err?.message ?? err)}`, 'PIPELINE_DUCKDB_QUERY', '表名固定是 input；可以先在 map 步骤里把列名改成英文再算');
    }
  }

  async close(): Promise<void> {
    try {
      this.connection?.closeSync();
    } catch {
      /* 忽略关闭失败 */
    }
    try {
      this.instance?.closeSync();
    } catch {
      /* 忽略关闭失败 */
    }
    this.connection = undefined;
    this.instance = undefined;
    this.opening = undefined;
    await rm(this.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function singleStatement(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new PipelineError('SQL 步骤没有内容', 'PIPELINE_SQL_EMPTY');
  if (trimmed.length > MAX_STATEMENT_BYTES) throw new PipelineError('SQL 步骤过长', 'PIPELINE_SQL_TOO_LONG');
  if (/;/.test(trimmed)) throw new PipelineError('SQL 步骤只允许一条语句', 'PIPELINE_SQL_MULTI', '去掉分号，或拆成两个步骤');
  return trimmed;
}

function cleanDriverMessage(message: unknown): string {
  return String(message)
    .replace(/\nLINE \d+.*$/s, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

/** DuckDB 的 list/struct/date/decimal 是包装对象，必须转成 JSON 可序列化的值。 */
function normalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `<binary ${value.length} bytes>`;
  const boxed = value as {
    items?: unknown[];
    entries?: Record<string, unknown>;
    days?: number | bigint;
    microseconds?: bigint;
    nanoseconds?: bigint;
    hours?: bigint;
    minutes?: bigint;
    seconds?: bigint;
    scale?: number;
    value?: bigint;
  };
  if (Array.isArray(boxed.items)) return boxed.items.map(normalizeValue);
  if (boxed.entries && typeof boxed.entries === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(boxed.entries)) out[key] = normalizeValue(item);
    return out;
  }
  if (boxed.days !== undefined && boxed.microseconds !== undefined) {
    const ms = Number(boxed.days) * 86400000 + Number(boxed.microseconds) / 1000;
    return new Date(ms).toISOString();
  }
  if (boxed.days !== undefined && boxed.nanoseconds !== undefined) {
    const ms = Number(boxed.days) * 86400000 + Number(boxed.nanoseconds) / 1_000_000;
    return new Date(ms).toISOString();
  }
  if (typeof boxed.days === 'number' && boxed.hours === undefined) {
    return new Date(boxed.days * 86400000).toISOString().slice(0, 10);
  }
  if (boxed.hours !== undefined && boxed.minutes !== undefined && boxed.seconds !== undefined) {
    const micro = boxed.microseconds ?? 0n;
    return `${String(boxed.hours).padStart(2, '0')}:${String(boxed.minutes).padStart(2, '0')}:${String(boxed.seconds).padStart(2, '0')}${micro ? `.${String(Number(micro)).padStart(6, '0')}` : ''}`;
  }
  if (boxed.scale !== undefined && boxed.value !== undefined) {
    return Number(boxed.value) / 10 ** boxed.scale;
  }
  if (typeof value === 'object') {
    const plain = value as Record<string, unknown>;
    const keys = Object.keys(plain);
    if (!keys.length) return null;
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = normalizeValue(plain[key]);
    return out;
  }
  return value;
}
