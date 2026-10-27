import type { QueryResult } from '@aidb/core';
import { quoteLiteral } from '@aidb/core';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

export interface AdvancedObject {
  name: string;
  type: string;
  table?: string;
  detail?: string;
  definition?: string;
}

export interface AdvancedObjectsResult {
  supported: boolean;
  triggers: AdvancedObject[];
  routines: AdvancedObject[];
  sequences: AdvancedObject[];
  events: AdvancedObject[];
  note?: string;
}

function objectsFrom(result: QueryResult, mapper: (row: unknown[], names: string[]) => AdvancedObject): AdvancedObject[] {
  const names = result.columns.map((column) => column.name);
  return result.rows.map((row) => mapper(row, names));
}

export async function listAdvancedObjects(
  store: Store,
  manager: ConnectionManager,
  connectionId: string,
  database?: string,
): Promise<AdvancedObjectsResult> {
  const conn = store.getConnection(connectionId);
  if (!conn) throw new Error('连接不存在');
  const db = database ?? conn.database;
  const run = async (sql: string) => {
    const batch = await manager.query(connectionId, sql, {
      database: db,
      maxRows: 500,
      allowMulti: false,
      autoLimit: false,
      actor: 'user',
    });
    return batch.sets[0] as QueryResult;
  };
  const empty: AdvancedObjectsResult = { supported: true, triggers: [], routines: [], sequences: [], events: [] };

  if (conn.engine === 'sqlite') {
    const result = await run("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name");
    const triggers = objectsFrom(result, (row) => ({ name: String(row[0]), type: 'trigger', definition: String(row[1] ?? '') }));
    return { ...empty, triggers };
  }
  if (conn.engine === 'mysql' || conn.engine === 'mariadb') {
    const dbl = quoteLiteral(db ?? '');
    const triggers = objectsFrom(
      await run(`SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION, ACTION_STATEMENT FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ${dbl} ORDER BY TRIGGER_NAME`),
      (row) => ({ name: String(row[0]), type: 'trigger', table: String(row[1] ?? ''), detail: `${row[2]} ${row[3]}`, definition: String(row[4] ?? '') }),
    );
    const routines = objectsFrom(
      await run(`SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ${dbl} ORDER BY ROUTINE_NAME`),
      (row) => ({ name: String(row[0]), type: String(row[1] ?? 'routine').toLowerCase(), detail: String(row[2] ?? '') }),
    );
    const events = objectsFrom(
      await run(`SELECT EVENT_NAME, STATUS, EVENT_DEFINITION FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ${dbl} ORDER BY EVENT_NAME`),
      (row) => ({ name: String(row[0]), type: 'event', detail: String(row[1] ?? ''), definition: String(row[2] ?? '') }),
    );
    return { supported: true, triggers, routines, sequences: [], events };
  }
  if (conn.engine === 'postgresql' || conn.engine === 'cockroachdb') {
    const triggers = objectsFrom(
      await run(`SELECT t.tgname, c.relname, pg_get_triggerdef(t.oid) FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE NOT t.tgisinternal AND n.nspname NOT IN ('pg_catalog','information_schema')
        ORDER BY c.relname, t.tgname`),
      (row) => ({ name: String(row[0]), type: 'trigger', table: String(row[1] ?? ''), definition: String(row[2] ?? '') }),
    );
    const routines = objectsFrom(
      await run(`SELECT p.proname, CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END, pg_get_functiondef(p.oid)
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY p.proname`),
      (row) => ({ name: String(row[0]), type: String(row[1] ?? ''), definition: String(row[2] ?? '') }),
    );
    const sequences = objectsFrom(
      await run(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'S' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY c.relname`),
      (row) => ({ name: String(row[0]), type: 'sequence', definition: `CREATE SEQUENCE ${row[0]};` }),
    );
    return { supported: true, triggers, routines, sequences, events: [] };
  }
  if (conn.engine === 'sqlserver') {
    const triggers = objectsFrom(
      await run(`SELECT tr.name, OBJECT_NAME(tr.parent_id), OBJECT_DEFINITION(tr.object_id)
        FROM sys.triggers tr WHERE tr.is_ms_shipped = 0 ORDER BY tr.name`),
      (row) => ({ name: String(row[0]), type: 'trigger', table: String(row[1] ?? ''), definition: String(row[2] ?? '') }),
    );
    const routines = objectsFrom(
      await run(`SELECT name, CASE type WHEN 'P' THEN 'procedure' WHEN 'FN' THEN 'function' WHEN 'IF' THEN 'function' WHEN 'TF' THEN 'function' ELSE type END, OBJECT_DEFINITION(object_id)
        FROM sys.objects WHERE type IN ('P','FN','IF','TF') AND is_ms_shipped = 0 ORDER BY name`),
      (row) => ({ name: String(row[0]), type: String(row[1] ?? ''), definition: String(row[2] ?? '') }),
    );
    const sequences = objectsFrom(
      await run('SELECT name, start_value, increment, current_value FROM sys.sequences ORDER BY name'),
      (row) => ({ name: String(row[0]), type: 'sequence', detail: `start ${row[1]} / step ${row[2]} / current ${row[3]}` }),
    );
    return { supported: true, triggers, routines, sequences, events: [] };
  }
  if (conn.engine === 'oracle') {
    const owner = (conn.username ?? '').toUpperCase();
    const triggers = objectsFrom(
      await run(`SELECT TRIGGER_NAME, TABLE_NAME, TRIGGER_TYPE, TRIGGERING_EVENT FROM ALL_TRIGGERS WHERE OWNER = ${quoteLiteral(owner)} ORDER BY TRIGGER_NAME`),
      (row) => ({ name: String(row[0]), type: 'trigger', table: String(row[1] ?? ''), detail: `${row[2]} ${row[3]}` }),
    );
    const routines = objectsFrom(
      await run(`SELECT OBJECT_NAME, OBJECT_TYPE, STATUS FROM ALL_OBJECTS WHERE OWNER = ${quoteLiteral(owner)} AND OBJECT_TYPE IN ('PROCEDURE','FUNCTION') ORDER BY OBJECT_NAME`),
      (row) => ({ name: String(row[0]), type: String(row[1] ?? '').toLowerCase(), detail: String(row[2] ?? '') }),
    );
    const sequences = objectsFrom(
      await run(`SELECT SEQUENCE_NAME, LAST_NUMBER, INCREMENT_BY FROM ALL_SEQUENCES WHERE SEQUENCE_OWNER = ${quoteLiteral(owner)} ORDER BY SEQUENCE_NAME`),
      (row) => ({ name: String(row[0]), type: 'sequence', detail: `current ${row[1]} / step ${row[2]}` }),
    );
    return { supported: true, triggers, routines, sequences, events: [] };
  }
  if (conn.engine === 'clickhouse') {
    return { ...empty, note: 'ClickHouse 没有传统触发器/存储过程；物化视图可在对象树中查看。' };
  }
  return { supported: false, triggers: [], routines: [], sequences: [], events: [], note: '该引擎暂无高级对象查询' };
}
