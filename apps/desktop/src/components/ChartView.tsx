import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { useApp, type ContextMenuItem } from '../store';
import { ChartToolbar, type ChartType } from './ChartToolbar';

export interface ChartSpec {
  type: ChartType;
  title: string;
  xLabel: string;
  yLabel: string;
  sql?: string;
  series: Array<{ label: string; value: number }>;
  /** 多列对比：与 series 等长的附加数值列（柱状/堆叠/折线/雷达） */
  extraSeries?: Array<{ name: string; values: number[] }>;
  /** 柱状图多系列时按列堆叠（正负分开累计）；type='stacked' 时等效 */
  stacked?: boolean;
  /** 双轴：仅一个附加列时，它使用右侧独立刻度并以折线绘制 */
  dualAxis?: boolean;
  /** 散点：x/y 都是数值列；label 用于 tooltip（如商品名） */
  scatter?: Array<{ x: number; y: number; label?: string }>;
  /** 热力：行 × 列矩阵，values[row][column] */
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  /** forecast_chart 的外推段：虚线 + 半透明区间带，接在 series 之后 */
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
  /** forecast_chart 的方法说明，必须原样展示给用户 */
  note?: string;
}

function seriesColors(chart: ChartSpec) {
  return [
    { name: chart.yLabel || '值', values: chart.series.map((point) => point.value), color: '#45c8c3' },
    ...(chart.extraSeries ?? [])
      .filter((extra) => extra.values.length === chart.series.length)
      .map((extra, index) => ({ name: extra.name, values: extra.values, color: COLORS[(index + 1) % COLORS.length] })),
  ];
}

function heatmapOf(chart: ChartSpec) {
  if (chart.heatmap?.xLabels.length && chart.heatmap.yLabels.length) return chart.heatmap;
  // Agent 侧切到热力时如果只带了单序列，就把「数值列 × 分类」摊成一行热力带，
  // 而不是弹空图——工具条的类型切换必须始终有结果。
  const list = seriesColors(chart);
  if (!chart.series.length) return null;
  return {
    xLabels: chart.series.map((point) => point.label || '—'),
    yLabels: list.map((entry) => entry.name),
    values: list.map((entry) => entry.values),
    valueLabel: chart.yLabel,
  };
}

function scatterOf(chart: ChartSpec, maxPoints: number) {
  if (chart.scatter?.length) return chart.scatter.slice(0, maxPoints);
  return chart.series.slice(0, maxPoints).map((point, index) => {
    const numeric = Number(point.label);
    return { x: Number.isFinite(numeric) ? numeric : index + 1, y: point.value, label: point.label };
  });
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
  /** 可用高度上限（px）：Agent 面板按可见聊天区传入，缺省按窗口比例 */
  maxHeight?: number;
}

export function ChartView({ chart, onOpenEditor, typeOverride, maxPoints = 12, zoomed = false, onExportCsv, onTypeChange, columns, x, y, onX, onY, maxHeight }: ChartViewProps) {
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

  const body =
    type === 'pie' ? (
      <PieBody chart={chart} maxPoints={maxPoints} />
    ) : type === 'scatter' ? (
      <ScatterBody chart={chart} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} />
    ) : type === 'heatmap' ? (
      <HeatmapBody chart={chart} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} />
    ) : type === 'radar' ? (
      <RadarBody chart={chart} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} />
    ) : (
      <AxisBody chart={chart} type={type} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} />
    );

  return (
    <div
      className="chart-card"
      data-testid="chart-card"
      onContextMenu={(event) => {
        event.preventDefault();
        const items: ContextMenuItem[] = [{ label: '导出 PNG', onClick: () => void exportPng(svgRef, chart.title, setExporting) }];
        if (onExportCsv) items.push({ label: '导出 CSV', onClick: onExportCsv });
        if (chart.sql && onOpenEditor) items.push({ label: '打开 SQL', onClick: () => onOpenEditor(chart.sql!) });
        useApp.getState().openContextMenu(event.clientX, event.clientY, items);
      }}
    >
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

function SeriesLegend({ series }: { series: Array<{ name: string; color: string }> }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, padding: '0 4px 2px', fontSize: 11, color: 'var(--text-secondary)' }} data-testid="chart-series-legend">
      {series.map((entry) => (
        <span key={entry.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <i style={{ width: 8, height: 8, borderRadius: 2, background: entry.color, display: 'inline-block' }} />
          {entry.name}
        </span>
      ))}
    </div>
  );
}

function ScatterBody({ chart, maxPoints, zoomed, svgRef, maxHeight }: { chart: ChartSpec; maxPoints: number; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const points = scatterOf(chart, maxPoints);
  if (!points.length) {
    return <div className="dash-empty" data-testid="chart-empty">没有可绘制的散点（x/y 需要同时为数值）。</div>;
  }
  const width = zoomed ? 720 : Math.max(260, Math.round(measured));
  const naturalHeight = Math.round(width * (zoomed ? 320 / 720 : 176 / 380));
  const height = zoomed ? 320 : maxHeight !== undefined ? Math.max(140, Math.min(350, maxHeight)) : Math.max(140, Math.min(chartHeightCap(), naturalHeight));
  const pad = { left: 46, right: 14, top: 12, bottom: 30 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bloom = (lo: number, hi: number): [number, number] => {
    if (lo === hi) return [lo - 0.5, hi + 0.5];
    const margin = (hi - lo) * 0.06;
    return [lo - margin, hi + margin];
  };
  const [xMin, xMax] = bloom(Math.min(...xs), Math.max(...xs));
  const [yMin, yMax] = bloom(Math.min(...ys), Math.max(...ys));
  const sx = (value: number) => pad.left + ((value - xMin) / (xMax - xMin || 1)) * innerW;
  const sy = (value: number) => pad.top + innerH - ((value - yMin) / (yMax - yMin || 1)) * innerH;
  const xTicks = [0, 0.25, 0.5, 0.75, 1];
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={chart.title} data-testid="chart-svg" data-scatter="true">
      {xTicks.map((ratio) => {
        const gy = pad.top + innerH * ratio;
        return (
          <g key={`y-${ratio}`}>
            <line x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} className="chart-grid" />
            <text x={pad.left - 5} y={gy + 3} textAnchor="end" className="chart-axis">{formatTick(yMax - (yMax - yMin) * ratio)}</text>
          </g>
        );
      })}
      {xTicks.map((ratio) => (
        <text key={`x-${ratio}`} x={pad.left + innerW * ratio} y={height - 9} textAnchor="middle" className="chart-axis">
          {formatTick(xMin + (xMax - xMin) * ratio)}
        </text>
      ))}
      <g data-testid="chart-scatter">
        {points.map((point, index) => (
          <circle key={`${point.label ?? point.x}-${index}`} cx={sx(point.x)} cy={sy(point.y)} r={zoomed ? 3.2 : 2.8} fill={COLORS[0]} fillOpacity={0.82}>
            <title>{`${point.label ? `${point.label} · ` : ''}${point.x.toLocaleString()}, ${point.y.toLocaleString()}`}</title>
          </circle>
        ))}
      </g>
    </svg>
  );
}

function HeatmapBody({ chart, zoomed, svgRef, maxHeight }: { chart: ChartSpec; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const matrix = heatmapOf(chart);
  if (!matrix || !matrix.xLabels.length || !matrix.yLabels.length) {
    return <div className="dash-empty" data-testid="chart-empty">热力图需要一组行/列分类和一个数值度量。</div>;
  }
  const width = zoomed ? 720 : Math.max(300, Math.round(measured));
  const labelW = Math.min(112, Math.max(46, Math.max(...matrix.yLabels.map((label) => Math.min(12, label.length))) * 7.4 + 10));
  const pad = { left: labelW, right: 12, top: 8, bottom: 30 };
  const cellW = Math.max(10, (width - pad.left - pad.right) / matrix.xLabels.length);
  const cap = maxHeight ?? (zoomed ? 320 : 300);
  const cellH = Math.max(13, Math.min(32, (cap - pad.top - pad.bottom) / matrix.yLabels.length));
  const height = Math.round(pad.top + pad.bottom + cellH * matrix.yLabels.length);
  const flat = matrix.values.flat().filter((value) => Number.isFinite(value));
  const hi = Math.max(1, ...flat);
  const lo = Math.min(0, ...flat);
  const showValues = cellW >= 28 && cellH >= 15;
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={chart.title} data-testid="chart-svg" data-heatmap="true">
      {matrix.yLabels.map((label, row) => (
        <text key={`y-${label}`} x={pad.left - 6} y={pad.top + cellH * row + cellH / 2 + 3} textAnchor="end" className="chart-axis">
          {label.length > 12 ? `${label.slice(0, 12)}…` : label}
        </text>
      ))}
      {matrix.yLabels.map((yLabelOfRow, row) =>
        matrix.xLabels.map((xLabel, column) => {
          const value = matrix.values[row]?.[column];
          const numeric = Number.isFinite(value) ? value : 0;
          const ratio = (numeric - lo) / (hi - lo || 1);
          return (
            <g key={`${xLabel}-${yLabelOfRow}`}>
              <rect
                data-testid="chart-heatmap-cell"
                x={pad.left + column * cellW + 1}
                y={pad.top + row * cellH + 1}
                width={Math.max(1, cellW - 2)}
                height={Math.max(1, cellH - 2)}
                rx={2}
                fill={COLORS[0]}
                fillOpacity={0.06 + ratio * 0.86}
                stroke="rgba(128,136,132,.35)"
                strokeWidth={0.5}
              >
                <title>{`${xLabel} · ${yLabelOfRow}: ${numeric.toLocaleString()}${matrix.valueLabel ? `（${matrix.valueLabel}）` : ''}`}</title>
              </rect>
              {showValues ? (
                <text x={pad.left + column * cellW + cellW / 2} y={pad.top + row * cellH + cellH / 2 + 3} textAnchor="middle" className="chart-axis">
                  {formatTick(numeric)}
                </text>
              ) : null}
            </g>
          );
        }),
      )}
      {matrix.xLabels.map((label, column) => (
        <text key={`x-${label}`} x={pad.left + column * cellW + cellW / 2} y={height - 10} textAnchor="middle" className="chart-axis">
          {label.length > 10 ? `${label.slice(0, 10)}…` : label}
        </text>
      ))}
    </svg>
  );
}

function RadarBody({ chart, maxPoints, zoomed, svgRef, maxHeight }: { chart: ChartSpec; maxPoints: number; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const history = chart.series.slice(0, maxPoints);
  if (history.length < 3) {
    return <div className="dash-empty" data-testid="chart-empty">雷达图至少需要 3 个类别轴。</div>;
  }
  const extras = (chart.extraSeries ?? []).filter((extra) => extra.values.length >= history.length);
  const seriesList = [
    { name: chart.yLabel || '值', values: history.map((point) => point.value), color: COLORS[0] },
    ...extras.map((extra, index) => ({ name: extra.name, values: extra.values.slice(0, history.length), color: COLORS[(index + 1) % COLORS.length] })),
  ];
  const width = zoomed ? 720 : Math.max(280, Math.round(measured));
  const height = zoomed ? 320 : maxHeight !== undefined ? Math.max(180, Math.min(350, maxHeight)) : Math.max(180, Math.min(320, Math.round(width * 0.68)));
  const cx = width / 2;
  const cy = height / 2 + 4;
  const radius = Math.max(40, Math.min(width, height) / 2 - 38);
  const hi = Math.max(1, ...seriesList.flatMap((entry) => entry.values));
  const count = history.length;
  const angle = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / count;
  const at = (index: number, ratio: number) => [cx + Math.cos(angle(index)) * radius * ratio, cy + Math.sin(angle(index)) * radius * ratio] as const;
  const polygon = (ratio: number) => history.map((_, index) => at(index, ratio).join(',')).join(' ');
  return (
    <>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={chart.title} data-testid="chart-svg" data-radar="true">
        {[0.25, 0.5, 0.75, 1].map((ratio) => (
          <polygon key={ratio} points={polygon(ratio)} className="chart-grid" fill="none" />
        ))}
        {history.map((point, index) => {
          const [x, y] = at(index, 1);
          const [labelX, labelY] = at(index, 1.14);
          const anchor = Math.cos(angle(index)) > 0.25 ? 'start' : Math.cos(angle(index)) < -0.25 ? 'end' : 'middle';
          return (
            <g key={point.label}>
              <line x1={cx} y1={cy} x2={x} y2={y} className="chart-grid" />
              <text x={labelX} y={labelY + 3} textAnchor={anchor} className="chart-axis">{point.label.length > 9 ? `${point.label.slice(0, 9)}…` : point.label}</text>
            </g>
          );
        })}
        {seriesList.map((entry) => (
          <g key={entry.name} data-testid="chart-radar-shape">
            <polygon
              points={entry.values.map((value, index) => at(index, Math.max(0, Math.min(1, value / hi))).join(',')).join(' ')}
              fill={entry.color}
              fillOpacity={0.14}
              stroke={entry.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {entry.values.map((value, index) => {
              const [x, y] = at(index, Math.max(0, Math.min(1, value / hi)));
              return (
                <circle key={`${entry.name}-${index}`} cx={x} cy={y} r={2.4} fill={entry.color}>
                  <title>{`${entry.name} · ${history[index].label}: ${value.toLocaleString()}`}</title>
                </circle>
              );
            })}
          </g>
        ))}
      </svg>
      {seriesList.length > 1 ? <SeriesLegend series={seriesList} /> : null}
    </>
  );
}

interface AxisBodyProps {
  chart: ChartSpec;
  type: ChartType;
  maxPoints: number;
  zoomed: boolean;
  svgRef: RefObject<SVGSVGElement>;
  maxHeight?: number;
}

function useElementWidth(ref: RefObject<Element>, fallback: number): number {
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const measure = () => {
      const next = Math.round(ref.current?.getBoundingClientRect().width ?? 0);
      if (next > 0) setWidth(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ref]);
  return width;
}

/** 图表高度上限：不超过 400px，也不超过窗口可视高度的一半左右。 */
function chartHeightCap(): number {
  const viewport = typeof window === 'undefined' ? 800 : window.innerHeight;
  return Math.max(160, Math.min(400, Math.round(viewport * 0.55)));
}

function AxisBody({ chart, type, maxPoints, zoomed, svgRef, maxHeight }: AxisBodyProps) {
  const id = useStableId();
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const history = chart.series.slice(0, maxPoints);
  const extras = (chart.extraSeries ?? []).filter((extra) => extra.values.length === history.length);
  const multi = extras.length > 0;
  const isBar = type === 'bar' || type === 'stacked';
  const stacked = isBar && multi && (type === 'stacked' || chart.stacked === true);
  const dual = isBar && multi && chart.dualAxis === true && extras.length === 1 && !stacked;
  const seriesList = [
    { name: chart.yLabel, values: history.map((point) => point.value), color: '#45c8c3' },
    ...extras.map((extra, index) => ({ name: extra.name, values: extra.values, color: COLORS[(index + 1) % COLORS.length] })),
  ];
  const forecast = type === 'line' ? (chart.forecast ?? []).slice(0, 12) : [];
  const all = [...history, ...forecast.map((p) => ({ label: p.label, value: p.value }))];

  // 空序列必须早退：linePath 为空串时 areaPath 会退化成 " L …"，浏览器报
  // "<path> attribute d: Expected moveto path command"，画出一堆垃圾路径。
  if (!all.length) {
    return <div className="dash-empty" data-testid="chart-empty">没有可绘制的数据点（结果集为空或全为 NULL）。</div>;
  }

  // viewBox 用容器实际像素宽：1:1 渲染，文字更清晰。
  // Agent 面板给的是固定高度（350，窗口太矮时只缩不涨）；QueryView 仍随宽度增长，封顶 400。
  const width = zoomed ? 720 : Math.max(260, Math.round(measured));
  const naturalHeight = Math.round(width * (zoomed ? 320 / 720 : 176 / 380));
  const height = zoomed
    ? 320
    : maxHeight !== undefined
      ? Math.max(140, Math.min(350, maxHeight))
      : Math.max(140, Math.min(chartHeightCap(), naturalHeight));
  const pad = { left: 42, right: dual ? 44 : 12, top: 12, bottom: 28 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const band = innerW / all.length;

  const values = all.map((point) => point.value);
  if (dual) {
    // 主列独立缩放，附加列走右轴
  } else if (stacked) {
    for (let index = 0; index < history.length; index += 1) {
      let positive = 0;
      let negative = 0;
      for (const entry of seriesList) {
        const value = entry.values[index] ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      }
      values.push(positive, negative);
    }
  } else if (!dual) {
    for (const entry of seriesList.slice(1)) values.push(...entry.values);
  }
  if (forecast.length) {
    values.push(0);
    for (const point of forecast) values.push(point.lower, point.upper);
  }
  const hi = Math.max(...values, 1);
  const lo = Math.min(...values, 0);
  const span = hi - lo || 1;
  const y = (value: number) => pad.top + innerH - ((value - lo) / span) * innerH;
  const secondary = dual ? seriesList[1].values : [];
  const hi2 = Math.max(...secondary, 1);
  const lo2 = Math.min(...secondary, 0);
  const span2 = hi2 - lo2 || 1;
  const y2 = (value: number) => pad.top + innerH - ((value - lo2) / span2) * innerH;
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
    <>
    <svg
      ref={svgRef}
      viewBox={`0 0 ${width} ${height}`}
      className="chart-svg"
      role="img"
      aria-label={chart.title}
      data-testid="chart-svg"
      data-stacked={stacked ? 'true' : undefined}
      data-dual={dual ? 'true' : undefined}
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
      {isBar && (!multi || dual)
        ? history.map((point, index) => {
            const top = y(Math.max(point.value, 0));
            const bottom = y(Math.min(point.value, 0));
            // 分类少时每根柱一个定性色（和饼图同一套），超过色板长度就退回单色，避免循环撞色
            const fill = history.length <= COLORS.length ? COLORS[index % COLORS.length] : COLORS[0];
            const barWidth = Math.min(band * 0.6, 72);
            return (
              <rect
                key={`${point.label}-${index}`}
                x={pad.left + band * index + (band - barWidth) / 2}
                y={top}
                width={barWidth}
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
      {isBar && multi && !stacked && !dual
        ? history.map((point, index) => {
            const groupWidth = Math.min(band * 0.82, 96);
            const barWidth = groupWidth / seriesList.length;
            return seriesList.map((entry, entryIndex) => {
              const value = entry.values[index] ?? 0;
              const top = y(Math.max(value, 0));
              const bottom = y(Math.min(value, 0));
              return (
                <rect
                  key={`${entry.name}-${point.label}-${index}`}
                  x={pad.left + band * index + (band - groupWidth) / 2 + entryIndex * barWidth}
                  y={top}
                  width={Math.max(1, barWidth - 2)}
                  height={Math.max(1, bottom - top)}
                  rx={2}
                  fill={entry.color}
                  fillOpacity={0.92}
                >
                  <title>{`${entry.name} · ${point.label}: ${value.toLocaleString()}`}</title>
                </rect>
              );
            });
          })
        : null}
      {isBar && multi && stacked
        ? history.map((point, index) => {
            let positive = 0;
            let negative = 0;
            const barWidth = Math.min(band * 0.6, 72);
            return seriesList.map((entry) => {
              const value = entry.values[index] ?? 0;
              const start = value >= 0 ? positive : negative;
              const finish = start + value;
              if (value >= 0) positive = finish;
              else negative = finish;
              const top = y(Math.max(start, finish));
              const bottom = y(Math.min(start, finish));
              return (
                <rect
                  key={`${entry.name}-${point.label}-${index}`}
                  x={pad.left + band * index + (band - barWidth) / 2}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, bottom - top)}
                  rx={2}
                  fill={entry.color}
                  fillOpacity={0.92}
                >
                  <title>{`${entry.name} · ${point.label}: ${value.toLocaleString()}`}</title>
                </rect>
              );
            });
          })
        : null}
      {type === 'line' ? (
        <>
          {!multi && areaPath ? <path d={areaPath} fill={`url(#area-${id})`} /> : null}
          {!multi && bandPath ? <path d={bandPath} fill="#e0af63" fillOpacity="0.16" stroke="none" data-testid="chart-forecast-band" /> : null}
          {multi
            ? seriesList.map((entry) => (
                <path
                  key={entry.name}
                  d={entry.values.map((value, index) => `${index === 0 ? 'M' : 'L'} ${cx(index)} ${y(value)}`).join(' ')}
                  fill="none"
                  stroke={entry.color}
                  strokeWidth="2"
                />
              ))
            : linePath ? <path d={linePath} fill="none" stroke="#45c8c3" strokeWidth="2" /> : null}
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
      {dual ? (
        <g data-testid="chart-axis-right">
          {[0, 0.5, 1].map((ratio) => {
            const gy = pad.top + innerH * ratio;
            return (
              <text key={`r-${ratio}`} x={width - pad.right + 6} y={gy + 3} textAnchor="start" className="chart-axis" fill={COLORS[1]}>
                {formatTick(lo2 + span2 * (1 - ratio))}
              </text>
            );
          })}
        </g>
      ) : null}
      {dual ? (
        <path
          d={secondary.map((value, index) => `${index === 0 ? 'M' : 'L'} ${cx(index)} ${y2(value)}`).join(' ')}
          fill="none"
          stroke={COLORS[1]}
          strokeWidth="2"
          data-testid="chart-dual-line"
        />
      ) : null}
      {all.map((point, index) =>
        index % labelStep === 0 ? (
          <text key={`l-${point.label}-${index}`} x={cx(index)} y={height - 9} textAnchor="middle" className="chart-axis">
            {point.label.length > 8 ? `${point.label.slice(0, 8)}…` : point.label}
          </text>
        ) : null,
      )}
    </svg>
    {multi ? <SeriesLegend series={seriesList} /> : null}
    </>
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
