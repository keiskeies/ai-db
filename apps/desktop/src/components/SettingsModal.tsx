import { useEffect, useMemo, useState } from 'react';
import {
  Bot,
  Database,
  Download,
  Info,
  KeyRound,
  ListChecks,
  Loader2,
  Network,
  Palette,
  Plus,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type { AppSettings, AuditEntry, BackupInfo, ModelInfo, ModelInputModality, ModelProfile, ModelReasoningTier, ProviderKind, ProviderPreset } from '@aidb/core';
import {
  DEFAULT_REASONING_TIERS,
  TIER_LEVELS,
  formatTokenSize,
  matchPreset,
  getModelProfile,
  parseTokenSize,
  presetById,
  presetsByGroup,
  profileFromModelInfo,
  withModelProfile,
  withoutModelProfile,
} from '@aidb/core';
import { api, TOKEN } from '../lib/api';
import { formatBytes, formatRelative } from '../lib/format';
import { useApp } from '../store';
import { RiskBadge } from './ui';

type TabKey = 'appearance' | 'query' | 'agent' | 'bridge' | 'data' | 'about';

export function SettingsModal() {
  const open = useApp((s) => s.settingsOpen);
  const settings = useApp((s) => s.settings);
  const t = useApp((s) => s.t);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const saveSettings = useApp((s) => s.saveSettings);
  const notify = useApp((s) => s.notify);
  const pairing = useApp((s) => s.pairing);
  const devices = useApp((s) => s.devices);
  const startPairing = useApp((s) => s.startPairing);
  const loadDevices = useApp((s) => s.loadDevices);
  const revokeDevice = useApp((s) => s.revokeDevice);

  const [tab, setTab] = useState<TabKey>('appearance');
  const [form, setForm] = useState<AppSettings>(settings);
  const [apiKey, setApiKey] = useState('');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [modelList, setModelList] = useState<string[]>([]);
  const [modelInfos, setModelInfos] = useState<ModelInfo[]>([]);
  const [modelSource, setModelSource] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [modelQuery, setModelQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    setForm(settings);
    setApiKey('');
    setTab('appearance');
    setModelList([]);
    setModelInfos([]);
    setModelSource('');
    setModelsError('');
    setModelQuery('');
    void loadDevices();
  }, [open, settings, loadDevices]);

  useEffect(() => {
    if (!open || tab !== 'data') return;
    setDataLoading(true);
    Promise.all([api.audit({ limit: 40 }), api.backups()])
      .then(([a, b]) => {
        setAudit(a.entries);
        setBackups(b.backups);
      })
      .catch(() => undefined)
      .finally(() => setDataLoading(false));
  }, [open, tab]);

  const activePreset = useMemo(
    () =>
      presetById(form.agent.preset) ??
      matchPreset(form.agent.provider as ProviderKind, form.agent.baseUrl) ??
      presetById(form.agent.provider === 'local' ? 'local' : 'custom'),
    [form.agent.preset, form.agent.provider, form.agent.baseUrl],
  );

  if (!open) return null;

  const setAgent = (patch: Partial<AppSettings['agent']>) => setForm((prev) => ({ ...prev, agent: { ...prev.agent, ...patch } }));
  const setEmbedding = (patch: Partial<AppSettings['embedding']>) =>
    setForm((prev) => ({ ...prev, embedding: { ...prev.embedding, ...patch } }));

  /** 当前模型的能力档案；未配置时为 undefined，编辑器按空值渲染。 */
  const profile = getModelProfile(form.agent);

  const patchProfile = (patch: Partial<ModelProfile>) => {
    if (!form.agent.model) return;
    setForm((prev) => ({ ...prev, agent: withModelProfile(prev.agent, prev.agent.model, { ...(getModelProfile(prev.agent) ?? {}), ...patch }) }));
  };

  /** 选中模型：没有档案但探测到能力时立刻预填，并把档位选择收敛到新模型支持的档位。 */
  const pickModel = (model: string) => {
    setForm((prev) => {
      const stored = prev.agent.modelProfiles?.[model];
      const info = modelInfos.find((item) => item.id === model);
      const detected = !stored && info ? profileFromModelInfo(info) : undefined;
      let agent: AppSettings['agent'] = { ...prev.agent, model };
      if (detected) agent = withModelProfile(agent, model, detected);
      const tiers = (stored ?? detected)?.reasoningTiers ?? [];
      if (tiers.length && !tiers.some((tier) => tier.level === agent.reasoningTier)) agent = { ...agent, reasoningTier: undefined };
      return { ...prev, agent };
    });
  };

  const clearModels = () => {
    setModelList([]);
    setModelInfos([]);
    setModelSource('');
    setModelsError('');
    setModelQuery('');
  };

  const applyPreset = (preset: ProviderPreset) => {
    setAgent({ provider: preset.kind, preset: preset.id, baseUrl: preset.baseUrl, model: preset.defaultModel });
    clearModels();
  };

  const changeKind = (kind: ProviderKind) => {
    const preset = presetsByGroup()
      .flatMap((group) => group.presets)
      .find((item) => item.kind === kind && item.id !== 'custom');
    setAgent(
      preset && preset.kind === kind
        ? { provider: kind, preset: preset.id, baseUrl: preset.baseUrl, model: preset.defaultModel }
        : { provider: kind, preset: kind === 'local' ? 'local' : 'custom' },
    );
    clearModels();
  };

  const fetchModels = async () => {
    setModelsLoading(true);
    setModelsError('');
    try {
      const { models, infos, endpoint } = await api.agentModels({
        kind: form.agent.provider,
        baseUrl: form.agent.baseUrl || activePreset?.baseUrl || '',
        apiKey: apiKey.trim() || undefined,
      });
      setModelList(models);
      setModelInfos(infos ?? []);
      setModelSource(endpoint);
      if (!models.length) setModelsError('接口没有返回模型名，可直接在模型框手动填写。');
      else notify('success', '模型列表', `${models.length} 个模型 · ${infos?.length ? `${infos.filter((i) => i.contextWindow || i.reasoning || i.inputs?.length).length} 个带能力信息 · ` : ''}${endpoint}`);
    } catch (err: any) {
      setModelList([]);
      setModelInfos([]);
      setModelSource('');
      setModelsError(`${err?.message ?? '获取模型列表失败'}；也可直接手动填写模型名。`);
    } finally {
      setModelsLoading(false);
    }
  };

  const save = async () => {
    await saveSettings({
      ...form,
      agent: {
        ...form.agent,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      },
    });
    setOpen(false);
  };

  const downloadAudit = async () => {
    try {
      const res = await fetch('/api/audit?format=csv&limit=1000', { headers: { authorization: `Bearer ${TOKEN}` } });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'aidb-audit.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      notify('error', t('error'), err?.message);
    }
  };

  const nav: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: 'appearance', label: t('appearance'), icon: <Palette size={14} /> },
    { key: 'query', label: t('editor'), icon: <SlidersHorizontal size={14} /> },
    { key: 'agent', label: t('agentSettings'), icon: <Bot size={14} /> },
    { key: 'bridge', label: t('bridge'), icon: <Network size={14} /> },
    { key: 'data', label: t('dataSettings'), icon: <Database size={14} /> },
    { key: 'about', label: t('about'), icon: <Info size={14} /> },
  ];

  const savable = tab === 'appearance' || tab === 'query' || tab === 'agent';

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="modal wide settings-modal" role="dialog" aria-modal="true" style={{ height: 'min(740px, 90vh)' }}>
        <div className="modal-head">
          <h2>
            <Settings2 size={15} /> {t('settings')}
          </h2>
          <button className="icon-btn" onClick={() => setOpen(false)}>
            ×
          </button>
        </div>
        <div className="settings-layout" style={{ flex: 1, minHeight: 0 }}>
          <nav className="settings-nav">
            {nav.map((item) => (
              <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>
                {item.icon}
                {item.label}
              </button>
            ))}
          </nav>
          <div className="settings-content">
            {tab === 'appearance' ? (
              <div className="settings-section">
                <h3>{t('appearance')}</h3>
                <div className="form-grid">
                  <div className="field">
                    <label>{t('theme')}</label>
                    <select className="select" value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value as AppSettings['theme'] })}>
                      <option value="dark">{t('dark')}</option>
                      <option value="light">{t('light')}</option>
                      <option value="system">跟随系统</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>{t('language')}</label>
                    <select className="select" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value as AppSettings['locale'] })}>
                      <option value="zh">中文</option>
                      <option value="en">English</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>密度</label>
                    <select className="select" value={form.density} onChange={(e) => setForm({ ...form, density: e.target.value as AppSettings['density'] })}>
                      <option value="compact">紧凑</option>
                      <option value="comfortable">舒适</option>
                    </select>
                  </div>
                </div>
                <p className="desc">主题与语言即时生效；移动端使用同一套设计令牌。</p>
              </div>
            ) : null}

            {tab === 'query' ? (
              <div className="settings-section">
                <h3>{t('editor')} & 查询</h3>
                <div className="form-grid">
                  <div className="field">
                    <label>{t('defaultLimit')}</label>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={10000}
                      value={form.defaultLimit}
                      onChange={(e) => setForm({ ...form, defaultLimit: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>{t('queryTimeout')}</label>
                    <input
                      className="input"
                      type="number"
                      min={1000}
                      step={1000}
                      value={form.queryTimeoutMs}
                      onChange={(e) => setForm({ ...form, queryTimeoutMs: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={form.autoLimit} onChange={(e) => setForm({ ...form, autoLimit: e.target.checked })} /> {t('autoLimit')}
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={form.allowMultiStatement} onChange={(e) => setForm({ ...form, allowMultiStatement: e.target.checked })} /> {t('allowMulti')}
                </label>
                <p className="desc">多语句默认关闭；关闭时服务端会拒绝一次执行多条 SQL，避免误操作。</p>
              </div>
            ) : null}

            {tab === 'agent' ? (
              <>
                <div className="settings-section settings-section-wide">
                <h3>{t('agentSettings')}</h3>
                <div className="field">
                  <label>服务商快捷配置</label>
                  <div className="preset-groups">
                    {presetsByGroup().map((group) => (
                      <div key={group.group} className="preset-group">
                        <div className="preset-group-label">{group.group}</div>
                        <div className="preset-chips">
                          {group.presets.map((preset) => (
                            <button
                              key={preset.id}
                              className={`preset-chip ${activePreset?.id === preset.id ? 'active' : ''}`}
                              onClick={() => applyPreset(preset)}
                              title={[preset.baseUrl, preset.note].filter(Boolean).join(' · ')}
                              data-testid={`preset-${preset.id}`}
                            >
                              <span className="preset-dot" style={{ background: preset.color }} />
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  {activePreset?.note ? <span className="hint">{activePreset.note}</span> : null}
                </div>
                <div className="form-grid">
                  <div className="field">
                    <label>{t('provider')}</label>
                    <select
                      className="select"
                      value={form.agent.provider}
                      onChange={(e) => changeKind(e.target.value as ProviderKind)}
                      data-testid="settings-provider"
                    >
                      <option value="local">{t('providerLocal')}</option>
                      <option value="openai">OpenAI 兼容</option>
                      <option value="ollama">Ollama</option>
                      <option value="anthropic">{t('providerAnthropic')}</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>{t('model')}</label>
                    <div className="model-picker">
                      <input
                        className="input mono"
                        value={form.agent.model}
                        onChange={(e) => setAgent({ model: e.target.value })}
                        placeholder={form.agent.provider === 'local' ? 'local' : '自动获取或直接手动填写'}
                        disabled={form.agent.provider === 'local'}
                        data-testid="settings-model"
                      />
                      <button
                        className="btn small"
                        onClick={() => void fetchModels()}
                        disabled={modelsLoading || form.agent.provider === 'local'}
                        title="调用服务商的模型列表接口"
                        data-testid="settings-fetch-models"
                      >
                        {modelsLoading ? <Loader2 size={12} className="spin" /> : <ListChecks size={12} />} 获取模型
                      </button>
                    </div>
                  </div>
                  {form.agent.provider !== 'local' ? (
                    <>
                      <div className="field full">
                        <label>{t('baseUrl')}</label>
                        <input
                          className="input mono"
                          value={form.agent.baseUrl}
                          onChange={(e) => setAgent({ baseUrl: e.target.value })}
                          placeholder={activePreset?.baseUrl || 'https://api.example.com/v1'}
                          data-testid="settings-base-url"
                        />
                        <span className="hint">
                          {modelSource ? `模型列表来自 ${modelSource}（${modelList.length} 个）` : '切换服务商会自动填入官方端点，也可改成自建网关地址'}
                        </span>
                      </div>
                      {modelList.length ? (
                        <div className="field full">
                          <div className="row gap-6" style={{ alignItems: 'center', marginBottom: 6 }}>
                            <label style={{ margin: 0 }}>可用模型</label>
                            <input className="input" style={{ height: 26, maxWidth: 260 }} value={modelQuery} onChange={(e) => setModelQuery(e.target.value)} placeholder="过滤模型名…" />
                            <span className="muted" style={{ fontSize: 10.5 }}>点击填入，仍可自行编辑</span>
                          </div>
                          <div className="model-list" data-testid="settings-model-list">
                            {modelList
                              .filter((model) => !modelQuery || model.toLowerCase().includes(modelQuery.toLowerCase()))
                              .map((model) => {
                                const info = modelInfos.find((item) => item.id === model);
                                const caps = [
                                  info?.contextWindow ? formatTokenSize(info.contextWindow) : '',
                                  info?.reasoning ? '推理' : '',
                                  info?.inputs?.includes('image') ? '图片' : '',
                                ].filter(Boolean);
                                return (
                                  <button key={model} className={`model-item ${model === form.agent.model ? 'active' : ''}`} onClick={() => pickModel(model)} data-testid={`model-item-${model}`}>
                                    <span className="mono">{model}</span>
                                    {caps.length ? <span className="model-caps">{caps.join(' · ')}</span> : null}
                                    {form.agent.modelProfiles?.[model] ? <span className="badge read">已配置</span> : null}
                                  </button>
                                );
                              })}
                          </div>
                        </div>
                      ) : null}
                      {modelsError ? <div className="field full"><div className="risk-banner">{modelsError}</div></div> : null}
                      <div className="field full">
                        <label>
                          {t('apiKey')} {form.agent.hasApiKey ? <span className="badge read">已配置</span> : null}
                        </label>
                        <input
                          className="input mono"
                          type="password"
                          value={apiKey}
                          placeholder={form.agent.hasApiKey ? t('apiKeyHint') : activePreset?.keyRequired ? 'sk-...' : '本地服务可留空'}
                          onChange={(e) => setApiKey(e.target.value)}
                          data-testid="settings-api-key"
                        />
                        <span className="hint">
                          密钥只存在 Bridge 本地，不会下发到移动端。切换服务商后请更新对应的 Key。
                          {activePreset?.docs ? (
                            <>
                              {' '}
                              文档：<span className="mono">{activePreset.docs}</span>
                            </>
                          ) : null}
                        </span>
                        {apiKey.trim() ? (
                          <span className="hint">
                            <button className="link-btn" onClick={() => setApiKey('__CLEAR__')}>
                              清除已保存的密钥
                            </button>
                          </span>
                        ) : null}
                      </div>
                    </>
                  ) : (
                    <div className="field full">
                      <div className="setting-card" style={{ fontSize: 11.5, lineHeight: 1.7 }}>
                        <strong>Local Reasoner（离线）</strong>
                        <div className="muted">无需 API Key，支持：查看表/结构/样例、计数与分组、创建表、建索引、删除、生成示例数据、备份、导出、记忆检索。复杂推理请配置云端模型。</div>
                      </div>
                    </div>
                  )}
                  {form.agent.provider !== 'local' && form.agent.model ? (
                    <ModelProfileEditor
                      model={form.agent.model}
                      profile={profile}
                      onPatch={patchProfile}
                      onClear={() => setForm((prev) => ({ ...prev, agent: withoutModelProfile(prev.agent, prev.agent.model) }))}
                    />
                  ) : null}
                  <div className="field">
                    <label>{t('maxSteps')}</label>
                    <input className="input" type="number" min={1} max={40} value={form.agent.maxSteps} onChange={(e) => setAgent({ maxSteps: Number(e.target.value) })} />
                  </div>
                  <div className="field">
                    <label>Temperature</label>
                    <input className="input" type="number" min={0} max={2} step={0.1} value={form.agent.temperature} onChange={(e) => setAgent({ temperature: Number(e.target.value) })} />
                  </div>
                  <div className="field">
                    <label>上下文压缩阈值（tokens）</label>
                    <input className="input" type="number" min={4000} step={1000} value={form.agent.compactionThreshold} onChange={(e) => setAgent({ compactionThreshold: Number(e.target.value) })} />
                  </div>
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={form.agent.autoMemory} onChange={(e) => setAgent({ autoMemory: e.target.checked })} />
                  {t('autoMemory')}（自动沉淀事实、偏好与会话摘要）
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.agent.followUpSuggestions}
                    onChange={(e) => setAgent({ followUpSuggestions: e.target.checked })}
                    data-testid="settings-followups"
                  />
                  追问建议（每轮结束后按涉及的表推荐下一步问题，本地生成、不消耗 token）
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={form.agent.snapshotBeforeWrite} onChange={(e) => setAgent({ snapshotBeforeWrite: e.target.checked })} />
                  {t('snapshotBeforeWrite')}（破坏性操作前自动 SQL dump）
                </label>
                <p className="desc">权限策略：只读 → 拒绝写；询问 → 写/DDL 需确认；自动 → 仅破坏性需确认；全自动 → 全部放行（生产环境破坏性操作仍需确认）。所有调用写入审计。</p>
              </div>
                <div className="settings-section settings-section-wide">
                  <h3>向量检索（Embedding）</h3>
                  <p className="desc">pgvector / Qdrant / Milvus 的文本检索需要 Embedding 服务；也可以直接传入向量。</p>
                  <div className="form-grid">
                    <div className="field">
                      <label>Provider</label>
                      <select className="select" value={form.embedding.provider} onChange={(e) => setEmbedding({ provider: e.target.value as AppSettings['embedding']['provider'] })} data-testid="settings-embedding-provider">
                        <option value="none">未配置</option>
                        <option value="openai">OpenAI 兼容 /embeddings</option>
                        <option value="ollama">Ollama /api/embeddings</option>
                      </select>
                    </div>
                    <div className="field">
                      <label>Model</label>
                      <input className="input" value={form.embedding.model} onChange={(e) => setEmbedding({ model: e.target.value })} placeholder="text-embedding-3-small" disabled={form.embedding.provider === 'none'} />
                    </div>
                    <div className="field full">
                      <label>Base URL</label>
                      <input
                        className="input mono"
                        value={form.embedding.baseUrl}
                        onChange={(e) => setEmbedding({ baseUrl: e.target.value })}
                        placeholder="https://api.openai.com/v1"
                        disabled={form.embedding.provider === 'none'}
                      />
                    </div>
                    <div className="field full">
                      <label>API Key {form.embedding.hasApiKey ? <span className="badge read">已配置</span> : null}</label>
                      <input
                        className="input mono"
                        type="password"
                        value={form.embedding.apiKey ?? ''}
                        onChange={(e) => setEmbedding({ apiKey: e.target.value })}
                        placeholder={form.embedding.hasApiKey ? '已保存，留空保持不变' : form.embedding.provider === 'ollama' ? '本地 Ollama 可留空' : 'sk-...'}
                        disabled={form.embedding.provider === 'none'}
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {tab === 'bridge' ? (
              <div className="settings-section">
                <h3>{t('bridge')}</h3>
                <div className="setting-card">
                  <div className="row">
                    <Network size={14} style={{ color: 'var(--accent)' }} />
                    <span className="mono" style={{ fontSize: 11.5 }}>{location.origin}</span>
                    <div className="spacer" />
                    <span className="badge read">本地</span>
                  </div>
                  <p className="hint" style={{ marginTop: 8 }}>
                    Bridge 承载数据库驱动、Agent 运行时与元数据。桌面端内置；移动端通过配对访问，会话与记忆跨端同步。
                  </p>
                </div>
                <div className="setting-card">
                  <div className="row">
                    <KeyRound size={14} />
                    <strong style={{ fontSize: 12 }}>{t('pairing')}</strong>
                    <div className="spacer" />
                    <button className="btn small" onClick={() => void startPairing()}>
                      <RefreshCw size={11} /> {t('startPairing')}
                    </button>
                  </div>
                  {pairing ? (
                    <>
                      <div className="row" style={{ marginTop: 10 }}>
                        <span className="mono" style={{ fontSize: 26, letterSpacing: 8, color: 'var(--agent)' }}>{pairing.code}</span>
                        <span className="badge write">5 分钟有效</span>
                        <div className="spacer" />
                        <button className="icon-btn" onClick={() => void navigator.clipboard.writeText(pairing.code)}>
                          <ShieldCheck size={14} />
                        </button>
                      </div>
                      <p className="hint">移动端填写：{pairing.host}:{pairing.port} + 上方配对码。建议仅在内网使用；远程访问请置于 TLS 反向代理之后。</p>
                    </>
                  ) : (
                    <p className="hint" style={{ marginTop: 8 }}>{t('pairHint')}</p>
                  )}
                </div>
                <div>
                  <h3 style={{ marginBottom: 8 }}>{t('devices')}</h3>
                  {devices.length ? (
                    devices.map((device) => (
                      <div key={device.id} className="setting-card row" style={{ marginBottom: 6 }}>
                        <span className="badge">{device.platform}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12 }}>{device.name}</div>
                          <div className="muted" style={{ fontSize: 10 }}>配对于 {formatRelative(device.pairedAt)}</div>
                        </div>
                        {device.revoked ? <span className="badge destructive">已吊销</span> : <button className="btn small danger" onClick={() => void revokeDevice(device.id)}>{t('revoke')}</button>}
                      </div>
                    ))
                  ) : (
                    <p className="hint">{t('noDevices')}</p>
                  )}
                </div>
              </div>
            ) : null}

            {tab === 'data' ? (
              <div className="settings-section">
                <h3>{t('dataSettings')} & {t('audit')}</h3>
                <div className="row gap-8">
                  <button className="btn small" onClick={() => void downloadAudit()}>
                    <Download size={12} /> 导出审计 CSV
                  </button>
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      if (!window.confirm('清空全部查询历史？')) return;
                      await api.clearHistory();
                      notify('success', '查询历史已清空');
                    }}
                  >
                    <Trash2 size={12} /> 清空历史
                  </button>
                </div>
                {dataLoading ? <div className="loading-inline"><span className="spinner" /> {t('loading')}</div> : null}
                {audit.length ? (
                  <div className="panel">
                    <div className="panel-head">最近审计 <span className="badge">{audit.length}</span></div>
                    <div style={{ maxHeight: 260, overflow: 'auto' }}>
                      {audit.map((entry) => (
                        <div key={entry.id} style={{ padding: '7px 10px', borderBottom: '1px solid var(--border-subtle)' }}>
                          <div className="row" style={{ fontSize: 11 }}>
                            <span className={`badge ${entry.actor === 'agent' ? 'agent' : ''}`}>{entry.actor}</span>
                            {entry.tool ? <span className="mono">{entry.tool}</span> : null}
                            <RiskBadge risk={entry.risk} />
                            <span className={`badge ${entry.status === 'ok' ? 'read' : 'destructive'}`}>{entry.status}</span>
                            <div className="spacer" />
                            <span className="muted">{formatRelative(entry.createdAt)}</span>
                          </div>
                          {entry.sql ? <div className="mono muted" style={{ fontSize: 10, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.sql}</div> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <h3 style={{ marginTop: 8 }}>备份</h3>
                {backups.length ? (
                  backups.slice(0, 8).map((backup) => (
                    <div key={backup.id} className="setting-card" style={{ marginBottom: 6 }}>
                      <div className="row">
                        <span className="badge read">{backup.format.toUpperCase()}</span>
                        <span className="mono" style={{ fontSize: 10.5, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{backup.path}</span>
                        <span className="muted" style={{ fontSize: 10 }}>{formatBytes(backup.bytes)}</span>
                        <button
                          className="btn ghost small"
                          onClick={async () => {
                            if (!window.confirm(`从备份恢复将执行 SQL 并可能覆盖现有结构/数据：
${backup.path}

继续？`)) return;
                            try {
                              await api.restoreBackup(backup.id);
                              notify('success', '备份已恢复', backup.path);
                            } catch (err: any) {
                              notify('error', '恢复失败', err?.message);
                            }
                          }}
                        >
                          恢复
                        </button>
                      </div>
                      <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{formatRelative(backup.createdAt)}{backup.label ? ` · ${backup.label}` : ''}</div>
                    </div>
                  ))
                ) : (
                  <p className="hint">还没有备份。可在命令面板执行“备份当前数据库”，或让 Agent 备份。</p>
                )}
              </div>
            ) : null}

            {tab === 'about' ? (
              <div className="settings-section">
                <h3>AiDB Studio</h3>
                <div className="setting-card">
                  <div className="row">
                    <div className="brand-mark" style={{ width: 34, height: 34, fontSize: 13 }}>AI</div>
                    <div>
                      <div style={{ fontWeight: 650 }}>AiDB Studio v0.1.0</div>
                      <div className="muted" style={{ fontSize: 11 }}>AI-native, cross-platform database studio</div>
                    </div>
                  </div>
                </div>
                <p className="desc">
                  五端覆盖：Windows / macOS / Linux（Electron）与 Android / iOS（Expo React Native）。Agent 运行时、数据库驱动与元数据位于 Bridge；
                  桌面与移动端共享同一协议、会话与四层记忆。
                </p>
                <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                  <span className="badge">Electron</span>
                  <span className="badge">React</span>
                  <span className="badge">CodeMirror 6</span>
                  <span className="badge">node:sqlite</span>
                  <span className="badge">Expo</span>
                  <span className="badge agent">22 tools</span>
                  <span className="badge agent">4-layer memory</span>
                </div>
                <p className="hint">设计文档位于仓库 docs/（产品、架构、功能、UI/UX、Agent、数据模型、验证报告）。License: MIT。</p>
              </div>
            ) : null}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => setOpen(false)}>{t('close')}</button>
          <div className="spacer" />
          {savable ? (
            <button className="btn primary" onClick={() => void save()} data-testid="settings-save">
              {t('save')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** 单个模型的能力档案编辑器：上下文窗口、最大输出、输入类型与推理档位映射。 */
function ModelProfileEditor({
  model,
  profile,
  onPatch,
  onClear,
}: {
  model: string;
  profile?: ModelProfile;
  onPatch: (patch: Partial<ModelProfile>) => void;
  onClear: () => void;
}) {
  const inputs = profile?.inputs ?? [];
  const tiers = profile?.reasoningTiers ?? [];
  const levels = [...new Set<string>([...TIER_LEVELS, ...tiers.map((tier) => tier.level)])];

  const toggleInput = (modality: ModelInputModality) => {
    const next = new Set(inputs);
    if (next.has(modality)) next.delete(modality);
    else next.add(modality);
    onPatch({ inputs: [...next] });
  };

  const setTiers = (next: ModelReasoningTier[]) => onPatch({ reasoningTiers: next });

  /** 标准档位用尽后仍要保证 level 唯一，否则聊天面板的下拉会出现重复 key。 */
  const nextLevel = (taken: Set<string>) => {
    const free = levels.find((level) => !taken.has(level));
    if (free) return free;
    let index = 2;
    while (taken.has(`custom_${index}`)) index += 1;
    return `custom_${index}`;
  };

  return (
    <div className="field full model-profile" data-testid="model-profile">
      <div className="model-profile-head">
        <label>模型能力</label>
        <span className="mono muted">{model}</span>
        <div className="spacer" />
        {profile ? (
          <button className="link-btn" onClick={onClear} data-testid="model-profile-clear">
            清除该模型的档案
          </button>
        ) : null}
      </div>
      <div className="model-profile-grid">
        <div className="field">
          <label>上下文窗口</label>
          <input
            className="input"
            key={`ctx-${model}`}
            defaultValue={profile?.contextWindow ? formatTokenSize(profile.contextWindow) : ''}
            placeholder="256K"
            onBlur={(e) => onPatch({ contextWindow: parseTokenSize(e.target.value) })}
            data-testid="model-context-window"
          />
        </div>
        <div className="field">
          <label>最大输出 token 数</label>
          <input
            className="input"
            key={`max-${model}`}
            defaultValue={profile?.maxOutputTokens ? formatTokenSize(profile.maxOutputTokens) : ''}
            placeholder="32K"
            onBlur={(e) => onPatch({ maxOutputTokens: parseTokenSize(e.target.value) })}
            data-testid="model-max-output"
          />
        </div>
      </div>
      <div className="field">
        <label>输入类型</label>
        <div className="row gap-6">
          <label className="checkbox">
            <input type="checkbox" checked={inputs.includes('text')} onChange={() => toggleInput('text')} /> 文本
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={inputs.includes('image')} onChange={() => toggleInput('image')} data-testid="model-input-image" /> 图片
          </label>
        </div>
        <span className="hint">勾选「图片」后聊天面板才能贴图；两项都不选按仅文本处理。</span>
      </div>
      <div className="model-profile-switch">
        <label>
          推理等级
          <span className="tip" title="开启后可定义档位与发给服务商的参数值。OpenAI 兼容协议按字符串下发 reasoning_effort；Anthropic 协议把值当作 thinking.budget_tokens 的数字。">?</span>
        </label>
        <div className="spacer" />
        <button
          className={`switch ${profile?.reasoning ? 'on' : ''}`}
          role="switch"
          aria-checked={Boolean(profile?.reasoning)}
          data-testid="model-reasoning-toggle"
          onClick={() =>
            onPatch(
              profile?.reasoning
                ? { reasoning: false }
                : { reasoning: true, reasoningTiers: tiers.length ? tiers : DEFAULT_REASONING_TIERS.map((tier) => ({ ...tier })) },
            )
          }
        >
          <span className="knob" />
        </button>
      </div>
      {profile?.reasoning ? (
        <div className="tier-table" data-testid="model-tiers">
          <div className="tier-row tier-row-head">
            <span>档位</span>
            <span>API 参数值</span>
            <span />
          </div>
          {tiers.map((tier, index) => (
            <div className="tier-row" key={`${tier.level}_${index}`}>
              <select
                className="select"
                value={tier.level}
                onChange={(e) => setTiers(tiers.map((item, i) => (i === index ? { ...item, level: e.target.value } : item)))}
              >
                {levels.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
              <input
                className="input mono"
                value={tier.value}
                placeholder={tier.level === 'off' ? '关闭思考' : '如 low / 2048'}
                onChange={(e) => setTiers(tiers.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))}
                data-testid={`model-tier-value-${tier.level}`}
              />
              <button className="icon-btn" title="删除档位" onClick={() => setTiers(tiers.filter((_, i) => i !== index))}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {!tiers.length ? <div className="hint">还没有档位，点下面的按钮添加。</div> : null}
          <button
            className="btn small"
            onClick={() => setTiers([...tiers, { level: nextLevel(new Set(tiers.map((tier) => tier.level))), value: '' }])}
            data-testid="model-tier-add"
          >
            <Plus size={12} /> 添加档位
          </button>
          <span className="hint">值留空表示该档不下发任何推理参数。</span>
        </div>
      ) : null}
    </div>
  );
}
