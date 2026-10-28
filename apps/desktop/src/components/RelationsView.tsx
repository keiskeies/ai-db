import { useMemo } from 'react';
import { Download, Network, RefreshCw, Table2, TerminalSquare } from 'lucide-react';
import type { TableInfo } from '@aidb/core';
import { useApp, type Tab } from '../store';
import { DatabaseSelect } from './DatabaseSelect';
import { EmptyState } from './ui';

type RelationsTab = Extract<Tab, { kind: 'relations' }>;

const NODE_W = 224;
const GAP_X = 78;
const GAP_Y = 30;
const COLS = 3;
const HEADER_H = 34;
const ROW_H = 19;
const MAX_COLS = 9;

interface Node {
  table: TableInfo;
  x: number;
  y: number;
  h: number;
}

export function RelationsView({ tab }: { tab: RelationsTab }) {
  const schemas = useApp((s) => s.schemas[tab.connectionId]);
  const connections = useApp((s) => s.connections);
  const loadSchema = useApp((s) => s.loadSchema);
  const openData = useApp((s) => s.openData);
  const openQuery = useApp((s) => s.openQuery);
  const updateTab = useApp((s) => s.updateTab);

  const conn = connections.find((c) => c.id === tab.connectionId);

  const exportSvg = (layout: { nodes: Node[]; edges: Array<{ d: string; title: string }>; width: number; height: number }) => {
    const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const body: string[] = [`<rect width="${layout.width}" height="${layout.height}" fill="#111414"/>`];
    for (const edge of layout.edges) body.push(`<path d="${edge.d}" fill="none" stroke="#45c8c3" stroke-opacity="0.55" stroke-width="1.4"><title>${esc(edge.title)}</title></path>`);
    for (const node of layout.nodes) {
      body.push(`<rect x="${node.x}" y="${node.y}" width="${224}" height="${node.h}" rx="8" fill="#171b1b" stroke="#272a2a"/>`);
      body.push(`<rect x="${node.x}" y="${node.y}" width="224" height="28" rx="8" fill="#1e2323"/>`);
      body.push(`<text x="${node.x + 9}" y="${node.y + 18}" fill="#f1f3f1" font-family="Inter, sans-serif" font-size="11" font-weight="600">${esc(node.table.name)}</text>`);
      (node.table.columns ?? []).slice(0, 9).forEach((column, index) => {
        body.push(`<text x="${node.x + 9}" y="${node.y + 46 + index * 17}" fill="${column.primaryKey ? '#45c8c3' : '#b8beba'}" font-family="Consolas, monospace" font-size="9">${esc(column.name)}</text>`);
        body.push(`<text x="${node.x + 214}" y="${node.y + 46 + index * 17}" fill="#858d88" font-family="Consolas, monospace" font-size="8" text-anchor="end">${esc(column.type.slice(0, 18))}</text>`);
      });
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">${body.join('')}</svg>`;
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${conn?.name ?? 'aidb'}-erd.svg`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const tables = useMemo(() => {
    const all = (schemas ?? []).flatMap((s) => s.tables);
    if (!tab.database) return all;
    const scoped = (schemas ?? []).find((s) => s.name === tab.database);
    return scoped ? scoped.tables : all;
  }, [schemas, tab.database]);

  const { nodes, width, height, edges } = useMemo(() => {
    const map = new Map<string, Node>();
    const colY = new Array(COLS).fill(22);
    tables.forEach((table, index) => {
      const col = index % COLS;
      const visible = Math.min(MAX_COLS, table.columns?.length ?? 0);
      const more = (table.columns?.length ?? 0) > MAX_COLS ? ROW_H : 0;
      const h = HEADER_H + visible * ROW_H + more + 8;
      map.set(table.name, { table, x: 22 + col * (NODE_W + GAP_X), y: colY[col], h });
      colY[col] += h + GAP_Y;
    });
    const edgeList: Array<{ key: string; d: string; title: string }> = [];
    for (const node of map.values()) {
      for (const [fkIndex, fk] of (node.table.foreignKeys ?? []).entries()) {
        const target = map.get(fk.refTable);
        if (!target) continue;
        const toRight = target.x >= node.x;
        const sx = toRight ? node.x + NODE_W : node.x;
        const tx = toRight ? target.x : target.x + NODE_W;
        const sy = node.y + HEADER_H / 2 + 6;
        const ty = target.y + HEADER_H / 2 + 6;
        const bend = Math.max(46, Math.abs(tx - sx) / 2);
        const d = `M ${sx} ${sy} C ${sx + (toRight ? bend : -bend)} ${sy}, ${tx + (toRight ? -bend : bend)} ${ty}, ${tx} ${ty}`;
        edgeList.push({
          key: `${node.table.name}_${fkIndex}`,
          d,
          title: `${node.table.name}(${fk.columns.join(',')}) → ${fk.refTable}(${fk.refColumns.join(',')})`,
        });
      }
    }
    return {
      nodes: [...map.values()],
      width: 22 + COLS * (NODE_W + GAP_X) + 30,
      height: Math.max(420, ...colY) + 30,
      edges: edgeList,
    };
  }, [tables]);

  return (
    <div className="view">
      <div className="toolbar">
        <span className="title">
          <Network size={14} style={{ color: 'var(--accent)' }} />
          关系图
          <span className="muted" style={{ fontWeight: 400, fontSize: 11 }}>
            {conn?.name} · {nodes.length} 张表 · {edges.length} 条关系
          </span>
        </span>
        <DatabaseSelect
          connectionId={tab.connectionId}
          value={tab.database ?? ''}
          onChange={(database) => updateTab(tab.id, { database })}
          testId="erd-db"
        />
        <button className="icon-btn" title="刷新" onClick={() => void loadSchema(tab.connectionId, true, tab.database)}>
          <RefreshCw size={14} />
        </button>
        <button className="btn small" onClick={() => openQuery(tab.connectionId, undefined, undefined, tab.database)}>
          <TerminalSquare size={12} /> 新建查询
        </button>
        <button className="btn small" onClick={() => exportSvg({ nodes, edges, width, height })}>
          <Download size={12} /> 导出 SVG
        </button>
        <div className="spacer" />
        <span className="erd-legend">
          <span className="legend-dot" /> 外键关系（只读）
        </span>
      </div>
      {nodes.length ? (
        <div className="erd-wrap">
          <div className="erd-canvas" style={{ width, height }} data-testid="erd-canvas">
            <svg className="erd-svg" width={width} height={height} aria-hidden>
              {edges.map((edge) => (
                <g key={edge.key}>
                  <title>{edge.title}</title>
                  <path d={edge.d} className="erd-edge" />
                </g>
              ))}
            </svg>
            {nodes.map((node) => (
              <div
                key={node.table.name}
                className="erd-node"
                style={{ left: node.x, top: node.y, width: NODE_W, height: node.h }}
                onClick={() => openData(tab.connectionId, node.table.name, tab.database)}
                title="点击打开数据"
              >
                <div className="erd-node-head">
                  <Table2 size={12} style={{ color: 'var(--accent)' }} />
                  <span className="truncate">{node.table.name}</span>
                  {node.table.rowEstimate !== undefined ? <span className="meta">~{node.table.rowEstimate}</span> : null}
                </div>
                <div className="erd-cols">
                  {(node.table.columns ?? []).slice(0, MAX_COLS).map((column) => (
                    <div key={column.name} className={`erd-col ${column.primaryKey ? 'pk' : ''}`}>
                      <span className="truncate">{column.name}</span>
                      <span className="t">{column.type}</span>
                    </div>
                  ))}
                  {(node.table.columns?.length ?? 0) > MAX_COLS ? (
                    <div className="erd-col more">+{(node.table.columns?.length ?? 0) - MAX_COLS} more…</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState icon={<Network size={20} />} title="没有可展示的表">
          连接数据库并刷新结构后，这里会显示表与外键关系。
        </EmptyState>
      )}
    </div>
  );
}
