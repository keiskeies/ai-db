import { useState } from 'react';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import type { ReportAnalysis, ReportBlock, ReportEvidence, ReportMetric, ReportSpec } from '@aidb/core';
import { deltaIsGood, describeEvidence, formatReportNumber, reportCopy, reportDensity } from '@aidb/core';
import { colors } from '../theme';
import { translate } from '../i18n';
import { styles } from '../styles';
import { Text } from './base';
import { MobileChart } from './chart/MobileChart';

const MODE_LABELS: Record<NonNullable<ReportSpec['meta']['brief']>['mode'], () => string> = {
  overview: () => translate('经营概览'),
  diagnosis: () => translate('问题诊断'),
  target: () => translate('目标差距'),
  opportunity: () => translate('增长机会'),
  comparison: () => translate('同口径对比'),
  technical: () => translate('数据质量'),
};

const ANALYSIS_LABELS: Record<ReportAnalysis, () => string> = {
  metrics: () => translate('核心指标'),
  trend: () => translate('趋势'),
  composition: () => translate('结构'),
  comparison: () => translate('对比'),
  attribution: () => translate('归因'),
  anomaly: () => translate('异常'),
  target: () => translate('目标'),
  forecast: () => translate('预测'),
  detail: () => translate('明细'),
  actions: () => translate('行动'),
};

const AUDIENCE_LABELS: Record<string, () => string> = {
  executive: () => translate('管理层'),
  business: () => translate('业务读者'),
  technical: () => translate('技术读者'),
};

function localeOf(spec: ReportSpec): 'zh' | 'en' {
  return spec.meta.locale === 'en' ? 'en' : 'zh';
}

function toneColor(tone: 'good' | 'bad' | 'neutral'): string {
  return tone === 'good' ? colors.success : tone === 'bad' ? colors.danger : colors.muted;
}

function EvidenceTag({ evidence, locale }: { evidence: ReportEvidence | undefined; locale: 'zh' | 'en' }) {
  const [open, setOpen] = useState(false);
  if (!evidence) return null;
  return (
    <View style={styles.reportEvidence}>
      <Pressable accessibilityLabel={translate('查看 SQL 证据')} onPress={() => setOpen((value) => !value)}>
        <Text style={styles.reportEvidenceTag}>{open ? '−' : '+'} SQL</Text>
      </Pressable>
      {open ? <Text selectable style={styles.reportEvidenceText}>{describeEvidence(evidence, reportCopy(locale))}</Text> : null}
    </View>
  );
}

function Delta({ metric, locale }: { metric: ReportMetric; locale: 'zh' | 'en' }) {
  if (!metric.delta) return null;
  const tone = deltaIsGood(metric.delta.absolute, metric.goodDirection ?? 'up');
  const percent = metric.delta.percent;
  return (
    <Text style={[styles.reportMetricDelta, { color: toneColor(tone) }]}>
      {metric.delta.absolute > 0 ? '+' : ''}{metric.delta.absolute.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 })}
      {percent === null || percent === undefined ? '' : `（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`}
    </Text>
  );
}

function Expandable({ count, limit, label, children }: { count: number; limit: number; label: (hidden: number) => string; children: (visible: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const hidden = count - limit;
  if (hidden <= 0) return <>{children(count)}</>;
  return (
    <View style={styles.reportExpandable}>
      {children(open ? count : limit)}
      <Pressable accessibilityRole="button" onPress={() => setOpen((value) => !value)} style={styles.reportMoreButton}>
        <Text style={styles.reportMoreText}>{open ? translate('收起') : label(hidden)}</Text>
      </Pressable>
    </View>
  );
}

function MetricBlock({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  const density = reportDensity(spec.meta.audience);
  const locale = localeOf(spec);
  const metrics = block.metrics ?? [];
  return (
    <View style={styles.reportBlock}>
      {block.title ? <Text style={styles.reportBlockLabel}>{block.title}</Text> : null}
      <Expandable count={metrics.length} limit={density.metrics} label={(hidden) => translate('再显示 {0} 项指标', [hidden])}>
        {(visible) => (
          <View style={styles.reportMetricsRow}>
            {metrics.slice(0, visible).map((metric, index) => {
              const formatted = typeof metric.value === 'number' ? formatReportNumber(metric.value, locale) : undefined;
              const evidence = metric.resultRef ? spec.meta.evidence?.[metric.resultRef] : undefined;
              return (
                <View key={`${metric.label}-${index}`} style={styles.reportMetric}>
                  <View style={styles.reportMetricLabelRow}>
                    <Text style={styles.reportMetricLabel} numberOfLines={2}>{metric.label}</Text>
                    <EvidenceTag evidence={evidence} locale={locale} />
                  </View>
                  <Text accessibilityLabel={formatted?.exact} style={styles.reportMetricValue} numberOfLines={1}>
                    {formatted?.text ?? String(metric.value)}{metric.unit ? <Text style={styles.reportMetricUnit}> {metric.unit}</Text> : null}
                  </Text>
                  {formatted?.abbreviated ? <Text style={styles.reportMetricExact}>{formatted.exact}</Text> : null}
                  {metric.delta || typeof metric.baseline === 'number' ? (
                    <View style={styles.reportMetricBaselineRow}>
                      <Text style={styles.reportMetricBaseline} numberOfLines={1}>{metric.baselineLabel ?? translate('对比上期')}</Text>
                      {typeof metric.baseline === 'number' ? <Text style={styles.reportMetricBaselineValue}> {formatReportNumber(metric.baseline, locale).text}</Text> : null}
                      <Delta metric={metric} locale={locale} />
                    </View>
                  ) : null}
                  {(metric.alternativeBaselines ?? []).map((item, altIndex) => {
                    const value = typeof item.value === 'number' ? formatReportNumber(item.value, locale) : undefined;
                    const tone = item.delta ? deltaIsGood(item.delta.absolute, metric.goodDirection ?? 'up') : 'neutral';
                    return (
                      <View key={altIndex} style={styles.reportMetricAlternative}>
                        <Text style={styles.reportMetricBaseline} numberOfLines={1}>{item.label}{value ? ` ${value.text}` : ''}</Text>
                        {item.delta ? <Text style={[styles.reportMetricDelta, { color: toneColor(tone) }]}> {item.delta.absolute > 0 ? '+' : ''}{item.delta.absolute.toLocaleString(locale === 'en' ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 })}</Text> : null}
                      </View>
                    );
                  })}
                </View>
              );
            })}
          </View>
        )}
      </Expandable>
    </View>
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return String(value);
}

function TableBlock({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  const density = reportDensity(spec.meta.audience);
  const columns = block.columns ?? [];
  const rows = block.rows ?? [];
  const measures = new Set(block.measureColumns ?? []);
  const [allRows, setAllRows] = useState(false);
  const visible = allRows ? rows.length : Math.min(rows.length, density.rows);
  const widthOf = (value: unknown, index: number) => Math.min(180, Math.max(88, cellText(value).length * 11 + (index === 0 ? 18 : 28)));
  return (
    <View style={styles.reportBlock}>
      {block.title ? <Text style={styles.reportBlockLabel}>{block.title}</Text> : null}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reportTableContent}>
        <View style={styles.reportTable}>
          <View style={[styles.reportTableRow, styles.reportTableHead]}>
            {columns.map((column, index) => <Text key={`${column}-${index}`} style={[styles.reportTableCell, { width: widthOf(column, index), textAlign: measures.has(column) ? 'right' : 'left' }]}>{column}</Text>)}
          </View>
          {rows.slice(0, visible).map((row, rowIndex) => (
            <View key={rowIndex} style={styles.reportTableRow}>
              {row.map((cell, cellIndex) => {
                const column = columns[cellIndex];
                const numeric = typeof cell === 'number' || Boolean(column && measures.has(column) && cell !== null && cell !== '' && Number.isFinite(Number(cell)));
                return <Text key={cellIndex} style={[styles.reportTableCell, { width: widthOf(cell, cellIndex), textAlign: column && measures.has(column) ? 'right' : 'left' }, numeric && styles.reportTableCellNumeric]}>{cellText(cell)}</Text>;
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      {rows.length > visible ? (
        <Pressable accessibilityRole="button" style={styles.reportMoreButton} onPress={() => setAllRows(true)}>
          <Text style={styles.reportMoreText}>{translate('再显示 {0} 行', [rows.length - visible])}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function ChartBlock({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  const evidence = block.resultRef ? spec.meta.evidence?.[block.resultRef] : undefined;
  return (
    <View style={styles.reportBlock}>
      <EvidenceTag evidence={evidence} locale={localeOf(spec)} />
      <MobileChart
        allowTypeSwitch={false}
        chart={{
          type: block.chartType ?? 'bar',
          title: block.title ?? '',
          xLabel: block.xLabel ?? '',
          yLabel: block.yLabel ?? '',
          baselineName: block.baselineName,
          series: (block.series ?? []).map((point) => ({ ...point })),
          extraSeries: block.extraSeries,
          stacked: block.stacked || block.chartType === 'stacked',
          dualAxis: block.dualAxis,
          scatter: block.scatter,
          heatmap: block.heatmap,
          note: block.note,
        }}
      />
    </View>
  );
}

function ComparisonBlock({ block }: { block: ReportBlock }) {
  const tone = block.delta ? deltaIsGood(block.delta.absolute, block.goodDirection ?? 'neutral') : 'neutral';
  return (
    <View style={[styles.reportBlock, styles.reportComparison]}>
      <Text style={styles.reportBlockLabel}>{block.title ?? translate('对比')}</Text>
      <View style={styles.reportComparisonRow}>
        {[block.left, block.right].map((side, index) => (
          <View key={index} style={styles.reportComparisonSide}>
            <Text style={styles.reportMetricLabel}>{side?.label}</Text>
            <Text style={styles.reportComparisonValue}>{formatReportNumber(Number(side?.value ?? 0)).text}{side?.unit ?? ''}</Text>
          </View>
        ))}
      </View>
      <Text style={styles.reportMetricLabel}>{translate('差值')}</Text>
      <Text style={[styles.reportComparisonValue, { color: toneColor(tone) }]}>
        {block.delta ? `${block.delta.absolute > 0 ? '+' : ''}${block.delta.absolute.toLocaleString()}` : '—'}
        {block.delta?.percent === null || block.delta?.percent === undefined ? '' : ` (${block.delta.percent > 0 ? '+' : ''}${block.delta.percent.toFixed(1)}%)`}
      </Text>
    </View>
  );
}

function ActionsBlock({ block }: { block: ReportBlock }) {
  return (
    <View style={[styles.reportBlock, styles.reportActions]}>
      {block.title ? <Text style={styles.reportBlockLabel}>{block.title}</Text> : null}
      {(block.actions ?? []).map((action, index) => (
        <View key={index} style={styles.reportAction}>
          <Text style={styles.reportActionIndex}>{index + 1}</Text>
          <View style={styles.reportActionBody}>
            <Text style={styles.reportActionText}>{action.text}</Text>
            {action.impact ? <Text style={styles.reportMetricBaseline}>{translate('预期影响：')}{action.impact}</Text> : null}
            {action.owner || action.due ? <Text style={styles.reportMetricBaseline}>{[action.owner, action.due].filter(Boolean).join(' / ')}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function ReportBlockView({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  if (block.kind === 'narrative') return <Text style={styles.reportNarrative}>{block.text}</Text>;
  if (block.kind === 'metric') return <MetricBlock block={block} spec={spec} />;
  if (block.kind === 'table') return <TableBlock block={block} spec={spec} />;
  if (block.kind === 'chart') return <ChartBlock block={block} spec={spec} />;
  if (block.kind === 'comparison') return <ComparisonBlock block={block} />;
  if (block.kind === 'actions') return <ActionsBlock block={block} />;
  if (block.kind === 'callout') {
    return (
      <View style={[styles.reportBlock, styles.reportCallout, block.tone === 'danger' && { borderColor: colors.danger }, block.tone === 'warning' && { borderColor: colors.warning }]}>
        <Text style={styles.reportCalloutText}>{block.text}</Text>
      </View>
    );
  }
  return null;
}

function BriefDisclosure({ spec }: { spec: ReportSpec }) {
  const [open, setOpen] = useState(false);
  const brief = spec.meta.brief;
  if (!brief) return null;
  return (
    <View style={styles.reportBrief}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen((value) => !value)} style={styles.reportDisclosure}>
        <Text style={styles.reportDisclosureText}>{translate('分析与计划')}</Text>
        <Text style={styles.reportDisclosureHint}>{MODE_LABELS[brief.mode]()} · {brief.analyses.length} {translate('项分析')}</Text>
        <Text style={styles.reportDisclosureArrow}>{open ? '−' : '+'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.reportBriefBody} testID="m-report-brief">
          <Text style={styles.reportBriefObjective}>{brief.objective}</Text>
          {brief.questions.length ? (
            <View style={styles.reportBriefList}>
              {brief.questions.map((question, index) => <Text key={index} style={styles.reportBriefLine}>· {question}</Text>)}
            </View>
          ) : null}
          <Text style={styles.reportBriefMeta}>
            {translate('阅读对象')}：{AUDIENCE_LABELS[brief.audience]?.() ?? brief.audience} · {translate('指标')} {brief.coverage.minMetrics}–{brief.coverage.maxMetrics} · {translate('图表')} {brief.coverage.minCharts}–{brief.coverage.maxCharts}
          </Text>
          <View style={styles.reportAnalysisChips}>
            {brief.analyses.map((analysis) => <Text key={analysis} style={styles.reportAnalysisChip}>{ANALYSIS_LABELS[analysis]()}</Text>)}
          </View>
          {brief.grounding.tables.length ? (
            <Text style={styles.reportBriefMeta}>{translate('候选对象')}：{brief.grounding.tables.map((table) => `${table.database ? `${table.database}.` : ''}${table.name}`).join('、')}</Text>
          ) : null}
          <View style={styles.reportPlan}>
            {brief.plan.map((step, index) => (
              <View key={step.id} style={styles.reportPlanStep}>
                <Text style={styles.reportPlanTitle}>{index + 1}. {step.title}</Text>
                <Text style={styles.reportBriefLine}>{step.deliverable}</Text>
                {step.tables.length ? <Text style={styles.reportBriefMeta}>{translate('表')}：{step.tables.join('、')}</Text> : null}
                {step.columns.length ? <Text style={styles.reportBriefMeta}>{translate('字段')}：{step.columns.join('、')}</Text> : null}
              </View>
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
}

export function ReportView({ spec, error }: { spec: ReportSpec; error?: string }) {
  const density = reportDensity(spec.meta.audience);
  const [showAllSections, setShowAllSections] = useState(false);
  const sections = spec.sections.filter((section) => section.blocks.length > 0);
  const visibleSections = showAllSections ? sections : sections.slice(0, density.sections);
  const hiddenSections = Math.max(0, sections.length - density.sections);
  const period = spec.meta.period;
  return (
    <View testID="m-report-view" style={styles.reportView}>
      <View style={styles.reportHeader}>
        <Text style={styles.reportTitle}>{spec.title}</Text>
        <Text style={styles.reportMeta}>
          {[spec.sources.map((source) => `${source.label} · ${source.engine}`).join(' / '), period?.label ?? (period ? `${period.from} ~ ${period.to}` : ''), new Date(spec.meta.createdAt).toLocaleString(), AUDIENCE_LABELS[spec.meta.audience ?? 'business']?.()].filter(Boolean).join(' · ')}
        </Text>
      </View>
      <BriefDisclosure spec={spec} />
      {error ? <Text style={styles.reportError}>{error}</Text> : null}
      {spec.meta.degraded ? (
        <View style={[styles.reportCallout, styles.reportErrorBox]}>
          <Text style={styles.reportError}>{translate('本报告为降级产物：')}{spec.meta.degraded}</Text>
        </View>
      ) : null}
      {spec.executive ? (
        <View style={styles.reportExecutive}>
          <Text style={styles.reportBlockLabel}>{translate('管理层摘要')}</Text>
          <Text style={styles.reportExecutiveHeadline}>{spec.executive.headline}</Text>
          {spec.executive.takeaways.length ? (
            <View style={styles.reportBriefList}>
              {spec.executive.takeaways.map((takeaway, index) => <Text key={index} style={styles.reportExecutiveLine}>· {takeaway}</Text>)}
            </View>
          ) : null}
          {(spec.executive.risks ?? []).map((risk, index) => <Text key={index} style={styles.reportRisk}>{risk}</Text>)}
        </View>
      ) : null}
      {visibleSections.map((section, index) => (
        <View key={section.id} style={styles.reportSection}>
          <View style={styles.reportSectionHead}>
            <Text style={styles.reportSectionIndex}>{String(index + 1).padStart(2, '0')}</Text>
            <Text style={styles.reportSectionTitle}>{section.title}</Text>
          </View>
          {section.conclusion ? <Text style={styles.reportConclusion}>{section.conclusion}</Text> : null}
          {section.blocks.map((block, blockIndex) => (
            <View key={blockIndex}>
              <ReportBlockView block={block} spec={spec} />
              {block.note && block.kind !== 'chart' ? <Text style={styles.reportNote}>{block.note}</Text> : null}
            </View>
          ))}
        </View>
      ))}
      {hiddenSections > 0 ? (
        <Pressable accessibilityRole="button" style={styles.reportMoreButton} onPress={() => setShowAllSections((value) => !value)}>
          <Text style={styles.reportMoreText}>{showAllSections ? translate('收起') : translate('再显示 {0} 个章节', [hiddenSections])}</Text>
        </Pressable>
      ) : null}
      {spec.meta.qualityNotes?.length ? (
        <View style={styles.reportNotes}>
          <Text style={styles.reportBlockLabel}>{translate('质量提示')}</Text>
          {spec.meta.qualityNotes.map((note, index) => <Text key={index} style={styles.reportNote}>· {note}</Text>)}
        </View>
      ) : null}
      {spec.meta.assumptions?.length ? (
        <View style={styles.reportNotes}>
          {spec.meta.assumptions.map((line, index) => <Text key={index} style={styles.reportNote}>{translate('口径：')}{line}</Text>)}
        </View>
      ) : null}
      {spec.meta.notes?.length ? (
        <View style={styles.reportNotes}>
          {spec.meta.notes.map((note, index) => <Text key={index} style={styles.reportNote}>{note}</Text>)}
        </View>
      ) : null}
    </View>
  );
}
