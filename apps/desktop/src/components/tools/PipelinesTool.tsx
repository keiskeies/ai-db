import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleStop,
  FlaskConical,
  History,
  KeyRound,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Workflow,
} from 'lucide-react';
import {
  PIPELINE_STEP_KINDS,
  PIPELINE_TEMPLATES,
  applyMapRule,
  applyPipelineTemplate,
  mapRuleFromValues,
  defaultPipelineStep,
  pipelineStepKind,
  newPipelineSpec,
  type PipelineTemplate,
  type PipelineCredentialInfo,
  type PipelineEvent,
  type PipelineField,
  type PipelineInfo,
  type PipelineRunInfo,
  type PipelineSpec,
  type PipelineStep,
  type PipelineStepRun,
  type PipelineStepType,
} from '@aidb/core';
import { api, streamPipelineRun } from '../../lib/api';
import { useApp, type Toast } from '../../store';
import { DatabaseSelect } from '../DatabaseSelect';
import { askConfirm } from '../AskDialog';
import { Option, SecretInput, Select } from '../ui';
import { getI18nLocale, t as tr } from '../../i18n';

/**
 * 数据流处理：取数 → 清洗 → 计算 → 写出。
 *
 * 表单由 core 的步骤目录（PIPELINE_STEP_KINDS）驱动：加一类步骤只改目录，
 * 这里自动长出来。目标步骤在「试运行」里只渲染 SQL / 请求体不执行，所以看到
 * 的写入内容与真实运行一致。
 */

function label(pair: { zh: string; en: string }): string {
  return getI18nLocale().startsWith('zh') ? pair.zh : pair.en;
}

function ledText(status: PipelineStepRun['status']): string {
  switch (status) {
    case 'pending':
      return tr('待运行');
    case 'running':
      return tr('运行中');
    case 'ok':
      return tr('成功');
    case 'error':
      return tr('失败');
    default:
      return tr('跳过');
  }
}

function formatKeymap(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${key} = ${item === null || item === undefined ? '' : String(item)}`)
    .join('\n');
}

function parseKeymap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const index = line.indexOf('=');
    if (index < 0) continue;
    const key = line.slice(0, index).trim();
    if (!key) continue;
    out[key] = line.slice(index + 1).trim();
  }
  return out;
}

function formatList(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

function parseList(text: string): string[] {
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 顶部「默认连接/默认库」下发到步骤：只填空位，已经单独选过的不动。
 * 没有这一步，新建的流水线会因为步骤缺 connectionId 而保存失败。
 */
function applyDefaults(spec: PipelineSpec, defaults: { connectionId?: string; database?: string }): PipelineSpec {
  if (!defaults.connectionId && !defaults.database) return spec;
  return {
    ...spec,
    steps: spec.steps.map((step) => {
      const kind = pipelineStepKind(step.type);
      if (!kind) return step;
      const next = { ...step.with };
      for (const field of kind.fields) {
        if (field.type === 'connection' && defaults.connectionId && !String(next[field.key] ?? '')) next[field.key] = defaults.connectionId;
        if (field.type === 'database' && defaults.database && !String(next[field.key] ?? '')) next[field.key] = defaults.database;
      }
      return { ...step, with: next };
    }),
  };
}

function summaryText(run: PipelineRunInfo): string {
  return tr('{0} 步 / {1} 行', [run.steps.length, run.rowsOut ?? 0]);
}

function sampleCells(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function SampleTable({ columns, rows }: { columns?: string[]; rows?: Record<string, unknown>[] }) {
  if (!rows?.length) return null;
  const cols = (columns?.length ? columns : Object.keys(rows[0])).slice(0, 8);
  return (
    <table className="pipe-sample">
      <thead>
        <tr>{cols.map((column) => <th key={column}>{column}</th>)}</tr>
      </thead>
      <tbody>
        {rows.slice(0, 8).map((row, index) => (
          <tr key={index}>
            {cols.map((column) => (
              <td key={column} title={String(row[column] ?? '')}>{sampleCells(row[column])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function statusLed(status?: PipelineStepRun['status']): string {
  if (status === 'ok') return 'status-led ok';
  if (status === 'error') return 'status-led error';
  return 'status-led';
}

export function PipelinesTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const prefillAgent = useApp((s) => s.prefillAgent);
  const [aiBrief, setAiBrief] = useState('');

  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [credentials, setCredentials] = useState<PipelineCredentialInfo[]>([]);
  const [pythonReady, setPythonReady] = useState(true);

  const [draftId, setDraftId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [connectionId, setConnectionId] = useState('');
  const [database, setDatabase] = useState('');
  const [spec, setSpec] = useState<PipelineSpec>(newPipelineSpec);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [template, setTemplate] = useState<PipelineTemplate | null>(null);
  const [templateSpec, setTemplateSpec] = useState<PipelineSpec | null>(null);
  const [spotlight, setSpotlight] = useState('');
  const [spotlightStep, setSpotlightStep] = useState('');

  const [run, setRun] = useState<PipelineRunInfo | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState('');
  const [showRuns, setShowRuns] = useState(false);
  const [runs, setRuns] = useState<PipelineRunInfo[]>([]);
  const [showCredentials, setShowCredentials] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const loadLists = useCallback(async () => {
    try {
      const [list, creds, meta] = await Promise.all([api.pipelines(), api.pipelineCredentials(), api.pipelineMeta()]);
      setPipelines(list.pipelines);
      setCredentials(creds.credentials);
      setPythonReady(meta.python.ok);
      return list.pipelines;
    } catch (err: any) {
      notify('error', tr('加载数据流失败'), err?.message);
      return [];
    }
  }, [notify]);

  useEffect(() => {
    // 打开面板就落一份可用草稿：有已存流水线则载入第一条，否则新建并带上默认连接，
    // 免得首屏是个连保存都会失败的半成品。
    void loadLists().then((list) => beginDraft(list[0]));
  }, [loadLists]);

  const beginDraft = (pipeline?: PipelineInfo) => {
    if (!pipeline) {
      setDraftId('');
      setName(tr('每日订单同步'));
      setDescription('');
      const fallbackConnection = activeConnectionId || connections[0]?.id || '';
      setConnectionId(fallbackConnection);
      setDatabase('');
      setSpec(applyDefaults(newPipelineSpec(), { connectionId: fallbackConnection }));
      setTemplate(null);
      setTemplateSpec(null);
      setSpotlight('');
      setSpotlightStep('');
      setDirty(true);
      setExpanded(0);
      setRun(null);
      return;
    }
    setDraftId(pipeline.id);
    setName(pipeline.name);
    setDescription(pipeline.description ?? '');
    setConnectionId(pipeline.connectionId || activeConnectionId || connections[0]?.id || '');
    setDatabase(pipeline.database ?? '');
    setSpec(structuredClone(pipeline.spec));
    setTemplate(null);
    setTemplateSpec(null);
    setSpotlight('');
    setSpotlightStep('');
    setDirty(false);
    setExpanded(0);
    setRun(null);
  };

  const current = useMemo(() => pipelines.find((item) => item.id === draftId), [pipelines, draftId]);

  const useTemplate = (next: PipelineTemplate | null) => {
    if (!next) return;
    const applied = applyPipelineTemplate(next, { connectionId, database });
    setSpec(applied);
    setTemplateSpec(applied);
    setTemplate(next);
    setExpanded(0);
    setSpotlight('');
    setSpotlightStep('');
    setDirty(true);
  };

  // 用户改过的项就从清单里消失：只有「还是模板里的占位值」才需要提醒。
  const pending = useMemo(() => {
    if (!template || !templateSpec) return [];
    return template.review.filter((item) => {
      const original = templateSpec.steps.find((step) => step.id === item.step)?.with?.[item.field];
      const current = spec.steps.find((step) => step.id === item.step)?.with?.[item.field];
      return JSON.stringify(original) === JSON.stringify(current);
    });
  }, [template, templateSpec, spec]);

  const jumpToField = (stepId: string, field: string) => {
    const index = spec.steps.findIndex((step) => step.id === stepId);
    if (index < 0) return;
    setExpanded(index);
    setSpotlightStep(stepId);
    setSpotlight(`${stepId}.${field}`);
  };

  const patchSpec = (next: PipelineSpec) => {
    setSpec(next);
    setDirty(true);
  };

  const patchStep = (index: number, patch: Partial<PipelineStep>) => {
    const steps = spec.steps.map((step, position) => (position === index ? { ...step, ...patch } : step));
    patchSpec({ ...spec, steps });
  };

  const patchWith = (index: number, key: string, value: unknown) => {
    const step = spec.steps[index];
    patchStep(index, { with: { ...step.with, [key]: value } });
    if (spotlight === `${step.id}.${key}`) setSpotlight('');
  };

  const moveStep = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= spec.steps.length) return;
    const steps = [...spec.steps];
    const [moved] = steps.splice(index, 1);
    steps.splice(target, 0, moved);
    patchSpec({ ...spec, steps });
    setExpanded(target);
  };

  const removeStep = (index: number) => {
    patchSpec({ ...spec, steps: spec.steps.filter((_, position) => position !== index) });
    setExpanded((value) => Math.max(0, Math.min(value, spec.steps.length - 2)));
  };

  const addStep = (type: PipelineStepType) => {
    const used = new Set(spec.steps.map((step) => step.id));
    const base = type.replace('.', '-');
    let index = 1;
    let id = `${base}-${index}`;
    while (used.has(id)) {
      index += 1;
      id = `${base}-${index}`;
    }
    patchSpec(applyDefaults({ ...spec, steps: [...spec.steps, defaultPipelineStep(type, id)] }, { connectionId, database }));
    setExpanded(spec.steps.length);
  };

  /** 用上一次运行/试运行的列名生成写入映射：目标表存在就按同名交集，否则恒等映射。 */
  const autoMap = async (index: number) => {
    const step = spec.steps[index];
    const before = (run?.steps ?? []).slice(0, index).filter((item) => item.columns?.length);
    const sourceColumns = before.length ? before[before.length - 1].columns ?? [] : [];
    if (!sourceColumns.length) {
      notify('warning', tr('需要上一步的列名'), tr('先「试运行到这一步」拿到样本，再自动映射'));
      return;
    }
    const connId = String(step.with.connectionId ?? connectionId ?? '');
    const tableName = String(step.with.table ?? '').trim();
    const db = String(step.with.database ?? database ?? '') || undefined;
    let targetColumns: string[] = [];
    if (connId && tableName) {
      try {
        const { tables } = await api.getTables(connId, db);
        const hit = tables.find((item) => item.name.toLowerCase() === tableName.toLowerCase());
        targetColumns = (hit?.columns ?? []).map((column) => column.name);
      } catch {
        targetColumns = [];
      }
    }
    const mapping: Record<string, string> = {};
    const unmatched: string[] = [];
    if (targetColumns.length) {
      const byLower = new Map(targetColumns.map((name) => [name.toLowerCase(), name]));
      for (const column of sourceColumns) {
        const hit = byLower.get(column.toLowerCase());
        if (hit) mapping[hit] = column;
        else unmatched.push(column);
      }
      if (!Object.keys(mapping).length) {
        notify('warning', tr('目标表没有同名列'), `${tr('目标表已有列：')}${targetColumns.slice(0, 10).join(', ')}`);
        return;
      }
    } else {
      for (const column of sourceColumns) mapping[column] = column;
    }
    patchWith(index, 'columns', mapping);
    notify(
      'success',
      tr('已生成列映射'),
      targetColumns.length
        ? tr('匹配 {0} 列，{1} 列目标表没有', [Object.keys(mapping).length, unmatched.length])
        : tr('目标表还不存在，按同名恒等映射，建表时会照此创建'),
    );
  };

  /** 失败步骤要自己跳出来：展开它、高亮它，别让用户在长列表里找红点。 */
  const focusFailedStep = (info: PipelineRunInfo | null) => {
    const index = info?.steps.findIndex((item) => item.status === 'error') ?? -1;
    if (index < 0 || !info) return;
    setExpanded(index);
    setSpotlightStep(info.steps[index].id);
  };

  const patchParam = (index: number, patch: Partial<{ key: string; default: string }>) => {
    const params = (spec.params ?? []).map((param, position) => (position === index ? { ...param, ...patch } : param));
    patchSpec({ ...spec, params });
  };

  const addParam = () => {
    const params = [...(spec.params ?? []), { key: `p${(spec.params?.length ?? 0) + 1}`, default: '' }];
    patchSpec({ ...spec, params });
  };

  const removeParam = (index: number) => {
    patchSpec({ ...spec, params: (spec.params ?? []).filter((_, position) => position !== index) });
  };

  /** 保存草稿并返回 id：试运行与运行都基于已保存的定义，避免「界面改过了、跑的却还是旧 spec」。 */
  const persist = async (): Promise<string | null> => {
    if (!name.trim()) {
      notify('error', tr('需要名称'));
      return null;
    }
    setBusy('save');
    try {
      const body = {
        name: name.trim(),
        description: description.trim() || undefined,
        connectionId: connectionId || undefined,
        database: database || undefined,
        spec,
      };
      const saved = draftId ? await api.updatePipeline(draftId, body) : await api.createPipeline(body);
      setDraftId(saved.pipeline.id);
      setDirty(false);
      setIssues([]);
      await loadLists();
      notify('success', tr('已保存'));
      return saved.pipeline.id;
    } catch (err: any) {
      const hint = err?.hint ? String(err.hint) : '';
      setIssues(hint && hint !== String(err?.message ?? '') ? [hint] : []);
      notify('error', tr('保存失败'), err?.message);
      return null;
    } finally {
      setBusy('');
    }
  };

  const save = () => void persist();

  const applyEvent = (previous: PipelineRunInfo | null, event: PipelineEvent): PipelineRunInfo | null => {
    switch (event.type) {
      case 'run-start':
        return {
          id: event.runId,
          pipelineId: event.pipelineId,
          pipelineName: name,
          trigger: 'manual',
          status: 'running',
          batchAt: event.batchAt,
          startedAt: new Date().toISOString(),
          steps: event.steps.map((step) => ({ id: step.id, type: step.type, label: step.label, role: 'transform', status: 'pending' })),
        };
      case 'step-start':
        if (!previous) return previous;
        return { ...previous, steps: previous.steps.map((step, index) => (index === event.index ? { ...step, label: event.label, status: 'running' } : step)) };
      case 'step-done':
      case 'step-error':
        if (!previous) return previous;
        return { ...previous, steps: previous.steps.map((step, index) => (index === event.index ? event.run : step)) };
      case 'done':
        return event.run;
      default:
        return previous;
    }
  };

  const runNow = async () => {
    const target = dirty || !draftId ? await persist() : draftId;
    if (!target) return;
    setRunning(true);
    setRun(null);
    setIssues([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      let latest: PipelineRunInfo | null = null;
      await streamPipelineRun(
        target,
        {},
        (event) => {
          if (event.type === 'error') {
            setIssues([event.message]);
            notify('error', tr('数据流失败'), event.message);
            return;
          }
          latest = applyEvent(latest, event);
          setRun(latest);
        },
        controller.signal,
      );
      const finished = latest as PipelineRunInfo | null;
      if (finished) {
        focusFailedStep(finished);
        notify(finished.status === 'ok' ? 'success' : 'error', finished.status === 'ok' ? tr('数据流完成') : tr('数据流失败'), finished.status === 'ok' ? summaryText(finished) : finished.error);
      }
      await loadLists();
    } catch (err: any) {
      notify('error', tr('运行失败'), err?.message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const trialTo = async (index: number) => {
    setBusy(`trial-${index}`);
    setIssues([]);
    try {
      const target = dirty || !draftId ? await persist() : draftId;
      if (!target) return;
      const { run: result } = await api.trialPipeline(target, { index });
      setRun(result);
      setExpanded(index);
      focusFailedStep(result);
      const failed = result.steps.find((step) => step.status === 'error');
      if (failed) notify('error', tr('试运行停在「{0}」', [failed.label]), failed.error ?? '');
      else notify('success', tr('试运行到第 {0} 步完成', [index + 1]), tr('目标步骤只渲染不执行'));
    } catch (err: any) {
      notify('error', tr('试运行失败'), err?.message);
      if (err?.hint) setIssues([String(err.hint)]);
    } finally {
      setBusy('');
    }
  };

  const openRuns = async () => {
    if (!draftId) return;
    setShowRuns((value) => !value);
    if (!showRuns) {
      try {
        setRuns((await api.pipelineRuns(draftId)).runs);
      } catch (err: any) {
        notify('error', tr('读取历史失败'), err?.message);
      }
    }
  };

  const removePipeline = async () => {
    if (!draftId) return;
    if (!(await askConfirm({ message: tr('删除数据流「{0}」？历史运行记录会一起清掉。', [name]), danger: true, confirmLabel: tr('删除') }))) return;
    await api.deletePipeline(draftId);
    beginDraft();
    await loadLists();
    notify('success', tr('已删除'));
  };

  const resetState = async () => {
    if (!draftId) return;
    await api.resetPipelineState(draftId);
    await loadLists();
    notify('success', tr('增量断点已清空'), tr('下次运行会从头取数'));
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Workflow size={15} /> {tr(' 数据流处理 ')}
        <span className="muted">{tr('接口/数据库取数 → JSONPath 与表达式清洗 → SQL 或脚本计算 → 写出')}</span>
      </div>

      <div className="tool-row">
        <Select
          className="select"
          style={{ width: 220 }}
          value={draftId}
          onChange={(e) => {
            const found = pipelines.find((item) => item.id === e.target.value);
            if (found) beginDraft(found);
          }}
        >
          <Option value="">{tr('（新建数据流）')}</Option>
          {pipelines.map((item) => (
            <Option key={item.id} value={item.id}>
              {item.name}
            </Option>
          ))}
        </Select>
        <button className="btn" onClick={() => beginDraft()} disabled={running}>
          <Plus size={12} /> {tr(' 新建 ')}
        </button>
        <button className="btn primary" onClick={() => void save()} disabled={busy === 'save' || !dirty}>
          {busy === 'save' ? <Loader2 size={12} className="spin" /> : <Save size={12} />} {tr(' 保存 ')}
        </button>
        <button className="btn" onClick={() => void runNow()} disabled={running}>
          {running ? <Loader2 size={12} className="spin" /> : <Play size={12} />} {tr(' 运行 ')}
        </button>
        {running ? (
          <button className="btn" onClick={() => void api.cancelPipeline(draftId).catch(() => undefined)}>
            <CircleStop size={12} /> {tr(' 取消 ')}
          </button>
        ) : null}
        <button className="btn" onClick={() => void openRuns()} disabled={!draftId}>
          <History size={12} /> {tr(' 历史 ')}
        </button>
        <button className="btn" onClick={() => void loadLists()}>
          <RefreshCw size={12} /> {tr(' 刷新 ')}
        </button>
        <span className="spacer" />
        {current?.lastStatus ? <span className={`status-led ${current.lastStatus === 'ok' ? 'ok' : 'error'}`} /> : null}
        {dirty ? <span className="badge write">{tr('未保存')}</span> : null}
        <button className="icon-btn danger" onClick={() => void removePipeline()} disabled={!draftId}>
          <Trash2 size={12} />
        </button>
      </div>

      {!draftId ? (
        <div className="setting-card" style={{ marginBottom: 8 }}>
          <div className="row gap-6" style={{ alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 11 }}>{tr('从一个模板开始')}</strong>
            <span className="muted" style={{ fontSize: 10 }}>{tr('选中即填好步骤，改几个占位值就能跑；也可以直接空着手加步骤。')}</span>
          </div>
          <div className="pipe-tpl">
            {PIPELINE_TEMPLATES.map((item) => (
              <button
                key={item.id}
                data-testid={`pipe-tpl-${item.id}`}
                className={`btn small${template?.id === item.id ? ' primary' : ''}`}
                title={label(item.description)}
                onClick={() => useTemplate(item)}
              >
                {label(item.label)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {pending.length ? (
        <div className="pipe-pending">
          <span style={{ fontSize: 10.5 }}>{tr('还需确认 {0} 处：', [pending.length])}</span>
          {pending.map((item) => {
            const index = spec.steps.findIndex((step) => step.id === item.step);
            return (
              <button
                key={`${item.step}.${item.field}`}
                data-testid={`pipe-pending-${item.step}-${item.field}`}
                className="btn small"
                onClick={() => jumpToField(item.step, item.field)}
              >
                {index >= 0 ? index + 1 : ''} · {item.note ? label(item.note) : item.field}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="row gap-6" style={{ marginBottom: 8, alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 10.5 }}>{tr('不想手填？')}</span>
        <input
          className="input"
          data-testid="pipe-ai-brief"
          style={{ flex: '1 1 260px' }}
          value={aiBrief}
          placeholder={tr('或者一句话描述，例：把 shop 库的 orders 按 id 去重同步到 ods_orders')}
          onChange={(e) => setAiBrief(e.target.value)}
        />
        <button
          className="btn"
          data-testid="pipe-ai-draft"
          disabled={!aiBrief.trim()}
          onClick={() => {
            prefillAgent(tr('用 manage_pipeline 帮我建一条数据流：{0}。先 validate，通过后 create，再 run（dryRun=true）把每步行数和渲染出的写入语句报给我。', [aiBrief.trim()]));
            notify('info', tr('已填入 Agent 输入框'), tr('回车发送即可，生成完回到这里点刷新'));
          }}
        >
          {tr(' 让 AI 起草 ')}
        </button>
      </div>
      <div className="settings-feature-bar" style={{ marginBottom: 8 }}>
        <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={settings.features.pipelines}
            onChange={(e) => void saveSettings({ features: { ...settings.features, pipelines: e.target.checked } })}
          />
          {tr(' 启用数据流处理 ')}
        </label>
        <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={settings.features.pipelineScripts}
            onChange={(e) => void saveSettings({ features: { ...settings.features, pipelineScripts: e.target.checked } })}
          />
          {tr(' 允许脚本步骤 ')}
        </label>
        <span className="muted" style={{ fontSize: 10 }}>
          {tr('脚本在子进程里运行，只读 stdin 的行数据、写 stdout 的结果：拿不到数据库连接、网络和 Gateway 的密钥。')}
        </span>
      </div>

      <div className="setting-card" style={{ marginBottom: 8 }}>
        <div className="form-grid" style={{ gap: 8 }}>
          <div className="field">
            <label>{tr('名称')}</label>
            <input className="input" value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} />
          </div>
          <div className="field">
            <label>{tr('默认连接')}</label>
            <Select className="select" value={connectionId} onChange={(e) => {
              setConnectionId(e.target.value);
              setSpec((current) => applyDefaults(current, { connectionId: e.target.value }));
              setDirty(true);
            }}>
              <Option value="">{tr('（每步各自选）')}</Option>
              {connections.map((conn) => (
                <Option key={conn.id} value={conn.id}>{conn.name}</Option>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>{tr('默认库')}</label>
            <DatabaseSelect connectionId={connectionId} value={database} onChange={(value) => {
              setDatabase(value);
              setSpec((current) => applyDefaults(current, { connectionId, database: value }));
              setDirty(true);
            }} testId="pipeline-db" />
          </div>
          <div className="field">
            <label>{tr('说明')}</label>
            <input className="input" value={description} onChange={(e) => { setDescription(e.target.value); setDirty(true); }} placeholder={tr('把支付回调同步到订单表')} />
          </div>
        </div>
        <div className="row gap-6" style={{ marginTop: 8, flexWrap: 'wrap' }}>
          <span className="muted" style={{ fontSize: 10 }}>{tr('参数')}</span>
            {(spec.params ?? []).map((param, index) => (
              <span key={index} className="row gap-4">
                <input
                  className="input"
                  style={{ width: 120 }}
                  value={param.key}
                  onChange={(e) => patchParam(index, { key: e.target.value.replace(/[^A-Za-z0-9_]/g, '') })}
                />
                <span className="muted">=</span>
                <input
                  className="input"
                  style={{ width: 140 }}
                  value={String(param.default ?? '')}
                  placeholder={tr('默认值')}
                  onChange={(e) => patchParam(index, { default: e.target.value })}
                />
                <button className="icon-btn" title={tr('删除参数')} onClick={() => removeParam(index)}>
                  <Trash2 size={11} />
                </button>
              </span>
            ))}
            <button className="btn small" onClick={addParam}>
              <Plus size={11} /> {tr(' 加参数 ')}
            </button>
            <span className="muted" style={{ fontSize: 10 }}>{tr('步骤里用 {0} 引用', ['{{ params.名称 }}'])}</span>
        </div>
      </div>

      {issues.length ? (
        <div className="setting-card" style={{ marginBottom: 8, borderColor: 'var(--danger)' }}>
          {issues.map((issue, index) => (
            <div key={index} className="hint" style={{ color: 'var(--danger)' }}>{issue}</div>
          ))}
        </div>
      ) : null}

      <div className="tool-scroll">
        <div className="row gap-6" style={{ marginBottom: 6 }}>
          <strong style={{ fontSize: 11 }}>{tr('步骤')}</strong>
          <span className="muted">{tr('按顺序执行；上一步的输出用 {0} 取用', ['{{ steps.步骤id.rows }}'])}</span>
        </div>

        {spec.steps.map((step, index) => {
          const kind = pipelineStepKind(step.type);
          const live = run?.steps[index];
          const open = expanded === index;
          const scriptDisabled = step.type.startsWith('script.') && !settings.features.pipelineScripts;
          const pythonMissing = step.type === 'script.py' && !pythonReady;
          return (
            <div key={`${step.id}-${index}`} className={`pipe-step${spotlightStep === step.id ? ' spot' : ''}`}>
              <div className="row gap-6" style={{ alignItems: 'center' }}>
                <button className="icon-btn" onClick={() => setExpanded(open ? -1 : index)} title={open ? tr('收起') : tr('展开')}>
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <span className="badge">{index + 1}</span>
                <span className={`status-led ${live?.status === 'ok' ? 'ok' : live?.status === 'error' ? 'error' : ''}`} title={live ? ledText(live.status) : tr('尚未运行')} />
                <Select
                  className="select"
                  style={{ width: 168 }}
                  value={step.type}
                  onChange={(e) => {
                    const type = e.target.value as PipelineStepType;
                    const fresh = defaultPipelineStep(type, step.id);
                    patchSpec(applyDefaults({ ...spec, steps: spec.steps.map((item, position) => (position === index ? { ...item, type, label: fresh.label, with: fresh.with } : item)) }, { connectionId, database }));
                  }}
                >
                  {PIPELINE_STEP_KINDS.map((item) => (
                    <Option key={item.type} value={item.type}>
                      {label(item.label)}
                    </Option>
                  ))}
                </Select>
                <input
                  className="input"
                  style={{ flex: '1 1 120px', minWidth: 90 }}
                  value={step.label ?? ''}
                  placeholder={step.id}
                  onChange={(e) => patchStep(index, { label: e.target.value })}
                />
                {live?.status && live.status !== 'pending' ? (
                  <span className="muted" style={{ fontSize: 10 }}>
                    {live.inRows ?? 0} → {live.outRows ?? 0} {tr('行')} {live.durationMs ? `· ${live.durationMs}ms` : ''}
                  </span>
                ) : null}
                {live?.status === 'error' && !open ? (
                  <button
                    type="button"
                    className="pipe-error-inline"
                    data-testid="pipe-error-inline"
                    title={live.error ?? ''}
                    onClick={() => {
                      setExpanded(index);
                      setSpotlightStep(step.id);
                    }}
                  >
                    {live.error ?? ''}
                  </button>
                ) : null}
                <button className="btn small" title={tr('试运行到这一步')} onClick={() => void trialTo(index)} disabled={busy === `trial-${index}`}>
                  {busy === `trial-${index}` ? <Loader2 size={11} className="spin" /> : <FlaskConical size={11} />} {tr(' 试到这步 ')}
                </button>
                <button className="icon-btn" onClick={() => moveStep(index, -1)} disabled={index === 0} title={tr('上移')}>
                  <ArrowUp size={11} />
                </button>
                <button className="icon-btn" onClick={() => moveStep(index, 1)} disabled={index === spec.steps.length - 1} title={tr('下移')}>
                  <ArrowDown size={11} />
                </button>
                <button className="icon-btn danger" onClick={() => removeStep(index)} title={tr('删除步骤')}>
                  <Trash2 size={11} />
                </button>
              </div>

              {scriptDisabled ? (
                <div className="hint" style={{ color: 'var(--warning)' }}>
                  {tr('脚本步骤当前关闭，用下方「允许脚本步骤」开启。')}
                </div>
              ) : null}
              {pythonMissing ? (
                <div className="hint" style={{ color: 'var(--warning)' }}>
                  {tr('本机没检测到 Python；装好后可用，或设置 AIDB_PYTHON 指向解释器。')}
                </div>
              ) : null}

              {open ? (
                <div className="pipe-fields">
                  <div className="form-grid" style={{ gap: 8 }}>
                    {(kind?.fields ?? []).map((field) => (
                      <FieldEditor
                        key={field.key}
                        field={field}
                        step={step}
                        credentials={credentials}
                        connections={connections}
                        spotlighted={spotlight === `${step.id}.${field.key}`}
                        onChange={(value) => patchWith(index, field.key, value)}
                      />
                    ))}
                  </div>
                  <div className="row gap-6" style={{ marginTop: 8 }}>
                    <span className="muted" style={{ fontSize: 10 }}>{tr('步骤 id')}</span>
                    <input
                      className="input"
                      style={{ width: 140 }}
                      value={step.id}
                      onChange={(e) => patchStep(index, { id: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })}
                    />
                    <span className="muted" style={{ fontSize: 10 }}>{tr('后面用 {0} 引用这一步的输出', [`{{ steps.${step.id}.rows }}`])}</span>
                  </div>
                  {live?.error ? (
                    <button
                      type="button"
                      data-testid="pipe-error"
                      className="pipe-error"
                      title={tr('展开这一步')}
                      onClick={() => {
                        setExpanded(index);
                        setSpotlightStep(step.id);
                      }}
                    >
                      {live.error}
                      {live.meta?.hint ? `｜${String(live.meta.hint)}` : ''}
                    </button>
                  ) : null}
                  {kind?.type === 'map' ? <MapPreview values={step.with} rows={(run?.steps[index - 1]?.sample ?? [])} /> : null}
                  {kind?.type === 'db.write' ? (
                    <div className="row gap-6" style={{ marginTop: 6 }}>
                      <button className="btn small" data-testid="pipe-auto-map" onClick={() => void autoMap(index)}>
                        {tr('按上一步列名自动映射')}
                      </button>
                      <span className="muted" style={{ fontSize: 10 }}>{tr('目标表存在时按同名交集，缺表时照源列建表')}</span>
                    </div>
                  ) : null}
                  {live?.preview ? (
                    <details className="pipe-preview" open={live.status === 'error'}>
                      <summary>{tr('实际发出的语句 / 请求体')}</summary>
                      <pre>{live.preview}</pre>
                    </details>
                  ) : null}
                  {live?.sample?.length ? (
                    <>
                      <div className="muted" style={{ fontSize: 10, margin: '6px 0 4px' }}>{tr('样本 {0} 行（共 {1} 行）', [Math.min(8, live.sample.length), live.outRows ?? live.sample.length])}</div>
                      <SampleTable columns={live.columns} rows={live.sample} />
                    </>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}

        <div className="row gap-6" style={{ marginTop: 8 }}>
          <Select
            className="select"
            style={{ width: 200 }}
            value=""
            onChange={(e) => e.target.value && addStep(e.target.value as PipelineStepType)}
          >
            <Option value="">{tr('（添加步骤）')}</Option>
            {PIPELINE_STEP_KINDS.map((item) => (
              <Option key={item.type} value={item.type}>
                {item.badge} · {label(item.label)}
              </Option>
            ))}
          </Select>
          <button className="btn small" onClick={() => void resetState()} disabled={!draftId} title={tr('清空增量断点')}>
            {tr('清空断点')}
          </button>
          <button className="btn small" onClick={() => setShowCredentials((value) => !value)}>
            <KeyRound size={11} /> {tr(' 接口凭证 ')}<span className="badge">{credentials.length}</span>
          </button>
        </div>

        {showCredentials ? <CredentialsPanel credentials={credentials} onChanged={() => void loadLists()} notify={notify} /> : null}

        {showRuns ? (
          <div className="setting-card" style={{ marginTop: 10 }}>
            <div className="row gap-6" style={{ marginBottom: 6 }}>
              <strong style={{ fontSize: 11 }}>{tr('运行历史')}</strong>
              <span className="muted">{tr('保留最近 40 次')}</span>
            </div>
            {!runs.length ? <div className="dash-empty">{tr('还没有运行记录')}</div> : null}
            {runs.map((item) => (
              <button
                key={item.id}
                className="job-row"
                style={{ width: '100%', textAlign: 'left', background: 'transparent' }}
                onClick={() => {
                  setRun(item);
                  setExpanded(0);
                }}
              >
                <div className="job-main">
                  <div className="row gap-6">
                    <span className={`status-led ${item.status === 'ok' ? 'ok' : item.status === 'error' ? 'error' : ''}`} />
                    <strong>{new Date(item.startedAt).toLocaleString()}</strong>
                    <span className="badge">{item.trigger === 'scheduled' ? tr('定时') : tr('手动')}</span>
                  </div>
                  <div className="listMeta">
                    {item.status === 'error' ? (item.error ?? '') : summaryText(item)}{item.durationMs ? ` · ${item.durationMs}ms` : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ) : null}

        {run && run.steps.some((step) => step.status !== 'pending') ? (
          <div className="row gap-6" style={{ marginTop: 10 }}>
            <span className={`status-led ${run.status === 'ok' ? 'ok' : run.status === 'error' ? 'error' : ''}`} />
            <span className="muted">
              {run.status === 'running' ? tr('运行中') : run.status === 'ok' ? tr('本次运行成功') : tr('本次运行失败')}
              {run.status === 'error' ? '' : ` · ${summaryText(run)}`}
              {run.error ? ` · ${run.error}` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MapPreview({ values, rows }: { values: Record<string, unknown>; rows: Record<string, unknown>[] }) {
  const outcome = useMemo(() => {
    try {
      return { ok: true as const, result: applyMapRule(rows, mapRuleFromValues(values)) };
    } catch (err: any) {
      return { ok: false as const, message: String(err?.message ?? err) };
    }
  }, [values, rows]);

  const untouched = !values.select && !values.explode && !values.filter && !values.project && !values.distinct && !values.sortBy && !values.limit;
  if (untouched) return null;
  return (
    <div className="pipe-playground" data-testid="pipe-playground">
      <div className="row gap-6" style={{ alignItems: 'center' }}>
        <span className="muted" style={{ fontSize: 10 }}>{tr('按样本试算')}</span>
        {outcome.ok ? (
          <span className="badge">{`${rows.length} → ${outcome.result.rows.length}`}</span>
        ) : (
          <span className="badge write">{tr('表达式有误')}</span>
        )}
        {outcome.ok && outcome.result.dropped ? (
          <span className="muted" style={{ fontSize: 10 }}>{tr('丢掉 {0} 行', [outcome.result.dropped])}</span>
        ) : null}
      </div>
      {outcome.ok ? (
        outcome.result.rows.length ? (
          <SampleTable columns={outcome.result.columns} rows={outcome.result.rows} />
        ) : (
          <div className="hint">{tr('样本行全部被过滤掉了，检查过滤条件里的字段名和大小写。')}</div>
        )
      ) : (
        <div className="hint" style={{ color: 'var(--danger)' }}>{outcome.message}</div>
      )}
      {!rows.length ? <div className="hint">{tr('还没有样本：先「试运行到上一步」，这里会实时试算当前规则。')}</div> : null}
    </div>
  );
}

function FieldEditor({
  field,
  step,
  credentials,
  connections,
  spotlighted,
  onChange,
}: {
  field: PipelineField;
  step: PipelineStep;
  credentials: PipelineCredentialInfo[];
  connections: { id: string; name: string }[];
  spotlighted?: boolean;
  onChange: (value: unknown) => void;
}) {
  const values = step.with ?? {};
  const showWhen = field.showWhen;
  if (showWhen) {
    const actual = String(values[showWhen.field] ?? '');
    const expected = Array.isArray(showWhen.equals) ? showWhen.equals : [showWhen.equals];
    const visible = showWhen.equals === '__any' ? actual.trim().length > 0 : expected.includes(actual);
    if (!visible) return null;
  }
  const raw = values[field.key] ?? field.default;
  const mono = field.type === 'code' || field.type === 'keymap' || field.type === 'expression' || field.type === 'jsonpath';
  const className = mono ? 'textarea mono' : 'input';

  return (
    <div className={`field${field.type === 'code' || field.type === 'keymap' ? ' full' : ''}${spotlighted ? ' pipe-field-spot' : ''}`}>
      <label>
        {label(field.label)}
        {field.required ? <span style={{ color: 'var(--danger)' }}> *</span> : null}
      </label>
      {field.type === 'boolean' ? (
        <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
          <input type="checkbox" checked={raw === true} onChange={(e) => onChange(e.target.checked)} />
          <span className="muted">{field.placeholder ?? ''}</span>
        </label>
      ) : null}
      {field.type === 'enum' ? (
        <Select className="select" value={String(raw ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(field.options ?? []).map((option) => (
            <Option key={option.value} value={option.value}>
              {label(option.label)}
            </Option>
          ))}
        </Select>
      ) : null}
      {field.type === 'number' ? (
        <input className="input" type="number" min={field.min} max={field.max} value={String(raw ?? '')} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
      ) : null}
      {field.type === 'credential' ? (
        <div className="row gap-4">
          <Select className="select" style={{ flex: 1 }} value={String(raw ?? '')} onChange={(e) => onChange(e.target.value || undefined)}>
            <Option value="">{tr('（不带认证）')}</Option>
            {credentials.map((item) => (
              <Option key={item.id} value={item.id}>
                {item.name}
              </Option>
            ))}
          </Select>
        </div>
      ) : null}
      {field.type === 'connection' ? (
        <Select className="select" value={String(raw ?? '')} onChange={(e) => onChange(e.target.value)}>
          <Option value="">{tr('（选择连接）')}</Option>
          {connections.map((conn) => (
            <Option key={conn.id} value={conn.id}>{conn.name}</Option>
          ))}
        </Select>
      ) : null}
      {field.type === 'database' ? (
        <DatabaseSelect connectionId={String(values.connectionId ?? '')} value={String(raw ?? '')} onChange={onChange} />
      ) : null}
      {field.type === 'keymap' ? (
        <textarea
          className="textarea mono"
          rows={4}
          value={formatKeymap(raw)}
          placeholder={field.placeholder ?? (field.key === 'project' ? 'total = @.price * @.qty' : tr('列名 = 源字段'))}
          onChange={(e) => onChange(parseKeymap(e.target.value))}
        />
      ) : null}
      {field.type === 'columns' ? (
        <input className="input" value={formatList(raw)} placeholder={field.placeholder ?? 'id, dt'} onChange={(e) => onChange(parseList(e.target.value))} />
      ) : null}
      {field.type === 'code' ? (
        <textarea
          className="textarea mono"
          rows={field.language === 'sql' ? 5 : 7}
          value={String(raw ?? '')}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {field.type === 'text' || field.type === 'expression' || field.type === 'jsonpath' || field.type === 'table' ? (
        <input
          className={className}
          value={String(raw ?? '')}
          placeholder={field.placeholder}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : null}
      {field.hint ? <span className="hint">{label(field.hint)}</span> : null}
    </div>
  );
}

function CredentialsPanel({
  credentials,
  onChanged,
  notify,
}: {
  credentials: PipelineCredentialInfo[];
  onChanged: () => void;
  notify: (kind: Toast['kind'], message: string, detail?: string) => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'bearer' | 'basic' | 'apikey' | 'header'>('bearer');
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [header, setHeader] = useState('X-API-Key');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const secret = kind === 'bearer' ? { token } : kind === 'basic' ? { username, password } : { header, value };
      await api.createPipelineCredential({ name, kind, secret });
      setName('');
      setToken('');
      setPassword('');
      setValue('');
      notify('success', tr('凭证已保存'), tr('流水线定义里只记录 id'));
      onChanged();
    } catch (err: any) {
      notify('error', tr('保存失败'), err?.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setting-card" style={{ marginTop: 8 }}>
      <div className="row gap-6" style={{ marginBottom: 6 }}>
        <strong style={{ fontSize: 11 }}>{tr('接口凭证')}</strong>
        <span className="muted">{tr('用 AES-256-GCM 存在 Gateway 本地库里，导出与 AI 生成都不会带出明文')}</span>
      </div>
      <div className="form-grid" style={{ gap: 8 }}>
        <div className="field">
          <label>{tr('名称')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tr('上游 API Key')} />
        </div>
        <div className="field">
          <label>{tr('类型')}</label>
          <Select className="select" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <Option value="bearer">Bearer</Option>
            <Option value="basic">Basic</Option>
            <Option value="apikey">API Key</Option>
          </Select>
        </div>
        {kind === 'bearer' ? (
          <div className="field">
            <label>Token</label>
            <SecretInput value={token} onChange={(e) => setToken(e.target.value)} name="aidb-pipeline-credential-token" />
          </div>
        ) : null}
        {kind === 'basic' ? (
          <>
            <div className="field">
              <label>{tr('用户名')}</label>
              <input
                className="input"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                name="aidb-pipeline-credential-user"
                data-form-type="other"
              />
            </div>
            <div className="field">
              <label>{tr('密码')}</label>
              <SecretInput value={password} onChange={(e) => setPassword(e.target.value)} name="aidb-pipeline-credential-password" />
            </div>
          </>
        ) : null}
        {kind === 'apikey' ? (
          <>
            <div className="field">
              <label>{tr('头名')}</label>
              <input className="input" value={header} onChange={(e) => setHeader(e.target.value)} />
            </div>
            <div className="field">
              <label>{tr('密钥值')}</label>
              <SecretInput value={value} onChange={(e) => setValue(e.target.value)} name="aidb-pipeline-credential-value" />
            </div>
          </>
        ) : null}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn primary" onClick={() => void create()} disabled={busy || !name.trim()}>
          {busy ? <Loader2 size={12} className="spin" /> : <Plus size={12} />} {tr(' 添加凭证 ')}
        </button>
      </div>
      {!credentials.length ? <div className="dash-empty">{tr('还没有凭证')}</div> : null}
      {credentials.map((item) => (
        <div key={item.id} className="job-row">
          <div className="job-main">
            <strong>{item.name}</strong>
            <div className="listMeta">{item.kind} · {item.summary ?? ''}</div>
          </div>
          <button
            className="icon-btn danger"
            onClick={async () => {
              await api.deletePipelineCredential(item.id);
              onChanged();
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
