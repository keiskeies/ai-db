import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Trash2 } from 'lucide-react';
import type { ResultField } from '@aidb/core';
import { formatCell } from '../lib/format';
import { useApp, type ContextMenuItem } from '../store';

export interface DataGridProps {
  columns: ResultField[];
  rows: unknown[][];
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  onSort?: (column: string) => void;
  editable?: boolean;
  onCellEdit?: (rowIndex: number, columnIndex: number, value: string) => Promise<void> | void;
  onRowDelete?: (rowIndex: number) => void;
  newRowValues?: Record<number, string>;
  onNewRowChange?: (columnIndex: number, value: string) => void;
  /** 新行编辑时按 Esc 取消。 */
  onNewRowCancel?: () => void;
  selectedRows?: Set<number>;
  onToggleRow?: (rowIndex: number) => void;
  onToggleAll?: () => void;
  rowNumberStart?: number;
  textMode?: boolean;
  testId?: string;
  /** 双击一行时回调（如 Redis 键详情）。 */
  onRowActivate?: (rowIndex: number) => void;
  /** 不渲染的列名；回调仍用原始列下标。 */
  hiddenColumns?: string[];
}

interface EditState {
  row: number;
  col: number;
  value: string;
  original: string;
}

export function DataGrid({
  columns,
  rows,
  orderBy,
  orderDir,
  onSort,
  editable,
  onCellEdit,
  onRowDelete,
  newRowValues,
  onNewRowChange,
  onNewRowCancel,
  selectedRows,
  onToggleRow,
  onToggleAll,
  rowNumberStart = 0,
  textMode,
  onRowActivate,
  hiddenColumns,
  testId = 'data-grid',
}: DataGridProps) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(600);
  const [rowHeight, setRowHeight] = useState(30);
  const [headerHeight, setHeaderHeight] = useState(32);
  const inputRef = useRef<HTMLInputElement>(null);
  const visibleColumns = columns
    .map((col, index) => ({ col, index }))
    .filter(({ col }) => !hiddenColumns?.includes(col.name));
  const rowCount = rows.length;
  useEffect(() => {
    const wrap = wrapRef.current;
    if (wrap) wrap.scrollTop = 0;
  }, [rowCount]);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const sync = () => {
      setScrollTop(wrap.scrollTop);
      setViewHeight(wrap.clientHeight);
      const first = wrap.querySelector('tbody tr[data-testid^="grid-row-"]') as HTMLElement | null;
      const measuredRow = first?.offsetHeight ?? 0;
      if (measuredRow >= 20) setRowHeight((prev) => (Math.abs(prev - measuredRow) > 0.5 ? measuredRow : prev));
      const head = wrap.querySelector('thead') as HTMLElement | null;
      const measuredHead = head?.offsetHeight ?? 0;
      if (measuredHead > 0) setHeaderHeight((prev) => (Math.abs(prev - measuredHead) > 0.5 ? measuredHead : prev));
    };
    sync();
    wrap.addEventListener('scroll', sync, { passive: true });
    const observer = new ResizeObserver(sync);
    observer.observe(wrap);
    return () => {
      wrap.removeEventListener('scroll', sync);
      observer.disconnect();
    };
  }, [rows]);
  const windowed = rows.length > 200;
  const overscan = 8;
  const safeRowHeight = rowHeight >= 20 ? rowHeight : 27;
  const visibleStart = windowed ? Math.min(rows.length, Math.max(0, Math.floor(Math.max(0, scrollTop - headerHeight) / safeRowHeight) - overscan)) : 0;
  const visibleCount = windowed ? Math.ceil(viewHeight / safeRowHeight) + overscan * 2 : rows.length;
  const visibleEnd = windowed ? Math.min(rows.length, visibleStart + visibleCount) : rows.length;
  const renderedRows = rows.slice(visibleStart, visibleEnd);
  const columnSpan = visibleColumns.length + 1 + (onToggleRow ? 1 : 0) + (onRowDelete ? 1 : 0);
  const spacer = (height: number) => (
    <tr className="grid-spacer">
      <td colSpan={columnSpan} style={{ height, padding: 0, border: 0 }} />
    </tr>
  );

  const beginEdit = (row: number, col: number) => {
    if (!editable || !onCellEdit) return;
    const raw = rows[row]?.[col];
    const value = raw === null || raw === undefined ? '' : typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    setEdit({ row, col, value, original: value });
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const commit = async () => {
    if (!edit) return;
    const current = edit;
    setEdit(null);
    if (!onCellEdit || current.value === current.original) return;
    await onCellEdit(current.row, current.col, current.value);
  };

  return (
    <div className={`grid-wrap ${textMode ? 'text-mode' : ''}`} ref={wrapRef}>
      <table className="data-grid" data-testid={testId}>
        <thead>
          <tr>
            <th className="grid-rowno">#</th>
            {onToggleRow ? (
              <th className="grid-select">
                <input type="checkbox" checked={rows.length > 0 && (selectedRows?.size ?? 0) === rows.length} onChange={() => onToggleAll?.()} />
              </th>
            ) : null}
            {visibleColumns.map(({ col, index }) => {
              const active = orderBy === col.name;
              return (
                <th
                  key={`${col.name}_${index}`}
                  className={onSort ? 'sortable' : ''}
                  onClick={() => onSort?.(col.name)}
                  title={col.type ? `${col.name} · ${col.type}` : col.name}
                >
                  {col.name}
                  {col.type ? <span className="th-type">{col.type}</span> : null}
                  {active ? <span className="sort">{orderDir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />}</span> : null}
                </th>
              );
            })}
            {onRowDelete ? <th className="row-actions" /> : null}
          </tr>
        </thead>
        <tbody>
          {newRowValues ? (
            <tr>
              <td className="grid-rowno" />
              {onToggleRow ? <td className="grid-select" /> : null}
              {visibleColumns.map(({ col, index }) => (
                <td key={`new_${col.name}`} className="new-row">
                  <input
                    className="mono"
                    style={{ width: '100%', border: 'none', background: 'transparent', outline: 'none', height: 26, fontSize: 11.5 }}
                    value={newRowValues[index] ?? ''}
                    placeholder={col.name}
                    onChange={(e) => onNewRowChange?.(index, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') onNewRowCancel?.();
                    }}
                  />
                </td>
              ))}
              {onRowDelete ? <td className="row-actions new-row" /> : null}
            </tr>
          ) : null}
          {visibleStart > 0 ? spacer(visibleStart * safeRowHeight) : null}
          {renderedRows.map((row, offset) => {
            const rowIndex = visibleStart + offset;
            return (
            <tr
              key={rowIndex}
              data-testid={`grid-row-${rowIndex}`}
              className={selectedRows?.has(rowIndex) ? 'selected' : undefined}
              onDoubleClick={onRowActivate ? () => onRowActivate(rowIndex) : undefined}
              style={onRowActivate ? { cursor: 'pointer' } : undefined}
            >
              <td className="grid-rowno">{rowNumberStart + rowIndex + 1}</td>
              {onToggleRow ? (
                <td className="grid-select">
                  <input type="checkbox" checked={selectedRows?.has(rowIndex) ?? false} onChange={() => onToggleRow(rowIndex)} />
                </td>
              ) : null}
              {visibleColumns.map(({ col, index: colIndex }) => {
                const value = row[colIndex];
                const formatted = formatCell(value);
                const display = textMode && formatted.kind === 'null' ? '(Null)' : formatted.text;
                const editing = edit?.row === rowIndex && edit?.col === colIndex;
                return (
                  <td
                    key={`${col.name}_${colIndex}`}
                    className={`${formatted.kind === 'null' ? 'null' : ''} ${formatted.kind === 'number' ? 'num' : ''} ${editing ? 'editing' : ''}`}
                    title={display}
                    onDoubleClick={() => beginEdit(rowIndex, colIndex)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      const cell = formatted.kind === 'null' ? '' : formatted.text;
                      const line = row.map((value) => {
                        const item = formatCell(value);
                        return item.kind === 'null' ? '' : item.text;
                      }).join('	');
                      const items: ContextMenuItem[] = [
                        { label: `复制「${col.name}」`, icon: <Copy size={12} />, onClick: () => void navigator.clipboard.writeText(cell).catch(() => undefined) },
                        { label: '复制整行（制表符分隔）', onClick: () => void navigator.clipboard.writeText(line).catch(() => undefined) },
                        { label: '复制列名', onClick: () => void navigator.clipboard.writeText(col.name).catch(() => undefined) },
                      ];
                      if (editable) {
                        items.push({ label: '编辑此单元格', onClick: () => beginEdit(rowIndex, colIndex) });
                      }
                      useApp.getState().openContextMenu(event.clientX, event.clientY, items);
                    }}
                  >
                    {editing ? (
                      <input
                        ref={inputRef}
                        value={edit.value}
                        onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commit();
                          if (e.key === 'Escape') setEdit(null);
                        }}
                        onBlur={() => void commit()}
                      />
                    ) : (
                      display
                    )}
                  </td>
                );
              })}
              {onRowDelete ? (
                <td className="row-actions">
                  <button className="icon-btn danger" title="delete row" onClick={() => onRowDelete(rowIndex)}>
                    <Trash2 size={12} />
                  </button>
                </td>
              ) : null}
            </tr>
            );
          })}
          {visibleEnd < rows.length ? spacer((rows.length - visibleEnd) * safeRowHeight) : null}
        </tbody>
      </table>
      {!rows.length ? <div className="empty-state" style={{ padding: 30 }}>没有数据</div> : null}
    </div>
  );
}
