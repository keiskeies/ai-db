import { useEffect, useState } from 'react';
import { KeyRound, Loader2, Plus, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../store';

export function UsersTool() {
  const connections = useApp((s) => s.connections);
  const activeConnectionId = useApp((s) => s.activeConnectionId);
  const notify = useApp((s) => s.notify);
  const [connectionId, setConnectionId] = useState(activeConnectionId ?? connections[0]?.id ?? '');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ action: 'create', name: '', host: '%', password: '', privileges: 'SELECT', scope: '*.*', role: '' });
  const conn = connections.find((item) => item.id === connectionId);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.users(connectionId));
    } catch (err: any) {
      notify('error', '加载用户失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (connectionId) void load();
  }, [connectionId]);

  const submit = async () => {
    if (!form.name) return;
    if (form.action === 'create' && !form.password) {
      notify('warning', '创建用户需要密码');
      return;
    }
    try {
      await api.userAction({ connectionId, ...form });
      notify('success', '操作已执行');
      setForm({ ...form, name: '', password: '' });
      await load();
    } catch (err: any) {
      notify('error', '操作失败', err?.message);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <KeyRound size={15} /> 用户与权限
        <span className="muted">账号、角色与授权（需要数据库管理员权限）</span>
      </div>
      <div className="tool-row">
        <select className="select" value={connectionId} onChange={(e) => setConnectionId(e.target.value)} style={{ width: 240 }}>
          {connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.engine}</option>)}
        </select>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <RefreshCw size={12} />} 刷新
        </button>
        <span className="spacer" />
        {data?.supported ? <span className="badge">{data.users.length} 个账户</span> : null}
      </div>

      {data?.supported === false ? (
        <div className="risk-banner"><ShieldAlert size={12} /> {data.note ?? '该引擎不支持用户管理'}</div>
      ) : (
        <div className="users-grid">
          <div className="panel">
            <div className="panel-head">操作
              <div className="spacer" />
              <button className="btn primary small" onClick={() => void submit()}><Plus size={11} /> 执行</button>
            </div>
            <div className="tool-row" style={{ flexWrap: 'wrap', padding: 8 }}>
              <div className="field" style={{ width: 130 }}>
                <label>动作</label>
                <select className="select" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                  <option value="create">创建</option>
                  <option value="grant">授权</option>
                </select>
              </div>
              <div className="field" style={{ flex: 1, minWidth: 120 }}>
                <label>用户名</label>
                <input className="input mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="app_user" />
              </div>
              {conn?.engine === 'mysql' || conn?.engine === 'mariadb' ? (
                <div className="field" style={{ width: 120 }}>
                  <label>Host</label>
                  <input className="input mono" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
                </div>
              ) : null}
              {form.action === 'create' ? (
                <div className="field" style={{ flex: 1, minWidth: 140 }}>
                  <label>密码</label>
                  <input className="input" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </div>
              ) : (
                <div className="field" style={{ flex: 1, minWidth: 140 }}>
                  <label>角色 / 权限</label>
                  <input className="input mono" value={form.role || form.privileges} onChange={(e) => setForm({ ...form, role: e.target.value, privileges: e.target.value })} />
                </div>
              )}
              {form.action === 'grant' && (conn?.engine === 'mysql' || conn?.engine === 'mariadb') ? (
                <div className="field" style={{ flex: 1, minWidth: 140 }}>
                  <label>作用域</label>
                  <input className="input mono" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
                </div>
              ) : null}
            </div>
            <div className="hint" style={{ padding: '0 10px 8px' }}>
              示例：MySQL 授权 `SELECT ON shop.*`；PostgreSQL 授予角色 `readonly`；其他引擎按 CREATE USER / GRANT 语法执行。所有操作写入审计。
            </div>
          </div>
          <div className="panel">
            <div className="panel-head">账户列表 <span className="badge">{data?.users?.length ?? 0}</span></div>
            <div className="transfer-list" style={{ maxHeight: 360 }}>
              {(data?.users ?? []).map((user: any) => (
                <div key={`${user.name}_${user.host ?? ''}`} className="transfer-row">
                  <span className="status-led ok" />
                  <span className="mono">{user.name}{user.host ? `@${user.host}` : ''}</span>
                  <span className="muted" style={{ fontSize: 10 }}>{user.attributes?.join(' · ')}</span>
                  {user.superuser ? <span className="badge destructive">SUPER</span> : null}
                  {user.disabled ? <span className="badge write">DISABLED</span> : null}
                  <span className="spacer" />
                  <button
                    className="icon-btn danger"
                    title="删除用户"
                    onClick={async () => {
                      if (!window.confirm(`删除账户 ${user.name}？`)) return;
                      try {
                        await api.userAction({ connectionId, action: 'drop', name: user.name, host: user.host });
                        notify('success', '账户已删除');
                        await load();
                      } catch (err: any) {
                        notify('error', '删除失败', err?.message);
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              {!data?.users?.length ? <div className="dash-empty">没有账户数据。</div> : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
