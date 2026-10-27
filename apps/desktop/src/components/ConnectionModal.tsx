import { useEffect, useState } from 'react';
import { Cable, Check, Loader2, PlugZap, X } from 'lucide-react';
import type { ConnectionConfig, Engine } from '@aidb/core';
import { ENGINES, engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import { Modal } from './ui';

const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'gray'];

export function ConnectionModal() {
  const editor = useApp((s) => s.connectionEditor);
  const close = useApp((s) => s.closeConnectionEditor);
  const save = useApp((s) => s.saveConnection);
  const t = useApp((s) => s.t);

  const existing = editor?.connection;
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<Engine>('sqlite');
  const [color, setColor] = useState('blue');
  const [environment, setEnvironment] = useState<ConnectionConfig['environment']>('dev');
  const [groupName, setGroupName] = useState('默认');
  const [note, setNote] = useState('');
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState('3306');
  const [database, setDatabase] = useState('');
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);
  const [readonly, setReadonly] = useState(false);
  const [sshEnabled, setSshEnabled] = useState(false);
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>('password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string; latencyMs: number; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editor) return;
    const c = editor.connection;
    setName(c?.name ?? '');
    setEngine(c?.engine ?? 'sqlite');
    setColor(c?.color ?? 'blue');
    setEnvironment(c?.environment ?? 'dev');
    setGroupName(c?.groupName ?? '默认');
    setNote(c?.note ?? '');
    setHost(c?.host ?? '127.0.0.1');
    setPort(String(c?.port ?? (c?.engine === 'postgresql' ? 5432 : 3306)));
    setDatabase(c?.database ?? '');
    setUsername(c?.username ?? (c?.engine === 'postgresql' ? 'postgres' : 'root'));
    setPassword('');
    setSsl(Boolean(c?.ssl));
    setReadonly(Boolean(c?.readonly));
    setSshEnabled(Boolean(c?.ssh?.enabled));
    setSshHost(c?.ssh?.host ?? '');
    setSshPort(String(c?.ssh?.port ?? 22));
    setSshUser(c?.ssh?.user ?? '');
    setSshAuth(c?.ssh?.authMethod ?? 'password');
    setSshPassword('');
    setSshKeyPath(c?.ssh?.privateKeyPath ?? '');
    setTestResult(null);
  }, [editor]);

  if (!editor) return null;

  const changeEngine = (next: Engine) => {
    const meta = engineMeta(next);
    setEngine(next);
    setPort(meta.defaultPort ? String(meta.defaultPort) : '');
    if (next === 'postgresql' || next === 'cockroachdb') setUsername('postgres');
    else if (next === 'sqlserver') setUsername('sa');
    else if (next === 'oracle') setUsername('system');
    else if (next === 'clickhouse') setUsername('default');
    else if (next === 'mysql' || next === 'mariadb') setUsername('root');
    if (next === 'sqlite') setDatabase('');
    setTestResult(null);
  };

  const buildBody = (): Record<string, unknown> => ({
    name: name.trim(),
    engine,
    color,
    environment,
    groupName: groupName.trim() || '默认',
    note: note.trim() || undefined,
    host: engine === 'sqlite' ? undefined : host.trim(),
    port: engine === 'sqlite' ? undefined : Number(port) || undefined,
    database: database.trim() || undefined,
    username: engine === 'sqlite' ? undefined : username.trim(),
    password: password || undefined,
    ssl,
    readonly,
    ssh:
      engine !== 'sqlite' && sshEnabled
        ? {
            enabled: true,
            host: sshHost.trim(),
            port: Number(sshPort) || 22,
            user: sshUser.trim(),
            authMethod: sshAuth,
            privateKeyPath: sshAuth === 'key' ? sshKeyPath.trim() : undefined,
          }
        : undefined,
    sshPassword: sshAuth === 'password' ? sshPassword || undefined : undefined,
  });

  const test = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const { result } = await api.testDraft(buildBody());
      setTestResult(result);
    } catch (err: any) {
      setTestResult({ ok: false, latencyMs: 0, message: err?.message });
    } finally {
      setTesting(false);
    }
  };

  const submit = async () => {
    if (!name.trim()) return;
    if (engine === 'sqlite' && !database.trim()) return;
    setSaving(true);
    const result = await save(buildBody());
    setSaving(false);
    if (result) close();
  };

  return (
    <Modal
      title={editor.mode === 'edit' ? t('editConnection') : t('newConnection')}
      onClose={close}
      icon={<PlugZap size={15} />}
      footer={
        <>
          <button className="btn" onClick={() => void test()} disabled={testing} data-testid="connection-test">
            {testing ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : <Cable size={12} />} {testing ? t('testing') : t('test')}
          </button>
          {testResult ? (
            <span style={{ fontSize: 11, color: testResult.ok ? 'var(--success)' : 'var(--danger)' }} title={testResult.message}>
              {testResult.ok ? <Check size={11} /> : <X size={11} />} {testResult.ok ? `${testResult.version ?? 'OK'} · ${testResult.latencyMs}ms` : testResult.message?.slice(0, 60)}
            </span>
          ) : null}
          <div className="spacer" />
          <button className="btn" onClick={close}>{t('cancel')}</button>
          <button className="btn primary" onClick={() => void submit()} disabled={saving || !name.trim()} data-testid="connection-save">
            {saving ? <Loader2 size={12} className="spin" style={{ animation: 'spin .8s linear infinite' }} /> : null} {t('save')}
          </button>
        </>
      }
    >
      <div className="col gap-12">
        <div className="form-grid">
          <div className="field">
            <label>{t('connectionName')}</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Production DB" autoFocus data-testid="connection-name" />
          </div>
          <div className="field">
            <label>{t('engine')}</label>
            <select className="select" data-testid="connection-engine" value={engine} onChange={(e) => changeEngine(e.target.value as Engine)} disabled={editor.mode === 'edit'}>
              <optgroup label="文件 / 嵌入式">
                {ENGINES.filter((item) => item.fileBased).map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
              <optgroup label="关系型 / 分布式">
                {ENGINES.filter((item) => !item.fileBased && item.family !== 'clickhouse').map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
              <optgroup label="分析型">
                {ENGINES.filter((item) => item.family === 'clickhouse').map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </optgroup>
            </select>
          </div>
          <div className="field">
            <label>{t('environment')}</label>
            <select className="select" value={environment} onChange={(e) => setEnvironment(e.target.value as ConnectionConfig['environment'])}>
              <option value="dev">{t('dev')}</option>
              <option value="staging">{t('staging')}</option>
              <option value="prod">{t('prod')}</option>
            </select>
          </div>
          <div className="field">
            <label>{t('color')}</label>
            <div className="row gap-6" style={{ height: 30 }}>
              {COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 16,
                    height: 16,
                    borderRadius: 99,
                    border: color === c ? '2px solid var(--text-primary)' : '1px solid transparent',
                    background: { blue: '#5b93ff', green: '#46c46b', orange: '#e0a155', red: '#f16b62', purple: '#a78bfa', cyan: '#38bdf8', gray: '#7d8b9a' }[c],
                  }}
                  aria-label={c}
                />
              ))}
            </div>
          </div>

          {engine === 'sqlite' ? (
            <div className="field full">
              <label>{t('filePath')}</label>
              <input className="input mono" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={t('sqliteHint')} data-testid="connection-database" />
              <span className="hint">支持绝对路径；示例库位于 AiDB 数据目录下。</span>
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t('host')}</label>
                <input className="input" value={host} onChange={(e) => setHost(e.target.value)} />
              </div>
              <div className="field">
                <label>{t('port')}</label>
                <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} />
              </div>
              {engine === 'oracle' ? (
                <div className="field">
                  <label>服务名 / SID</label>
                  <input
                    className="input mono"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="ORCL"
                    data-testid="connection-database"
                  />
                </div>
              ) : null}
              <div className="field">
                <label>{t('username')}</label>
                <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} />
              </div>
              <div className="field">
                <label>{t('password')}</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editor.connection?.hasPassword ? t('apiKeyHint') : ''} />
              </div>
              {engineMeta(engine).supportsSsl ? (
                <div className="field" style={{ justifyContent: 'flex-end' }}>
                  <label className="checkbox"><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> SSL</label>
                </div>
              ) : (
                <div />
              )}
              {engine === 'oracle' ? null : (
                <div className="field full">
                  <span className="hint" style={{ margin: 0 }}>无需填写数据库：连接成功后会自动列出服务器上所有可访问的库，展开某个库再加载它的表。</span>
                </div>
              )}
            </>
          )}

          <div className="field full">
            <label>分组</label>
            <input className="input" value={groupName} onChange={(e) => setGroupName(e.target.value)} />
          </div>
          <div className="field full">
            <label>{t('note')}</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="给 Agent 的业务背景备注（会进入连接上下文）" />
          </div>
          <div className="field full">
            <label className="checkbox">
              <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} /> {t('readonly')}（服务端强制，Agent 同样受限）
            </label>
          </div>
          <div className="field full">
            <div className="engine-note">
              <span className="engine-chip" style={{ borderColor: engineMeta(engine).color }}>
                {engineMeta(engine).label}
              </span>
              <span className="hint" style={{ margin: 0 }}>{engineMeta(engine).description}</span>
            </div>
          </div>
        </div>

        {engine !== 'sqlite' ? (
          <div className="setting-card">
            <label className="checkbox" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} /> {t('ssh')}
            </label>
            {sshEnabled ? (
              <div className="form-grid" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>{t('host')}</label>
                  <input className="input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" />
                </div>
                <div className="field">
                  <label>{t('port')}</label>
                  <input className="input" type="number" value={sshPort} onChange={(e) => setSshPort(e.target.value)} />
                </div>
                <div className="field">
                  <label>{t('username')}</label>
                  <input className="input" value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
                </div>
                <div className="field">
                  <label>认证方式</label>
                  <select className="select" value={sshAuth} onChange={(e) => setSshAuth(e.target.value as 'password' | 'key')}>
                    <option value="password">{t('authByPassword')}</option>
                    <option value="key">{t('authByKey')}</option>
                  </select>
                </div>
                {sshAuth === 'password' ? (
                  <div className="field full">
                    <label>SSH {t('password')}</label>
                    <input className="input" type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} />
                  </div>
                ) : (
                  <div className="field full">
                    <label>{t('keyFile')}</label>
                    <input className="input mono" value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:/Users/me/.ssh/id_ed25519" />
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
