import { useEffect, useState } from 'react';
import { Download, FileChartColumn, FileText, Loader2, Play, Presentation, RefreshCw } from 'lucide-react';
import type { ArtifactInfo, CommandRunEvent, ReportSpec } from '@aidb/core';
import { api, streamCommandRun } from '../../lib/api';
import { useApp } from '../../store';
import { DatabaseSelect } from '../DatabaseSelect';
import { ReportView } from '../ReportView';
import { Select, Option } from '../ui';
import { t as tr } from '../../i18n';

const PERIODS = [
  [tr("本周"), tr("本周")],
  [tr("上周"), tr("上周")],
  [tr("本月"), tr("本月")],
  [tr("上月"), tr("上月")],
  [tr("本季度"), tr("本季度")],
  [tr("上季度"), tr("上季度")],
  [tr("今年"), tr("今年")],
  [tr("去年"), tr("去年")],
  [tr("近 7 天"), tr("近 7 天")],
  [tr("近 30 天"), tr("近 30 天")],
  [tr("近 3 个月"), tr("近 3 个月")],
] as const;

const AUDIENCES = [
  ['executive', tr("管理层")],
  ['business', tr("业务")],
  ['technical', tr("技术")],
] as const;

function eventText(event: CommandRunEvent): string {
  switch (event.type) {
    case 'run_started':
      return tr("开始生成…");
    case 'step_started':
      return event.label;
    case 'step_progress':
      return event.message;
    case 'step_succeeded':
      return event.summary;
    case 'step_failed':
      return event.error.message;
    default:
      return '';
  }
}

export function ReportsTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const homeDatabase = useApp((s) => s.homeDatabase);
  const notify = useApp((s) => s.notify);
  const [connectionId, setConnectionId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState(homeDatabase);
  const [topic, setTopic] = useState(tr("本月经营概览"));
  const [period, setPeriod] = useState(tr("本月"));
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [audience, setAudience] = useState<'executive' | 'business' | 'technical'>('business');
  const [format, setFormat] = useState<'screen' | 'xlsx' | 'pptx'>('screen');
  const [reports, setReports] = useState<ArtifactInfo[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [spec, setSpec] = useState<ReportSpec | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [busy, setBusy] = useState('');

  const load = async (keep?: string) => {
    const { artifacts } = await api.artifacts({ type: 'report', limit: 50 });
    setReports(artifacts);
    const next = keep ?? selectedId ?? artifacts[0]?.id ?? '';
    setSelectedId(next);
    if (next) await openSpec(next);
    else setSpec(null);
  };

  const openSpec = async (id: string) => {
    try {
      const { runs } = await api.artifactRuns(id, 1);
      setSpec((runs[0]?.result as ReportSpec) ?? null);
    } catch (err: any) {
      setSpec(null);
      notify('error', tr("读取报告失败"), err?.message);
    }
  };

  useEffect(() => {
    void load().catch((err: any) => notify('error', tr("加载报告列表失败"), err?.message));
  }, []);

  const waitFor = async (runId: string): Promise<void> => {
    setProgress(tr("排队中…"));
    await streamCommandRun(runId, (event) => {
      const text = eventText(event);
      if (text) setProgress(text);
    });
  };

  const choose = async (id: string) => {
    setSelectedId(id);
    await openSpec(id);
  };

  const create = async () => {
    if (!connectionId) {
      notify('warning', tr("先选择连接"));
      return;
    }
    setRunning(true);
    setProgress('');
    try {
      const custom = period === 'custom';
      const input = {
        sources: [{ connectionId, ...(database ? { database } : {}) }],
        topic: topic.trim() || tr("数据概览"),
        period: custom ? { from, to } : period,
        audience,
        format,
      };
      // 标题交给网关生成（主题 + 日期）；这里传固定标题会让同名报告无法区分。
      const { run } = await api.startCommand('report', input);
      await waitFor(run.id);
      await load(run.artifactId);
      notify('success', tr("报告已生成"), run.artifactId ? tr("可在右侧查看并导出") : undefined);
    } catch (err: any) {
      notify('error', tr("报告生成失败"), err?.message);
    } finally {
      setRunning(false);
      setProgress('');
    }
  };

  const rerun = async () => {
    if (!selectedId) return;
    setBusy(selectedId);
    try {
      const { run } = await api.rerunArtifact(selectedId);
      await waitFor(run.id);
      await load(selectedId);
      notify('success', tr("报告已刷新"));
    } catch (err: any) {
      notify('error', tr("刷新失败"), err?.message);
    } finally {
      setBusy('');
      setProgress('');
    }
  };

  const exportAs = async (kind: 'xlsx' | 'pptx') => {
    if (!selectedId) return;
    setBusy(`export-${kind}`);
    try {
      const file = await api.exportArtifact(selectedId, kind);
      notify('success', tr("已导出 {0}", [kind.toUpperCase()]), file.path);
    } catch (err: any) {
      notify('error', tr("导出失败"), err?.message);
    } finally {
      setBusy('');
    }
  };

  const makeDeck = async () => {
    if (!selectedId) return;
    setBusy('deck');
    try {
      const { run } = await api.artifactDeck(selectedId, { mode: 'deterministic' });
      notify('success', tr("AI PPT 已生成"), tr("Skill 运行 {0}", [run.runId]));
    } catch (err: any) {
      notify('error', tr("AI PPT 生成失败"), err?.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <FileChartColumn size={15} /> {tr(" 报告 ")}<span className="muted">{tr("结论先行 · 同口径基线 · 可导出 Excel / PPT")}</span>
      </div>
      <div className="tool-row">
        <div className="field" style={{ minWidth: 170 }}>
          <label>{tr("连接")}</label>
          <Select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((conn) => <Option key={conn.id} value={conn.id}>{conn.name}</Option>)}
          </Select>
        </div>
        <div className="field" style={{ minWidth: 130 }}>
          <label>{tr("数据库")}</label>
          <DatabaseSelect connectionId={connectionId} value={database} onChange={setDatabase} testId="report-db" />
        </div>
        <div className="field" style={{ flex: 1, minWidth: 220 }}>
          <label>{tr("报告主题")}</label>
          <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={tr("例如：本月订单与履约情况")} data-testid="report-topic" />
        </div>
        <div className="field" style={{ minWidth: 120 }}>
          <label>{tr("时间范围")}</label>
          <Select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
            <Option value="custom">{tr("自定义…")}</Option>
          </Select>
        </div>
        {period === 'custom' ? (
          <div className="field" style={{ minWidth: 200 }}>
            <label>{tr("起止日期")}</label>
            <div className="row gap-6">
              <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 120 }} />
              <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 120 }} />
            </div>
          </div>
        ) : null}
        <div className="field" style={{ minWidth: 110 }}>
          <label>{tr("阅读对象")}</label>
          <Select className="select" value={audience} onChange={(e) => setAudience(e.target.value as typeof audience)}>
            {AUDIENCES.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
          </Select>
        </div>
        <div className="field" style={{ minWidth: 100 }}>
          <label>{tr("输出")}</label>
          <Select className="select" value={format} onChange={(e) => setFormat(e.target.value as typeof format)}>
            <Option value="screen">{tr("屏幕")}</Option>
            <Option value="xlsx">Excel</Option>
            <Option value="pptx">PPT</Option>
          </Select>
        </div>
        <button className="btn primary" style={{ alignSelf: 'flex-end' }} onClick={() => void create()} disabled={running} data-testid="report-create">
          {running ? <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> : <Play size={12} />}{tr(" 生成报告 ")}</button>
      </div>
      {running && progress ? <div className="tool-summary">{progress}</div> : null}
      <div className="tool-scroll">
        {!reports.length ? (
          <div className="dash-empty">{tr("还没有报告。填好主题和时间范围后点「生成报告」；也可以用 /report 在对话里直接提问。")}</div>
        ) : (
          <div className="row" style={{ alignItems: 'flex-start', gap: 10 }}>
            <div className="panel" style={{ width: 230, flexShrink: 0 }}>
              <div className="panel-head">{tr("已保存 ")}<span className="badge">{reports.length}</span></div>
              <div className="transfer-list">
                {reports.map((artifact) => (
                  <button
                    key={artifact.id}
                    className="transfer-row"
                    style={{
                      textAlign: 'left',
                      width: '100%',
                      ...(artifact.id === selectedId ? { background: 'var(--bg-active)', color: 'var(--text-primary)' } : {}),
                    }}
                    onClick={() => void choose(artifact.id)}
                  >
                    <FileText size={12} />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artifact.title}</span>
                  </button>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 6, marginBottom: 8 }}>
                <button className="btn" onClick={() => void rerun()} disabled={!selectedId || Boolean(busy)}>
                  {busy === selectedId ? <Loader2 size={12} style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />}{tr(" 刷新 ")}</button>
                <button className="btn" onClick={() => void exportAs('xlsx')} disabled={!selectedId || Boolean(busy)}>
                  <Download size={12} /> Excel
                </button>
                <button className="btn" onClick={() => void exportAs('pptx')} disabled={!selectedId || Boolean(busy)}>
                  <Presentation size={12} /> PPT
                </button>
                <button className="btn" onClick={() => void makeDeck()} disabled={!selectedId || Boolean(busy)}>
                  <Presentation size={12} /> AI PPT
                </button>
              </div>
              {busy.startsWith('export') || busy === 'deck' ? <div className="tool-summary">{busy === 'deck' ? tr("正在生成 AI PPT…") : tr("正在导出…")}</div> : null}
              {spec ? <ReportView spec={spec} /> : <div className="dash-empty">{tr("选择左侧报告查看内容，或先生成一份。")}</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
