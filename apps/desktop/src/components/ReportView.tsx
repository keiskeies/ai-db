import { useState } from 'react';
import type { ReactNode } from 'react';
import type { ReportBlock, ReportEvidence, ReportMetric, ReportSpec } from '@aidb/core';
import { deltaIsGood, describeEvidence, formatReportNumber, reportDensity } from '@aidb/core';
import { ChartView } from './ChartView';
import { t as tr } from '../i18n';

function metricValue(metric: ReportMetric): { text: string; exact?: string } {
  if (typeof metric.value === 'number') {
    const formatted = formatReportNumber(metric.value);
    return { text: formatted.text, exact: formatted.abbreviated ? formatted.exact : undefined };
  }
  return { text: String(metric.value) };
}

/** 证据入口：数字旁边给一个可点的标记，点开就是产生它的 SQL、行数与耗时。 */
function EvidenceTag({ evidence }: { evidence: ReportEvidence | undefined }) {
  if (!evidence) return null;
  return (
    <span
      className="mono"
      style={{ fontSize: 9, marginLeft: 4, cursor: 'help', opacity: 0.6 }}
      title={describeEvidence(evidence)}
    >
      SQL
    </span>
  );
}

/** 涨跌配色只看业务方向，不看符号：退款率上涨是坏事。 */
function toneColor(tone: 'good' | 'bad' | 'neutral'): string {
  return tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--danger)' : 'var(--text-muted)';
}

function DeltaChip({ metric }: { metric: ReportMetric }) {
  if (!metric.delta) return null;
  const color = toneColor(deltaIsGood(metric.delta.absolute, metric.goodDirection ?? 'up'));
  const percent = metric.delta.percent;
  return (
    <span className="mono" style={{ fontSize: 10, color, marginLeft: 6 }} title={metric.baselineLabel ?? tr("对比基线")}>
      {metric.delta.absolute > 0 ? '+' : ''}
      {metric.delta.absolute.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      {percent === null || percent === undefined ? '' : `（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`}
    </span>
  );
}

/**
 * 「先给密度合适的量，剩下的折叠起来」。
 * 管理层读到 4 个指标就该翻页，明细不是给他看的；但折叠必须是可展开的，
 * 不能像以前那样直接把内容裁掉——屏幕上看不见不等于报告里没有。
 */
function Expandable({ count, limit, label, children }: { count: number; limit: number; label: (hidden: number) => string; children: (visible: number) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const hidden = count - limit;
  if (hidden <= 0) return <>{children(count)}</>;
  return (
    <>
      {children(open ? count : limit)}
      <button
        type="button"
        className="btn ghost"
        style={{ marginTop: 6, fontSize: 10 }}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? tr("收起") : label(hidden)}
      </button>
    </>
  );
}

function MetricBlock({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  const density = reportDensity(spec.meta.audience);
  const metrics = block.metrics ?? [];
  return (
    <div style={{ marginTop: 6 }}>
      {block.title ? <div className="muted" style={{ fontSize: 9.5, letterSpacing: '0.4px', margin: '4px 0 6px' }}>{block.title}</div> : null}
      <Expandable count={metrics.length} limit={density.metrics} label={(hidden) => tr("再显示 {0} 项指标", [hidden])}>
        {(visible) => (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {metrics.slice(0, visible).map((metric, index) => {
              const value = metricValue(metric);
              const evidence = metric.resultRef ? spec.meta.evidence?.[metric.resultRef] : undefined;
              return (
                <div key={`${metric.label}-${index}`} className="panel" style={{ padding: '8px 12px', minWidth: 120 }}>
                  <div className="muted" style={{ fontSize: 10 }}>
                    {metric.label}
                    <EvidenceTag evidence={evidence} />
                  </div>
                  <div className="mono" style={{ fontSize: 18, marginTop: 2 }} title={value.exact}>
                    {value.text}
                    {metric.unit ? <span className="muted" style={{ fontSize: 10, marginLeft: 3 }}>{metric.unit}</span> : null}
                  </div>
                  {metric.delta ? (
                    <div style={{ fontSize: 10 }}>
                      <span className="muted">{metric.baselineLabel ?? tr("对比上期")}</span>
                      <DeltaChip metric={metric} />
                    </div>
                  ) : null}
                  {(metric.alternativeBaselines ?? []).map((item, altIndex) => {
                    // 补充基线与主值同口径读数：主值写「4.57 万」、这里写「32,100」，
                    // 等于逼读者心算单位换算。完整精度放在 title 里。
                    const alt = typeof item.value === 'number' ? formatReportNumber(item.value) : undefined;
                    const tone = item.delta ? deltaIsGood(item.delta.absolute, metric.goodDirection ?? 'up') : 'neutral';
                    return (
                      <div key={altIndex} className="muted" style={{ fontSize: 9.5, marginTop: 2 }}>
                        {item.label}
                        {alt ? <span title={alt.abbreviated ? alt.exact : undefined}> {alt.text}</span> : ''}
                        {item.delta ? (
                          <span className="mono" style={{ color: toneColor(tone) }}>
                            {` ${item.delta.absolute > 0 ? '+' : ''}${item.delta.absolute.toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
                            {item.delta.percent === null || item.delta.percent === undefined ? '' : `（${item.delta.percent > 0 ? '+' : ''}${item.delta.percent.toFixed(1)}%）`}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </Expandable>
    </div>
  );
}

function TableBlock({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  const measures = new Set(block.measureColumns ?? []);
  const density = reportDensity(spec.meta.audience);
  const rows = block.rows ?? [];
  const columns = block.columns ?? [];
  const [allRows, setAllRows] = useState(false);
  const visible = allRows ? rows.length : Math.min(rows.length, density.rows);
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      {block.title ? <div className="panel-head">{block.title}</div> : null}
      <div style={{ overflowX: 'auto' }}>
        <table className="tool-table">
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={`${column}-${index}`} style={measures.has(column) ? { textAlign: 'right' } : undefined}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, visible).map((row, index) => (
                  <tr key={index}>
                    {row.map((cell, cellIndex) => {
                      const column = columns[cellIndex];
                      const isMeasure = column ? measures.has(column) : false;
                      const numeric = typeof cell === 'number' || (isMeasure && cell !== null && cell !== '' && Number.isFinite(Number(cell)));
                      return (
                        <td
                          key={cellIndex}
                          className={numeric || cellIndex === 0 ? 'mono' : undefined}
                          style={isMeasure ? { textAlign: 'right' } : undefined}
                        >
                          {cell === null || cell === ''
                            ? '—'
                            : typeof cell === 'number' || numeric
                              ? Number(cell).toLocaleString(undefined, { maximumFractionDigits: 2 })
                              : cell}
                        </td>
                      );
                    })}
                  </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > visible ? (
        <button
          type="button"
          className="btn ghost"
          style={{ margin: 6, fontSize: 10 }}
          onClick={() => setAllRows(true)}
        >
          {tr("再显示 {0} 行", [rows.length - visible])}
        </button>
      ) : null}
    </div>
  );
}

function ActionsBlock({ block }: { block: ReportBlock }) {
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      {block.title ? <div className="panel-head">{block.title}</div> : null}
      <ol style={{ margin: '4px 0 0 18px', padding: 0, fontSize: 12, lineHeight: 1.7 }}>
        {(block.actions ?? []).map((action, index) => (
          <li key={index}>
            {action.text}
            {action.impact ? <span className="muted"> {tr(" · 预期影响：")}{action.impact}</span> : null}
            {action.owner || action.due ? (
              <span className="muted"> · {[action.owner, action.due].filter(Boolean).join(' / ')}</span>
            ) : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Block({ block, spec }: { block: ReportBlock; spec: ReportSpec }) {
  if (block.kind === 'narrative') {
    return <p style={{ margin: '6px 0', fontSize: 12, lineHeight: 1.6 }}>{block.text}</p>;
  }
  if (block.kind === 'metric') return <MetricBlock block={block} spec={spec} />;
  if (block.kind === 'table') return <TableBlock block={block} spec={spec} />;
  if (block.kind === 'actions') return <ActionsBlock block={block} />;
  if (block.kind === 'chart') {
    const hasBaseline = (block.series ?? []).some((point) => typeof point.baseline === 'number');
    const evidence = block.resultRef ? spec.meta.evidence?.[block.resultRef] : undefined;
    return (
      <div style={{ marginTop: 8 }}>
        {evidence ? (
          <div className="muted" style={{ fontSize: 9 }}>
            <EvidenceTag evidence={evidence} />
          </div>
        ) : null}
        <ChartView
          chart={{
            type: block.chartType ?? 'bar',
            title: block.title ?? '',
            xLabel: '',
            yLabel: '',
            series: (block.series ?? []).map((point) => ({ label: point.label, value: point.value })),
            ...(hasBaseline
              ? {
                  extraSeries: [
                    { name: block.baselineName ?? tr("上期"), values: (block.series ?? []).map((point) => point.baseline ?? 0) },
                  ],
                }
              : {}),
          }}
          maxHeight={220}
        />
      </div>
    );
  }
  if (block.kind === 'comparison') {
    const left = Number(block.left?.value ?? 0);
    const right = Number(block.right?.value ?? 0);
    const tone = block.delta ? deltaIsGood(block.delta.absolute, block.goodDirection ?? 'neutral') : 'neutral';
    const color = tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--danger)' : 'var(--text-muted)';
    return (
      <div className="panel" style={{ padding: 10, marginTop: 8 }}>
        <div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>{block.title ?? tr("对比")}</div>
        <div className="row" style={{ gap: 18, alignItems: 'flex-end' }}>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>{block.left?.label}</div>
            <div className="mono" style={{ fontSize: 18 }}>{left.toLocaleString()}{block.left?.unit ?? ''}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>{block.right?.label}</div>
            <div className="mono" style={{ fontSize: 18 }}>{right.toLocaleString()}{block.right?.unit ?? ''}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>{tr("差值")}</div>
            <div className="mono" style={{ fontSize: 18, color }}>
              {block.delta ? `${block.delta.absolute > 0 ? '+' : ''}${block.delta.absolute.toLocaleString()}` : '—'}
              {block.delta?.percent !== null && block.delta?.percent !== undefined ? ` (${block.delta.percent > 0 ? '+' : ''}${block.delta.percent.toFixed(1)}%)` : ''}
            </div>
          </div>
        </div>
      </div>
    );
  }
  if (block.kind === 'callout') {
    return (
      <div className="risk-banner" style={{ marginTop: 8, borderColor: block.tone === 'danger' ? 'var(--danger)' : block.tone === 'warning' ? 'var(--warning, var(--danger))' : undefined }}>
        {block.text}
      </div>
    );
  }
  return null;
}

export function ReportView({ spec }: { spec: ReportSpec }) {
  const period = spec.meta.period;
  const density = reportDensity(spec.meta.audience);
  const [showAllSections, setShowAllSections] = useState(false);
  const sections = spec.sections.filter((section) => section.blocks.length > 0);
  const hiddenSections = Math.max(0, sections.length - density.sections);
  const visibleSections = showAllSections ? sections : sections.slice(0, density.sections);
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{spec.title}</div>
        <div className="muted" style={{ fontSize: 10 }}>
          {spec.sources.map((source) => `${source.label} · ${source.engine}`).join(' / ')}
          {period ? ` · ${period.label ?? `${period.from} ~ ${period.to}`}` : ''} · {new Date(spec.meta.createdAt).toLocaleString()} · {spec.layout}
        </div>
      </div>
      {spec.meta.degraded ? (
        <div className="risk-banner" style={{ marginBottom: 8, borderColor: 'var(--danger)' }}>
          {tr("本报告为降级产物：")}
          {spec.meta.degraded}
        </div>
      ) : null}
      {spec.executive ? (
        <div className="panel" style={{ padding: 12, marginBottom: 8, borderColor: 'var(--accent, #45c8c3)' }}>
          <div className="muted" style={{ fontSize: 9, letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: 4 }}>{tr("管理层摘要")}</div>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{spec.executive.headline}</div>
          {spec.executive.takeaways.length ? (
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12, lineHeight: 1.7 }}>
              {spec.executive.takeaways.map((takeaway, index) => <li key={index}>{takeaway}</li>)}
            </ul>
          ) : null}
          {(spec.executive.risks ?? []).map((risk, index) => (
            <div key={index} className="muted" style={{ fontSize: 11, color: 'var(--warning, var(--danger))', marginTop: 6 }}>{risk}</div>
          ))}
        </div>
      ) : null}
      {visibleSections.map((section) => (
        <div key={section.id} className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>{section.title}</div>
          {section.conclusion ? (
            <div style={{ fontSize: 12, fontWeight: 600, margin: '2px 0 8px' }}>{section.conclusion}</div>
          ) : null}
          {section.blocks.map((block, index) => (
            <div key={index}>
              <Block block={block} spec={spec} />
              {block.note ? (
                <div className="muted" style={{ fontSize: 9, marginTop: 2 }}>{block.note}</div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {hiddenSections > 0 ? (
        <button type="button" className="btn ghost" style={{ marginBottom: 8, fontSize: 10 }} onClick={() => setShowAllSections((value) => !value)}>
          {showAllSections ? tr("收起") : tr("再显示 {0} 个章节", [hiddenSections])}
        </button>
      ) : null}
      {spec.meta.assumptions?.length ? (
        <div className="muted" style={{ fontSize: 9, marginBottom: 4 }}>
          {spec.meta.assumptions.map((line, index) => <div key={index}>{tr("口径：")}{line}</div>)}
        </div>
      ) : null}
      {spec.meta.qualityNotes?.length ? (
        <div className="muted" style={{ fontSize: 9, marginBottom: 4 }}>
          <div style={{ marginBottom: 2 }}>{tr("质量提示：")}</div>
          {spec.meta.qualityNotes.map((note, index) => <div key={index}>· {note}</div>)}
        </div>
      ) : null}
      {spec.meta.notes?.length ? (
        <div className="muted" style={{ fontSize: 9, opacity: 0.75 }}>
          {spec.meta.notes.map((note, index) => <div key={index}>{note}</div>)}
        </div>
      ) : null}
    </div>
  );
}
