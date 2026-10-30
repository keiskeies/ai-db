import type { ReportBlock, ReportSpec } from '@aidb/core';
import { ChartView } from './ChartView';

function MetricBlock({ block }: { block: ReportBlock }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {(block.metrics ?? []).map((metric) => (
        <div key={metric.label} className="panel" style={{ padding: '8px 12px', minWidth: 110 }}>
          <div className="muted" style={{ fontSize: 10 }}>{metric.label}</div>
          <div className="mono" style={{ fontSize: 18, marginTop: 2 }}>
            {typeof metric.value === 'number' ? metric.value.toLocaleString() : metric.value}
            {metric.unit ? <span className="muted" style={{ fontSize: 10, marginLeft: 3 }}>{metric.unit}</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function TableBlock({ block }: { block: ReportBlock }) {
  return (
    <div className="panel" style={{ marginTop: 8 }}>
      {block.title ? <div className="panel-head">{block.title}</div> : null}
      <div style={{ overflowX: 'auto' }}>
        <table className="tool-table">
          <thead>
            <tr>
              {(block.columns ?? []).map((column) => <th key={column}>{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {(block.rows ?? []).map((row, index) => (
              <tr key={index}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className={cellIndex === 0 ? 'mono' : undefined}>
                    {typeof cell === 'number' ? cell.toLocaleString() : cell ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Block({ block }: { block: ReportBlock }) {
  if (block.kind === 'narrative') {
    return <p style={{ margin: '6px 0', fontSize: 12, lineHeight: 1.6 }}>{block.text}</p>;
  }
  if (block.kind === 'metric') return <MetricBlock block={block} />;
  if (block.kind === 'table') return <TableBlock block={block} />;
  if (block.kind === 'chart') {
    return (
      <div style={{ marginTop: 8 }}>
        <ChartView
          chart={{
            type: block.chartType ?? 'bar',
            title: block.title ?? '',
            xLabel: '',
            yLabel: '',
            series: block.series ?? [],
          }}
          maxHeight={220}
        />
      </div>
    );
  }
  if (block.kind === 'comparison') {
    const left = Number(block.left?.value ?? 0);
    const right = Number(block.right?.value ?? 0);
    return (
      <div className="panel" style={{ padding: 10, marginTop: 8 }}>
        <div className="muted" style={{ fontSize: 10, marginBottom: 6 }}>{block.title ?? '对比'}</div>
        <div className="row" style={{ gap: 18, alignItems: 'flex-end' }}>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>{block.left?.label}</div>
            <div className="mono" style={{ fontSize: 18 }}>{left.toLocaleString()}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>{block.right?.label}</div>
            <div className="mono" style={{ fontSize: 18 }}>{right.toLocaleString()}</div>
          </div>
          <div>
            <div className="muted" style={{ fontSize: 10 }}>差值</div>
            <div className="mono" style={{ fontSize: 18, color: block.delta && block.delta.absolute < 0 ? 'var(--danger)' : 'var(--success)' }}>
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
      <div className={`risk-banner`} style={{ marginTop: 8, borderColor: block.tone === 'danger' ? 'var(--danger)' : undefined }}>
        {block.text}
      </div>
    );
  }
  return null;
}

export function ReportView({ spec }: { spec: ReportSpec }) {
  return (
    <div>
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{spec.title}</div>
        <div className="muted" style={{ fontSize: 10 }}>
          {spec.sources.map((source) => `${source.label} · ${source.engine}`).join(' / ')} · {new Date(spec.meta.createdAt).toLocaleString()} · {spec.layout}
        </div>
      </div>
      {spec.sections.map((section) => (
        <div key={section.id} className="panel" style={{ padding: 10, marginBottom: 8 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>{section.title}</div>
          {section.blocks.map((block, index) => <Block key={index} block={block} />)}
        </div>
      ))}
      {spec.meta.notes?.length ? (
        <div className="muted" style={{ fontSize: 10 }}>
          {spec.meta.notes.map((note) => <div key={note}>{note}</div>)}
        </div>
      ) : null}
    </div>
  );
}
