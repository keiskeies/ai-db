import { useEffect, useMemo, type CSSProperties } from 'react';
import type { TableInfo } from '@aidb/core';
import { useApp } from '../store';

interface DatabaseSelectProps {
  connectionId?: string;
  value: string;
  onChange: (database: string) => void;
  /** 允许「全部库」：跨库搜索这类功能才需要 */
  allowAll?: boolean;
  allLabel?: string;
  testId?: string;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
}

/**
 * 库选择器。连接不再手填库名之后，凡是按库操作的面板都得显式选库。
 * 选项来自 store 里的 schemas（无库参数时 loadSchema 只拉库名，不内省表）；
 * 只有一个库时（文件型连接）直接不渲染。
 */
export function DatabaseSelect({ connectionId, value, onChange, allowAll, allLabel = '全部库', testId = 'database-select', disabled, className = 'select', style }: DatabaseSelectProps) {
  const connections = useApp((s) => s.connections);
  const schemas = useApp((s) => (connectionId ? s.schemas[connectionId] : undefined));
  const loadSchema = useApp((s) => s.loadSchema);
  const conn = connections.find((item) => item.id === connectionId);
  const options = useMemo(() => (schemas ?? []).map((schema) => schema.name), [schemas]);

  useEffect(() => {
    if (connectionId && !schemas) void loadSchema(connectionId);
  }, [connectionId, schemas, loadSchema]);

  useEffect(() => {
    if (!options.length || allowAll) return;
    if (value && options.includes(value)) return;
    const preferred = conn?.database && options.includes(conn.database) ? conn.database : options[0];
    if (preferred !== value) onChange(preferred);
  }, [options, value, allowAll, conn?.database, onChange]);

  if (options.length <= 1) return null;
  return (
    <select className={className} data-testid={testId} value={value} disabled={disabled} style={style} title="数据库" onChange={(e) => onChange(e.target.value)}>
      {allowAll ? <option value="">{allLabel}</option> : null}
      {options.map((name) => (
        <option key={name} value={name}>{name}</option>
      ))}
    </select>
  );
}

/** 取某个库的表；该库还没加载过时按需拉一次 schema。 */
export function useDatabaseTables(connectionId: string | undefined, database: string): TableInfo[] {
  const schemas = useApp((s) => (connectionId ? s.schemas[connectionId] : undefined));
  const loaded = useApp((s) => (connectionId ? s.loadedDatabases[connectionId] : undefined));
  const loadSchema = useApp((s) => s.loadSchema);

  useEffect(() => {
    if (!connectionId || !database) return;
    if (!(loaded ?? []).includes(database)) void loadSchema(connectionId, false, database);
  }, [connectionId, database, loaded, loadSchema]);

  return useMemo(
    () => ((schemas ?? []).find((schema) => schema.name === database)?.tables ?? []).filter((table) => table.type === 'table'),
    [schemas, database],
  );
}
