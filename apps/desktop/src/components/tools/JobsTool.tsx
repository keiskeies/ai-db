import { useEffect, useState } from 'react';
import { Clock, ListTodo, Loader2, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

interface Job {
  id: string;
  name: string;
  connectionId: string;
  database?: string;
  type: 'query' | 'backup';
  sql?: string;
  intervalSeconds: number;
  enabled: boolean;
  lastRunAt?: string;
  lastStatus?: string;
  lastError?: string;
}

export function JobsTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('每小时统计订单');
  const [connectionId, setConnectionId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [type, setType] = useState<'query' | 'backup'>('query');
  const [sql, setSql] = useState('SELECT status, COUNT(*) AS n FROM orders GROUP BY status');
  const [minutes, setMinutes] = useState(60);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const { jobs: list } = await api.jobs();
      setJobs(list as Job[]);
    } catch (err: any) {
      notify('error', '加载任务失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const create = async () => {
    try {
      await api.createJob({ name, connectionId, type, sql: type === 'query' ? sql : undefined, intervalSeconds: Math.max(30, minutes * 60), enabled: true });
      setShowForm(false);
      await load();
      notify('success', '任务已创建');
    } catch (err: any) {
      notify('error', '创建失败', err?.message);
    }
  };

  const runNow = async (job: Job) => {
    setBusyId(job.id);
    try {
      const result = await api.runJob(job.id);
      notify(result.ok ? 'success' : 'error', result.ok ? '任务执行成功' : '任务执行失败', result.message);
      await load();
    } catch (err: any) {
      notify('error', '执行失败', err?.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <ListTodo size={15} /> 自动化任务
        <span className="muted">定时查询与备份，Gateway 每 15 秒检查调度</span>
      </div>
      <div className="tool-row">
        <button className="btn primary" onClick={() => setShowForm((value) => !value)}>
          <Plus size={12} /> 新建任务
        </button>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />} 刷新
        </button>
        <span className="spacer" />
        <span className="badge">{jobs.filter((job) => job.enabled).length} 启用 / {jobs.length} 总数</span>
      </div>
      {showForm ? (
        <div className="setting-card" style={{ marginBottom: 8 }}>
          <div className="form-grid" style={{ gap: 8 }}>
            <div className="field">
              <label>名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label>连接</label>
              <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
                {connections.map((conn) => <option key={conn.id} value={conn.id}>{conn.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>类型</label>
              <select className="select" value={type} onChange={(e) => setType(e.target.value as 'query' | 'backup')}>
                <option value="query">SQL 查询</option>
                <option value="backup">数据库备份</option>
              </select>
            </div>
            <div className="field">
              <label>间隔（分钟）</label>
              <input className="input" type="number" min={1} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
            </div>
            {type === 'query' ? (
              <div className="field full">
                <label>SQL</label>
                <textarea className="textarea" rows={3} value={sql} onChange={(e) => setSql(e.target.value)} />
              </div>
            ) : null}
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn" onClick={() => setShowForm(false)}>取消</button>
            <button className="btn primary" onClick={() => void create()} disabled={!name || !connectionId}>保存</button>
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
                  <span className="badge">{job.type === 'backup' ? 'BACKUP' : 'SQL'}</span>
                  {!job.enabled ? <span className="badge write">已暂停</span> : null}
                </div>
                <div className="listMeta">
                  {conn?.name} · 每 {Math.round(job.intervalSeconds / 60)} 分钟
                  {job.lastRunAt ? ` · 上次 ${new Date(job.lastRunAt).toLocaleString()}` : ' · 尚未运行'}
                </div>
                {job.lastError ? <div className="hint" style={{ color: 'var(--danger)' }}>{job.lastError}</div> : null}
              </div>
              <Clock size={12} className="muted" />
              <button className="btn small" onClick={() => void runNow(job)} disabled={busyId === job.id}>
                {busyId === job.id ? <Loader2 size={11} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Play size={11} />} 运行
              </button>
              <button
                className="btn small"
                onClick={async () => {
                  await api.updateJob(job.id, { enabled: !job.enabled });
                  await load();
                }}
              >
                {job.enabled ? '暂停' : '启用'}
              </button>
              <button
                className="icon-btn danger"
                onClick={async () => {
                  if (!window.confirm(`删除任务「${job.name}」？`)) return;
                  await api.deleteJob(job.id);
                  await load();
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          );
        })}
        {!jobs.length ? <div className="dash-empty">还没有任务。创建定时查询或自动备份。</div> : null}
      </div>
    </div>
  );
}
