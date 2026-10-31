import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, X } from 'lucide-react';
import { useApp, type ContextMenuItem } from '../store';
import { ChartToolbar, type ChartType } from './ChartToolbar';
import { CHART_TYPE_NAMES, chartSuitability, recommendChartType } from './chartSuitability';

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
  /** 可用高度上限（px）：报告等紧凑场景传入，缺省按窗口比例 */
  maxHeight?: number;
  /** 固定绘图区高度（px）：Agent 对话统一 300，切换图表类型时布局不跳 */
  height?: number;
  /** AI 生成的图表按数据结构限制可选类型；QueryView 等探索场景不传 */
  enforceSuitability?: boolean;
}

export function ChartView({ chart, onOpenEditor, typeOverride, maxPoints = 12, zoomed = false, onExportCsv, onTypeChange, columns, x, y, onX, onY, maxHeight, height, enforceSuitability = false }: ChartViewProps) {
  const suitability = useMemo(() => (enforceSuitability ? chartSuitability(chart) : undefined), [chart, enforceSuitability]);
  const correctedFrom = enforceSuitability && suitability && !suitability[chart.type]?.ok ? chart.type : undefined;
  const correctedType = correctedFrom && suitability ? recommendChartType(suitability) : undefined;
  const preferredType = correctedType ?? chart.type;
  const [localType, setLocalType] = useState<ChartType>(preferredType);
  useEffect(() => {
    setLocalType(preferredType);
  }, [preferredType]);
  const adjustmentReason = correctedFrom && correctedType && suitability ? suitability[correctedFrom].reason : undefined;
  const [exporting, setExporting] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [hover, setHover] = useState<{ x: number; y: number; text: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const dark = useDocumentDark();

  /** 所有图形都用 data-tip 标注悬停内容，这里统一做事件委托并跟随鼠标定位。 */
  const onHoverMove = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = (event.target as Element | null)?.closest?.('[data-tip]');
    const text = target?.getAttribute('data-tip');
    if (!text) {
      setHover(null);
      return;
    }
    const card = cardRef.current;
    if (!card) return;
    const rect = card.getBoundingClientRect();
    const x = Math.max(78, Math.min(Math.max(78, rect.width - 78), event.clientX - rect.left));
    setHover({ x, y: event.clientY - rect.top, text });
  };

  const type = typeOverride ?? localType;
  const setType = (next: ChartType) => {
    if (enforceSuitability && suitability && !suitability[next].ok) return;
    setLocalType(next);
    onTypeChange?.(next);
  };

  const toolbar = (
    <ChartToolbar
      type={type}
      onType={setType}
      suitability={enforceSuitability ? suitability : undefined}
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
      <PieBody chart={chart} maxPoints={maxPoints} height={height} maxHeight={maxHeight} zoomed={zoomed} svgRef={svgRef} />
    ) : type === 'scatter' ? (
      <ScatterBody chart={chart} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} height={height} />
    ) : type === 'heatmap' ? (
      <HeatmapBody chart={chart} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} height={height} dark={dark} />
    ) : type === 'radar' ? (
      <RadarBody chart={chart} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} height={height} />
    ) : (
      <AxisBody chart={chart} type={type} maxPoints={maxPoints} zoomed={zoomed} svgRef={svgRef} maxHeight={maxHeight} height={height} />
    );

  return (
    <div
      className="chart-card"
      data-testid="chart-card"
      ref={cardRef}
      onMouseMove={onHoverMove}
      onMouseLeave={() => setHover(null)}
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
        <span className="chart-kind">{type.toUpperCase()}</span>
      </div>
      {correctedFrom && correctedType ? (
        <div className="chart-adapt-note" data-testid="chart-adapt-note">
          已按数据结构改用{CHART_TYPE_NAMES[correctedType]}：{adjustmentReason ?? '当前类型不适合这组数据'}。
        </div>
      ) : null}
      {toolbar}
      {body}
      {hover ? (
        <div className="chart-hover-tip" data-testid="chart-hover-tip" style={{ left: hover.x, top: hover.y }}>
          {hover.text}
        </div>
      ) : null}
      {chart.note ? <div className="chart-note" data-testid="chart-note">{chart.note}</div> : null}
      <div className="chart-foot">
        <span className="truncate">{chart.xLabel} → {chart.yLabel}</span>
        {chart.sql && onOpenEditor ? (
          <button className="chart-open" onClick={() => onOpenEditor(chart.sql!)}>
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

/** 主题切换会改 html[data-theme]；图表里少数需要按主题计算的颜色跟着它走。 */
function useDocumentDark(): boolean {
  const [dark, setDark] = useState(() => (typeof document === 'undefined' ? true : document.documentElement.dataset.theme !== 'light'));
  useEffect(() => {
    const read = () => setDark(document.documentElement.dataset.theme !== 'light');
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return dark;
}

const MAX_ROSE_PETALS = 8;
const ROSE_OTHER_COLOR = '#7d8794';

type RosePoint = { label: string; value: number; other?: boolean };

/** 花瓣外角做二次贝塞尔圆角，内角保持靠近圆心，整体像 ECharts 玫瑰花瓣。 */
function rosePetalPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  const at = (angle: number, distance: number) => [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance] as const;
  const span = end - start;
  const radius = Math.max(1, Math.min(3, (outer - inner) * 0.18, span * outer * 0.12));
  const dTheta = radius / Math.max(1, outer);
  const [ix0, iy0] = at(start, inner);
  const [a1x, a1y] = at(start, outer - radius);
  const [b1x, b1y] = at(start + dTheta, outer);
  const [b2x, b2y] = at(end - dTheta, outer);
  const [a2x, a2y] = at(end, outer - radius);
  const [c1x, c1y] = at(start, outer);
  const [c2x, c2y] = at(end, outer);
  const [ix1, iy1] = at(end, inner);
  const large = span - dTheta * 2 > Math.PI ? 1 : 0;
  return `M ${ix0} ${iy0} L ${a1x} ${a1y} Q ${c1x} ${c1y} ${b1x} ${b1y} A ${outer} ${outer} 0 ${large} 1 ${b2x} ${b2y} Q ${c2x} ${c2y} ${a2x} ${a2y} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
}

/** 花瓣图最多展示 8 个分类，其余合并为「其他」；中心总数与花瓣/标签之和保持一致。 */
function rosePoints(chart: ChartSpec, maxPoints: number): RosePoint[] {
  const positives = chart.series
    .map((point) => ({ label: point.label || '—', value: Number(point.value) }))
    .filter((point) => Number.isFinite(point.value) && point.value > 0)
    .sort((a, b) => b.value - a.value);
  const cap = Math.max(2, Math.min(MAX_ROSE_PETALS, maxPoints));
  if (positives.length <= cap) return positives;
  const rest = positives.slice(cap - 1);
  return [
    ...positives.slice(0, cap - 1),
    { label: `其他 ${rest.length} 项`, value: rest.reduce((sum, point) => sum + point.value, 0), other: true },
  ];
}

function PieBody({ chart, maxPoints, height: fixedHeight, maxHeight, zoomed, svgRef }: { chart: ChartSpec; maxPoints: number; height?: number; maxHeight?: number; zoomed: boolean; svgRef: RefObject<SVGSVGElement> }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const points = rosePoints(chart, maxPoints);
  if (!points.length) {
    return <div className="dash-empty" data-testid="chart-empty">没有可绘制的正向数据（饼图忽略 0 与负值）。</div>;
  }
  const width = zoomed ? 720 : Math.max(280, Math.round(measured));
  const height = zoomed ? 320 : fixedHeight ?? maxHeight ?? 300;
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const maxValue = Math.max(...points.map((point) => point.value));
  // 花瓣居中，标签分布在左右两侧；引线先向外伸，再横向折到标签，
  // 和 ECharts 玫瑰图的左右 labelLine 一样，避免所有标签堆在一侧交叉。
  const sideSpace = Math.min(140, Math.max(72, width * 0.23));
  const cx = width / 2;
  const cy = height / 2 + 4;
  // 半径按 sqrt 缩放：花瓣面积与数值成正比，比例不会被半径直接放大。
  const radius = Math.max(40, Math.min(width / 2 - sideSpace - 4, height / 2 - 34));
  const inner = Math.max(8, radius * 0.18);
  const step = (Math.PI * 2) / points.length;
  // 花瓣之间只留发丝缝，视觉上拼成一整朵花
  const gap = 0.001;
  const at = (angle: number, distance: number) => [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance] as const;
  const leftX = cx - radius - 12;
  const rightX = cx + radius + 12;
  const labelTop = 40;
  const labelBottom = height - 18;
  const petals = points.map((point, index) => {
    const start = -Math.PI / 2 + step * index + gap / 2;
    const end = -Math.PI / 2 + step * (index + 1) - gap / 2;
    const outer = inner + (radius - inner) * Math.sqrt(point.value / maxValue);
    const percent = (point.value / total) * 100;
    const mid = (start + end) / 2;
    return {
      point,
      mid,
      outer,
      percent,
      side: Math.cos(mid) >= 0 ? ('right' as const) : ('left' as const),
      idealY: cy + Math.sin(mid) * (radius + 8),
      labelY: 0,
      color: point.other ? ROSE_OTHER_COLOR : COLORS[index % COLORS.length],
      tip: `${point.label}: ${formatExact(point.value)}（${formatPercent(percent)}）`,
      path: rosePetalPath(cx, cy, inner, outer, start, end),
    };
  });
  // 每一侧按理想高度排序，再以最小行距铺开，必要时整体上移，防止标签互相压住。
  const layoutSide = (side: 'left' | 'right') => {
    const items = petals.filter((petal) => petal.side === side).sort((a, b) => a.idealY - b.idealY);
    if (!items.length) return items;
    items[0].labelY = Math.max(items[0].idealY, labelTop);
    for (let index = 1; index < items.length; index++) {
      items[index].labelY = Math.max(items[index].idealY, items[index - 1].labelY + 22);
    }
    const overflow = items[items.length - 1].labelY - labelBottom;
    if (overflow > 0) {
      items[items.length - 1].labelY = labelBottom;
      for (let index = items.length - 2; index >= 0; index--) {
        items[index].labelY = Math.min(items[index].labelY, items[index + 1].labelY - 22);
      }
    }
    return items;
  };
  const labels = [...layoutSide('left'), ...layoutSide('right')];
  return (
    <div className="pie-row" style={{ height }}>
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={chart.title} data-testid="chart-svg" data-rose="true">
        {petals.map((petal, index) => (
          <path key={`petal-${index}`} className="rose-petal" d={petal.path} color={petal.color} fill={petal.color} fillOpacity={0.92} data-testid="chart-rose-petal" data-tip={petal.tip} />
        ))}
        <text x={cx} y={16} textAnchor="middle" className="chart-axis rose-title" data-tip={`总计: ${formatExact(total)}`}>
          总计 {formatCompactValue(total)}
        </text>
        <text x={cx} y={28} textAnchor="middle" className="chart-axis rose-label-value">
          {chart.yLabel}{chart.extraSeries?.length ? ' · 占比仅按此列' : ''}
        </text>
        {labels.map((petal, index) => {
          const [tipX, tipY] = at(petal.mid, petal.outer);
          const isRight = petal.side === 'right';
          const labelX = isRight ? rightX : leftX;
          const elbowX = isRight ? rightX - 10 : leftX + 10;
          const lineEndX = isRight ? labelX - 4 : labelX + 4;
          const lineY = petal.labelY + 2;
          const available = isRight ? width - labelX : labelX;
          const labelCap = Math.max(4, Math.floor((available - 2) / 8.5));
          const label = petal.point.label.length > labelCap ? `${petal.point.label.slice(0, labelCap)}…` : petal.point.label;
          return (
            <g key={`label-${index}`} data-tip={petal.tip} data-testid="chart-rose-label">
              <path
                d={`M ${tipX} ${tipY} L ${elbowX} ${lineY} L ${lineEndX} ${lineY}`}
                fill="none"
                stroke={petal.color}
                strokeWidth={0.8}
                strokeOpacity={0.5}
                data-testid="chart-rose-leader"
              />
              <text x={labelX} y={petal.labelY - 1} textAnchor={isRight ? 'start' : 'end'} className="chart-axis rose-label-name">
                {label}
              </text>
              <text x={labelX} y={petal.labelY + 9} textAnchor={isRight ? 'start' : 'end'} className="chart-axis rose-label-value">
                {formatCompactValue(petal.point.value)} · {formatPercent(petal.percent)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function SeriesLegend({ series }: { series: Array<{ name: string; color: string }> }) {
  return (
    <div className="chart-legend" data-testid="chart-series-legend">
      {series.map((entry) => (
        <span key={entry.name}>
          <i style={{ background: entry.color }} />
          {entry.name}
        </span>
      ))}
    </div>
  );
}

function ScatterBody({ chart, maxPoints, zoomed, svgRef, maxHeight, height: targetHeight }: { chart: ChartSpec; maxPoints: number; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number; height?: number }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const points = scatterOf(chart, maxPoints);
  if (!points.length) {
    return <div className="dash-empty" data-testid="chart-empty">没有可绘制的散点（x/y 需要同时为数值）。</div>;
  }
  const width = zoomed ? 720 : Math.max(260, Math.round(measured));
  const naturalHeight = Math.round(width * (zoomed ? 320 / 720 : 176 / 380));
  const height = zoomed
    ? 320
    : targetHeight !== undefined
      ? targetHeight
      : maxHeight !== undefined
        ? Math.max(140, Math.min(350, maxHeight))
        : Math.max(140, Math.min(chartHeightCap(), naturalHeight));
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
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="rgba(128,136,132,.32)" strokeWidth="1" />
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="rgba(128,136,132,.32)" strokeWidth="1" />
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
          <circle
            key={`${point.label ?? point.x}-${index}`}
            className="chart-dot"
            cx={sx(point.x)}
            cy={sy(point.y)}
            r={zoomed ? 3.6 : 3.2}
            color={COLORS[0]}
            fill={COLORS[0]}
            fillOpacity={0.88}
            data-tip={`${point.label ? `${point.label}\n` : ''}X: ${formatExact(point.x)}\nY: ${formatExact(point.y)}`}
          />
        ))}
      </g>
    </svg>
  );
}

type HeatTone = { fill: string; text: string };

const HEAT_PALETTE = {
  dark: { low: [20, 38, 35], mid: [45, 152, 141], high: [232, 183, 92] },
  light: { low: [226, 241, 237], mid: [137, 211, 202], high: [9, 108, 102] },
};

/** 顺序色阶：低值偏底色，中段青绿，高热偏暖金/深青；文字颜色按亮度自动反色。 */
function heatTone(ratio: number, dark: boolean): HeatTone {
  const palette = dark ? HEAT_PALETTE.dark : HEAT_PALETTE.light;
  const t = Math.max(0, Math.min(1, ratio));
  const [from, to, mix] = t <= 0.55 ? [palette.low, palette.mid, t / 0.55] : [palette.mid, palette.high, (t - 0.55) / 0.45];
  const rgb = from.map((value, index) => Math.round(value + (to[index] - value) * mix));
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return { fill: `rgb(${rgb.join(',')})`, text: luminance > 0.45 ? '#10201c' : '#f2fbf8' };
}

function HeatmapBody({ chart, zoomed, svgRef, maxHeight, height: targetHeight, dark }: { chart: ChartSpec; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number; height?: number; dark: boolean }) {
  const id = useStableId();
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const matrix = heatmapOf(chart);
  if (!matrix || !matrix.xLabels.length || !matrix.yLabels.length) {
    return <div className="dash-empty" data-testid="chart-empty">热力图需要一组行/列分类和一个数值度量。</div>;
  }
  const width = zoomed ? 720 : Math.max(300, Math.round(measured));
  const labelW = Math.min(112, Math.max(46, Math.max(...matrix.yLabels.map((label) => Math.min(12, label.length))) * 7.4 + 10));
  const pad = { left: labelW, right: 12, top: 26, bottom: 46 };
  const cellW = Math.max(10, (width - pad.left - pad.right) / matrix.xLabels.length);
  const rows = matrix.yLabels.length;
  // 固定高度时让单元格在绘图区内居中，行数少也不塌成一条窄带。
  const fixedHeight = zoomed ? 320 : targetHeight;
  const cap = fixedHeight ?? maxHeight ?? (zoomed ? 320 : 300);
  const cellH = fixedHeight
    ? Math.max(2, Math.min(46, (cap - pad.top - pad.bottom) / rows))
    : Math.max(13, Math.min(34, (cap - pad.top - pad.bottom) / rows));
  const contentH = cellH * rows;
  const offsetY = fixedHeight ? pad.top + Math.max(0, (fixedHeight - pad.top - pad.bottom - contentH) / 2) : pad.top;
  const height = Math.round(fixedHeight ?? (pad.top + pad.bottom + contentH));
  const flat = matrix.values.flat().filter((value) => Number.isFinite(value));
  const hi = Math.max(1, ...flat);
  const lo = Math.min(0, ...flat);
  const showValues = cellW >= 22 && cellH >= 16;
  const verticalLabels = cellW < 24;
  const rotateLabels = cellW < 48;
  const rotateAngle = verticalLabels ? -90 : -40;
  // 列很窄时改成竖排（-90°），每个分类都能读，不再抽稀成几个残缺标签。
  const labelChars = verticalLabels ? 4 : Math.max(2, Math.min(8, Math.floor(cellW / 8)));
  const labelEvery = verticalLabels ? 2 : 1;
  const lowTone = heatTone(0, dark);
  const midTone = heatTone(0.55, dark);
  const highTone = heatTone(1, dark);
  return (
    <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="chart-svg" role="img" aria-label={chart.title} data-testid="chart-svg" data-heatmap="true">
      <defs>
        <linearGradient id={`heat-${id}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={lowTone.fill} />
          <stop offset="55%" stopColor={midTone.fill} />
          <stop offset="100%" stopColor={highTone.fill} />
        </linearGradient>
      </defs>
      <rect x={width - 86} y={7} width={54} height={6} rx={3} fill={`url(#heat-${id})`} />
      <text x={width - 91} y={13} textAnchor="end" className="chart-axis" style={{ fontSize: 7.5 }}>低</text>
      <text x={width - 27} y={13} textAnchor="start" className="chart-axis" style={{ fontSize: 7.5 }}>高</text>
      {matrix.yLabels.map((label, row) => (
        <text key={`y-${label}`} x={pad.left - 6} y={offsetY + cellH * row + cellH / 2 + 3} textAnchor="end" className="chart-axis">
          {label.length > 12 ? `${label.slice(0, 12)}…` : label}
        </text>
      ))}
      {matrix.yLabels.map((yLabelOfRow, row) =>
        matrix.xLabels.map((xLabel, column) => {
          const value = matrix.values[row]?.[column];
          const numeric = Number.isFinite(value) ? value : 0;
          const ratio = (numeric - lo) / (hi - lo || 1);
          const tone = heatTone(ratio, dark);
          return (
            <g key={`${xLabel}-${yLabelOfRow}`}>
              <rect
                className="heat-cell"
                data-testid="chart-heatmap-cell"
                x={pad.left + column * cellW + 1}
                y={offsetY + row * cellH + 1}
                width={Math.max(1, cellW - 2)}
                height={Math.max(1, cellH - 2)}
                rx={3}
                color={tone.fill}
                fill={tone.fill}
                data-tip={`${xLabel} · ${yLabelOfRow}: ${formatExact(numeric)}${matrix.valueLabel ? `（${matrix.valueLabel}）` : ''}`}
              />
              {showValues ? (
                <text
                  x={pad.left + column * cellW + cellW / 2}
                  y={offsetY + row * cellH + cellH / 2 + 3}
                  textAnchor="middle"
                  className="heat-cell-value"
                  fontSize={cellW >= 30 ? 8.5 : 7.5}
                  fill={tone.text}
                >
                  {formatTick(numeric)}
                </text>
              ) : null}
            </g>
          );
        }),
      )}
      {matrix.xLabels.map((label, column) => {
        if (column % labelEvery !== 0) return null;
        const x = pad.left + column * cellW + cellW / 2;
        const y = height - (verticalLabels ? 8 : 10);
        return (
          <text
            key={`x-${label}`}
            x={x}
            y={y}
            textAnchor={rotateLabels ? 'end' : 'middle'}
            transform={rotateLabels ? `rotate(${rotateAngle} ${x} ${y})` : undefined}
            className="chart-axis chart-axis-label"
          >
            {label.length > labelChars ? `${label.slice(0, labelChars)}…` : label}
          </text>
        );
      })}
    </svg>
  );
}

function RadarBody({ chart, maxPoints, zoomed, svgRef, maxHeight, height: targetHeight }: { chart: ChartSpec; maxPoints: number; zoomed: boolean; svgRef: RefObject<SVGSVGElement>; maxHeight?: number; height?: number }) {
  const measured = useElementWidth(svgRef, zoomed ? 720 : 380);
  const history = chart.series.slice(0, maxPoints);
  if (history.length < 3) {
    return <div className="dash-empty" data-testid="chart-empty">雷达图至少需要 3 个类别轴。</div>;
  }
  const denseAxes = history.length > 12;
  const axisLabelChars = denseAxes ? 5 : 9;
  /** 日期型类别轴（2025-07）不截断，否则整圈标签全变成「2025-」。 */
  const radarLabel = (label: string) => {
    const limit = /^\d{4}[-/]\d{1,2}/.test(label) ? Math.max(axisLabelChars, label.length) : axisLabelChars;
    return label.length > limit ? `${label.slice(0, limit)}…` : label;
  };
  const extras = (chart.extraSeries ?? []).filter((extra) => extra.values.length >= history.length);
  const seriesList = [
    { name: chart.yLabel || '值', values: history.map((point) => point.value), color: COLORS[0] },
    ...extras.map((extra, index) => ({ name: extra.name, values: extra.values.slice(0, history.length), color: COLORS[(index + 1) % COLORS.length] })),
  ];
  const width = zoomed ? 720 : Math.max(280, Math.round(measured));
  const height = zoomed
    ? 320
    : targetHeight !== undefined
      ? targetHeight
      : maxHeight !== undefined
        ? Math.max(180, Math.min(350, maxHeight))
        : Math.max(180, Math.min(320, Math.round(width * 0.68)));
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
              <text x={labelX} y={labelY + 3} textAnchor={anchor} className="chart-axis chart-axis-label" style={denseAxes ? { fontSize: 8 } : undefined}>
                {radarLabel(point.label)}
              </text>
            </g>
          );
        })}
        {seriesList.map((entry) => (
          <g key={entry.name} className="chart-radar-shape" data-testid="chart-radar-shape">
            <polygon
              points={entry.values.map((value, index) => at(index, Math.max(0, Math.min(1, value / hi))).join(',')).join(' ')}
              color={entry.color}
              fill={entry.color}
              fillOpacity={0.14}
              stroke={entry.color}
              strokeWidth={2}
              strokeLinejoin="round"
            />
            {entry.values.map((value, index) => {
              const [x, y] = at(index, Math.max(0, Math.min(1, value / hi)));
              return (
                <circle
                  key={`${entry.name}-${index}`}
                  className="chart-dot"
                  cx={x}
                  cy={y}
                  r={2.4}
                  color={entry.color}
                  fill={entry.color}
                  data-tip={`${entry.name} · ${history[index].label}: ${formatExact(value)}`}
                />
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
  height?: number;
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

function AxisBody({ chart, type, maxPoints, zoomed, svgRef, maxHeight, height: targetHeight }: AxisBodyProps) {
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
  // Agent 面板给固定 300；QueryView 仍随宽度增长，封顶 400。
  const width = zoomed ? 720 : Math.max(260, Math.round(measured));
  const naturalHeight = Math.round(width * (zoomed ? 320 / 720 : 176 / 380));
  const height = zoomed
    ? 320
    : targetHeight !== undefined
      ? targetHeight
      : maxHeight !== undefined
        ? Math.max(140, Math.min(350, maxHeight))
        : Math.max(140, Math.min(chartHeightCap(), naturalHeight));
  const plotW = width - 42 - (dual ? 44 : 12);
  const denseLabels = all.length > 6 && plotW / all.length < 52;
  const pad = { left: 42, right: dual ? 44 : 12, top: 12, bottom: denseLabels ? 42 : 28 };
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

  const labelChars = denseLabels ? Math.max(3, Math.min(8, Math.floor(band / 7.5))) : 8;
  const projected = (labelChars + 1) * 9 * 0.72;
  const labelStep = denseLabels
    ? projected > band * 1.15 ? Math.ceil(projected / band) : 1
    : Math.max(1, Math.ceil(all.length / (zoomed ? 10 : 6)));
  /** 日期型轴标签（2025-07 / 2025-07-15）必须整段显示：截成「2025-」等于把趋势图横轴废掉。 */
  const labelLimit = (label: string) => (/^\d{4}[-/]\d{1,2}([-/]\d{1,2})?[日号]?$/.test(label) ? Math.max(labelChars, label.length) : labelChars);
  const tipAt = (label: string, index: number) =>
    `${label}\n${seriesList.map((entry) => `${entry.name}: ${formatExact(entry.values[index] ?? 0)}`).join('\n')}`;

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
          <stop offset="0%" stopColor="#45c8c3" stopOpacity="0.34" />
          <stop offset="100%" stopColor="#45c8c3" stopOpacity="0.01" />
        </linearGradient>
        <linearGradient id={`bar-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#55d8d2" stopOpacity="0.98" />
          <stop offset="100%" stopColor="#2d9791" stopOpacity="0.7" />
        </linearGradient>
      </defs>
      <line x1={pad.left} x2={pad.left} y1={pad.top} y2={height - pad.bottom} stroke="rgba(128,136,132,.32)" strokeWidth="1" />
      <line x1={pad.left} x2={width - pad.right} y1={height - pad.bottom} y2={height - pad.bottom} stroke="rgba(128,136,132,.32)" strokeWidth="1" />
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const gy = pad.top + innerH * ratio;
        return (
          <g key={ratio}>
            <line x1={pad.left} x2={width - pad.right} y1={gy} y2={gy} className="chart-grid" />
            <text x={pad.left - 5} y={gy + 3} textAnchor="end" className="chart-axis">
              {axisLabels(lo, span, seriesList.flatMap((entry) => entry.values))[Math.round(ratio * 4)]}
            </text>
          </g>
        );
      })}
      {lo < 0 ? <line x1={pad.left} x2={width - pad.right} y1={y(0)} y2={y(0)} className="chart-zero" /> : null}
      {isBar && (!multi || dual)
        ? history.map((point, index) => {
            const top = y(Math.max(point.value, 0));
            const bottom = y(Math.min(point.value, 0));
            // 单系列用统一的青绿渐变，避免每根柱一个颜色；多系列才按系列区分。
            const barWidth = Math.min(band * 0.6, 72);
            return (
              <rect
                key={`${point.label}-${index}`}
                className="chart-bar"
                x={pad.left + band * index + (band - barWidth) / 2}
                y={top}
                width={barWidth}
                height={Math.max(1, bottom - top)}
                rx={Math.min(4, barWidth / 2)}
                color="#55d8d2"
                fill={`url(#bar-${id})`}
                data-tip={`${point.label}: ${formatExact(point.value)}`}
              />
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
                  className="chart-bar"
                  x={pad.left + band * index + (band - groupWidth) / 2 + entryIndex * barWidth}
                  y={top}
                  width={Math.max(1, barWidth - 2)}
                  height={Math.max(1, bottom - top)}
                  rx={Math.min(3, barWidth / 2)}
                  color={entry.color}
                  fill={entry.color}
                  fillOpacity={0.9}
                  data-tip={`${entry.name} · ${point.label}: ${formatExact(value)}`}
                />
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
                  className="chart-bar"
                  x={pad.left + band * index + (band - barWidth) / 2}
                  y={top}
                  width={barWidth}
                  height={Math.max(1, bottom - top)}
                  rx={Math.min(3, barWidth / 2)}
                  color={entry.color}
                  fill={entry.color}
                  fillOpacity={0.9}
                  data-tip={`${entry.name} · ${point.label}: ${formatExact(value)}`}
                />
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
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))
            : linePath ? <path d={linePath} fill="none" stroke="#45c8c3" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /> : null}
          {forecastPath ? (
            <path d={forecastPath} fill="none" stroke="#e0af63" strokeWidth="2" strokeDasharray="4 3" data-testid="chart-forecast-line" />
          ) : null}
          {history.length <= 10
            ? seriesList.map((entry) =>
                history.map((point, index) => (
                  <circle
                    key={`${entry.name}-${point.label}-${index}`}
                    cx={cx(index)}
                    cy={y(entry.values[index] ?? 0)}
                    r="2.8"
                    fill={entry.color}
                    data-tip={tipAt(point.label, index)}
                  />
                )),
              )
            : null}
          {forecast.map((point, index) => (
            <circle
              key={`f-${point.label}-${index}`}
              className="chart-dot"
              cx={cx(history.length + index)}
              cy={y(point.value)}
              r="2.6"
              color="#F5C451"
              fill="#F5C451"
              data-tip={`${point.label}: ${formatExact(point.value)}\n区间 ${formatExact(point.lower)} ~ ${formatExact(point.upper)}`}
            />
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
      {type === 'line' || dual ? (
        <g data-testid="chart-hover-bands">
          {history.map((point, index) => (
            <g key={`band-${point.label}-${index}`} className="line-hover-col">
              <line className="line-hover-guide" x1={cx(index)} x2={cx(index)} y1={pad.top} y2={pad.top + innerH} />
              {seriesList.map((entry, entryIndex) => {
                const value = entry.values[index] ?? 0;
                return (
                  <circle
                    key={entry.name}
                    className="line-hover-dot"
                    cx={cx(index)}
                    cy={dual && entryIndex === 1 ? y2(value) : y(value)}
                    r={4.2}
                    color={entry.color}
                    fill="currentColor"
                  />
                );
              })}
              <rect
                x={cx(index) - band / 2}
                y={pad.top}
                width={Math.max(1, band)}
                height={innerH}
                fill="transparent"
                pointerEvents="all"
                data-tip={tipAt(point.label, index)}
              />
            </g>
          ))}
        </g>
      ) : null}
      {all.map((point, index) => {
        if (index % labelStep !== 0) return null;
        const x = cx(index);
        const y = height - (denseLabels ? 10 : 9);
        return (
          <text
            key={`l-${point.label}-${index}`}
            x={x}
            y={y}
            textAnchor={denseLabels ? 'end' : 'middle'}
            transform={denseLabels ? `rotate(-42 ${x} ${y})` : undefined}
            className="chart-axis chart-axis-label"
          >
            {point.label.length > labelLimit(point.label) ? `${point.label.slice(0, labelLimit(point.label))}…` : point.label}
          </text>
        );
      })}
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

/**
 * 纵轴标签：整数指标（单量、个数）在小跨度下不该出现 0.3 / 0.5 这种小数刻度。
 * 取整后重复的标签只保留第一次出现，避免出现 1 / 1 / 1 / 1。
 */
function axisLabels(lo: number, span: number, values: number[]): string[] {
  const integer = values.length > 0 && span > 0 && span <= 5 && values.every((value) => Number.isInteger(value));
  const labels: string[] = [];
  let previous = '';
  for (const ratio of [0, 0.25, 0.5, 0.75, 1]) {
    const raw = lo + span * (1 - ratio);
    const label = integer ? String(Math.round(raw)) : formatTick(raw);
    labels.push(label === previous ? '' : label);
    previous = label;
  }
  return labels;
}

function formatExact(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 0.1) return '<0.1%';
  return `${percent.toFixed(1)}%`;
}

/** 花瓣外侧标签用紧凑值，避免在窄卡片里压到相邻标签。 */
function formatCompactValue(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  if (abs >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
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
