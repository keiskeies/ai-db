import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { GraphData, GraphNode } from '@aidb/core';

const WIDTH = 900;
const HEIGHT = 520;
const PAD = 56;
const COLORS = ['#45c8c3', '#5b93ff', '#a78bfa', '#e0a155', '#46c46b', '#f16b62', '#38bdf8'];

type Position = { x: number; y: number };
type Viewport = { x: number; y: number; scale: number };

function colorFor(labels: string[]): string {
  const key = labels[0] ?? '';
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function seedOf(text: string): number {
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return (hash % 1000) / 1000;
}

function circleLayout(graph: GraphData): Map<string, Position> {
  const positions = new Map<string, Position>();
  const centerX = WIDTH / 2;
  const centerY = HEIGHT / 2;
  const radius = Math.max(80, Math.min(210, 42 + graph.nodes.length * 14));
  graph.nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, graph.nodes.length) - Math.PI / 2;
    positions.set(node.id, { x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius });
  });
  if (graph.nodes.length === 1) positions.set(graph.nodes[0].id, { x: centerX, y: centerY });
  return positions;
}

/** 确定性力导向布局：无第三方依赖，同一份结果每次渲染一致。 */
function forceLayout(graph: GraphData): Map<string, Position> {
  const count = graph.nodes.length;
  if (count <= 2) return circleLayout(graph);
  if (count > 140) return circleLayout(graph);
  const positions = new Map<string, Position>();
  graph.nodes.forEach((node, index) => {
    const angle = index * 2.399963229728653 + seedOf(node.id) * 0.9;
    const radius = Math.min(WIDTH, HEIGHT) * 0.34 * Math.sqrt((index + 0.5) / count);
    positions.set(node.id, { x: WIDTH / 2 + Math.cos(angle) * radius, y: HEIGHT / 2 + Math.sin(angle) * radius });
  });
  const ids = graph.nodes.map((node) => node.id);
  const edges = graph.edges.filter((edge) => positions.has(edge.source) && positions.has(edge.target) && edge.source !== edge.target);
  const ideal = Math.sqrt((WIDTH * HEIGHT) / count) * 0.58;
  const iterations = 220;
  for (let step = 0; step < iterations; step += 1) {
    const cooling = 1 - step / iterations;
    const disp = new Map<string, Position>(ids.map((id) => [id, { x: 0, y: 0 }]));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])!;
        const b = positions.get(ids[j])!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.01) {
          dx = (seedOf(ids[i]) - 0.5) * 0.4;
          dy = (seedOf(ids[j]) - 0.5) * 0.4;
          distance = Math.hypot(dx, dy) || 0.01;
        }
        const force = (ideal * ideal) / distance;
        const ux = dx / distance;
        const uy = dy / distance;
        disp.get(ids[i])!.x += ux * force;
        disp.get(ids[i])!.y += uy * force;
        disp.get(ids[j])!.x -= ux * force;
        disp.get(ids[j])!.y -= uy * force;
      }
    }
    for (const edge of edges) {
      const a = positions.get(edge.source)!;
      const b = positions.get(edge.target)!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy) || 0.01;
      const force = (distance * distance) / ideal;
      const ux = dx / distance;
      const uy = dy / distance;
      disp.get(edge.source)!.x += ux * force;
      disp.get(edge.source)!.y += uy * force;
      disp.get(edge.target)!.x -= ux * force;
      disp.get(edge.target)!.y -= uy * force;
    }
    for (const id of ids) {
      const point = positions.get(id)!;
      const delta = disp.get(id)!;
      point.x += Math.max(-30, Math.min(30, delta.x * 0.02 * cooling));
      point.y += Math.max(-30, Math.min(30, delta.y * 0.02 * cooling));
      point.x += (WIDTH / 2 - point.x) * 0.004 * cooling;
      point.y += (HEIGHT / 2 - point.y) * 0.004 * cooling;
    }
  }
  const xs = ids.map((id) => positions.get(id)!.x);
  const ys = ids.map((id) => positions.get(id)!.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min((WIDTH - PAD * 2) / spanX, (HEIGHT - PAD * 2) / spanY, 2.2);
  const offsetX = (WIDTH - spanX * scale) / 2;
  const offsetY = (HEIGHT - spanY * scale) / 2;
  for (const id of ids) {
    const point = positions.get(id)!;
    point.x = (point.x - minX) * scale + offsetX;
    point.y = (point.y - minY) * scale + offsetY;
  }
  return positions;
}

function layoutGraph(graph: GraphData): Map<string, Position> {
  return graph.nodes.length ? forceLayout(graph) : new Map();
}

function matches(node: GraphNode, query: string): boolean {
  if (!query) return false;
  const needle = query.toLowerCase();
  if (node.id.toLowerCase().includes(needle)) return true;
  if (node.labels.some((label) => label.toLowerCase().includes(needle))) return true;
  return Object.entries(node.properties).some(([key, value]) => key.toLowerCase().includes(needle) || String(value ?? '').toLowerCase().includes(needle));
}

function propertyText(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function GraphView({ graph }: { graph: GraphData }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [positions, setPositions] = useState<Map<string, Position>>(() => layoutGraph(graph));
  const [view, setView] = useState<Viewport>({ x: 0, y: 0, scale: 1 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const dragRef = useRef<{ kind: 'pan' | 'node'; id?: string; startX: number; startY: number; origin: Position; moved: boolean } | null>(null);

  useEffect(() => {
    setPositions(layoutGraph(graph));
    setView({ x: 0, y: 0, scale: 1 });
    setSelectedId((current) => (current && graph.nodes.some((node) => node.id === current) ? current : null));
  }, [graph]);

  const degrees = useMemo(() => {
    const map = new Map<string, number>();
    for (const edge of graph.edges) {
      map.set(edge.source, (map.get(edge.source) ?? 0) + 1);
      map.set(edge.target, (map.get(edge.target) ?? 0) + 1);
    }
    return map;
  }, [graph]);

  const legend = useMemo(() => {
    const map = new Map<string, number>();
    for (const node of graph.nodes) {
      const label = node.labels[0] ?? node.id;
      map.set(label, (map.get(label) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [graph]);

  const selected = selectedId ? graph.nodes.find((node) => node.id === selectedId) ?? null : null;
  const matched = useMemo(() => new Set(graph.nodes.filter((node) => matches(node, query)).map((node) => node.id)), [graph, query]);
  const isFiltering = query.trim().length > 0;
  const connected = useMemo(() => {
    if (!selectedId) return new Set<string>();
    const set = new Set<string>([selectedId]);
    for (const edge of graph.edges) {
      if (edge.source === selectedId) set.add(edge.target);
      if (edge.target === selectedId) set.add(edge.source);
    }
    return set;
  }, [graph, selectedId]);
  const dimmed = (id: string) => (isFiltering && !matched.has(id)) || (selectedId !== null && !connected.has(id));

  const toViewBox = (clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ((clientX - rect.left) * WIDTH) / rect.width, y: ((clientY - rect.top) * HEIGHT) / rect.height };
  };

  const zoomBy = (factor: number, anchor?: Position) => {
    setView((current) => {
      const next = Math.max(0.3, Math.min(3, current.scale * factor));
      const point = anchor ?? { x: WIDTH / 2, y: HEIGHT / 2 };
      const worldX = (point.x - current.x) / current.scale;
      const worldY = (point.y - current.y) / current.scale;
      return { x: point.x - worldX * next, y: point.y - worldY * next, scale: next };
    });
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      const anchor = { x: ((event.clientX - rect.left) * WIDTH) / rect.width, y: ((event.clientY - rect.top) * HEIGHT) / rect.height };
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((current) => {
        const next = Math.max(0.3, Math.min(3, current.scale * factor));
        const worldX = (anchor.x - current.x) / current.scale;
        const worldY = (anchor.y - current.y) / current.scale;
        return { x: anchor.x - worldX * next, y: anchor.y - worldY * next, scale: next };
      });
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    const point = toViewBox(event.clientX, event.clientY);
    (event.target as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = { kind: 'pan', startX: point.x, startY: point.y, origin: { x: view.x, y: view.y }, moved: false };
  };

  const onNodePointerDown = (event: ReactPointerEvent<SVGGElement>, id: string) => {
    event.stopPropagation();
    const point = toViewBox(event.clientX, event.clientY);
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    dragRef.current = {
      kind: 'node',
      id,
      startX: point.x,
      startY: point.y,
      origin: { ...(positions.get(id) ?? { x: 0, y: 0 }) },
      moved: false,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const point = toViewBox(event.clientX, event.clientY);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
    if (drag.kind === 'pan') {
      setView((current) => ({ ...current, x: drag.origin.x + dx, y: drag.origin.y + dy }));
    } else if (drag.id) {
      setPositions((current) => {
        const next = new Map(current);
        next.set(drag.id!, { x: drag.origin.x + dx, y: drag.origin.y + dy });
        return next;
      });
    }
  };

  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag && drag.kind === 'node' && !drag.moved && drag.id) {
      setSelectedId((current) => (current === drag.id ? null : drag.id!));
    }
  };

  const edgeGeometry = (source: Position, target: Position, curvature: number) => {
    if (curvature === 0) return { path: `M ${source.x} ${source.y} L ${target.x} ${target.y}`, midX: (source.x + target.x) / 2, midY: (source.y + target.y) / 2 };
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const length = Math.hypot(dx, dy) || 1;
    const midX = (source.x + target.x) / 2 - (dy / length) * curvature * length;
    const midY = (source.y + target.y) / 2 + (dx / length) * curvature * length;
    return { path: `M ${source.x} ${source.y} Q ${midX} ${midY} ${target.x} ${target.y}`, midX, midY };
  };

  const showAllEdgeLabels = graph.edges.length <= 24 || isFiltering;

  return (
    <div data-testid="graph-view" data-zoom={`${Math.round(view.scale * 100)}%`} style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2, var(--surface))', overflow: 'hidden' }}>
      <div className="graph-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderBottom: '1px solid var(--border)' }}>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索节点 / 标签 / 属性"
          aria-label="搜索图节点"
          style={{ width: 200, height: 24, fontSize: 11, padding: '0 8px', borderRadius: 6, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text-primary)' }}
        />
        {isFiltering ? <span className="muted" style={{ fontSize: 11 }}>{matched.size} 个匹配</span> : null}
        <div style={{ flex: 1 }} />
        {legend.map(([label, count]) => (
          <span key={label} data-testid="graph-legend-item" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-secondary)' }}>
            <span style={{ width: 8, height: 8, borderRadius: 4, background: colorFor([label]) }} />
            {label} {count}
          </span>
        ))}
        <button className="icon-btn" title="放大" data-testid="graph-zoom-in" onClick={() => zoomBy(1.2)}>+</button>
        <button className="icon-btn" title="缩小" data-testid="graph-zoom-out" onClick={() => zoomBy(1 / 1.2)}>−</button>
        <button className="btn small" title="重置视图" data-testid="graph-reset" onClick={() => { setPositions(layoutGraph(graph)); setView({ x: 0, y: 0, scale: 1 }); }}>重置</button>
      </div>
      <div style={{ display: 'flex', minHeight: 420 }}>
        <div ref={containerRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <svg
            ref={svgRef}
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            style={{ width: '100%', height: 420, display: 'block', cursor: 'grab', touchAction: 'none' }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <defs>
              <marker id="graph-arrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted, #8b9490)" />
              </marker>
            </defs>
            <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
              {graph.edges.map((edge, index) => {
                const source = positions.get(edge.source);
                const target = positions.get(edge.target);
                if (!source || !target) return null;
                const pairId = [edge.source, edge.target].sort().join('::');
                const samePair = graph.edges.filter((candidate) => [candidate.source, candidate.target].sort().join('::') === pairId);
                const forward = samePair.length > 1 ? (samePair.findIndex((candidate) => candidate.id === edge.id) % 2 === 0 ? 1 : -1) : 1;
                const curvature = edge.source === edge.target ? 0 : samePair.length > 1 ? 0.14 * forward : 0;
                const geometry = edge.source === edge.target
                  ? { path: `M ${source.x - 8} ${source.y - 16} C ${source.x - 46} ${source.y - 64}, ${source.x + 46} ${source.y - 64}, ${source.x + 8} ${source.y - 16}`, midX: source.x, midY: source.y - 62 }
                  : edgeGeometry(source, target, curvature);
                const active = hoveredEdge === edge.id || selectedId === edge.source || selectedId === edge.target;
                const showLabel = showAllEdgeLabels || active;
                return (
                  <g key={edge.id} data-testid="graph-edge" opacity={isFiltering || selectedId ? (active ? 1 : 0.35) : 1}>
                    <path d={geometry.path} fill="none" stroke={active ? 'var(--accent, #45c8c3)' : 'var(--text-muted, #8b9490)'} strokeWidth={active ? 2 : 1.4} markerEnd="url(#graph-arrow)" />
                    <path
                      d={geometry.path}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={12}
                      style={{ pointerEvents: 'stroke', cursor: 'pointer' }}
                      onPointerEnter={() => setHoveredEdge(edge.id)}
                      onPointerLeave={() => setHoveredEdge((current) => (current === edge.id ? null : current))}
                    >
                      <title>{JSON.stringify({ type: edge.type, from: edge.source, to: edge.target, ...edge.properties }, null, 2)}</title>
                    </path>
                    {showLabel ? (
                      <text x={geometry.midX} y={geometry.midY - 5} textAnchor="middle" fontSize={10} fill={active ? 'var(--accent, #45c8c3)' : 'var(--text-muted, #8b9490)'} style={{ pointerEvents: 'none' }}>
                        {edge.type}
                      </text>
                    ) : null}
                  </g>
                );
              })}
              {graph.nodes.map((node) => {
                const position = positions.get(node.id) ?? { x: WIDTH / 2, y: HEIGHT / 2 };
                const color = colorFor(node.labels);
                const label = node.labels[0] ?? node.id;
                const radius = 15 + Math.min(9, (degrees.get(node.id) ?? 0) * 1.6);
                const dim = dimmed(node.id);
                return (
                  <g
                    key={node.id}
                    data-testid="graph-node"
                    opacity={dim ? 0.18 : 1}
                    style={{ cursor: 'pointer' }}
                    onPointerDown={(event) => onNodePointerDown(event, node.id)}
                  >
                    <title>{JSON.stringify({ id: node.id, labels: node.labels, ...node.properties }, null, 2)}</title>
                    {selectedId === node.id ? <circle cx={position.x} cy={position.y} r={radius + 5} fill="none" stroke="var(--accent, #45c8c3)" strokeWidth={2} /> : null}
                    {isFiltering && matched.has(node.id) ? <circle cx={position.x} cy={position.y} r={radius + 7} fill={color} fillOpacity={0.18} /> : null}
                    <circle cx={position.x} cy={position.y} r={radius} fill={color} fillOpacity={0.92} stroke="var(--surface, #0b0d0d)" strokeWidth={2} />
                    <text x={position.x} y={position.y + radius + 12} textAnchor="middle" fontSize={11} fill="var(--text-primary, #f1f3f1)" style={{ pointerEvents: 'none' }}>
                      {label}
                    </text>
                    <text x={position.x} y={position.y + radius + 24} textAnchor="middle" fontSize={9} fill="var(--text-muted, #8b9490)" style={{ pointerEvents: 'none' }}>
                      {String(node.properties.name ?? node.properties.title ?? node.properties._key ?? node.id).slice(0, 20)}
                    </text>
                  </g>
                );
              })}
            </g>
          </svg>
          <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 10, color: 'var(--text-muted)', pointerEvents: 'none' }}>
            滚轮缩放 · 拖拽画布平移 · 拖动节点固定位置 · 点击节点查看属性
          </div>
        </div>
        {selected ? (
          <aside
            data-testid="graph-detail"
            style={{ width: 250, flexShrink: 0, borderLeft: '1px solid var(--border)', padding: '10px 12px', overflow: 'auto', maxHeight: 420 }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: colorFor(selected.labels), flexShrink: 0 }} />
              <strong style={{ fontSize: 12, wordBreak: 'break-all' }}>{selected.labels[0] ?? '节点'}</strong>
              <div style={{ flex: 1 }} />
              <button className="icon-btn" title="关闭" onClick={() => setSelectedId(null)}>×</button>
            </div>
            <div className="muted" style={{ fontSize: 10, margin: '4px 0 8px', wordBreak: 'break-all' }}>{selected.id}</div>
            <table className="table" style={{ fontSize: 11 }}>
              <tbody>
                {Object.entries(selected.properties).length ? (
                  Object.entries(selected.properties).map(([key, value]) => (
                    <tr key={key}>
                      <td className="muted" style={{ width: '38%', verticalAlign: 'top' }}>{key}</td>
                      <td style={{ wordBreak: 'break-all' }}>{propertyText(value)}</td>
                    </tr>
                  ))
                ) : (
                  <tr><td className="muted">无属性</td></tr>
                )}
              </tbody>
            </table>
            <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>与其他节点有 {degrees.get(selected.id) ?? 0} 条关系</div>
          </aside>
        ) : null}
      </div>
      <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        {graph.nodes.length} 节点 · {graph.edges.length} 关系 · 缩放 {Math.round(view.scale * 100)}%
      </div>
    </div>
  );
}
