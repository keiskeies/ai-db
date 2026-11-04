import type { ReportBlock, ReportMetric, ReportSpec } from '@aidb/core';
import { deltaIsGood, formatReportNumber } from '@aidb/core';
import { ChartView } from './ChartView';
import { t as tr } from '../i18n';

function metricValue(metric: ReportMetric): { text: string; exact?: string } {
  if (typeof metric.value === 'number') {
    const formatted = formatReportNumber(metric.value);
    return { text: formatted.text, exact: formatted.abbreviated ? formatted.exact : undefined };
  }
  return { text: String(metric.value) };
}

function DeltaChip({ metric }: { metric: ReportMetric }) {
  if (!metric.delta) return null;
  const tone = deltaIsGood(metric.delta.absolute, metric.goodDirection ?? 'up');
  const color = tone === 'good' ? 'var(--success)' : tone === 'bad' ? 'var(--danger)' : 'var(--text-muted)';
  const percent = metric.delta.percent;
  return (
    <span className="mono" style={{ fontSize: 10, color, marginLeft: 6 }} title={metric.baselineLabel ?? tr("对比基线")}>
      {metric.delta.absolute > 0 ? '+' : ''}
      {metric.delta.absolute.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      {percent === null || percent === undefined ? '' : `（${percent > 0 ? '+' : ''}${percent.toFixed(1)}%）`}
    </span>
  );
}

function MetricBlock({ block }: { block: ReportBlock }) {
  return (
    <div style={{ marginTop: 6 }}>
      {block.title ? <div className="muted" style={{ fontSize: 9.5, letterSpacing: '0.4px', margin: '4px 0 6px' }}>{block.title}</div> : null}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {(block.metrics ?? []).map((metric) => {
        const value = metricValue(metric);
        return (
          <div key={metric.label} className="panel" style={{ padding: '8px 12px', minWidth: 120 }}>
            <div className="muted" style={{ fontSize: 10 }}>{metric.label}</div>
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
          </div>
        );
      })}
      </div>
    </div>
  );
}

function TableBlock({ block }: { block: ReportBlock }) {
  const measures = new Set(block.measureColumns ?? []);
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      {block.title ? <div className="panel-head">{block.title}</div> : null}
      <div style={{ overflowX: 'auto' }}>
        <table className="tool-table">
          <thead>
            <tr>
              {(block.columns ?? []).map((column) => (
                <th key={column} style={measures.has(column) ? { textAlign: 'right' } : undefined}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(block.rows ?? []).map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => {
                  const column = block.columns?.[cellIndex];
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

function Block({ block }: { block: ReportBlock }) {
  if (block.kind === 'narrative') {
    return <p style={{ margin: '6px 0', fontSize: 12, lineHeight: 1.6 }}>{block.text}</p>;
  }
  if (block.kind === 'metric') return <MetricBlock block={block} />;
  if (block.kind === 'table') return <TableBlock block={block} />;
  if (block.kind === 'actions') return <ActionsBlock block={block} />;
  if (block.kind === 'chart') {
    const hasBaseline = (block.series ?? []).some((point) => typeof point.baseline === 'number');
    return (
      <div style={{ marginTop: 8 }}>
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
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{spec.title}</div>
        <div className="muted" style={{ fontSize: 10 }}>
          {spec.sources.map((source) => `${source.label} · ${source.engine}`).join(' / ')}
          {period ? ` · ${period.label ?? `${period.from} ~ ${period.to}`}` : ''} · {new Date(spec.meta.createdAt).toLocaleString()} · {spec.layout}
        </div>
      </div>
      {spec.executive ? (
        <div className="panel" style={{ padding: 12, marginBottom: 8, borderColor: 'var(--accent, #45c8c3)' }}>
          <div className="muted" style={{ fontSize: 9, letterSpacing: '0.6px', textTransform: 'uppercase', marginBottom: 4 }}>{tr("管理层摘要")}</div>
          <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.5 }}>{spec.executive.headline}</div>
          {spec.executive.takeaways.length ? (
            <ul style={{ margin: '6px 0 0 16px', padding: 0, fontSize: 12, lineHeight: 1.7 }}>
              {spec.executive.takeaways.map((takeaway) => <li key={takeaway}>{takeaway}</li>)}
            </ul>
          ) : null}
          {(spec.executive.risks ?? []).map((risk) => (
            <div key={risk} className="muted" style={{ fontSize: 11, color: 'var(--warning, var(--danger))', marginTop: 6 }}>{risk}</div>
          ))}
        </div>
      ) : null}
      {spec.sections.map((section) => (
        <div key={section.id} className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>{section.title}</div>
          {section.conclusion ? (
            <div style={{ fontSize: 12, fontWeight: 600, margin: '2px 0 8px' }}>{section.conclusion}</div>
          ) : null}
          {section.blocks.map((block, index) => (
            <div key={index}>
              <Block block={block} />
              {block.note ? (
                <div className="muted" style={{ fontSize: 9, marginTop: 2 }}>{block.note}</div>
              ) : null}
            </div>
          ))}
        </div>
      ))}
      {spec.meta.assumptions?.length ? (
        <div className="muted" style={{ fontSize: 9, marginBottom: 4 }}>
          {spec.meta.assumptions.map((line) => <div key={line}>{tr("口径：")}{line}</div>)}
        </div>
      ) : null}
      {spec.meta.notes?.length ? (
        <div className="muted" style={{ fontSize: 9, opacity: 0.75 }}>
          {spec.meta.notes.map((note) => <div key={note}>{note}</div>)}
        </div>
      ) : null}
    </div>
  );
}
