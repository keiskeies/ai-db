import { useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { ChartToolbar, type ChartType } from './ChartToolbar';

export interface ChartSpec {
  type: 'bar' | 'line' | 'pie';
  title: string;
  xLabel: string;
  yLabel: string;
  sql?: string;
  series: Array<{ label: string; value: number }>;
  /** forecast_chart 的外推段：虚线 + 半透明区间带，接在 series 之后 */
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
  /** forecast_chart 的方法说明，必须原样展示给用户 */
  note?: string;
}

const COLORS = ['#45c8c3', '#e0af63', '#a9c97e', '#8fa8f0', '#e58cb0', '#c48fc8', '#6e9fbf', '#d98e6e'];

export interface ChartViewProps {
  chart: ChartSpec;
  onOpenEditor?: (sql: string) => void;
  /** 外部（工具条）指定的类型，优先于 chart.type */
  typeOverride?: ChartType;
  /** 最多画多少个点，放大态给更大的值 */
  maxPoints?: number;
  zoomed?: boolean;
  onExportCsv?: () => void;
  onTypeChange?: (type: ChartType) => void;
  /** 传了才在工具条里显示 X/Y 下拉（QueryView 用；Agent 侧的轴由 Bridge 决定） */
  columns?: string[];
  x?: string;
  y?: string;
  onX?: (value: string) => void;
  onY?: (value: string) => void;
}

export function ChartView({ chart, onOpenEditor, typeOverride, maxPoints = 12, zoomed = false, onExportCsv, onTypeChange, columns, x, y, onX, onY }: ChartViewProps) {
  const [localType, setLocalType] = useState<ChartType>(chart.type);
  const [exporting, setExporting] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  const type = typeOverride ?? localType;
  const setType = (next: ChartType) => {
    setLocalType(next);
    onTypeChange?.(next);
  };

  const toolbar = (
    <ChartToolbar
      type={type}
      onType={setType}
      columns={columns}
      x={x}
      y={y}
      onX={onX}
      onY={onY}
      sql={chart.sql}
      onExportCsv={onExportCsv}
      onExportPng={() => void exportPng(svgRef, chart.title, setExporting)}
      onZoom={zoomed ? undefined : () => setZoomOpen(true)}
      exporting={exporting}
    />
  );

  const body = type === 'pie' ? (
    <PieBody chart={chart} maxPoints={maxPoints} />
  ) : (
    <AxisBody chart={chart} type={type} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} />
  );

  return (
    <div className="chart-card" data-testid="chart-card">
      <div className="chart-head">
        <span className="truncate">{chart.title}</span>
        <span className="badge agent">{type.toUpperCase()}</span>
      </div>
      {toolbar}
      {body}
      {chart.note ? <div className="chart-note" data-testid="chart-note">{chart.note}</div> : null}
      <div className="chart-foot">
        <span className="truncate">{chart.xLabel} → {chart.yLabel}</span>
        {chart.sql ? (
          <button className="chart-open" onClick={() => onOpenEditor?.(chart.sql!)}>
            <ArrowUpRight size={11} /> 打开 SQL
          </button>
        ) : null}
      </div>
      {zoomOpen ? (
        createPortal(
          <div className="chart-modal" role="dialog" aria-label={chart.title} onClick={() => setZoomOpen(false)}>
            <div className="chart-modal-body" onClick={(e) => e.stopPropagation()}>
              <button className="icon-btn chart-modal-close" title="关闭" data-testid="chart-zoom-close" onClick={() => setZoomOpen(false)}><X size={14} /></button>
              <ChartView chart={chart} onOpenEditor={onOpenEditor} typeOverride={type} maxPoints={60} zoomed onExportCsv={onExportCsv} columns={columns} x={x} y={y} onX={onX} onY={onY} />
            </div>
          </div>,
          document.body,
        )
      ) : null}
    </div>
  );
}

function PieBody({ chart, maxPoints }: { chart: ChartSpec; maxPoints: number }) {
  const points = chart.series.slice(0, maxPoints);
  const total = points.reduce((sum, point) => sum + Math.max(0, point.value), 0);
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
  );
}

interface AxisBodyProps {
  chart: ChartSpec;
  type: ChartType;
  maxPoints: number;
  zoomed: boolean;
  svgRef: RefObject<SVGSVGElement>;
}

function AxisBody({ chart, type, maxPoints, zoomed, svgRef }: AxisBodyProps) {
  const id = useStableId();
  const history = chart.series.slice(0, maxPoints);
  const forecast = type === 'line' ? (chart.forecast ?? []).slice(0, 12) : [];
  const all = [...history, ...forecast.map((p) => ({ label: p.label, value: p.value }))];

  // 空序列必须早退：linePath 为空串时 areaPath 会退化成 " L …"，浏览器报
  // "<path> attribute d: Expected moveto path command"，画出一堆垃圾路径。
  if (!all.length) {
    return <div className="dash-empty" data-testid="chart-empty">没有可绘制的数据点（结果集为空或全为 NULL）。</div>;
  }

  const width = zoomed ? 720 : 380;
  const height = zoomed ? 320 : 176;
  const pad = { left: 42, right: 12, top: 12, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / all.length;

  const values = all.map((point) => point.value);
  if (forecast.length) {
    values.push(0);
    for (const point of forecast) values.push(point.lower, point.upper);
  }
  const hi = Math.max(...values, 1);
  const lo = Math.min(...values, 0);
  const span = hi - lo || 1;
  const y = (value: number) => pad.top + innerH - ((value - lo) / span) * innerH;
  const cx = (index: number) => pad.left + band * (index + 0.5);

  const linePath = history.map((point, index) => `${index === 0 ? 'M' : 'L'} ${cx(index)} ${y(point.value)}`).join(' ');
  // 单点没有线段可闭合，只画点，不生成 area 路径
  const areaPath = history.length > 1
    ? `${linePath} L ${cx(history.length - 1)} ${y(lo)} L ${cx(0)} ${y(lo)} Z`
    : '';

  // 预测段：从最后一个历史点接出去，虚线 + 区间带
  const anchor = history.length ? { x: cx(history.length - 1), y: y(history[history.length - 1].value) } : null;
  const forecastPath = forecast
    .map((point, index) => `${anchor && index === 0 ? `M ${anchor.x} ${anchor.y} L` : index === 0 ? 'M' : 'L'} ${cx(history.length + index)} ${y(point.value)}`)
    .join(' ');
  const bandPath = forecast.length
    ? [
        ...forecast.map((p, i) => `${i === 0 ? 'M' : 'L'} ${cx(history.length + i)} ${y(p.upper)}`),
        ...[...forecast].reverse().map((p, i) => `L ${cx(history.length + forecast.length - 1 - i)} ${y(p.lower)}`),
        'Z',
      ].join(' ')
    : '';

  const labelStep = Math.max(1, Math.ceil(all.length / (zoomed ? 10 : 6)));

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="chart-svg"
      role="img"
      aria-label={chart.title}
      data-testid="chart-svg"
    >
      <defs>
        <linearGradient id={`area-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#45c8c3" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#45c8c3" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const gy = pad.top + innerH * ratio;
        return (
          <g key={ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} className="chart-grid" />
            <text x={pad.left - 5} y={gy + 3} textAnchor="end" className="chart-axis">
              {formatTick(lo + span * (1 - ratio))}
            </text>
          </g>
        );
      })}
      {lo < 0 ? <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="chart-zero" /> : null}
      {type === 'bar'
        ? history.map((point, index) => {
            const top = y(Math.max(point.value, 0));
            const bottom = y(Math.min(point.value, 0));
            // 分类少时每根柱一个定性色（和饼图同一套），超过色板长度就退回单色，避免循环撞色
            const fill = history.length <= COLORS.length ? COLORS[index % COLORS.length] : COLORS[0];
            return (
              <rect
                key={`${point.label}-${index}`}
                x={pad.left + band * index + band * 0.2}
                y={top}
                width={band * 0.6}
                height={Math.max(1, bottom - top)}
                rx={2}
                fill={fill}
                fillOpacity={0.92}
              >
                <title>{`${point.label}: ${point.value.toLocaleString()}`}</title>
              </rect>
            );
          })
        : null}
      {type === 'line' ? (
        <>
          {areaPath ? <path d={areaPath} fill={`url(#area-${id})`} /> : null}
          {bandPath ? <path d={bandPath} fill="#e0af63" fillOpacity="0.16" stroke="none" data-testid="chart-forecast-band" /> : null}
          {linePath ? <path d={linePath} fill="none" stroke="#45c8c3" strokeWidth="2" /> : null}
          {forecastPath ? (
            <path d={forecastPath} fill="none" stroke="#e0af63" strokeWidth="2" strokeDasharray="4 3" data-testid="chart-forecast-line" />
          ) : null}
          {history.map((point, index) => (
            <circle key={`${point.label}-${index}`} cx={cx(index)} cy={y(point.value)} r="2.6" fill="#45c8c3">
              <title>{`${point.label}: ${point.value.toLocaleString()}`}</title>
            </circle>
          ))}
          {forecast.map((point, index) => (
            <circle key={`f-${point.label}-${index}`} cx={cx(history.length + index)} cy={y(point.value)} r="2.6" fill="#F5C451">
              <title>{`${point.label}: ${point.value.toLocaleString()}（区间 ${point.lower.toLocaleString()} ~ ${point.upper.toLocaleString()}）`}</title>
            </circle>
          ))}
        </>
      ) : null}
      {all.map((point, index) =>
        index % labelStep === 0 ? (
          <text key={`l-${point.label}-${index}`} x={cx(index)} y={height - 9} textAnchor="middle" className="chart-axis">
            {point.label.length > 8 ? `${point.label.slice(0, 8)}…` : point.label}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1000).toFixed(0)}k`;
  if (abs >= 100 || Number.isInteger(value)) return Math.round(value).toLocaleString();
  return value.toFixed(1);
}

let idCounter = 0;
function useStableId(): string {
  const ref = useRef<string>('');
  if (!ref.current) ref.current = `c${(idCounter += 1)}`;
  return ref.current;
}

/**
 * 导出 PNG。两个必须遵守的细节（headless Chrome 实测）：
 * ① base64 走 btoa(unescape(encodeURIComponent(svg)))，直接 btoa 遇到中文坐标轴标签会抛 InvalidCharacterError；
 * ② SVG 自身没有背景，drawImage 前要先 fillRect 底色，否则导出的是透明图。
 * 另外 class 样式在独立 SVG 里不生效，导出前要把网格线/坐标轴的颜色内联成属性。
 */
async function exportPng(svgRef: RefObject<SVGSVGElement>, title: string, setExporting: (value: boolean) => void): Promise<void> {
  const svg = svgRef.current;
  if (!svg) return;
  setExporting(true);
  try {
    const rect = svg.getBoundingClientRect();
    const scale = 2;
    const width = Math.max(1, Math.round(rect.width)) * scale;
    const height = Math.max(1, Math.round(rect.height)) * scale;
    const clone = svg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    const styles = getComputedStyle(document.documentElement);
    const grid = (styles.getPropertyValue('--border-subtle') || '#2a2f3a').trim();
    const axis = (styles.getPropertyValue('--text-muted') || '#8b93a7').trim();
    const background = (styles.getPropertyValue('--bg-elevated') || '#14161c').trim();
    clone.querySelectorAll<SVGLineElement>('.chart-grid').forEach((line) => line.setAttribute('stroke', grid));
    clone.querySelectorAll<SVGTextElement>('.chart-axis').forEach((text) => {
      text.setAttribute('fill', axis);
      text.setAttribute('font-size', '9');
      text.setAttribute('font-family', 'system-ui, sans-serif');
    });
    clone.querySelectorAll<SVGLineElement>('.chart-zero').forEach((line) => line.setAttribute('stroke', axis));

    const source = new XMLSerializer().serializeToString(clone);
    const url = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(source)))}`;
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('SVG 渲染失败'));
      image.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 canvas 上下文');
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败');
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${(title || 'chart').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 4000);
  } finally {
    setExporting(false);
  }
}
