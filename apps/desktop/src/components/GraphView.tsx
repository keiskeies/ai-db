import type { GraphData } from '@aidb/core';

const COLORS = ['#45c8c3', '#5b93ff', '#a78bfa', '#e0a155', '#46c46b', '#f16b62', '#38bdf8'];

function colorFor(labels: string[]): string {
  const key = labels[0] ?? '';
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

export function GraphView({ graph }: { graph: GraphData }) {
  const width = 900;
  const height = 520;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = Math.max(80, Math.min(210, 42 + graph.nodes.length * 14));
  const positions = new Map<string, { x: number; y: number }>();
  graph.nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, graph.nodes.length) - Math.PI / 2;
    positions.set(node.id, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
    });
  });
  if (graph.nodes.length === 1) positions.set(graph.nodes[0].id, { x: centerX, y: centerY });

  return (
    <div
      data-testid="graph-view"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface-2, var(--surface))',
        overflow: 'hidden',
      }}
    >
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 420, display: 'block' }}>
        <defs>
          <marker id="graph-arrow" viewBox="0 0 10 10" refX="18" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted, #8b9490)" />
          </marker>
        </defs>
        {graph.edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const midX = (source.x + target.x) / 2;
          const midY = (source.y + target.y) / 2;
          return (
            <g key={edge.id}>
              <line
                x1={source.x}
                y1={source.y}
                x2={target.x}
                y2={target.y}
                stroke="var(--text-muted, #8b9490)"
                strokeWidth={1.4}
                markerEnd="url(#graph-arrow)"
              />
              <text x={midX} y={midY - 5} textAnchor="middle" fontSize={10} fill="var(--text-muted, #8b9490)">
                {edge.type}
              </text>
            </g>
          );
        })}
        {graph.nodes.map((node) => {
          const position = positions.get(node.id) ?? { x: centerX, y: centerY };
          const color = colorFor(node.labels);
          const label = node.labels[0] ?? node.id;
          return (
            <g key={node.id} data-testid="graph-node">
              <title>{JSON.stringify({ id: node.id, labels: node.labels, ...node.properties }, null, 2)}</title>
              <circle cx={position.x} cy={position.y} r={18} fill={color} fillOpacity={0.9} stroke="var(--surface, #0b0d0d)" strokeWidth={2} />
              <text x={position.x} y={position.y + 32} textAnchor="middle" fontSize={11} fill="var(--text-primary, #f1f3f1)">
                {label}
              </text>
              <text x={position.x} y={position.y + 44} textAnchor="middle" fontSize={9} fill="var(--text-muted, #8b9490)">
                {String(node.properties.name ?? node.id).slice(0, 18)}
              </text>
            </g>
          );
        })}
      </svg>
      <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
        {graph.nodes.length} 节点 · {graph.edges.length} 关系 · 悬停节点查看属性
      </div>
    </div>
  );
}
