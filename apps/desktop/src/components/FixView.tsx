import { useMemo, useState } from 'react';
import type { Risk } from '@aidb/core';
import { RiskBadge } from './ui';

interface FixFinding {
  severity: string;
  code: string;
  title: string;
  table?: string;
  detail: string;
  sql?: string;
  risk?: Risk;
  requiresBackup?: boolean;
}

interface FixResult {
  mode: 'check' | 'repair';
  summary?: Record<string, number>;
  findings: FixFinding[];
  plan: Array<{ finding: string; table?: string; title: string; sql: string; risk: Risk; requiresBackup: boolean }>;
  note?: string;
}

const SEVERITY_LABEL: Record<string, string> = { high: '高', medium: '中', low: '低', info: '提示' };

export function FixView({ result, onExecute }: { result: FixResult; onExecute?: (steps: number[]) => void }) {
  const summary = result.summary ?? {};
  const [selected, setSelected] = useState<Set<number>>(() => new Set(result.plan.map((_, index) => index)));
  const selectedPlan = useMemo(() => result.plan.filter((_, index) => selected.has(index)), [result.plan, selected]);
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
        {[
          ['表', summary.tablesChecked ?? 0],
          ['高风险', summary.high ?? 0],
          ['中风险', summary.medium ?? 0],
          ['低风险', summary.low ?? 0],
          ['提示', summary.info ?? 0],
        ].map(([label, value]) => (
          <div key={String(label)} className="panel" style={{ padding: '8px 12px', minWidth: 80 }}>
            <div className="muted" style={{ fontSize: 10 }}>{label}</div>
            <div className="mono" style={{ fontSize: 16 }}>{value}</div>
          </div>
        ))}
      </div>
      {result.findings.length ? (
        <div className="panel">
          <div className="panel-head">发现 <span className="badge">{result.findings.length}</span></div>
          <div style={{ maxHeight: 260, overflow: 'auto' }}>
            {result.findings.map((finding, index) => (
              <div key={`${finding.code}-${index}`} className="transfer-row" style={{ alignItems: 'flex-start' }}>
                <span className={`badge ${finding.severity === 'high' ? 'destructive' : finding.severity === 'medium' ? 'write' : 'read'}`}>
                  {SEVERITY_LABEL[finding.severity] ?? finding.severity}
                </span>
                <span style={{ flex: 1 }}>
                  <span>{finding.title}</span>
                  {finding.table ? <span className="muted"> · {finding.table}</span> : null}
                  <div className="muted" style={{ fontSize: 10 }}>{finding.detail}</div>
                </span>
                {finding.risk ? <RiskBadge risk={finding.risk} /> : null}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="dash-empty">没有发现需要处理的问题。</div>
      )}
      {result.plan.length ? (
        <div className="panel" style={{ marginTop: 8 }}>
          <div className="panel-head">修复计划 <span className="badge">{result.plan.length}</span></div>
          <div style={{ maxHeight: 120, overflow: 'auto', padding: '0 8px' }}>
            {result.plan.map((step, index) => (
              <label key={`${step.finding}-${index}`} className="transfer-row" style={{ padding: '3px 0' }}>
                <input
                  type="checkbox"
                  checked={selected.has(index)}
                  onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(index);
                    else next.delete(index);
                    setSelected(next);
                  }}
                />
                <RiskBadge risk={step.risk} />
                <span className="truncate">{step.title}</span>
              </label>
            ))}
          </div>
          <pre
            className="mono"
            style={{ margin: 0, padding: 8, maxHeight: 220, overflow: 'auto', background: 'var(--bg-inset)', fontSize: 10 }}
          >
            {result.plan.map((step) => `-- ${step.title}${step.requiresBackup ? '（需备份）' : ''}\n${step.sql}`).join('\n\n')}
          </pre>
        </div>
      ) : null}
      {result.note ? <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>{result.note}</div> : null}
    </div>
  );
}
