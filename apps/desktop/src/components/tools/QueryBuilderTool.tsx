import { useEffect, useMemo, useState } from 'react';
import { Braces, Play } from 'lucide-react';
import type { TableInfo } from '@aidb/core';
import { useApp } from '../../store';
import { DatabaseSelect, useDatabaseTables } from '../DatabaseSelect';

function quote(name: string, engine: string): string {
  if (engine === 'mysql' || engine === 'mariadb' || engine === 'clickhouse') return '`' + name.replace(/`/g, '``') + '`';
  if (engine === 'sqlserver') return '[' + name.replace(/]/g, ']]') + ']';
  return '"' + name.replace(/"/g, '""') + '"';
}

export function QueryBuilderTool() {
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const connections = useApp((s) => s.connections);
  const openQuery = useApp((s) => s.openQuery);
  const closeTools = useApp((s) => s.closeTools);
  const notify = useApp((s) => s.notify);
  const conn = connections.find((c) => c.id === activeConnectionId);
  const [database, setDatabase] = useState('');
  const tables = useDatabaseTables(activeConnectionId, database);
  const [t1, setT1] = useState('');
  const [t2, setT2] = useState('');
  const [joinType, setJoinType] = useState<'INNER' | 'LEFT'>('LEFT');
  const [joinLeft, setJoinLeft] = useState('');
  const [joinRight, setJoinRight] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [where, setWhere] = useState('');
  const [orderBy, setOrderBy] = useState('');
  const [direction, setDirection] = useState<'ASC' | 'DESC'>('DESC');
  const [limit, setLimit] = useState(100);

  const table1 = tables.find((table) => table.name === t1);
  const table2 = tables.find((table) => table.name === t2);
  const engine = conn?.engine ?? 'sqlite';

  useEffect(() => {
    if (!tables.length) return;
    if (!t1 || !tables.some((table) => table.name === t1)) {
      const first = tables[0];
      setT1(first.name);
      setSelected(new Set(first.columns?.slice(0, 5).map((column) => `${first.name}.${column.name}`) ?? []));
    }
  }, [tables, t1]);

  useEffect(() => {
    if (!table1 || !table2) return;
    const fk = (table1.foreignKeys ?? []).find((item) => item.refTable.toLowerCase() === table2.name.toLowerCase());
    if (fk) {
      setJoinLeft(`${table1.name}.${fk.columns[0]}`);
      setJoinRight(`${table2.name}.${fk.refColumns[0]}`);
    } else {
      setJoinLeft(`${table1.name}.id`);
      setJoinRight(`${table2.name}.id`);
    }
  }, [table1?.name, table2?.name]);

  const columnOptions = useMemo(() => {
    const options: Array<{ key: string; table: string; column: string; type: string }> = [];
    for (const table of [table1, table2].filter(Boolean) as TableInfo[]) {
      for (const column of table.columns ?? []) {
        options.push({ key: `${table.name}.${column.name}`, table: table.name, column: column.name, type: column.type });
      }
    }
    return options;
  }, [table1, table2]);

  const sql = useMemo(() => {
    if (!table1) return '';
    const chosen = columnOptions.filter((option) => selected.has(option.key));
    const selectList = chosen.length
      ? chosen.map((option) => `${quote(option.table, engine)}.${quote(option.column, engine)} AS ${quote(`${option.table}_${option.column}`, engine)}`).join(', ')
      : '*';
    let query = `SELECT ${selectList}\nFROM ${quote(table1.name, engine)}`;
    if (table2 && joinLeft && joinRight) {
      const [lt, lc] = joinLeft.split('.');
      const [rt, rc] = joinRight.split('.');
      query += `\n${joinType} JOIN ${quote(table2.name, engine)} ON ${quote(lt, engine)}.${quote(lc, engine)} = ${quote(rt, engine)}.${quote(rc, engine)}`;
    }
    if (where.trim()) query += `\nWHERE ${where.trim()}`;
    if (orderBy) {
      const [table, column] = orderBy.split('.');
      query += `\nORDER BY ${quote(table, engine)}.${quote(column, engine)} ${direction}`;
    }
    query += `\nLIMIT ${Math.max(1, Math.min(10000, limit))};`;
    return query;
  }, [table1, table2, joinType, joinLeft, joinRight, selected, where, orderBy, direction, limit, engine, columnOptions]);

  if (!conn) return <div className="dash-empty">请选择一个连接。</div>;

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Braces size={15} /> 查询构建器
        <span className="muted">{conn.name} · {tables.length} 张表</span>
      </div>
      <div className="tool-row">
        <DatabaseSelect
          connectionId={activeConnectionId}
          value={database}
          onChange={(value) => { setDatabase(value); setT1(''); setT2(''); setSelected(new Set()); }}
          testId="builder-db"
        />
      </div>
      <div className="builder-grid">
        <div className="builder-form">
          <div className="form-grid" style={{ gap: 8 }}>
            <div className="field">
              <label>主表</label>
              <select className="select" value={t1} onChange={(e) => { setT1(e.target.value); setSelected(new Set()); }}>
                {tables.map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>连接表（可选）</label>
              <select className="select" value={t2} onChange={(e) => setT2(e.target.value)}>
                <option value="">— 不连接 —</option>
                {tables.filter((table) => table.name !== t1).map((table) => <option key={table.name} value={table.name}>{table.name}</option>)}
              </select>
            </div>
            {table2 ? (
              <>
                <div className="field">
                  <label>连接类型</label>
                  <select className="select" value={joinType} onChange={(e) => setJoinType(e.target.value as 'INNER' | 'LEFT')}>
                    <option value="LEFT">LEFT JOIN</option>
                    <option value="INNER">INNER JOIN</option>
                  </select>
                </div>
                <div className="field">
                  <label>连接条件</label>
                  <div className="row gap-4">
                    <select className="select" value={joinLeft} onChange={(e) => setJoinLeft(e.target.value)} style={{ flex: 1 }}>
                      {columnOptions.filter((option) => option.table === t1).map((option) => <option key={option.key} value={option.key}>{option.key}</option>)}
                    </select>
                    <span className="muted">=</span>
                    <select className="select" value={joinRight} onChange={(e) => setJoinRight(e.target.value)} style={{ flex: 1 }}>
                      {columnOptions.filter((option) => option.table === t2).map((option) => <option key={option.key} value={option.key}>{option.key}</option>)}
                    </select>
                  </div>
                </div>
              </>
            ) : null}
            <div className="field full">
              <label>WHERE（可选）</label>
              <input className="input mono" value={where} onChange={(e) => setWhere(e.target.value)} placeholder="status = 'completed' AND total_cents > 1000" />
            </div>
            <div className="field">
              <label>排序</label>
              <select className="select" value={orderBy} onChange={(e) => setOrderBy(e.target.value)}>
                <option value="">— 不排序 —</option>
                {columnOptions.map((option) => <option key={option.key} value={option.key}>{option.table}.{option.column}</option>)}
              </select>
            </div>
            <div className="field">
              <label>方向 / 行数</label>
              <div className="row gap-4">
                <select className="select" value={direction} onChange={(e) => setDirection(e.target.value as 'ASC' | 'DESC')} style={{ width: 80 }}>
                  <option value="DESC">DESC</option>
                  <option value="ASC">ASC</option>
                </select>
                <input className="input" type="number" min={1} max={10000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
              </div>
            </div>
          </div>

          <div className="field" style={{ marginTop: 8 }}>
            <label>选择列（{selected.size} / {columnOptions.length}）</label>
            <div className="column-picker">
              {columnOptions.map((option) => (
                <label key={option.key} className="column-chip">
                  <input
                    type="checkbox"
                    checked={selected.has(option.key)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(option.key);
                      else next.delete(option.key);
                      setSelected(next);
                    }}
                  />
                  <span className="mono">{option.column}</span>
                  <em>{option.type}</em>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="builder-preview">
          <div className="tool-section-title">生成 SQL</div>
          <pre className="sql-block" style={{ minHeight: 180, whiteSpace: 'pre-wrap' }}>{sql || '-- 选择表和列'}</pre>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button
              className="btn primary"
              onClick={() => {
                if (!sql) {
                  notify('warning', '请先选择表');
                  return;
                }
                openQuery(activeConnectionId ?? undefined, sql, undefined, database || undefined);
                closeTools();
              }}
            >
              <Play size={12} /> 在编辑器打开
            </button>
          </div>
          <p className="hint">支持两表连接、列选择、WHERE、排序与行数。更复杂的查询可直接在 SQL 编辑器或让 Agent 完成。</p>
        </div>
      </div>
    </div>
  );
}
