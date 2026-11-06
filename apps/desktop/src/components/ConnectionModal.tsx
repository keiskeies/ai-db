import { useState } from 'react';
import { Cable, Check, Loader2, PlugZap, X } from 'lucide-react';
import type { ConnectionConfig, Engine, EngineMeta } from '@aidb/core';
import { ENGINES, engineMeta } from '@aidb/core';
import { api } from '../lib/api';
import { useApp } from '../store';
import type { ConnectionEditorState } from '../store';
import { Modal, OptGroup, Option, SecretInput, Select } from './ui';
import { t as tr } from '../i18n';
import { groupFromLabel, groupLabel } from '../lib/groups';

const COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'cyan', 'gray'];

/** Doris / StarRocks / GBase 8a 走 MySQL 协议，但属于分析型产品，单独成组。 */
const OLAP_IDS = new Set<Engine>(['clickhouse', 'doris', 'starrocks', 'gbase8a']);
const GROUP_ORDER = [
  tr("文件 / 嵌入式"),
  tr("关系型 · MySQL 系"),
  tr("关系型 · PostgreSQL 系"),
  tr("关系型 · Oracle / 达梦"),
  tr("关系型 · SQL Server"),
  tr("分析型 / OLAP"),
  tr("时序"),
  tr("文档"),
  tr("键值"),
  tr("图"),
  tr("向量"),
  tr("搜索"),
  tr("宽列"),
  tr("其它"),
];

function engineGroup(meta: EngineMeta): string {
  if (meta.fileBased) return tr("文件 / 嵌入式");
  if (OLAP_IDS.has(meta.id)) return tr("分析型 / OLAP");
  if (meta.model === 'relational') {
    if (meta.family === 'mysql') return tr("关系型 · MySQL 系");
    if (meta.family === 'postgres') return tr("关系型 · PostgreSQL 系");
    if (meta.family === 'oracle' || meta.family === 'dm') return tr("关系型 · Oracle / 达梦");
    if (meta.family === 'mssql') return tr("关系型 · SQL Server");
  }
  const byModel: Record<string, string> = {
    relational: tr("关系型 · 其他"),
    document: tr("文档"),
    keyvalue: tr("键值"),
    graph: tr("图"),
    vector: tr("向量"),
    search: tr("搜索"),
    widecolumn: tr("宽列"),
    timeseries: tr("时序"),
  };
  return byModel[meta.model] ?? tr("其它");
}

const GROUPED_ENGINES = GROUP_ORDER.map((label) => [label, ENGINES.filter((meta) => engineGroup(meta) === label)] as const)
  .filter(([, items]) => items.length > 0);

export function ConnectionModal() {
  const editor = useApp((s) => s.connectionEditor);
  if (!editor) return null;
  return <ConnectionForm key={`${editor.mode}:${editor.connection?.id ?? 'new'}`} editor={editor} />;
}

/** 表单只在打开时存在，状态直接从 editor 初始化：关闭后不再留状态，重开不会先闪出上一次的引擎。 */
function ConnectionForm({ editor }: { editor: ConnectionEditorState }) {
  const close = useApp((s) => s.closeConnectionEditor);
  const save = useApp((s) => s.saveConnection);
  const t = useApp((s) => s.t);

  const c = editor.connection;
  const meta = engineMeta(c?.engine ?? 'sqlite');
  const [name, setName] = useState(c?.name ?? '');
  const [engine, setEngine] = useState<Engine>(c?.engine ?? 'sqlite');
  const [color, setColor] = useState<string>(c?.color ?? 'blue');
  const [environment, setEnvironment] = useState<ConnectionConfig['environment']>(c?.environment ?? 'dev');
  const [groupName, setGroupName] = useState(c?.groupName ?? '默认'); // i18n-ignore
  const [note, setNote] = useState(c?.note ?? '');
  const [host, setHost] = useState(c?.host ?? '127.0.0.1');
  const [port, setPort] = useState(String(c?.port ?? meta.defaultPort ?? ''));
  const [database, setDatabase] = useState(c?.database ?? meta.defaultDatabase ?? '');
  const [username, setUsername] = useState(c?.username ?? meta.defaultUsername ?? '');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(Boolean(c?.ssl));
  const [sslInsecure, setSslInsecure] = useState(Boolean(c?.sslInsecure));
  const [authMode, setAuthMode] = useState<'basic' | 'apikey'>(c?.authMode ?? 'basic');
  const [replicaSet, setReplicaSet] = useState(c?.options?.replicaSet ?? '');
  const [authSource, setAuthSource] = useState(c?.options?.authSource ?? '');
  const [directConnection, setDirectConnection] = useState(Boolean(c?.options?.directConnection));
  const [redisMode, setRedisMode] = useState<'standalone' | 'cluster'>(c?.options?.redisMode ?? 'standalone');
  const [readonly, setReadonly] = useState(Boolean(c?.readonly));
  const [sshEnabled, setSshEnabled] = useState(Boolean(c?.ssh?.enabled));
  const [sshHost, setSshHost] = useState(c?.ssh?.host ?? '');
  const [sshPort, setSshPort] = useState(String(c?.ssh?.port ?? 22));
  const [sshUser, setSshUser] = useState(c?.ssh?.user ?? '');
  const [sshAuth, setSshAuth] = useState<'password' | 'key'>(c?.ssh?.authMethod ?? 'password');
  const [sshPassword, setSshPassword] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState(c?.ssh?.privateKeyPath ?? '');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; version?: string; latencyMs: number; message?: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const changeEngine = (next: Engine) => {
    const meta = engineMeta(next);
    setEngine(next);
    setPort(meta.defaultPort ? String(meta.defaultPort) : '');
    setUsername(meta.defaultUsername ?? '');
    if (meta.fileBased || meta.model !== 'relational' || meta.defaultDatabase) setDatabase(meta.defaultDatabase ?? '');
    setTestResult(null);
  };

  const buildBody = (): Record<string, unknown> => {
    const meta = engineMeta(engine);
    return {
      name: name.trim(),
      engine,
      color,
      environment,
      groupName: groupName.trim() || '默认', // i18n-ignore
      note: note.trim() || undefined,
      host: meta.fileBased ? undefined : host.trim(),
      port: meta.fileBased ? undefined : Number(port) || undefined,
      database: database.trim() || undefined,
      username: meta.fileBased ? undefined : username.trim(),
      password: password || undefined,
      ssl,
      sslInsecure: ssl ? sslInsecure : false,
      authMode: engineMeta(engine).model === 'search' ? authMode : undefined,
      options:
        engine === 'mongodb'
          ? {
              replicaSet: replicaSet.trim() || undefined,
              authSource: authSource.trim() || undefined,
              directConnection: directConnection || undefined,
            }
          : engine === 'redis'
            ? { redisMode }
            : undefined,
      readonly,
      ssh:
        !meta.fileBased && sshEnabled
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
    };
  };

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
    if (engineMeta(engine).fileBased && !database.trim()) return;
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
            <Select className="select" data-testid="connection-engine" value={engine} onChange={(e) => changeEngine(e.target.value as Engine)} disabled={editor.mode === 'edit'}>
              {GROUPED_ENGINES.map(([label, items]) => (
                <OptGroup key={label} label={label}>
                  {items.map((item) => (
                    <Option key={item.id} value={item.id}>{item.label}</Option>
                  ))}
                </OptGroup>
              ))}
            </Select>
          </div>
          <div className="field">
            <label>{t('environment')}</label>
            <Select className="select" value={environment} onChange={(e) => setEnvironment(e.target.value as ConnectionConfig['environment'])}>
              <Option value="dev">{t('dev')}</Option>
              <Option value="staging">{t('staging')}</Option>
              <Option value="prod">{t('prod')}</Option>
            </Select>
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

          {engineMeta(engine).fileBased ? (
            <div className="field full">
              <label>{t('filePath')}</label>
              <input className="input mono" value={database} onChange={(e) => setDatabase(e.target.value)} placeholder={engine === 'duckdb' ? 'D:/data/analytics.duckdb' : t('sqliteHint')} data-testid="connection-database" />
              <span className="hint">{engine === 'duckdb' ? tr("DuckDB 文件不存在时会自动创建；也可使用 :memory:。") : tr("支持绝对路径；示例库位于 AiDB 数据目录下。")}</span>
            </div>
          ) : (
            <>
              <div className="field">
                <label>{t('host')}</label>
                <input className="input" value={host} onChange={(e) => setHost(e.target.value)} data-testid="connection-host" />
              </div>
              <div className="field">
                <label>{t('port')}</label>
                <input className="input" type="number" value={port} onChange={(e) => setPort(e.target.value)} data-testid="connection-port" />
              </div>
              {engine === 'oracle' ? (
                <div className="field">
                  <label>{tr("服务名 / SID")}</label>
                  <input
                    className="input mono"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="ORCL"
                    data-testid="connection-database"
                  />
                </div>
              ) : null}
              {engineMeta(engine).model === 'search' && authMode === 'apikey' ? null : (
                <div className="field">
                  <label>{t('username')}</label>
                  <input
                    className="input"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    autoComplete="off"
                    name="aidb-connection-user"
                    data-form-type="other"
                    data-testid="connection-username"
                  />
                </div>
              )}
              <div className="field">
                <label>{engineMeta(engine).model === 'search' && authMode === 'apikey' ? tr("API Key") : t('password')}</label>
                <SecretInput
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editor.connection?.hasPassword ? t('apiKeyHint') : ''}
                  name="aidb-connection-secret"
                  data-testid="connection-password"
                />
              </div>
              {engineMeta(engine).supportsSsl ? (
                <div className="field" style={{ justifyContent: 'flex-end', gap: 6 }}>
                  <label className="checkbox"><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> SSL</label>
                  {/* MySQL 8 默认自签、内网 IP 证书没有受信 CA：只给「加密」一个开关等于逼用户关掉 TLS。 */}
                  {ssl ? (
                    <label className="checkbox" title={tr("证书自签或不匹配主机名时勾选；仍加密，但不校验证书链")}>
                      <input type="checkbox" checked={sslInsecure} onChange={(e) => setSslInsecure(e.target.checked)} data-testid="connection-ssl-insecure" />
                      {tr("不校验证书")}
                    </label>
                  ) : null}
                </div>
              ) : (
                <div />
              )}
              {engineMeta(engine).model === 'search' ? (
                <div className="field">
                  <label>{tr("认证方式")}</label>
                  <Select className="select" value={authMode} onChange={(e) => setAuthMode(e.target.value as 'basic' | 'apikey')} data-testid="connection-auth-mode">
                    <Option value="basic">{tr("用户名 + 密码")}</Option>
                    <Option value="apikey">{tr("API Key")}</Option>
                  </Select>
                </div>
              ) : null}
              {engineMeta(engine).model !== 'relational' ? (
                <div className="field">
                  <label>{engineMeta(engine).model === 'keyvalue' ? tr("DB 索引") : tr("数据库")}</label>
                  <input
                    className="input mono"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder={engineMeta(engine).model === 'keyvalue' ? '0' : tr("例如 app")}
                    data-testid="connection-database"
                  />
                </div>
              ) : null}
              {engine === 'mongodb' ? (
                <>
                  <div className="field">
                    <label>Replica Set</label>
                    <input
                      className="input mono"
                      value={replicaSet}
                      onChange={(e) => setReplicaSet(e.target.value)}
                      placeholder={tr("副本集名称，可留空")}
                      data-testid="connection-replica-set"
                    />
                  </div>
                  <div className="field">
                    <label>{tr("认证库")}</label>
                    <input
                      className="input mono"
                      value={authSource}
                      onChange={(e) => setAuthSource(e.target.value)}
                      placeholder="admin"
                      data-testid="connection-auth-source"
                    />
                  </div>
                  <div className="field">
                    {/* Docker / Atlas / SSH 隧道下拓扑发现返回的是内部主机名，直连才能稳定连上 */}
                    <label className="checkbox">
                      <input type="checkbox" checked={directConnection} onChange={(e) => setDirectConnection(e.target.checked)} data-testid="connection-direct" />
                      {tr("直连该节点，跳过副本集发现")}
                    </label>
                  </div>
                </>
              ) : null}
              {engine === 'redis' ? (
                <div className="field">
                  <label>{tr("部署形态")}</label>
                  <Select className="select" value={redisMode} onChange={(e) => setRedisMode(e.target.value as 'standalone' | 'cluster')} data-testid="connection-redis-mode">
                    <Option value="standalone">{tr("单机 / 主从（16 个库）")}</Option>
                    <Option value="cluster">{tr("Redis Cluster（只有 db0）")}</Option>
                  </Select>
                </div>
              ) : null}
              {engine === 'oracle' || engineMeta(engine).model !== 'relational' ? null : (
                <div className="field full">
                  <span className="hint" style={{ margin: 0 }}>{tr("无需填写数据库：连接成功后会自动列出服务器上所有可访问的库，展开某个库再加载它的表。")}</span>
                </div>
              )}
            </>
          )}

          <div className="field full">
            <label>{tr("分组")}</label>
            <input className="input" value={groupLabel(groupName)} onChange={(e) => setGroupName(groupFromLabel(e.target.value))} />
          </div>
          <div className="field full">
            <label>{t('note')}</label>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={tr("给 Agent 的业务背景备注（会进入连接上下文）")} />
          </div>
          <div className="field full">
            <label className="checkbox">
              <input type="checkbox" checked={readonly} onChange={(e) => setReadonly(e.target.checked)} data-testid="connection-readonly" /> {t('readonly')}{tr("（服务端强制，Agent 同样受限） ")}</label>
          </div>
          <div className="field full">
            <div className="engine-note">
              <span className="engine-chip" style={{ borderColor: engineMeta(engine).color }}>
                {engineMeta(engine).label}
              </span>
              <span className="hint" style={{ margin: 0 }}>{engineMeta(engine).description}</span>
              {engineMeta(engine).notes ? (
                <span className="hint" style={{ margin: 0, color: 'var(--warning, #e0a155)' }}>{engineMeta(engine).notes}</span>
              ) : null}
            </div>
          </div>
        </div>

        {engine !== 'sqlite' ? (
          <div className="setting-card">
            <label className="checkbox" style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              <input type="checkbox" checked={sshEnabled} onChange={(e) => setSshEnabled(e.target.checked)} data-testid="ssh-enabled" /> {t('ssh')}
            </label>
            {sshEnabled ? (
              <div className="form-grid" style={{ marginTop: 10 }}>
                <div className="field">
                  <label>{t('host')}</label>
                  <input className="input" value={sshHost} onChange={(e) => setSshHost(e.target.value)} placeholder="bastion.example.com" data-testid="ssh-host" />
                </div>
                <div className="field">
                  <label>{t('port')}</label>
                  <input className="input" type="number" value={sshPort} onChange={(e) => setSshPort(e.target.value)} data-testid="ssh-port" />
                </div>
                <div className="field">
                  <label>{t('username')}</label>
                  <input
                    className="input"
                    value={sshUser}
                    onChange={(e) => setSshUser(e.target.value)}
                    autoComplete="off"
                    name="aidb-ssh-user"
                    data-form-type="other"
                    data-testid="ssh-user"
                  />
                </div>
                <div className="field">
                  <label>{tr("认证方式")}</label>
                  <Select className="select" value={sshAuth} onChange={(e) => setSshAuth(e.target.value as 'password' | 'key')} data-testid="ssh-auth">
                    <Option value="password">{t('authByPassword')}</Option>
                    <Option value="key">{t('authByKey')}</Option>
                  </Select>
                </div>
                {sshAuth === 'password' ? (
                  <div className="field full">
                    <label>SSH {t('password')}</label>
                    <SecretInput
                      value={sshPassword}
                      onChange={(e) => setSshPassword(e.target.value)}
                      name="aidb-ssh-secret"
                      data-testid="ssh-password"
                    />
                  </div>
                ) : (
                  <div className="field full">
                    <label>{t('keyFile')}</label>
                    <input className="input mono" value={sshKeyPath} onChange={(e) => setSshKeyPath(e.target.value)} placeholder="C:/Users/me/.ssh/id_ed25519" data-testid="ssh-key-path" />
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
