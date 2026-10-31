import { BarChart3, Download, Grid3x3, Layers, LineChart, Maximize2, PieChart, Radar, ScatterChart } from 'lucide-react';
import { CopyButton } from './ui';

/**
 * 只包含图形类型：明细/表格是 AgentPanel 与 QueryView 自己的结果 tab，
 * 工具条里再放一个「明细」就是同一功能的第二个入口。
 */
export type ChartType = 'bar' | 'stacked' | 'line' | 'pie' | 'scatter' | 'heatmap' | 'radar';

const TYPES: Array<{ value: ChartType; label: string; icon: typeof BarChart3 }> = [
  { value: 'bar', label: '柱状图', icon: BarChart3 },
  { value: 'stacked', label: '堆叠柱状图', icon: Layers },
  { value: 'line', label: '折线图', icon: LineChart },
  { value: 'pie', label: '饼图', icon: PieChart },
  { value: 'scatter', label: '散点图', icon: ScatterChart },
  { value: 'heatmap', label: '热力图', icon: Grid3x3 },
  { value: 'radar', label: '雷达图', icon: Radar },
];

export interface ChartToolbarProps {
  type: ChartType;
  onType: (type: ChartType) => void;
  /** 传了才渲染 X/Y 下拉：Agent 侧的结果集列名由 Bridge 决定，不需要用户再选 */
  columns?: string[];
  x?: string;
  y?: string;
  onX?: (value: string) => void;
  onY?: (value: string) => void;
  /** 有 SQL 才显示复制与导出 CSV */
  sql?: string;
  onExportCsv?: () => void;
  onExportPng?: () => void;
  onZoom?: () => void;
  exporting?: boolean;
  /** AI 图表的数据适配结果；不适配的类型禁用并在 title 里说明原因 */
  suitability?: Partial<Record<ChartType, { ok: boolean; reason?: string }>>;
}

/**
 * 图表工具条：QueryView 与 Agent 的图表卡共用同一套入口。
 * 类型 / X / Y 三个下拉原本只存在于 QueryView，这里把它们吸收进来，避免出现两个功能相同的控件。
 */
export function ChartToolbar({ type, onType, columns, x, y, onX, onY, sql, onExportCsv, onExportPng, onZoom, exporting, suitability }: ChartToolbarProps) {
  const showAxes = Boolean(columns?.length && onX && onY);
  return (
    <div className="chart-toolbar" data-testid="chart-toolbar">
      <div className="chart-types" role="group" aria-label="图表类型">
        {TYPES.map((item) => {
          const fit = suitability?.[item.value];
          // 当前正在显示的类型即使被判为不适配也保持可点，避免出现一个禁用的 active 按钮
          const blocked = fit?.ok === false && item.value !== type;
          return (
            <button
              key={item.value}
              type="button"
              className={`chart-type${type === item.value ? ' active' : ''}${blocked ? ' unsuitable' : ''}`}
              title={blocked ? `${item.label}：${fit.reason ?? '当前数据不适合'}` : item.label}
              aria-pressed={type === item.value}
              aria-disabled={blocked || undefined}
              disabled={blocked}
              data-testid={`chart-type-${item.value}`}
              onClick={() => onType(item.value)}
            >
              <item.icon size={12} />
            </button>
          );
        })}
      </div>

      {showAxes ? (
        <>
          <label className="chart-axis-pick">
            <span>X</span>
            <select className="select" value={x ?? ''} onChange={(e) => onX?.(e.target.value)} data-testid="chart-x">
              <option value="">自动</option>
              {columns!.map((column) => <option key={column} value={column}>{column}</option>)}
            </select>
          </label>
          <label className="chart-axis-pick">
            <span>Y</span>
            <select className="select" value={y ?? ''} onChange={(e) => onY?.(e.target.value)} data-testid="chart-y">
              <option value="">自动</option>
              {columns!.map((column) => <option key={column} value={column}>{column}</option>)}
            </select>
          </label>
        </>
      ) : null}

      <div className="spacer" />

      {sql ? <CopyButton text={sql} /> : null}
      {onExportCsv && sql ? (
        <button type="button" className="icon-btn" title="导出 CSV" data-testid="chart-export-csv" onClick={onExportCsv}>
          <Download size={12} />
        </button>
      ) : null}
      {onExportPng ? (
        <button type="button" className="icon-btn" title="导出 PNG" data-testid="chart-export-png" disabled={exporting} onClick={onExportPng}>
          <Download size={12} />
        </button>
      ) : null}
      {onZoom ? (
        <button type="button" className="icon-btn" title="放大" data-testid="chart-zoom" onClick={onZoom}>
          <Maximize2 size={12} />
        </button>
      ) : null}
    </div>
  );
}
