export type ReportLayout = 'sections' | 'comparison' | 'merged' | 'mixed';

export interface ReportSourceRef {
  key: string;
  connectionId: string;
  connectionName: string;
  database?: string;
  engine: string;
  label: string;
}

export interface ReportMetric {
  label: string;
  value: number | string;
  unit?: string;
  source?: string;
  /** 产生该数字的工具调用 id；compose_report 用它做来源校验。 */
  resultRef?: string;
}

export interface ReportChartSeries {
  label: string;
  value: number;
}

export interface ReportBlock {
  kind: 'narrative' | 'metric' | 'table' | 'chart' | 'comparison' | 'callout';
  title?: string;
  /** 该数据块绑定的工具调用 id；compose_report 用它做来源校验。 */
  resultRef?: string;
  text?: string;
  tone?: 'info' | 'warning' | 'danger';
  metrics?: ReportMetric[];
  columns?: string[];
  rows?: Array<Array<string | number | null>>;
  chartType?: 'bar' | 'line' | 'pie';
  series?: ReportChartSeries[];
  left?: ReportMetric;
  right?: ReportMetric;
  delta?: { absolute: number; percent: number | null };
  note?: string;
}

export interface ReportSection {
  id: string;
  title: string;
  sourceKey?: string;
  blocks: ReportBlock[];
}

export interface ReportSpec {
  version: 1;
  title: string;
  layout: ReportLayout;
  sources: ReportSourceRef[];
  sections: ReportSection[];
  meta: {
    intent: string;
    createdAt: string;
    notes?: string[];
  };
}
