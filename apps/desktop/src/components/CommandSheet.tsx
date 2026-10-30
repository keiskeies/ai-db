import { useEffect, useMemo, useState } from 'react';
import { Loader2, Play, RotateCcw, X } from 'lucide-react';
import type { ArtifactInfo, CommandDefinition, CommandRunEvent, CommandRunInfo, CommandRunInput, CommandSourceInput, NotificationChannelInfo } from '@aidb/core';
import { api, streamCommandRun, type SkillWorkerRun } from '../lib/api';
import { deliverExport } from '../lib/exportDelivery';
import { deliverExportedFile } from '../lib/desktop';
import { useApp } from '../store';
import { DatabaseSelect } from './DatabaseSelect';
import { FixView } from './FixView';
import { ReportView } from './ReportView';
import { RiskBadge } from './ui';

interface Props {
  command: CommandDefinition;
  onClose: () => void;
}

interface DiffResult {
  summary: { added: number; removed: number; changed: number; unchanged: number; statements: number };
  tables: Array<{
    name: string;
    status: 'added' | 'removed' | 'changed' | 'unchanged';
    changes: Array<{ kind: string; column?: string; detail: string; destructive?: boolean }>;
    sql: string[];
  }>;
  sql: string[];
}

interface ReconDraft {
  leftKind: 'table' | 'keyspace' | 'documents';
  leftTable: string;
  leftKeys: string;
  leftId: string;
  leftPattern: string;
  leftExtract: string;
  leftValueType: 'string' | 'hash' | 'json';
  leftFields: string;
  rightKind: 'table' | 'keyspace' | 'documents';
  rightTable: string;
  rightKeys: string;
  rightId: string;
  rightPattern: string;
  rightExtract: string;
  rightValueType: 'string' | 'hash' | 'json';
  rightFields: string;
  fieldMap: string;
  baseSide: 'left' | 'right' | 'none';
}

const splitList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);

function kindOf(engine?: string): 'table' | 'keyspace' | 'documents' {
  if (engine === 'redis') return 'keyspace';
  if (engine === 'mongodb' || engine === 'elasticsearch' || engine === 'opensearch') return 'documents';
  return 'table';
}

function parseFieldMap(value: string): Array<{ left: string; right: string }> {
  return splitList(value)
    .map((item) => {
      const [left, right] = item.split('=').map((part) => part.trim());
      return left && right ? { left, right } : undefined;
    })
    .filter((item): item is { left: string; right: string } => Boolean(item));
}

function defaultReconDraft(connections: Array<{ id: string; engine: string }>, sources: CommandSourceInput[]): ReconDraft {
  const left = connections.find((connection) => connection.id === sources[0]?.connectionId);
  const right = connections.find((connection) => connection.id === sources[1]?.connectionId);
  return {
    leftKind: kindOf(left?.engine),
    leftTable: '',
    leftKeys: 'id',
    leftId: '_id',
    leftPattern: '',
    leftExtract: '',
    leftValueType: 'hash',
    leftFields: '',
    rightKind: kindOf(right?.engine),
    rightTable: '',
    rightKeys: 'id',
    rightId: '_id',
    rightPattern: '',
    rightExtract: '',
    rightValueType: 'hash',
    rightFields: '',
    fieldMap: '',
    baseSide: 'left',
  };
}

function defaultValues(command: CommandDefinition): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const slot of command.slots) {
    if (slot.kind === 'sources' || slot.kind === 'mapping') continue;
    if (slot.default !== undefined) values[slot.key] = slot.default;
    else if (slot.kind === 'boolean') values[slot.key] = false;
    else if (slot.kind === 'tables') values[slot.key] = [];
    else if (slot.kind === 'number') values[slot.key] = undefined;
    else values[slot.key] = '';
  }
  return values;
}

function initialSources(command: CommandDefinition, connections: Array<{ id: string; name: string; database?: string }>, activeId?: string): CommandSourceInput[] {
  const first = connections.find((connection) => connection.id === activeId) ?? connections[0];
  const second = connections.find((connection) => connection.id !== first?.id) ?? first;
  const count = Math.max(command.sources.min, first ? 1 : 0);
  const picks = count >= 2 ? [first, second] : [first];
  return picks.filter(Boolean).map((connection, index) => ({
    connectionId: connection!.id,
    database: connection!.database,
    label: connection!.name || `源 ${index + 1}`,
  }));
}

export function CommandSheet({ command, onClose }: Props) {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const schemas = useApp((s) => s.schemas);
  const notify = useApp((s) => s.notify);
  const features = useApp((s) => s.settings.features);
  const [sources, setSources] = useState<CommandSourceInput[]>(() => initialSources(command, connections, activeConnectionId));
  const [values, setValues] = useState<Record<string, unknown>>(() => defaultValues(command));
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<CommandRunInfo | null>(null);
  const [events, setEvents] = useState<CommandRunEvent[]>([]);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'xlsx' | 'pptx' | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);
  const [deckTemplate, setDeckTemplate] = useState('');
  const [deckDeterministic, setDeckDeterministic] = useState(false);
  const [deckTemplates, setDeckTemplates] = useState<string[]>([]);
  const [deckBusy, setDeckBusy] = useState(false);
  const [deckRun, setDeckRun] = useState<SkillWorkerRun | null>(null);
  const [recent, setRecent] = useState<ArtifactInfo[]>([]);
  const [schedule, setSchedule] = useState<{ intervalSeconds: number; lastStatus?: string; notifyChannels: string[] } | null>(null);
  const [channels, setChannels] = useState<NotificationChannelInfo[]>([]);
  const [reconDraft, setReconDraft] = useState<ReconDraft>(() => defaultReconDraft(connections, sources));

  const engineOf = (connectionId?: string) => connections.find((connection) => connection.id === connectionId)?.engine;
  useEffect(() => {
    setReconDraft((draft) => ({
      ...draft,
      leftKind: kindOf(engineOf(sources[0]?.connectionId)),
      rightKind: kindOf(engineOf(sources[1]?.connectionId)),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sources[0]?.connectionId, sources[1]?.connectionId, connections]);

  useEffect(() => {
    if (sources.length || !connections.length) return;
    setSources(initialSources(command, connections, activeConnectionId));
  }, [connections, activeConnectionId, command, sources.length]);

  const refreshRecent = async () => {
    try {
      const { artifacts } = await api.artifacts({ type: command.artifact, limit: 8 });
      setRecent(artifacts);
    } catch {
      setRecent([]);
    }
  };

  useEffect(() => {
    void refreshRecent();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command.id]);

  useEffect(() => {
    api
      .notificationChannels()
      .then((result) => setChannels(result.channels))
      .catch(() => setChannels([]));
  }, []);

  useEffect(() => {
    if (!artifactId) {
      setSchedule(null);
      return;
    }
    api
      .artifactSchedule(artifactId)
      .then((result) =>
        setSchedule(
          result.schedule
            ? { intervalSeconds: result.schedule.intervalSeconds, lastStatus: result.schedule.lastStatus, notifyChannels: result.schedule.notifyChannels ?? [] }
            : null,
        ),
      )
      .catch(() => setSchedule(null));
  }, [artifactId]);

  const openArtifact = async (artifact: ArtifactInfo) => {
    try {
      const { runs } = await api.artifactRuns(artifact.id, 1);
      const latest = runs[0];
      if (!latest) {
        setError('该产物还没有运行结果');
        return;
      }
      setArtifactId(artifact.id);
      setResult(latest.result ?? null);
      setRun({
        id: latest.id,
        command: command.id,
        title: artifact.title,
        status: latest.status,
        input: {},
        steps: [{ id: 'loaded', label: '已保存的产物', kind: 'deterministic', status: 'ok' }],
        artifactId: artifact.id,
        createdAt: latest.startedAt,
      });
      setEvents([]);
      setError(null);
    } catch (err: any) {
      notify('error', '打开产物失败', err?.message);
    }
  };

  const tables = useMemo(() => {
    const connectionId = sources[0]?.connectionId;
    if (!connectionId) return [];
    return (schemas[connectionId] ?? []).flatMap((schema) => schema.tables).filter((table) => table.type === 'table');
  }, [schemas, sources]);

  const setSource = (index: number, patch: Partial<CommandSourceInput>) => {
    setSources((prev) => prev.map((source, i) => (i === index ? { ...source, ...patch } : source)));
  };

  const addSource = () => {
    if (sources.length >= command.sources.max) return;
    const used = new Set(sources.map((source) => source.connectionId));
    const next = connections.find((connection) => !used.has(connection.id)) ?? connections[0];
    if (!next) return;
    setSources((prev) => [...prev, { connectionId: next.id, database: next.database, label: next.name }]);
  };

  const removeSource = (index: number) => {
    if (sources.length <= command.sources.min) return;
    setSources((prev) => prev.filter((_, i) => i !== index));
  };

  const loadResult = async (id: string) => {
    try {
      const { runs } = await api.artifactRuns(id, 1);
      setResult((runs[0]?.result as DiffResult | undefined) ?? null);
    } catch {
      setResult(null);
    }
  };

  const start = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    setEvents([]);
    setResult(null);
    setArtifactId(null);
    try {
      const input: CommandRunInput = { sources, ...values };
      if (command.id === 'recon') {
        const leftSource = sources[0];
        const rightSource = sources[1];
        if (!leftSource || !rightSource) throw new Error('对账需要两个源');
        const left: Record<string, unknown> = {
          kind: reconDraft.leftKind,
          connectionId: leftSource.connectionId,
          database: leftSource.database,
        };
        if (reconDraft.leftKind === 'table') {
          left.table = reconDraft.leftTable;
          left.keyColumns = splitList(reconDraft.leftKeys);
        } else if (reconDraft.leftKind === 'documents') {
          left.collection = reconDraft.leftTable;
          left.idField = reconDraft.leftId || '_id';
          left.fields = splitList(reconDraft.leftFields);
        } else {
          left.keyPattern = reconDraft.leftPattern;
          left.keyExtract = reconDraft.leftExtract;
          left.valueType = reconDraft.leftValueType;
          left.fields = splitList(reconDraft.leftFields);
        }
        const right: Record<string, unknown> = {
          kind: reconDraft.rightKind,
          connectionId: rightSource.connectionId,
          database: rightSource.database,
        };
        if (reconDraft.rightKind === 'table') {
          right.table = reconDraft.rightTable;
          right.keyColumns = splitList(reconDraft.rightKeys);
        } else if (reconDraft.rightKind === 'documents') {
          right.collection = reconDraft.rightTable;
          right.idField = reconDraft.rightId || '_id';
          right.fields = splitList(reconDraft.rightFields);
        } else {
          right.keyPattern = reconDraft.rightPattern;
          right.keyExtract = reconDraft.rightExtract;
          right.valueType = reconDraft.rightValueType;
          right.fields = splitList(reconDraft.rightFields);
        }
        input.mapping = {
          mode: `${reconDraft.leftKind}-${reconDraft.rightKind}`,
          left,
          right,
          fieldMap: parseFieldMap(reconDraft.fieldMap),
          baseSide: reconDraft.baseSide,
          maxKeys: Number(values.maxKeys) || 200000,
        };
      }
      const started = await api.startCommand(command.id, input, {
        title: `${command.title.zh}${sources.length ? ` · ${sources.map((source) => source.label || source.connectionId).join(' ↔ ')}` : ''}`,
      });
      setRun(started.run);
      await streamCommandRun(started.run.id, (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === 'step_started' || event.type === 'step_succeeded' || event.type === 'step_failed') {
          setRun((prev) =>
            prev
              ? {
                  ...prev,
                  steps: prev.steps.map((step) =>
                    step.id === event.stepId
                      ? {
                          ...step,
                          status: event.type === 'step_started' ? 'running' : event.type === 'step_succeeded' ? 'ok' : 'error',
                          summary: event.type === 'step_succeeded' ? event.summary : step.summary,
                          error: event.type === 'step_failed' ? event.error : step.error,
                        }
                      : step,
                  ),
                }
              : prev,
          );
        }
        if (event.type === 'artifact_ready') {
          setArtifactId(event.artifactId);
          void loadResult(event.artifactId);
        }
        if (event.type === 'run_finished') {
          setRun((prev) => (prev ? { ...prev, status: event.status } : prev));
          setRunning(false);
        }
        if (event.type === 'error') setError(event.message);
      });
      void refreshRecent();
    } catch (err: any) {
      setError(err?.message ?? String(err));
      notify('error', '命令启动失败', err?.message);
    } finally {
      setRunning(false);
    }
  };

  const rerun = async () => {
    if (!artifactId || running) return;
    setRunning(true);
    setEvents([]);
    setError(null);
    try {
      const started = await api.rerunArtifact(artifactId);
      setRun(started.run);
      await streamCommandRun(started.run.id, (event) => {
        setEvents((prev) => [...prev, event]);
        if (event.type === 'artifact_ready') void loadResult(event.artifactId);
        if (event.type === 'run_finished') setRunning(false);
        if (event.type === 'error') setError(event.message);
      });
      void refreshRecent();
    } catch (err: any) {
      setError(err?.message ?? String(err));
      notify('error', '重跑失败', err?.message);
    } finally {
      setRunning(false);
    }
  };

  const doExport = async (format: 'xlsx' | 'pptx') => {
    if (!artifactId || exporting) return;
    setExporting(format);
    try {
      const file = await api.exportArtifact(artifactId, format);
      await deliverExport(file, format === 'pptx' ? '导出 PPT' : '导出 Excel');
    } catch (err: any) {
      notify('error', '导出失败', err?.message);
    } finally {
      setExporting(null);
    }
  };

  useEffect(() => {
    if (!deckOpen || deckTemplates.length) return;
    void (async () => {
      try {
        const { skills } = await api.skills(false);
        const skill = skills.find((item) => item.id === 'ppt-master') ?? skills.find((item) => item.name === 'ppt-master');
        if (!skill) return;
        const { skill: detail } = await api.skill(skill.id);
        const kinds = ['brands', 'styles', 'layouts', 'decks'];
        const found = new Set<string>();
        for (const file of detail.files) {
          const parts = file.path.split('/');
          if (parts[0] === 'templates' && kinds.includes(parts[1]) && parts[2]) found.add(`${parts[1]}/${parts[2]}`);
        }
        setDeckTemplates([...found].sort());
      } catch {
        /* template catalog is optional */
      }
    })();
  }, [deckOpen, deckTemplates.length]);

  const startDeck = async () => {
    if (!artifactId || deckBusy) return;
    setDeckBusy(true);
    try {
      const { run: started } = await api.artifactDeck(artifactId, { template: deckTemplate.trim() || undefined, mode: deckDeterministic ? 'deterministic' : 'agent' });
      setDeckRun({
        runId: started.runId,
        skill: started.skill,
        status: 'running',
        text: '',
        outputs: [],
        startedAt: new Date().toISOString(),
      });
    } catch (err: any) {
      notify('error', '启动 PPT Master 失败', err?.message);
    } finally {
      setDeckBusy(false);
    }
  };

  const saveDeckFile = async (area: string, path: string) => {
    if (!deckRun?.workspace) return;
    const source = `${deckRun.workspace}/${area}/${path}`;
    const saved = await deliverExportedFile(source);
    if (!saved) notify('info', '产物路径', source);
    else if (saved.ok) notify('success', '已保存 PPT', saved.path ?? source);
    else if (saved.canceled) notify('info', '未选择位置', `文件仍在 ${source}`);
    else notify('error', '保存失败', saved.error ?? source);
  };

  useEffect(() => {
    if (!deckRun || deckRun.status !== 'running') return;
    let active = true;
    const timer = setInterval(() => {
      void api.skillRun(deckRun.runId).then(({ run }) => {
        if (active) setDeckRun(run);
      }).catch(() => undefined);
    }, 1500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [deckRun?.runId, deckRun?.status]);

  const changeSchedule = async (intervalSeconds: number) => {
    if (!artifactId) return;
    try {
      if (!intervalSeconds) {
        await api.deleteArtifactSchedule(artifactId);
        setSchedule(null);
      } else {
        const { schedule: next } = await api.setArtifactSchedule(artifactId, {
          intervalSeconds,
          notifyChannels: schedule?.notifyChannels ?? [],
        });
        setSchedule({ intervalSeconds: next.intervalSeconds, lastStatus: next.lastStatus, notifyChannels: next.notifyChannels ?? [] });
      }
    } catch (err: any) {
      notify('error', '设置定时失败', err?.message);
    }
  };

  const toggleNotifyChannel = async (channelId: string) => {
    if (!artifactId || !schedule) return;
    const next = schedule.notifyChannels.includes(channelId)
      ? schedule.notifyChannels.filter((id) => id !== channelId)
      : [...schedule.notifyChannels, channelId];
    try {
      const { schedule: updated } = await api.setArtifactSchedule(artifactId, {
        intervalSeconds: schedule.intervalSeconds,
        notifyChannels: next,
      });
      setSchedule({ intervalSeconds: updated.intervalSeconds, lastStatus: updated.lastStatus, notifyChannels: updated.notifyChannels ?? [] });
    } catch (err: any) {
      notify('error', '保存通知绑定失败', err?.message);
    }
  };

  const executeRecon = async () => {
    if (!artifactId) return;
    if (sources[1] && engineOf(sources[1].connectionId) !== 'redis') return;
    const confirm = window.prompt('Redis 写回会先快照受影响键，再执行 HSET/SET/DEL。\n请输入 EXECUTE 确认：');
    if (confirm !== 'EXECUTE') return;
    try {
      const result = await api.executeReconRepair(artifactId, { confirm });
      notify(
        result.failed || result.verification?.ok === false ? 'warning' : 'success',
        result.failed ? 'Redis 修复部分失败' : 'Redis 修复完成',
        `${result.executed} 条成功 · ${result.failed} 条失败${result.backupPath ? ` · 快照 ${result.backupPath}` : ''}${result.verification ? ` · 复检：缺失 ${result.verification.missingInRight} / 多余 ${result.verification.extraInRight} / 改值 ${result.verification.valueChanged}` : ''}`,
      );
      await loadResult(artifactId);
    } catch (err: any) {
      notify('error', 'Redis 修复失败', err?.message);
    }
  };

  const executeFix = async (steps: number[]) => {
    if (!artifactId) return;
    const confirm = window.prompt('执行修复会先备份目标库，然后逐条执行计划。\n请输入 EXECUTE 确认：');
    if (confirm !== 'EXECUTE') return;
    try {
      const result = await api.executeFixPlan(artifactId, { confirm, backup: true, steps });
      notify(
        result.failed ? 'warning' : 'success',
        result.failed ? '修复部分失败' : '修复执行完成',
        `${result.executed} 条成功 · ${result.failed} 条失败${result.backupPath ? ` · 备份 ${result.backupPath}` : ''}${result.verification ? ` · 复检：${result.verification.summary}` : ''}`,
      );
      await loadResult(artifactId);
    } catch (err: any) {
      notify('error', '执行修复失败', err?.message);
    }
  };

  const syncDiff = async () => {
    const target = sources[1];
    if (!target || !result?.sql?.length) return;
    const destructive = (result.tables ?? []).some((table: DiffResult['tables'][number]) =>
      (table.changes ?? []).some((change) => change.destructive),
    );
    const confirmed = window.confirm(
      `将把 ${result.sql.length} 条结构变更同步到「${target.label || target.connectionId}」${destructive ? '，其中包含破坏性变更' : ''}。\n\n建议先备份目标库。确认继续？`,
    );
    if (!confirmed) return;
    try {
      if (destructive) {
        const { backup } = await api.createBackup({
          connectionId: target.connectionId,
          database: target.database,
          label: 'diff-sync',
        });
        notify('info', '已备份目标库', backup.path);
      }
      await api.syncSchema({ connectionId: target.connectionId, database: target.database, statements: result.sql });
      notify('success', '结构同步完成', `${result.sql.length} 条语句`);
      await start();
    } catch (err: any) {
      notify('error', '结构同步失败', err?.message);
    }
  };

  const renderSlot = (slot: CommandDefinition['slots'][number]) => {
    const value = values[slot.key];
    const set = (next: unknown) => setValues((prev) => ({ ...prev, [slot.key]: next }));
    if (slot.kind === 'text') {
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}</label>
          <input className="input" value={String(value ?? '')} placeholder={slot.placeholder} onChange={(e) => set(e.target.value)} />
        </div>
      );
    }
    if (slot.kind === 'enum') {
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}</label>
          <select className="select" value={String(value ?? '')} onChange={(e) => set(e.target.value)}>
            {(slot.options ?? []).map((option) => (
              <option key={option.value} value={option.value}>{option.label.zh}</option>
            ))}
          </select>
        </div>
      );
    }
    if (slot.kind === 'number') {
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}</label>
          <input
            className="input"
            type="number"
            value={value === undefined ? '' : Number(value)}
            min={slot.min}
            max={slot.max}
            onChange={(e) => set(e.target.value === '' ? undefined : Number(e.target.value))}
          />
        </div>
      );
    }
    if (slot.kind === 'boolean') {
      return (
        <label className="field" key={slot.key} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={Boolean(value)} onChange={(e) => set(e.target.checked)} />
          <span>{slot.label.zh}</span>
        </label>
      );
    }
    if (slot.kind === 'tables') {
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}（可选）</label>
          <div className="panel" style={{ maxHeight: 150, overflow: 'auto', padding: 8 }}>
            {tables.length ? (
              tables.map((table) => {
                const selected = Array.isArray(value) && (value as string[]).includes(table.name);
                return (
                  <label key={table.name} className="transfer-row" style={{ padding: '3px 4px' }}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) => {
                        const current = new Set(Array.isArray(value) ? (value as string[]) : []);
                        if (e.target.checked) current.add(table.name);
                        else current.delete(table.name);
                        set([...current]);
                      }}
                    />
                    <span className="mono">{table.name}</span>
                  </label>
                );
              })
            ) : (
              <span className="muted">当前源没有加载到表；留空会对比全部对象。</span>
            )}
          </div>
        </div>
      );
    }
    if (slot.kind === 'period') {
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}（可选）</label>
          <input
            className="input"
            placeholder="例如：最近 7 天 / 2026-10-01..2026-10-31"
            value={String(value ?? '')}
            onChange={(e) => set(e.target.value)}
          />
        </div>
      );
    }
    if (slot.kind === 'mapping') {
      const leftEngine = engineOf(sources[0]?.connectionId);
      const rightEngine = engineOf(sources[1]?.connectionId);
      const tablesFor = (connectionId?: string) =>
        connectionId ? (schemas[connectionId] ?? []).flatMap((schema) => schema.tables).filter((table) => table.type === 'table') : [];
      const setDraft = (patch: Partial<ReconDraft>) => setReconDraft((draft) => ({ ...draft, ...patch }));
      return (
        <div className="field" key={slot.key}>
          <label>{slot.label.zh}</label>
          <div className="panel" style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <span className="badge">{reconDraft.leftKind === 'table' ? `表 · ${leftEngine ?? ''}` : reconDraft.leftKind === 'documents' ? `文档 · ${leftEngine ?? ''}` : `键空间 · ${leftEngine ?? ''}`}</span>
              {reconDraft.leftKind === 'table' ? (
                <>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="左表名"
                    list="recon-left-tables"
                    value={reconDraft.leftTable}
                    onChange={(e) => setDraft({ leftTable: e.target.value })}
                  />
                  <datalist id="recon-left-tables">
                    {tablesFor(sources[0]?.connectionId).map((table) => <option key={table.name} value={table.name} />)}
                  </datalist>
                  <input className="input" style={{ width: 110 }} placeholder="键列 id" value={reconDraft.leftKeys} onChange={(e) => setDraft({ leftKeys: e.target.value })} />
                </>
              ) : reconDraft.leftKind === 'documents' ? (
                <>
                  <input className="input" style={{ flex: 1 }} placeholder="collection / index" value={reconDraft.leftTable} onChange={(e) => setDraft({ leftTable: e.target.value })} />
                  <input className="input" style={{ width: 90 }} placeholder="_id" value={reconDraft.leftId} onChange={(e) => setDraft({ leftId: e.target.value })} />
                </>
              ) : (
                <>
                  <input className="input" style={{ flex: 1 }} placeholder="键模式 user:*" value={reconDraft.leftPattern} onChange={(e) => setDraft({ leftPattern: e.target.value })} />
                  <input className="input" style={{ width: 130 }} placeholder="提取正则" value={reconDraft.leftExtract} onChange={(e) => setDraft({ leftExtract: e.target.value })} />
                </>
              )}
            </div>
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <span className="badge">{reconDraft.rightKind === 'table' ? `表 · ${rightEngine ?? ''}` : reconDraft.rightKind === 'documents' ? `文档 · ${rightEngine ?? ''}` : `键空间 · ${rightEngine ?? ''}`}</span>
              {reconDraft.rightKind === 'table' ? (
                <>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder="右表名"
                    list="recon-right-tables"
                    value={reconDraft.rightTable}
                    onChange={(e) => setDraft({ rightTable: e.target.value })}
                  />
                  <datalist id="recon-right-tables">
                    {tablesFor(sources[1]?.connectionId).map((table) => <option key={table.name} value={table.name} />)}
                  </datalist>
                  <input className="input" style={{ width: 110 }} placeholder="键列 id" value={reconDraft.rightKeys} onChange={(e) => setDraft({ rightKeys: e.target.value })} />
                </>
              ) : reconDraft.rightKind === 'documents' ? (
                <>
                  <input className="input" style={{ flex: 1 }} placeholder="collection / index" value={reconDraft.rightTable} onChange={(e) => setDraft({ rightTable: e.target.value })} />
                  <input className="input" style={{ width: 90 }} placeholder="_id" value={reconDraft.rightId} onChange={(e) => setDraft({ rightId: e.target.value })} />
                </>
              ) : (
                <>
                  <input className="input" style={{ flex: 1 }} placeholder="键模式 user:*" value={reconDraft.rightPattern} onChange={(e) => setDraft({ rightPattern: e.target.value })} />
                  <input className="input" style={{ width: 130 }} placeholder="提取正则 ^user:(.+)$" value={reconDraft.rightExtract} onChange={(e) => setDraft({ rightExtract: e.target.value })} />
                  <select className="select" style={{ width: 86 }} value={reconDraft.rightValueType} onChange={(e) => setDraft({ rightValueType: e.target.value as ReconDraft['rightValueType'] })}>
                    <option value="hash">hash</option>
                    <option value="string">string</option>
                    <option value="json">json</option>
                  </select>
                </>
              )}
            </div>
            {reconDraft.leftKind !== 'table' || reconDraft.rightKind !== 'table' ? (
              <input
                className="input"
                placeholder="Redis 字段（逗号分隔，如 name,email,status）"
                value={reconDraft.rightKind !== 'table' ? reconDraft.rightFields : reconDraft.leftFields}
                onChange={(e) => setDraft(reconDraft.rightKind !== 'table' ? { rightFields: e.target.value } : { leftFields: e.target.value })}
              />
            ) : null}
            <input
              className="input"
              placeholder="字段映射（可选，如 name=name,email=email；留空按同名列自动匹配）"
              value={reconDraft.fieldMap}
              onChange={(e) => setDraft({ fieldMap: e.target.value })}
            />
            <div className="row gap-6" style={{ alignItems: 'center' }}>
              <span className="muted" style={{ fontSize: 11 }}>基准侧</span>
              <select className="select" style={{ width: 120 }} value={reconDraft.baseSide} onChange={(e) => setDraft({ baseSide: e.target.value as ReconDraft['baseSide'] })}>
                <option value="left">左侧（生成修复）</option>
                <option value="none">只看差异</option>
                <option value="right">右侧（暂不生成）</option>
              </select>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  const finished = run?.status === 'succeeded' || run?.status === 'failed' || run?.status === 'canceled';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label={command.title.zh} style={{ height: 'min(720px, 90vh)' }}>
        <div className="modal-head">
          <h2>
            {command.title.zh}
            <RiskBadge risk={command.maxRisk} />
          </h2>
          <button className="icon-btn" onClick={onClose} title="关闭"><X size={14} /></button>
        </div>
        <div className="modal-body" style={{ display: 'flex', gap: 14, minHeight: 0 }}>
          <div className="tool-pane" style={{ flex: 1, minWidth: 0 }}>
            <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>{command.description.zh}</div>
            <div className="tool-scroll" style={{ padding: 0 }}>
              <div className="field">
                <label>数据源</label>
                {sources.map((source, index) => (
                  <div key={index} className="panel" style={{ padding: 8, marginBottom: 6 }}>
                    <div className="row gap-6" style={{ alignItems: 'center' }}>
                      <select
                        className="select"
                        style={{ flex: 1 }}
                        value={source.connectionId}
                        onChange={(e) => {
                          const connection = connections.find((item) => item.id === e.target.value);
                          setSource(index, { connectionId: e.target.value, database: connection?.database, label: connection?.name });
                        }}
                      >
                        {connections.map((connection) => (
                          <option key={connection.id} value={connection.id}>{connection.name} · {connection.engine}</option>
                        ))}
                      </select>
                      {sources.length > command.sources.min ? (
                        <button className="icon-btn" onClick={() => removeSource(index)} title="移除源"><X size={12} /></button>
                      ) : null}
                    </div>
                    <div style={{ marginTop: 6 }}>
                      <DatabaseSelect
                        connectionId={source.connectionId}
                        value={source.database ?? ''}
                        onChange={(database) => setSource(index, { database })}
                        testId={`command-source-${index}`}
                      />
                    </div>
                  </div>
                ))}
                {sources.length < command.sources.max ? (
                  <button className="btn small" onClick={addSource} style={{ alignSelf: 'flex-start' }}>+ 添加源</button>
                ) : null}
              </div>
              {command.slots.filter((slot) => slot.kind !== 'sources').map(renderSlot)}
              {recent.length ? (
                <div className="field">
                  <label>最近产物</label>
                  <div className="panel" style={{ maxHeight: 120, overflow: 'auto' }}>
                    {recent.map((artifact) => (
                      <button
                        key={artifact.id}
                        className="transfer-row"
                        style={{ width: '100%', border: 0, background: 'transparent', textAlign: 'left', cursor: 'pointer' }}
                        onClick={() => void openArtifact(artifact)}
                      >
                        <span className="badge">{artifact.type}</span>
                        <span className="truncate">{artifact.title}</span>
                        <span className="spacer" />
                        <span className="muted" style={{ fontSize: 10 }}>{new Date(artifact.updatedAt).toLocaleString()}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, paddingTop: 10 }}>
              {artifactId ? (
                <select
                  className="select"
                  style={{ width: 104 }}
                  value={schedule?.intervalSeconds ?? 0}
                  onChange={(e) => void changeSchedule(Number(e.target.value))}
                  title={schedule?.lastStatus ? `上次定时运行：${schedule.lastStatus}` : '设置定时刷新'}
                >
                  <option value={0}>不定时</option>
                  <option value={3600}>每小时</option>
                  <option value={86400}>每天</option>
                </select>
              ) : null}
              {artifactId && schedule && channels.length ? (
                <div className="row gap-6" style={{ alignItems: 'center' }}>
                  <span className="muted" style={{ fontSize: 10 }}>通知</span>
                  {channels.map((channel) => (
                    <label key={channel.id} className="row gap-6" style={{ alignItems: 'center', fontSize: 10 }}>
                      <input
                        type="checkbox"
                        checked={schedule.notifyChannels.includes(channel.id)}
                        onChange={() => void toggleNotifyChannel(channel.id)}
                      />
                      {channel.name}
                    </label>
                  ))}
                </div>
              ) : null}
              {artifactId ? (
                <>
                  <button className="btn" onClick={() => void doExport('xlsx')} disabled={Boolean(exporting) || running}>
                    {exporting === 'xlsx' ? <Loader2 size={12} className="spin" /> : null} Excel
                  </button>
                  <button className="btn" onClick={() => void doExport('pptx')} disabled={Boolean(exporting) || running}>
                    {exporting === 'pptx' ? <Loader2 size={12} className="spin" /> : null} PPT
                  </button>
                  {features.reportDeck ? (
                    <button className="btn" onClick={() => setDeckOpen((open) => !open)} disabled={running || deckRun?.status === 'running'}>
                      AI PPT
                    </button>
                  ) : null}
                </>
              ) : null}
              {artifactId ? <button className="btn" onClick={() => void rerun()} disabled={running}><RotateCcw size={12} /> 重跑</button> : null}
              <button className="btn primary" onClick={() => void start()} disabled={running || !sources.length}>
                {running ? <Loader2 size={12} className="spin" /> : <Play size={12} />} 运行
              </button>
            </div>
            {deckOpen && features.reportDeck ? (
              <div className="panel" data-testid="deck-panel" style={{ marginTop: 10 }}>
                <div className="panel-head" style={{ paddingLeft: 0 }}>PPT Master 生成</div>
                <div className="tool-row" style={{ padding: 0, border: 0 }}>
                  <div className="field" style={{ flex: 1 }}>
                    <label>模板路径（可选，来自已安装 Skill）</label>
                    <input
                      className="input"
                      list="aidb-deck-templates"
                      value={deckTemplate}
                      onChange={(e) => setDeckTemplate(e.target.value)}
                      placeholder="templates/brands/accenture"
                    />
                    <datalist id="aidb-deck-templates">
                      {deckTemplates.map((item) => <option key={item} value={`templates/${item}`} />)}
                    </datalist>
                  </div>
                  <button className="btn primary" onClick={() => void startDeck()} disabled={deckBusy || deckRun?.status === 'running'}>
                    {deckBusy || deckRun?.status === 'running' ? <Loader2 size={12} className="spin" /> : <Play size={12} />} 生成
                  </button>
                </div>
                <label className="row gap-6" style={{ alignItems: 'center', fontSize: 10, marginTop: 6 }}>
                  <input type="checkbox" checked={deckDeterministic} onChange={(e) => setDeckDeterministic(e.target.checked)} />
                  确定性排版（不调用模型，数字逐字来自报告）
                </label>
                {deckRun ? (
                  <div style={{ marginTop: 8 }}>
                    <div className="row gap-6" style={{ alignItems: 'center' }}>
                      <span data-testid="deck-status" className={`badge ${deckRun.status === 'failed' ? 'danger' : ''}`}>{deckRun.status}</span>
                      {deckRun.error ? <span className="muted" style={{ fontSize: 10 }}>{deckRun.error}</span> : null}
                    </div>
                    {deckRun.outputs.filter((file) => file.type === 'file' && file.path.endsWith('.pptx')).map((file) => (
                      <div key={`${file.area}/${file.path}`} data-testid="deck-output" className="tool-row" style={{ padding: '3px 0', border: 0 }}>
                        <span className="mono" style={{ flex: 1, fontSize: 10 }}>{file.path} <span className="muted">{file.size ?? 0}B</span></span>
                        <button className="btn small" onClick={() => void saveDeckFile(file.area, file.path)}>保存</button>
                      </div>
                    ))}
                    {deckRun.text ? (
                      <pre className="mono" style={{ margin: '6px 0 0', padding: 8, maxHeight: 180, overflow: 'auto', background: 'var(--bg-inset)', fontSize: 10, whiteSpace: 'pre-wrap' }}>
                        {deckRun.text.slice(-3000)}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="tool-pane" style={{ flex: 1, minWidth: 0, borderLeft: '1px solid var(--border-subtle)', paddingLeft: 14 }}>
            <div className="panel-head" style={{ paddingLeft: 0 }}>
              执行
              {run ? <span className="badge">{run.status}</span> : null}
            </div>
            <div className="tool-scroll" style={{ padding: 0 }}>
              {!run ? (
                <div className="dash-empty">运行后会在这里显示步骤、差异和产物。</div>
              ) : (
                <>
                  {run.steps.map((step) => (
                    <div key={step.id} className="transfer-row" style={{ padding: '5px 0' }}>
                      <span className={`badge ${step.status === 'ok' ? 'read' : step.status === 'error' ? 'destructive' : ''}`}>{step.status}</span>
                      <span>{step.label}</span>
                      <span className="spacer" />
                      <span className="muted" style={{ fontSize: 10 }}>{step.summary ?? ''}</span>
                    </div>
                  ))}
                  {error ? <div className="dash-empty" style={{ color: 'var(--danger)' }}>{error}</div> : null}
                  {result ? (
                    <div style={{ marginTop: 10 }}>
                      {command.id === 'diff' ? (
                        <>
                          <div className="tool-summary">
                            新增 {result.summary.added} · 删除 {result.summary.removed} · 变更 {result.summary.changed} · {result.summary.statements} 条语句
                          </div>
                          <div className="panel" style={{ marginTop: 8 }}>
                            <div className="panel-head">对象 <span className="badge">{result.tables.length}</span></div>
                            <div style={{ maxHeight: 260, overflow: 'auto' }}>
                              {result.tables.map((table: DiffResult['tables'][number]) => (
                                <div key={table.name} className="transfer-row">
                                  <span className={`badge ${table.status === 'added' ? 'read' : table.status === 'removed' ? 'destructive' : 'write'}`}>{table.status}</span>
                                  <span className="mono">{table.name}</span>
                                  <span className="spacer" />
                                  <span className="muted" style={{ fontSize: 10 }}>{table.changes.length} 项变更</span>
                                </div>
                              ))}
                            </div>
                          </div>
                          {result.sql.length ? (
                            <>
                              <pre
                                className="mono"
                                style={{ marginTop: 8, padding: 8, maxHeight: 180, overflow: 'auto', background: 'var(--bg-inset)', borderRadius: 6, fontSize: 10 }}
                              >
                                {result.sql.join(';\n')}
                              </pre>
                              <div className="row" style={{ justifyContent: 'flex-end', marginTop: 6 }}>
                                <button className="btn" onClick={() => void syncDiff()} disabled={running || sources.length < 2}>
                                  同步到 B
                                </button>
                              </div>
                            </>
                          ) : null}
                        </>
                      ) : command.id === 'recon' ? (
                        <>
                          <div className="tool-summary">
                            {result.summary.comparedKeys} 键 · 缺失 {result.summary.missingInRight} · 多余 {result.summary.extraInRight} · 改值 {result.summary.valueChanged}
                            {result.summary.typeDrift ? ` · 类型漂移 ${result.summary.typeDrift}` : ''}
                          </div>
                          <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>
                            {result.target.left} ↔ {result.target.right} · 左 {result.target.counts.left} / 右 {result.target.counts.right}
                            {result.summary.truncated ? ' · 已截断' : ''}
                          </div>
                          <div className="panel" style={{ marginTop: 8 }}>
                            <div className="panel-head">差异 <span className="badge">{result.target.differences.length}</span></div>
                            <div style={{ maxHeight: 260, overflow: 'auto' }}>
                              {result.target.differences.map((diff: any) => (
                                <div key={`${diff.key}-${diff.status}`} className="transfer-row">
                                  <span className={`badge ${diff.status === 'missing_in_right' ? 'destructive' : diff.status === 'extra_in_right' ? 'write' : 'read'}`}>{diff.status}</span>
                                  <span className="mono">{diff.key}</span>
                                  <span className="spacer" />
                                  <span className="muted" style={{ fontSize: 10 }}>{(diff.fields ?? []).join(', ')}</span>
                                </div>
                              ))}
                              {!result.target.differences.length ? <div className="dash-empty">没有发现差异。</div> : null}
                            </div>
                          </div>
                          {result.repair.length ? (
                            <pre
                              className="mono"
                              style={{ marginTop: 8, padding: 8, maxHeight: 180, overflow: 'auto', background: 'var(--bg-inset)', borderRadius: 6, fontSize: 10 }}
                            >
                              {result.repair.join('\n')}
                            </pre>
                          ) : (
                            <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>{result.repairNote}</div>
                          )}
                          {result.notes?.map((note: string) => (
                            <div key={note} className="muted" style={{ fontSize: 10, marginTop: 4 }}>{note}</div>
                          ))}
                        </>
                      ) : command.id === 'report' || command.id === 'compare' ? (
                        <ReportView spec={result} />
                      ) : command.id === 'fix' ? (
                        <FixView result={result} onExecute={result.mode === 'repair' && result.plan?.length ? (steps) => void executeFix(steps) : undefined} />
                      ) : null}
                    </div>
                  ) : null}
                  {finished && !result && run.status === 'succeeded' ? <div className="muted" style={{ marginTop: 8 }}>结果加载中…</div> : null}
                  <div className="muted" style={{ fontSize: 10, marginTop: 8 }}>{events.length} 个事件</div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
