import { useId } from 'react';
import { ArrowUpRight } from 'lucide-react';

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title: string;
  xLabel: string;
  yLabel: string;
  sql?: string;
  series: Array<{ label: string; value: number }>;
}

const COLORS = ['#5B8CFF', '#9A7BFF', '#2DD4BF', '#F5C451', '#FF6B81', '#60A5FA', '#34D399', '#F472B6'];

export function ChartView({ chart, onOpenEditor }: { chart: ChartSpec; onOpenEditor?: (sql: string) => void }) {
  const gradientId = useId().replace(/:/g, '');
  const points = chart.series.slice(0, 12);
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
  const max = Math.max(...points.map((point) => point.value), 1);

  if (chart.type === 'pie') {
    let cursor = 0;
    const stops = points
      .map((point, index) => {
        const start = total ? (cursor / total) * 360 : 0;
        cursor += Math.max(0, point.value);
        const end = total ? (cursor / total) * 360 : 0;
        return `${COLORS[index % COLORS.length]} ${start}deg ${end}deg`;
      })
      .join(', ');
    return (
      <div className="chart-card">
        <div className="chart-head">
          <span>{chart.title}</span>
          <span className="badge agent">PIE</span>
        </div>
        <div className="pie-row">
          <div className="pie" style={{ background: `conic-gradient(${stops || '#223 0deg 360deg'})` }}>
            <div className="pie-hole">
              <span>{total.toLocaleString()}</span>
              <em>{chart.yLabel}</em>
            </div>
          </div>
          <div className="pie-legend">
            {points.slice(0, 8).map((point, index) => (
              <div key={point.label} className="pie-legend-row">
                <span className="swatch" style={{ background: COLORS[index % COLORS.length] }} />
                <span className="truncate">{point.label}</span>
                <em>{point.value.toLocaleString()}</em>
              </div>
            ))}
          </div>
        </div>
        {chart.sql ? (
          <button className="chart-open" onClick={() => onOpenEditor?.(chart.sql!)}>
            <ArrowUpRight size={11} /> 打开 SQL
          </button>
        ) : null}
      </div>
    );
  }

  const width = 380;
  const height = 176;
  const pad = { left: 34, right: 10, top: 12, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / Math.max(points.length, 1);
  const y = (value: number) => pad.top + innerH - (value / max) * innerH;
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${pad.left + band * (index + 0.5)} ${y(point.value)}`).join(' ');
  const areaPath = `${linePath} L ${pad.left + band * (points.length - 0.5)} ${pad.top + innerH} L ${pad.left + band * 0.5} ${pad.top + innerH} Z`;
  const labelStep = Math.max(1, Math.ceil(points.length / 6));

  return (
    <div className="chart-card">
      <div className="chart-head">
        <span>{chart.title}</span>
        <span className="badge agent">{chart.type === 'line' ? 'LINE' : 'BAR'}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img">
        <defs>
          <linearGradient id={`bar-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#5B8CFF" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#5B8CFF" stopOpacity="0.35" />
          </linearGradient>
          <linearGradient id={`area-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#9A7BFF" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#9A7BFF" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const gy = pad.top + innerH * ratio;
          return (
            <g key={ratio}>
              <line x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} className="chart-grid" />
              <text x={pad.left - 5} y={gy + 3} textAnchor="end" className="chart-axis">
                {Math.round(max * (1 - ratio)).toLocaleString()}
              </text>
            </g>
          );
        })}
        {chart.type === 'bar'
          ? points.map((point, index) => {
              const barH = (point.value / max) * innerH;
              return (
                <rect
                  key={point.label}
                  x={pad.left + band * index + band * 0.2}
                  y={pad.top + innerH - barH}
                  width={band * 0.6}
                  height={Math.max(1, barH)}
                  rx={2}
                  fill={`url(#bar-${gradientId})`}
                >
                  <title>{`${point.label}: ${point.value.toLocaleString()}`}</title>
                </rect>
              );
            })
          : null}
        {chart.type === 'line' ? (
          <>
            <path d={areaPath} fill={`url(#area-${gradientId})`} />
            <path d={linePath} fill="none" stroke="#9A7BFF" strokeWidth="2" />
            {points.map((point, index) => (
              <circle key={point.label} cx={pad.left + band * (index + 0.5)} cy={y(point.value)} r="2.6" fill="#9A7BFF">
                <title>{`${point.label}: ${point.value.toLocaleString()}`}</title>
              </circle>
            ))}
          </>
        ) : null}
        {points.map((point, index) =>
          index % labelStep === 0 ? (
            <text key={point.label} x={pad.left + band * (index + 0.5)} y={height - 9} textAnchor="middle" className="chart-axis">
              {point.label.length > 8 ? `${point.label.slice(0, 8)}…` : point.label}
            </text>
          ) : null,
        )}
      </svg>
      <div className="chart-foot">
        <span>{chart.xLabel} → {chart.yLabel}</span>
        {chart.sql ? (
          <button className="chart-open" onClick={() => onOpenEditor?.(chart.sql!)}>
            <ArrowUpRight size={11} /> 打开 SQL
          </button>
        ) : null}
      </div>
    </div>
  );
}
