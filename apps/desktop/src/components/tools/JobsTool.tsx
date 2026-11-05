import { useEffect, useState } from 'react';
import { Clock, ListTodo, Loader2, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';
import { DatabaseSelect } from '../DatabaseSelect';
import { askConfirm } from '../AskDialog';
import { Select, Option } from '../ui';
import { t as tr } from '../../i18n';
import type { JobInfo, PipelineInfo } from '@aidb/core';

type Job = JobInfo;

export function JobsTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState(tr("每小时统计订单"));
  const [connectionId, setConnectionId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [database, setDatabase] = useState('');
  const [type, setType] = useState<'query' | 'backup' | 'pipeline'>('query');
  const [sql, setSql] = useState('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const [pipelineIds, setPipelineIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(60);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [list, flows] = await Promise.all([api.jobs(), api.pipelines()]);
      setJobs(list.jobs as Job[]);
      setPipelines(flows.pipelines);
    } catch (err: any) {
      notify('error', tr("加载任务失败"), err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    try {
      await api.createJob({
        name,
        connectionId,
        database: database || undefined,
        type,
        sql: type === 'query' ? sql : undefined,
        payload: type === 'pipeline' ? { pipelineIds } : undefined,
        intervalSeconds: Math.max(30, minutes * 60),
        enabled: true,
      });
      setShowForm(false);
      await load();
      notify('success', tr("任务已创建"));
    } catch (err: any) {
      notify('error', tr("创建失败"), err?.message);
    }
  };

  const runNow = async (job: Job) => {
    setBusyId(job.id);
    try {
      const result = await api.runJob(job.id);
      notify(result.ok ? 'success' : 'error', result.ok ? tr("任务执行成功") : tr("任务执行失败"), result.message);
      await load();
    } catch (err: any) {
      notify('error', tr("执行失败"), err?.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <ListTodo size={15} /> {tr(" 自动化任务 ")}<span className="muted">{tr("定时查询与备份，Gateway 每 15 秒检查调度")}</span>
      </div>
      <div className="tool-row">
        <button className="btn primary" onClick={() => setShowForm((value) => !value)}>
          <Plus size={12} /> {tr(" 新建任务 ")}</button>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />}{tr(" 刷新 ")}</button>
        <span className="spacer" />
        <span className="badge">{jobs.filter((job) => job.enabled).length}{tr(" 启用 / ")}{jobs.length}{tr(" 总数")}</span>
      </div>
      {showForm ? (
        <div className="setting-card" style={{ marginBottom: 8 }}>
          <div className="form-grid" style={{ gap: 8 }}>
            <div className="field">
              <label>{tr("名称")}</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>{tr("连接")}</label>
              <Select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {connections.map((conn) => <Option key={conn.id} value={conn.id}>{conn.name}</Option>)}
              </Select>
            </div>
            <div className="field">
              <label>{tr("数据库")}</label>
              <DatabaseSelect connectionId={connectionId} value={database} onChange={setDatabase} testId="job-db" />
            </div>
            <div className="field">
              <label>{tr("类型")}</label>
              <Select className="select" value={type} onChange={(e) => setType(e.target.value as 'query' | 'backup' | 'pipeline')}>
                <Option value="query">{tr("SQL 查询")}</Option>
                <Option value="backup">{tr("数据库备份")}</Option>
                <Option value="pipeline">{tr("数据流处理")}</Option>
              </Select>
            </div>
            <div className="field">
              <label>{tr("间隔（分钟）")}</label>
              <input className="input" type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </div>
            {type === 'query' ? (
              <div className="field full">
                <label>SQL</label>
                <textarea className="textarea" rows={3} value={sql} onChange={(e) => setSql(e.target.value)} />
              </div>
            ) : null}
            {type === 'pipeline' ? (
              <div className="field full">
                <label>{tr("要运行的数据流")}</label>
                {!pipelines.length ? (
                  <span className="hint">{tr('还没有数据流；先到 工具箱 → 数据流处理 建一条。')}</span>
                ) : (
                  <div className="pipe-pick">
                    {pipelines.map((flow) => (
                      <label key={flow.id} className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
                        <input
                          type="checkbox"
                          checked={pipelineIds.includes(flow.id)}
                          onChange={(e) => setPipelineIds((current) => (e.target.checked ? [...current, flow.id] : current.filter((item) => item !== flow.id)))}
                        />
                        <span>
                          <strong>{flow.name}</strong>
                          <span className="muted"> · {flow.spec.steps.length}{tr(' 步 ')}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
                <span className="hint">{tr('按上面的勾选顺序依次运行；一条失败不影响后面的继续跑。')}</span>
              </div>
            ) : null}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn" onClick={() => setShowForm(false)}>{tr("取消")}</button>
            <button className="btn primary" onClick={() => void create()} disabled={!name || !connectionId || (type === 'pipeline' && !pipelineIds.length)}>{tr("保存")}</button>
          </div>
        </div>
      ) : null}
      <div className="tool-scroll">
        {jobs.map((job) => {
          const conn = connections.find((item) => item.id === job.connectionId);
          return (
            <div key={job.id} className="job-row">
              <div className="job-main">
                <div className="row gap-6">
                  <span className={`status-led ${job.lastStatus === 'ok' ? 'ok' : job.lastStatus === 'error' ? 'error' : ''}`} />
                  <strong>{job.name}</strong>
                  <span className="badge">{job.type === 'backup' ? 'BACKUP' : job.type === 'pipeline' ? 'FLOW' : 'SQL'}</span>
                  {!job.enabled ? <span className="badge write">{tr("已暂停")}</span> : null}
                </div>
                <div className="listMeta">
                  {conn?.name}{job.database ? ` / ${job.database}` : ''}{tr(" · 每 ")}{Math.round(job.intervalSeconds / 60)}{tr(" 分钟 ")}{job.lastRunAt ? tr(" · 上次 {0}", [new Date(job.lastRunAt).toLocaleString()]) : tr(" · 尚未运行")}
                </div>
                {job.lastError ? <div className="hint" style={{ color: 'var(--danger)' }}>{job.lastError}</div> : null}
              </div>
              <Clock size={12} className="muted" />
              <button className="btn small" onClick={() => void runNow(job)} disabled={busyId === job.id}>
                {busyId === job.id ? <Loader2 size={11} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Play size={11} />}{tr(" 运行 ")}</button>
              <button
                className="btn small"
                onClick={async () => {
                  await api.updateJob(job.id, { enabled: !job.enabled });
                  await load();
                }}
              >
                {job.enabled ? tr("暂停") : tr("启用")}
              </button>
              <button
                className="icon-btn danger"
                onClick={async () => {
                  if (!(await askConfirm({ message: tr("删除任务「{0}」？", [job.name]), danger: true, confirmLabel: tr("删除") }))) return;
                  await api.deleteJob(job.id);
                  await load();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {!jobs.length ? <div className="dash-empty">{tr("还没有任务。创建定时查询或自动备份。")}</div> : null}
      </div>
    </div>
  );
}
