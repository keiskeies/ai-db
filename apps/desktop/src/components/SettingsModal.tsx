import { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { secondsLeft, useNow } from '../lib/pairingCountdown';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Database,
  Download,
  Info,
  KeyRound,
  BookOpen,
  Bell,
  Boxes,
  Plug,
  Loader2,
  Network,
  Palette,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import type { AgentModelConfig, AgentModelEntry, AppSettings, AuditEntry, BackupInfo, ModelInputModality, ModelProfile, ModelReasoningTier, ProviderKind, ProviderPreset } from '@aidb/core';
import {
  DEFAULT_REASONING_TIERS,
  TIER_LEVELS,
  formatTokenSize,
  matchPreset,
  parseTokenSize,
  presetById,
  presetsByGroup,
  profileFromModelInfo,
  withModelProfile,
  withoutModelProfile,
} from '@aidb/core';
import { api, TOKEN } from '../lib/api';
import { formatBytes, formatRelative } from '../lib/format';
import { useApp, type SettingsTab } from '../store';
import { LOCALES } from '../i18n';
import { Option, RiskBadge, SecretInput, Select } from './ui';
import { askConfirm } from './AskDialog';
import { SkillsTool } from './tools/SkillsTool';
import { WebSearchTool } from './tools/WebSearchTool';
import { McpTool } from './tools/McpTool';
import { CapabilitiesTool } from './tools/CapabilitiesTool';
import { NotificationsTool } from './tools/NotificationsTool';
import { t as tr } from '../i18n';

type TabKey = SettingsTab;

/** 编辑中的模型行：orig 记录服务端原来的模型 id，提交时才把能力档案迁到新 id。 */
type DraftModel = AgentModelEntry & { orig?: string };
type ModelDraft = Omit<AgentModelConfig, 'models'> & { models: DraftModel[] };

export function SettingsModal() {
  const open = useApp((s) => s.settingsOpen);
  const settingsTab = useApp((s) => s.settingsTab);
  const settings = useApp((s) => s.settings);
  const t = useApp((s) => s.t);
  const setOpen = useApp((s) => s.setSettingsOpen);
  const saveSettings = useApp((s) => s.saveSettings);
  const notify = useApp((s) => s.notify);
  const pairing = useApp((s) => s.pairing);
  const mcpPairing = useApp((s) => s.mcpPairing);
  const devices = useApp((s) => s.devices);
  const startPairing = useApp((s) => s.startPairing);
  const startMcpPairing = useApp((s) => s.startMcpPairing);
  // 移动端与 MCP 两张卡片共用一个 60 秒倒计时：任一配对码存在时每秒刷新，归零后显示过期。
  const now = useNow(Boolean(pairing || mcpPairing));
  const mobileSecondsLeft = pairing ? secondsLeft(pairing.createdAt, pairing.expiresIn, now) : 0;
  const mcpSecondsLeft = mcpPairing ? secondsLeft(mcpPairing.createdAt, mcpPairing.expiresIn, now) : 0;
  const loadDevices = useApp((s) => s.loadDevices);
  const revokeDevice = useApp((s) => s.revokeDevice);

  const [pairingQr, setPairingQr] = useState('');
  useEffect(() => {
    let alive = true;
    if (!pairing) {
      setPairingQr('');
      return;
    }
    const payload = pairing.qrPayload ?? JSON.stringify({ v: 1, url: pairing.url ?? `http://${pairing.host}:${pairing.port}`, host: pairing.host, port: pairing.port, code: pairing.code });
    QRCode.toDataURL(payload, { margin: 1, width: 336, color: { dark: '#0b0d0d', light: '#ffffff' } })
      .then((url) => {
        if (alive) setPairingQr(url);
      })
      .catch(() => {
        if (alive) setPairingQr('');
      });
    return () => {
      alive = false;
    };
  }, [pairing]);

  const [tab, setTab] = useState<TabKey>('appearance');
  const [navQuery, setNavQuery] = useState('');
  const [form, setForm] = useState<AppSettings>(settings);
  const [draft, setDraft] = useState<ModelDraft | null>(null);
  const [draftNew, setDraftNew] = useState(false);
  const [draftKey, setDraftKey] = useState('');
  const [draftKeyDirty, setDraftKeyDirty] = useState(false);
  const [draftShowAdvanced, setDraftShowAdvanced] = useState(true);
  const [expandedModel, setExpandedModel] = useState('');
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [modelSource, setModelSource] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState('');
  /** 只在真正打开弹窗时重置草稿/页签；设置重启刷新时保留当前页。 */
  const openedRef = useRef(false);

  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (!openedRef.current) {
      openedRef.current = true;
      setDraft(null);
      setDraftNew(false);
      setDraftKey('');
      setDraftKeyDirty(false);
      setDraftShowAdvanced(true);
      setExpandedModel('');
      setTab(settingsTab ?? 'appearance');
      setModelSource('');
      setModelsError('');
      void loadDevices();
    }
    setForm(settings);
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

  const modelConfigs = form.agent.modelConfigs ?? [];
  const activeModelId = form.agent.activeModelId ?? modelConfigs[0]?.id ?? '';
  const apiKeyStatus = form.agent.modelApiKeyStatus ?? {};

  const draftPreset = useMemo(
    () =>
      draft
        ? presetById(draft.preset) ??
          matchPreset(draft.provider as ProviderKind, draft.baseUrl) ??
          presetById(draft.provider === 'local' ? 'local' : 'custom')
        : undefined,
    [draft?.preset, draft?.provider, draft?.baseUrl],
  );

  if (!open) return null;

  const setAgent = (patch: Partial<AppSettings['agent']>) => setForm((prev) => ({ ...prev, agent: { ...prev.agent, ...patch } }));
  const setEmbedding = (patch: Partial<AppSettings['embedding']>) =>
    setForm((prev) => ({ ...prev, embedding: { ...prev.embedding, ...patch } }));

  const clearModels = () => {
    setModelSource('');
    setModelsError('');
  };

  const patchDraft = (patch: Partial<AgentModelConfig>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));

  const resetDraftState = () => {
    setDraft(null);
    setDraftNew(false);
    setDraftKey('');
    setDraftKeyDirty(false);
    setDraftShowAdvanced(true);
    setExpandedModel('');
    clearModels();
  };

  const startAddModel = () => {
    const base = presetById('custom');
    setDraft({
      id: `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      provider: base?.kind ?? form.agent.provider,
      preset: base?.id,
      baseUrl: base?.baseUrl ?? '',
      models: [],
    });
    setDraftNew(true);
    setDraftKey('');
    setDraftKeyDirty(false);
    setDraftShowAdvanced(true);
    setExpandedModel('');
    clearModels();
  };

  const startEditModel = (config: AgentModelConfig) => {
    setDraft({ ...config, models: config.models.map((item) => ({ id: item.id, name: item.name, orig: item.id })) });
    setDraftNew(false);
    setDraftKey('');
    setDraftKeyDirty(false);
    setDraftShowAdvanced(true);
    setExpandedModel('');
    clearModels();
  };

  const cancelDraft = () => resetDraftState();

  /** 加/改模型行：id 改名不在编辑期迁移档案，避免取消编辑后档案被改坏。 */
  const updateDraftModel = (index: number, patch: Partial<DraftModel>) => {
    const current = draft?.models[index];
    if (!current) return;
    const oldId = current.id;
    setDraft((prev) => (prev ? { ...prev, models: prev.models.map((item, i) => (i === index ? { ...item, ...patch } : item)) } : prev));
    if (patch.id === undefined || patch.id === oldId) return;
    setExpandedModel((prev) => (prev === oldId ? patch.id! : prev));
    // 新加的模型还没落库，改名时直接把档案跟着走；已有模型留到提交时迁移。
    if (current.orig) return;
    const newId = patch.id.trim();
    setForm((prev) => {
      const profiles = { ...(prev.agent.modelProfiles ?? {}) };
      if (!oldId || !profiles[oldId]) return prev;
      const profile = profiles[oldId];
      delete profiles[oldId];
      if (newId) profiles[newId] = profile;
      return { ...prev, agent: { ...prev.agent, modelProfiles: profiles } };
    });
  };

  const addDraftModelRow = () => setDraft((prev) => (prev ? { ...prev, models: [...prev.models, { id: '' }] } : prev));

  const removeDraftModelAt = (index: number) => {
    const removed = draft?.models[index];
    setDraft((prev) => (prev ? { ...prev, models: prev.models.filter((_, i) => i !== index) } : prev));
    if (removed && expandedModel === removed.id) setExpandedModel('');
  };

  const mergeDraftModels = (ids: string[]) => {
    const incoming = ids.map((id) => id.trim()).filter(Boolean);
    if (!incoming.length) return;
    setDraft((prev) => {
      if (!prev) return prev;
      const have = new Set(prev.models.map((item) => item.id.trim()).filter(Boolean));
      const extra = incoming.filter((id) => !have.has(id)).map((id) => ({ id }));
      return { ...prev, models: [...prev.models.filter((item) => item.id.trim()), ...extra] };
    });
  };

  const presetModelIds = (preset?: ProviderPreset) =>
    preset?.models?.length ? preset.models : preset?.defaultModel ? [preset.defaultModel] : [];

  const applyDraftPreset = (preset: ProviderPreset) => {
    const fallback = presetModelIds(preset).map((id) => ({ id }));
    setDraft((prev) =>
      prev
        ? {
            ...prev,
            provider: preset.kind,
            preset: preset.id,
            baseUrl: preset.baseUrl,
            models: prev.models.some((item) => item.id.trim()) ? prev.models : fallback,
          }
        : prev,
    );
    setExpandedModel('');
    clearModels();
  };

  const changeDraftKind = (kind: ProviderKind) => {
    const preset = presetsByGroup()
      .flatMap((group) => group.presets)
      .find((item) => item.kind === kind && item.id !== 'custom');
    setDraft((prev) => {
      if (!prev) return prev;
      const next = preset && preset.kind === kind
        ? { ...prev, provider: kind, preset: preset.id, baseUrl: preset.baseUrl }
        : { ...prev, provider: kind, preset: kind === 'local' ? 'local' : 'custom' };
      if (preset && !prev.models.some((item) => item.id.trim())) next.models = presetModelIds(preset).map((id) => ({ id }));
      return next;
    });
    setExpandedModel('');
    clearModels();
  };

  const restoreDefaultModels = () => {
    if (!draft) return;
    const ids = presetModelIds(draftPreset);
    if (!ids.length) {
      notify('warning', tr("模型目录"), tr("该服务商没有默认模型，请用“获取可用模型”或手动添加。"));
      return;
    }
    setDraft({ ...draft, models: ids.map((id) => ({ id })) });
    setExpandedModel('');
  };

  const commitDraft = () => {
    if (!draft) return;
    const seen = new Set<string>();
    const drafted = draft.models
      .map((item) => ({ id: item.id.trim(), name: item.name?.trim() || undefined, orig: item.orig }))
      .filter((item) => item.id && !seen.has(item.id) && (seen.add(item.id), true));
    if (!drafted.length) {
      notify('warning', tr("模型配置"), tr("至少给这个服务商添加一个模型"));
      return;
    }
    const renames = drafted.filter((item) => item.orig && item.orig !== item.id);
    const config: AgentModelConfig = {
      id: draft.id,
      name: draft.name?.trim() || undefined,
      provider: draft.provider,
      preset: draft.preset,
      baseUrl: draft.baseUrl.trim(),
      models: drafted.map(({ id, name }) => ({ id, name })),
    };
    const keyPatch = draftKeyDirty ? draftKey.trim() || '__CLEAR__' : undefined;
    const list = form.agent.modelConfigs ?? [];
    const exists = list.some((item) => item.id === config.id);
    const modelConfigs = exists ? list.map((item) => (item.id === config.id ? config : item)) : [...list, config];
    const activeId = form.agent.activeModelId ?? list[0]?.id ?? config.id;
    let agent: AppSettings['agent'] = {
      ...form.agent,
      modelConfigs,
      activeModelId: activeId,
      ...(keyPatch ? { modelKeys: { ...(form.agent.modelKeys ?? {}), [config.id]: keyPatch } } : {}),
    };
    if (keyPatch) {
      agent = { ...agent, modelApiKeyStatus: { ...(form.agent.modelApiKeyStatus ?? {}), [config.id]: keyPatch !== '__CLEAR__' } };
    }
    if (renames.length) {
      const profiles = { ...(agent.modelProfiles ?? {}) };
      let changed = false;
      for (const item of renames) {
        const profile = profiles[item.orig!];
        if (!profile) continue;
        delete profiles[item.orig!];
        profiles[item.id] = { ...profile, ...(profiles[item.id] ?? {}) };
        changed = true;
      }
      if (changed) agent = { ...agent, modelProfiles: profiles };
    }
    if (activeId === config.id) {
      const renamedActive = renames.find((item) => item.orig === agent.model)?.id;
      const model = renamedActive && config.models.some((entry) => entry.id === renamedActive)
        ? renamedActive
        : config.models.some((entry) => entry.id === agent.model) ? agent.model : config.models[0].id;
      agent = { ...agent, provider: config.provider, preset: config.preset, baseUrl: config.baseUrl, model };
      const tiers = agent.modelProfiles?.[model]?.reasoningTiers ?? [];
      if (agent.reasoningTier && !tiers.some((tier) => tier.level === agent.reasoningTier)) agent.reasoningTier = undefined;
    }
    const nextForm: AppSettings = { ...form, agent };
    setForm(nextForm);
    // 编辑器里的“保存”即写 Bridge，避免用户以为已保存后又关闭弹窗导致丢失。
    void saveSettings({ ...nextForm } as unknown as Record<string, unknown>);
    resetDraftState();
  };

  const removeModelConfig = (config: AgentModelConfig) => {
    const list = form.agent.modelConfigs ?? [];
    if (list.length <= 1) return;
    const modelConfigs = list.filter((item) => item.id !== config.id);
    const wasActive = (form.agent.activeModelId ?? list[0]?.id) === config.id;
    const fallback = modelConfigs[0];
    const fallbackModel = fallback.models[0]?.id ?? '';
    const status = { ...(form.agent.modelApiKeyStatus ?? {}) };
    delete status[config.id];
    let agent: AppSettings['agent'] = {
      ...form.agent,
      modelConfigs,
      activeModelId: wasActive ? fallback.id : form.agent.activeModelId,
      modelKeys: { ...(form.agent.modelKeys ?? {}), [config.id]: '__CLEAR__' },
      modelApiKeyStatus: status,
    };
    if (wasActive) {
      agent = { ...agent, provider: fallback.provider, preset: fallback.preset, baseUrl: fallback.baseUrl, model: fallbackModel };
      const tiers = agent.modelProfiles?.[fallbackModel]?.reasoningTiers ?? [];
      if (agent.reasoningTier && !tiers.some((tier) => tier.level === agent.reasoningTier)) agent.reasoningTier = undefined;
    }
    const nextForm: AppSettings = { ...form, agent };
    setForm(nextForm);
    void saveSettings({ ...nextForm } as unknown as Record<string, unknown>);
    if (draft?.id === config.id) resetDraftState();
  };

  const patchDraftProfile = (model: string, patch: Partial<ModelProfile>) => {
    const key = model.trim();
    if (!key) return;
    setForm((prev) => ({
      ...prev,
      agent: withModelProfile(prev.agent, key, { ...(prev.agent.modelProfiles?.[key] ?? {}), ...patch }),
    }));
  };

  const fetchModels = async () => {
    if (!draft) return;
    setModelsLoading(true);
    setModelsError('');
    const typedKey = draftKeyDirty && draftKey.trim() && draftKey !== '__CLEAR__' ? draftKey.trim() : undefined;
    try {
      const { models, infos, endpoint } = await api.agentModels({
        kind: draft.provider,
        baseUrl: draft.baseUrl || draftPreset?.baseUrl || '',
        apiKey: typedKey,
        modelConfigId: draftNew ? undefined : draft.id,
      });
      setModelSource(endpoint);
      if (!models.length) {
        setModelsError(tr("接口没有返回模型名，可手动添加。"));
        return;
      }
      mergeDraftModels(models);
      const detectedInfos = infos ?? [];
      setForm((prev) => {
        let agent = prev.agent;
        for (const info of detectedInfos) {
          if (agent.modelProfiles?.[info.id]) continue;
          const detected = profileFromModelInfo(info);
          if (detected) agent = withModelProfile(agent, info.id, detected);
        }
        return { ...prev, agent };
      });
      notify(
        'success',
        tr("模型目录"),
        tr("拉到 {0} 个模型，已合并到目录{1} · {2}", [models.length, detectedInfos.length ? tr("，能力信息已自动预填") : '', endpoint]),
      );
    } catch (err: any) {
      setModelSource('');
      setModelsError(tr("{0}；也可手动添加模型名。", [err?.message ?? tr("获取模型列表失败")]));
    } finally {
      setModelsLoading(false);
    }
  };

  const save = async () => {
    await saveSettings({ ...form });
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

  const navGroups: Array<{ label: string; items: Array<{ key: TabKey; label: string; icon: React.ReactNode; keywords?: string }> }> = [
    {
      label: tr("基础"),
      items: [
        { key: 'appearance', label: t('appearance'), icon: <Palette size={14} />, keywords: tr("主题 颜色 语言 theme") },
        { key: 'query', label: t('editor'), icon: <SlidersHorizontal size={14} />, keywords: tr("查询 超时 行数 SQL 编辑器") },
        { key: 'agent', label: tr("模型"), icon: <Bot size={14} />, keywords: tr("Agent provider api key 温度 推理 模型") },
      ],
    },
    {
      label: tr("集成与连接"),
      items: [{ key: 'notify', label: tr("通知与机器人"), icon: <Bell size={14} />, keywords: tr("通知 机器人 飞书 企微 微信 钉钉 Slack Discord Telegram QQ") }],
    },
    {
      label: tr("能力扩展"),
      items: [
        { key: 'skills', label: 'Agent Skills', icon: <BookOpen size={14} />, keywords: tr("技能 技能包 PPT Master 内置") },
        { key: 'mcp', label: tr("MCP 与工具"), icon: <Plug size={14} />, keywords: tr("MCP 工具 外部 Server 文件系统 Git") },
        { key: 'capabilities', label: tr("功能能力"), icon: <Boxes size={14} />, keywords: tr("能力 契约 工具箱 表单 字段 功能 capability") },
        { key: 'search', label: tr("网络搜索"), icon: <Search size={14} />, keywords: tr("搜索 Exa Parallel Bing DuckDuckGo SearXNG Brave Tavily Serper Mojeek DeepSeek Anthropic OpenAI 代理") },
      ],
    },
    {
      label: tr("系统"),
      items: [
        { key: 'bridge', label: t('bridge'), icon: <Network size={14} />, keywords: tr("网关 配对 移动端 连接") },
        { key: 'data', label: tr("数据与备份"), icon: <Database size={14} />, keywords: tr("数据 备份 导出 导入") },
        { key: 'about', label: t('about'), icon: <Info size={14} />, keywords: tr("关于 版本 许可 依赖") },
      ],
    },
  ];
  const navText = navQuery.trim().toLowerCase();
  const visibleNavGroups = navGroups
    .map((group) => ({ ...group, items: group.items.filter((item) => !navText || `${item.label} ${item.keywords ?? ''}`.toLowerCase().includes(navText)) }))
    .filter((group) => group.items.length > 0);

  const savable = tab === 'appearance' || tab === 'query' || tab === 'agent';

  const activeEntry = modelConfigs.find((config) => config.id === activeModelId)?.models.find((entry) => entry.id === form.agent.model);
  const activeLabel = activeEntry?.name || activeEntry?.id || form.agent.model;

  const modelEditor = draft ? (
    <div className="provider-editor" data-testid="model-config-editor">
      <div className="field">
        <label>
          {tr(" API 密钥 ")}{apiKeyStatus[draft.id] ? <span className="badge read">{tr("已配置")}</span> : null}
        </label>
        <SecretInput
          className="input mono"
          value={draftKey === '__CLEAR__' ? '' : draftKey}
          placeholder={apiKeyStatus[draft.id] ? t('apiKeyHint') : draftPreset?.keyRequired ? 'sk-...' : tr("本地服务可留空")}
          onChange={(e) => {
            setDraftKey(e.target.value);
            setDraftKeyDirty(true);
          }}
          name="aidb-model-api-key"
          data-testid="settings-api-key"
        />
        <span className="hint">{tr("密钥按服务商加密保存在 Bridge 本地，不会下发到移动端；留空保持不变。")}</span>
        {apiKeyStatus[draft.id] ? (
          <span className="hint">
            <button
              className="link-btn"
              onClick={() => {
                setDraftKey(draftKey === '__CLEAR__' ? '' : '__CLEAR__');
                setDraftKeyDirty(true);
              }}
            >
              {draftKey === '__CLEAR__' ? tr("保存后将清除，点击撤销") : tr("清除已保存的密钥")}
            </button>
          </span>
        ) : null}
      </div>

      <button className="provider-advanced-toggle" type="button" onClick={() => setDraftShowAdvanced((value) => !value)} data-testid="settings-toggle-advanced">
        {draftShowAdvanced ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {tr(" 自定义设置 ")}</button>
      {draftShowAdvanced ? (
        <div className="form-grid">
          <div className="field">
            <label>{tr("显示名称")}</label>
            <input
              className="input"
              value={draft.name ?? ''}
              onChange={(e) => patchDraft({ name: e.target.value })}
              placeholder={draft.models[0]?.name || draft.models[0]?.id || tr("例如 DeepSeek")}
              data-testid="settings-model-name"
            />
          </div>
          <div className="field">
            <label>{tr("API 协议")}</label>
            <Select
              className="select"
              value={draft.provider}
              onChange={(e) => changeDraftKind(e.target.value as ProviderKind)}
              data-testid="settings-provider"
            >
              <Option value="openai">OpenAI Chat Completions</Option>
              <Option value="anthropic">Anthropic Messages</Option>
              <Option value="ollama">Ollama</Option>
              <Option value="local">{t('providerLocal')}</Option>
            </Select>
          </div>
          {draft.provider !== 'local' ? (
            <div className="field full">
              <label>{tr("API 地址")}</label>
              <input
                className="input mono"
                value={draft.baseUrl}
                onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                placeholder={draftPreset?.baseUrl || 'https://api.example.com/v1'}
                data-testid="settings-base-url"
              />
            </div>
          ) : null}
          <div className="field full">
            <label>{tr("服务商预设")}</label>
            <div className="preset-groups">
              {presetsByGroup().map((group) => (
                <div key={group.group} className="preset-group">
                  <div className="preset-group-label">{group.group}</div>
                  <div className="preset-chips">
                    {group.presets.map((preset) => (
                      <button
                        key={preset.id}
                        className={`preset-chip ${draftPreset?.id === preset.id ? 'active' : ''}`}
                        onClick={() => applyDraftPreset(preset)}
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
            {draftPreset?.note ? <span className="hint">{draftPreset.note}</span> : null}
          </div>
        </div>
      ) : null}

      <div className="model-directory">
        <div className="model-directory-head">
          <strong>{tr("模型目录")}</strong>
          <span className="muted">{modelSource ? tr("来自 {0}", [modelSource]) : tr("已自定义模型目录")}</span>
          <div className="spacer" />
          <button className="link-btn" onClick={restoreDefaultModels} data-testid="settings-restore-models">
            {tr(" 恢复默认模型 ")}</button>
          <button className="link-btn" onClick={() => void fetchModels()} disabled={modelsLoading || draft.provider === 'local'} data-testid="settings-fetch-models">
            {modelsLoading ? <Loader2 size={11} className="spin" /> : null}{tr(" 获取可用模型 ")}</button>
          <button className="link-btn" onClick={addDraftModelRow} data-testid="settings-model-add">
            {tr(" + 添加模型 ")}</button>
        </div>
        <div className="model-rows" data-testid="settings-model-rows">
          {draft.models.map((entry, index) => {
            const modelId = entry.id.trim();
            const profileKey = (entry.orig ?? modelId).trim();
            const isExpanded = Boolean(modelId) && expandedModel === modelId;
            return (
              <div className="model-row-wrap" key={`${index}-${entry.id}`}>
                <div className="model-row">
                  <input
                    className="input mono"
                    value={entry.id}
                    onChange={(e) => updateDraftModel(index, { id: e.target.value })}
                    placeholder={tr("模型 ID（如 deepseek-chat）")}
                    data-testid="settings-model-id"
                  />
                  <input
                    className="input"
                    value={entry.name ?? ''}
                    onChange={(e) => updateDraftModel(index, { name: e.target.value })}
                    placeholder={tr("显示名称（可选）")}
                    data-testid="settings-model-display"
                  />
                  <button
                    className="icon-btn"
                    title={tr("模型能力")}
                    disabled={!modelId}
                    onClick={() => setExpandedModel(isExpanded ? '' : modelId)}
                    data-testid="settings-model-expand"
                  >
                    {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  </button>
                  <button className="icon-btn" title={tr("删除")} onClick={() => removeDraftModelAt(index)} data-testid="settings-model-remove">
                    <Trash2 size={12} />
                  </button>
                </div>
                {isExpanded ? (
                  <ModelProfileEditor
                    model={modelId}
                    profile={profileKey ? form.agent.modelProfiles?.[profileKey] : undefined}
                    onPatch={(patch) => patchDraftProfile(profileKey, patch)}
                    onClear={() => {
                      if (!profileKey) return;
                      setForm((prev) => ({ ...prev, agent: withoutModelProfile(prev.agent, profileKey) }));
                    }}
                    hideHead
                  />
                ) : null}
              </div>
            );
          })}
          {!draft.models.length ? <div className="muted" style={{ fontSize: 10.5 }}>{tr("还没有模型：点“添加模型”手动填，或“获取可用模型”自动拉取。")}</div> : null}
        </div>
        {modelsError ? <div className="risk-banner">{modelsError}</div> : null}
        {draftPreset?.docs ? (
          <span className="hint">
            {tr(" 文档：")}<span className="mono">{draftPreset.docs}</span>
          </span>
        ) : null}
      </div>

      <div className="provider-actions">
        <span className="hint" style={{ marginRight: 'auto' }}>{tr("保存会立即写入 Bridge")}</span>
        <button className="btn small" onClick={cancelDraft}>
          {tr(" 取消 ")}</button>
        <button className="btn small primary" onClick={commitDraft} data-testid="model-config-commit">
          {draftNew ? tr("添加") : tr("保存")}
        </button>
      </div>
    </div>
  ) : null;

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
            <button className="settings-back" onClick={() => setOpen(false)}>{tr("← 返回工作区")}</button>
            <div className="settings-nav-search">
              <Search size={12} />
              <input
                value={navQuery}
                onChange={(e) => setNavQuery(e.target.value)}
                placeholder={tr("搜索设置…")}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                data-testid="settings-nav-search"
              />
              {navQuery ? (
                <button className="nav-search-clear" title={tr("清除搜索")} onClick={() => setNavQuery('')} data-testid="settings-nav-clear">
                  ×
                </button>
              ) : null}
            </div>
            {visibleNavGroups.map((group) => (
              <div className="settings-nav-group" key={group.label}>
                <div className="settings-nav-label">{group.label}</div>
                {group.items.map((item) => (
                  <button key={item.key} className={tab === item.key ? 'active' : ''} onClick={() => setTab(item.key)}>
                    {item.icon}
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
            {!visibleNavGroups.length ? (
              <div className="dash-empty">
                {tr(" 没有匹配的设置。 ")}<button className="link-btn" onClick={() => setNavQuery('')}>
                  {tr(" 清除搜索 ")}</button>
              </div>
            ) : null}
          </nav>
          <div className="settings-content">
            {tab === 'appearance' ? (
              <div className="settings-section">
                <h3>{t('appearance')}</h3>
                <div className="form-grid">
                  <div className="field">
                    <label>{t('theme')}</label>
                    <Select className="select" value={form.theme} onChange={(e) => setForm({ ...form, theme: e.target.value as AppSettings['theme'] })}>
                      <Option value="dark">{t('dark')}</Option>
                      <Option value="light">{t('light')}</Option>
                      <Option value="system">{tr("跟随系统")}</Option>
                    </Select>
                  </div>
                  <div className="field">
                    <label>{t('language')}</label>
                    <Select
                      className="select"
                      value={form.locale}
                      onChange={(e) => {
                        const next = e.target.value as AppSettings['locale'];
                        if (next === form.locale) return;
                        setForm({ ...form, locale: next });
                        // 模块级常量在加载时就已定稿，换语言必须整页重载才能全部刷新。
                        void saveSettings({ ...form, locale: next }).then(() => {
                          if (useApp.getState().settings.locale === next) window.location.reload();
                          else setForm({ ...form, locale: useApp.getState().settings.locale });
                        });
                      }}
                    >
                      {LOCALES.map((item) => (
                        <Option key={item.id} value={item.id}>
                          {item.native === item.english ? item.native : `${item.native} · ${item.english}`}
                        </Option>
                      ))}
                    </Select>
                  </div>
                </div>
                <p className="desc">{tr("主题即时生效；切换语言后会重新加载界面。移动端使用同一套设计令牌。")}</p>
              </div>
            ) : null}

            {tab === 'query' ? (
              <div className="settings-section">
                <h3>{t('editor')}{tr(" & 查询")}</h3>
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
                  <div className="field">
                    <label>{tr("历史保留条数")}</label>
                    <input
                      className="input"
                      type="number"
                      min={10}
                      max={100000}
                      value={form.historyLimit}
                      onChange={(e) => setForm({ ...form, historyLimit: Number(e.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label>{tr("历史保留天数")}</label>
                    <input
                      className="input"
                      type="number"
                      min={0}
                      max={3650}
                      value={form.historyRetentionDays}
                      onChange={(e) => setForm({ ...form, historyRetentionDays: Number(e.target.value) })}
                    />
                  </div>
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={form.autoLimit} onChange={(e) => setForm({ ...form, autoLimit: e.target.checked })} /> {t('autoLimit')}
                </label>
                <label className="checkbox">
                  <input type="checkbox" checked={form.allowMultiStatement} onChange={(e) => setForm({ ...form, allowMultiStatement: e.target.checked })} /> {t('allowMulti')}
                </label>
                <p className="desc">{tr("多语句默认关闭；关闭时只读脚本（多条 SELECT/SHOW）仍可整段执行，含写或 DDL 的脚本会要求逐条执行，避免误操作。收藏的历史不会被条数或天数裁剪；天数填 0 表示不按时间清理。")}</p>
              </div>
            ) : null}

            {tab === 'agent' ? (
              <>
                <div className="settings-section settings-section-wide">
                <div className="row" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
                  <h3 style={{ margin: 0 }}>{tr("模型")}</h3>
                  <button className="btn small primary" onClick={startAddModel} data-testid="settings-add-model">
                    <Plus size={12} /> {tr(" 添加服务商 ")}</button>
                </div>
                <p className="desc">{tr("每个服务商配置一次 API 地址与密钥，下面可以挂多个模型；当前用哪个模型，在 AI 助手输入框底部的下拉里切换。")}</p>
                <div className="model-config-list" data-testid="settings-model-configs">
                  {modelConfigs.map((config) => {
                    const isActive = config.id === activeModelId;
                    const preset = presetById(config.preset);
                    const editing = draft?.id === config.id;
                    const hasKey = config.provider === 'local' || Boolean(apiKeyStatus[config.id]);
                    const modelText = config.models.length > 1
                      ? tr("{0} 个模型 · {1}", [config.models.length, config.models.map((entry) => entry.name || entry.id).join(' / ')])
                      : config.models[0]?.name || config.models[0]?.id || '';
                    return (
                      <div
                        key={config.id}
                        className={`provider-card ${isActive ? 'active' : ''} ${editing ? 'editing' : ''}`}
                        data-testid={`model-config-${config.id}`}
                      >
                        <div className="provider-head">
                          <span className={`provider-status ${hasKey ? 'on' : 'off'}`} title={hasKey ? tr("已配置密钥") : tr("未配置密钥")} />
                          <div className="provider-main">
                            <div className="provider-name">{config.name || config.models[0]?.name || config.models[0]?.id || tr("未命名服务商")}</div>
                            <div className="provider-meta" title={`${modelText} ${config.baseUrl}`}>
                              <span className="badge">{preset?.label ?? (config.provider === 'local' ? tr("本地") : tr("自定义"))}</span>
                              <span>{modelText}</span>
                              {config.provider !== 'local' && config.baseUrl ? <span className="mono">{config.baseUrl}</span> : null}
                            </div>
                          </div>
                          {isActive ? <span className="badge agent">{tr("当前 · ")}{activeLabel}</span> : null}
                          <div className="spacer" />
                          <button className="btn small" onClick={() => (editing ? cancelDraft() : startEditModel(config))} data-testid={`model-config-edit-${config.id}`}>
                            {editing ? tr("收起") : tr("编辑")}
                          </button>
                          <button
                            className="link-btn danger"
                            disabled={modelConfigs.length <= 1}
                            onClick={() => removeModelConfig(config)}
                            data-testid={`model-config-delete-${config.id}`}
                          >
                            {tr(" 删除 ")}</button>
                        </div>
                        {editing ? modelEditor : null}
                      </div>
                    );
                  })}
                  {draftNew && draft ? <div className="provider-card editing">{modelEditor}</div> : null}
                </div>

                <div className="form-grid">
                  <div className="field">
                    <label>{t('maxSteps')}</label>
                    <input className="input" type="number" min={1} max={40} value={form.agent.maxSteps} onChange={(e) => setAgent({ maxSteps: Number(e.target.value) })} />
                  </div>
                  <div className="field">
                    <label>Temperature</label>
                    <input className="input" type="number" min={0} max={2} step={0.1} value={form.agent.temperature} onChange={(e) => setAgent({ temperature: Number(e.target.value) })} />
                  </div>
                  <div className="field">
                    <label>{tr("上下文压缩阈值（tokens）")}</label>
                    <input className="input" type="number" min={4000} step={1000} value={form.agent.compactionThreshold} onChange={(e) => setAgent({ compactionThreshold: Number(e.target.value) })} />
                  </div>
                  <div className="field">
                    <label>{tr("大 schema 候选表检索")}</label>
                    <Select
                      className="select"
                      value={form.agent.schemaFocus ?? 'auto'}
                      onChange={(e) => setAgent({ schemaFocus: e.target.value as 'auto' | 'on' | 'off' })}
                      data-testid="settings-schema-focus"
                    >
                      <Option value="auto">{tr("自动（超过 150 表或 2500 列）")}</Option>
                      <Option value="on">{tr("总是开启")}</Option>
                      <Option value="off">{tr("关闭")}</Option>
                    </Select>
                  </div>
                </div>
                <label className="checkbox">
                  <input type="checkbox" checked={form.agent.autoMemory} onChange={(e) => setAgent({ autoMemory: e.target.checked })} />
                  {t('autoMemory')}{tr("（自动沉淀事实、偏好与会话摘要） ")}</label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={form.agent.followUpSuggestions}
                    onChange={(e) => setAgent({ followUpSuggestions: e.target.checked })}
                    data-testid="settings-followups"
                  />
                  {tr(" 追问建议（每轮结束后按涉及的表推荐下一步问题，本地生成、不消耗 token） ")}</label>
                <label className="checkbox">
                  <input type="checkbox" checked={form.agent.snapshotBeforeWrite} onChange={(e) => setAgent({ snapshotBeforeWrite: e.target.checked })} />
                  {t('snapshotBeforeWrite')}{tr("（破坏性操作前自动 SQL dump） ")}</label>
                <p className="desc">{tr("权限策略：只读 → 拒绝写；询问 → 写/DDL 需确认；自动 → 仅破坏性需确认；全自动 → 全部放行（生产环境破坏性操作仍需确认）。所有调用写入审计。")}</p>
              </div>
                <div className="settings-section settings-section-wide">
                  <h3>{tr("向量检索（Embedding）")}</h3>
                  <p className="desc">{tr("pgvector / Qdrant / Milvus 的文本检索需要 Embedding 服务；也可以直接传入向量。")}</p>
                  <div className="form-grid">
                    <div className="field">
                      <label>Provider</label>
                      <Select className="select" value={form.embedding.provider} onChange={(e) => setEmbedding({ provider: e.target.value as AppSettings['embedding']['provider'] })} data-testid="settings-embedding-provider">
                        <Option value="none">{tr("未配置")}</Option>
                        <Option value="openai">{tr("OpenAI 兼容 /embeddings")}</Option>
                        <Option value="ollama">Ollama /api/embeddings</Option>
                      </Select>
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
                      <label>API Key {form.embedding.hasApiKey ? <span className="badge read">{tr("已配置")}</span> : null}</label>
                      <SecretInput
                        className="input mono"
                        value={form.embedding.apiKey ?? ''}
                        onChange={(e) => setEmbedding({ apiKey: e.target.value })}
                        placeholder={form.embedding.hasApiKey ? tr("已保存，留空保持不变") : form.embedding.provider === 'ollama' ? tr("本地 Ollama 可留空") : 'sk-...'}
                        disabled={form.embedding.provider === 'none'}
                        name="aidb-embedding-api-key"
                      />
                    </div>
                  </div>
                </div>
              </>
            ) : null}

            {tab === 'skills' ? (
              <div className="settings-embed-column">
                <div className="settings-feature-bar">
                  <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={settings.features.skills}
                      onChange={(e) => void saveSettings({ features: { ...settings.features, skills: e.target.checked } })}
                    />
                    <span>
                      {tr(" 允许 Agent 自动调用技能 ")}<span className="muted" style={{ display: 'block', fontSize: 10 }}>{tr("关闭后仍可在本页手动运行；Agent 看不到技能索引和 skill_* 工具。")}</span>
                    </span>
                  </label>
                  <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={settings.features.reportDeck}
                      onChange={(e) => void saveSettings({ features: { ...settings.features, reportDeck: e.target.checked } })}
                    />
                    {tr(" 启用 AI PPT（报告 → 原生 PPTX，需 PPT Master） ")}</label>
                </div>
                <div className="settings-embed"><SkillsTool /></div>
              </div>
            ) : null}
            {tab === 'mcp' ? (
              <div className="settings-embed-column">
                <div className="settings-feature-bar">
                  <label className="row gap-6" style={{ alignItems: 'center', fontSize: 11 }}>
                    <input
                      type="checkbox"
                      checked={settings.features.mcp}
                      onChange={(e) => void saveSettings({ features: { ...settings.features, mcp: e.target.checked } })}
                    />
                    {tr(" 允许 Agent 调用已配置的 MCP Server ")}</label>
                </div>
                <div className="settings-embed"><McpTool /></div>
              </div>
            ) : null}
            {tab === 'capabilities' ? <div className="settings-embed"><CapabilitiesTool /></div> : null}
            {tab === 'notify' ? <div className="settings-embed"><NotificationsTool /></div> : null}
            {tab === 'search' ? <div className="settings-embed"><WebSearchTool /></div> : null}

            {tab === 'bridge' ? (
              <div className="settings-section">
                <h3>{t('bridge')}</h3>
                <div className="setting-card">
                  <div className="row">
                    <Network size={14} style={{ color: 'var(--accent)' }} />
                    <span className="mono" style={{ fontSize: 11.5 }}>{location.origin}</span>
                    <div className="spacer" />
                    <span className="badge read">{tr("本地")}</span>
                  </div>
                  <p className="hint" style={{ marginTop: 8 }}>
                    {tr(" Bridge 承载数据库驱动、Agent 运行时与元数据。桌面端内置；移动端通过配对访问，会话与记忆跨端同步。 ")}</p>
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
                    <div className="pair-panel">
                      {pairingQr ? <img className="pair-qr" data-testid="pairing-qr" src={pairingQr} alt={tr("移动端配对二维码")} /> : null}
                      <div className="pair-info">
                        <div className="row">
                          <span className="mono" style={{ fontSize: 26, letterSpacing: 8, color: 'var(--agent)' }}>{pairing.code}</span>
                          <span className={mobileSecondsLeft > 0 ? 'badge write' : 'badge destructive'} data-testid="mobile-pair-countdown">
                            {mobileSecondsLeft > 0 ? tr("剩余 {0} 秒", { 0: mobileSecondsLeft }) : tr("配对码已过期")}
                          </span>
                          <div className="spacer" />
                          <button className="icon-btn" title={tr("复制配对码")} onClick={() => void navigator.clipboard.writeText(pairing.code)}>
                            <ShieldCheck size={14} />
                          </button>
                        </div>
                        <p className="hint">{tr("手机打开「扫码配对」扫描左侧二维码；也可填写 Bridge 地址：")}{pairing.url ?? `${pairing.host}:${pairing.port}`}{tr("，再输入上方配对码。远程访问请置于 TLS 反向代理之后（可用 AIDB_PUBLIC_URL 固定二维码地址）。")}</p>
                        <button
                          className="link-btn"
                          onClick={() => {
                            const target = pairing.url ?? `http://${pairing.host}:${pairing.port}`;
                            void navigator.clipboard.writeText(`aidb://pair?url=${encodeURIComponent(target)}&code=${pairing.code}`);
                          }}
                        >
                          {tr(" 复制 App 深链（aidb://pair） ")}</button>
                        {/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])([:/]|$)/.test(pairing.url ?? '') ? (
                          <p className="hint" style={{ color: 'var(--warning)' }}>{tr("当前是回环地址，手机无法访问；请改用局域网地址，或通过 AIDB_PUBLIC_URL / 反向代理打开桌面端后再生成二维码。")}</p>
                        ) : null}
                      </div>
                    </div>
                  ) : (
                    <p className="hint" style={{ marginTop: 8 }}>{t('pairHint')}</p>
                  )}
                </div>
                <div className="setting-card">
                  <div className="row">
                    <KeyRound size={14} />
                    <strong style={{ fontSize: 12 }}>{t('mcpPairing')}</strong>
                    <div className="spacer" />
                    <button className="btn small" onClick={() => void startMcpPairing()}>
                      <RefreshCw size={11} /> {t('startMcpPairing')}
                    </button>
                  </div>
                  {mcpPairing ? (
                    <div className="pair-panel">
                      <div className="pair-info">
                        <div className="row">
                          <span className="mono" style={{ fontSize: 26, letterSpacing: 8, color: 'var(--agent)' }}>{mcpPairing.code}</span>
                          <span className={mcpSecondsLeft > 0 ? 'badge write' : 'badge destructive'} data-testid="mcp-pair-countdown">
                            {mcpSecondsLeft > 0 ? tr("剩余 {0} 秒", { 0: mcpSecondsLeft }) : tr("配对码已过期")}
                          </span>
                          <div className="spacer" />
                          <button className="icon-btn" title={tr("复制配对码")} onClick={() => void navigator.clipboard.writeText(mcpPairing.code)}>
                            <ShieldCheck size={14} />
                          </button>
                        </div>
                        <p className="hint">{t('mcpPairHint')}</p>
                        <p className="hint">{tr("Bridge 地址：")}{mcpPairing.url ?? `${mcpPairing.host}:${mcpPairing.port}`}</p>
                      </div>
                    </div>
                  ) : (
                    <p className="hint" style={{ marginTop: 8 }}>{t('mcpPairHint')}</p>
                  )}
                </div>
                <div>
                  <h3 style={{ marginBottom: 8 }}>{t('devices')}</h3>
                  {devices.length ? (
                    devices.map((device) => (
                      <div key={device.id} className="setting-card row" style={{ marginBottom: 6 }}>
                        <span className="badge">{device.platform}</span>
                        {device.scope === 'mcp:readonly' && <span className="badge">{tr("只读 MCP")}</span>}
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12 }}>{device.name}</div>
                          <div className="muted" style={{ fontSize: 10 }}>{tr("配对于 ")}{formatRelative(device.pairedAt)}</div>
                        </div>
                        {device.revoked ? <span className="badge destructive">{tr("已吊销")}</span> : <button className="btn small danger" onClick={() => void revokeDevice(device.id)}>{t('revoke')}</button>}
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
                    <Download size={12} /> {tr(" 导出审计 CSV ")}</button>
                  <button
                    className="btn small danger"
                    onClick={async () => {
                      if (!(await askConfirm({ message: tr("清空全部查询历史？"), detail: tr("历史与审计列表会被清空，无法撤销。"), danger: true, confirmLabel: tr("清空") }))) return;
                      await api.clearHistory();
                      notify('success', tr("查询历史已清空"));
                    }}
                  >
                    <Trash2 size={12} /> {tr(" 清空历史 ")}</button>
                </div>
                {dataLoading ? <div className="loading-inline"><span className="spinner" /> {t('loading')}</div> : null}
                {audit.length ? (
                  <div className="panel">
                    <div className="panel-head">{tr("最近审计 ")}<span className="badge">{audit.length}</span></div>
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
                <h3 style={{ marginTop: 8 }}>{tr("备份")}</h3>
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
                            if (!(await askConfirm({ message: tr("从备份恢复会执行备份里的 SQL。"), detail: tr("现有结构/数据可能被覆盖：\n{0}", [backup.path]), danger: true, confirmLabel: tr("恢复") }))) return;
                            try {
                              await api.restoreBackup(backup.id);
                              notify('success', tr("备份已恢复"), backup.path);
                            } catch (err: any) {
                              notify('error', tr("恢复失败"), err?.message);
                            }
                          }}
                        >
                          {tr(" 恢复 ")}</button>
                      </div>
                      <div className="muted" style={{ fontSize: 10, marginTop: 3 }}>{formatRelative(backup.createdAt)}{backup.label ? ` · ${backup.label}` : ''}</div>
                    </div>
                  ))
                ) : (
                  <p className="hint">{tr("还没有备份。可在命令面板执行“备份当前数据库”，或让 Agent 备份。")}</p>
                )}
              </div>
            ) : null}

            {tab === 'about' ? (
              <div className="settings-section">
                <h3>AiDB Studio</h3>
                <div className="setting-card">
                  <div className="row">
                    <img className="brand-mark" src="/logo-mark.svg" alt="" style={{ width: 34, height: 34 }} />
                    <div>
                      <div style={{ fontWeight: 650 }}>AiDB Studio v0.0.1</div>
                      <div className="muted" style={{ fontSize: 11 }}>AI-native, cross-platform database studio</div>
                    </div>
                  </div>
                </div>
                <p className="desc">
                  {tr(" 五端覆盖：Windows / macOS / Linux（Electron）与 Android / iOS（Expo React Native）。Agent 运行时、数据库驱动与元数据位于 Bridge； 桌面与移动端共享同一协议、会话与四层记忆。 ")}</p>
                <div className="row gap-6" style={{ flexWrap: 'wrap' }}>
                  <span className="badge">Electron</span>
                  <span className="badge">React</span>
                  <span className="badge">CodeMirror 6</span>
                  <span className="badge">node:sqlite</span>
                  <span className="badge">Expo</span>
                  <span className="badge agent">22 tools</span>
                  <span className="badge agent">4-layer memory</span>
                </div>
                <p className="hint">{tr("设计文档位于仓库 docs/（产品、架构、功能、UI/UX、Agent、数据模型、验证报告）。License: MIT。")}</p>
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
  hideHead = false,
}: {
  model: string;
  profile?: ModelProfile;
  onPatch: (patch: Partial<ModelProfile>) => void;
  onClear: () => void;
  hideHead?: boolean;
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
      {hideHead ? null : (
        <div className="model-profile-head">
          <label>{tr("模型能力")}</label>
          <span className="mono muted">{model}</span>
          <div className="spacer" />
          {profile ? (
            <button className="link-btn" onClick={onClear} data-testid="model-profile-clear">
              {tr(" 清除该模型的档案 ")}</button>
          ) : null}
        </div>
      )}
      <div className="model-profile-grid">
        <div className="field">
          <label>{tr("上下文窗口")}</label>
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
          <label>{tr("最大输出 token 数")}</label>
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
        <label>{tr("输入类型")}</label>
        <div className="row gap-6">
          <label className="checkbox">
            <input type="checkbox" checked={inputs.includes('text')} onChange={() => toggleInput('text')} /> {tr(" 文本 ")}</label>
          <label className="checkbox">
            <input type="checkbox" checked={inputs.includes('image')} onChange={() => toggleInput('image')} data-testid="model-input-image" /> {tr(" 图片 ")}</label>
        </div>
        <span className="hint">{tr("勾选「图片」后聊天面板才能贴图；两项都不选按仅文本处理。")}</span>
      </div>
      <div className="model-profile-switch">
        <label>
          {tr(" 推理等级 ")}<span className="tip" title={tr("开启后可定义档位与发给服务商的参数值。OpenAI 兼容协议按字符串下发 reasoning_effort；Anthropic 协议把值当作 thinking.budget_tokens 的数字。")}>?</span>
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
            <span>{tr("档位")}</span>
            <span>{tr("API 参数值")}</span>
            <span />
          </div>
          {tiers.map((tier, index) => (
            <div className="tier-row" key={`${tier.level}_${index}`}>
              <Select
                className="select"
                value={tier.level}
                onChange={(e) => setTiers(tiers.map((item, i) => (i === index ? { ...item, level: e.target.value } : item)))}
              >
                {levels.map((level) => (
                  <Option key={level} value={level}>{level}</Option>
                ))}
              </Select>
              <input
                className="input mono"
                value={tier.value}
                placeholder={tier.level === 'off' ? tr("关闭思考") : tr("如 low / 2048")}
                onChange={(e) => setTiers(tiers.map((item, i) => (i === index ? { ...item, value: e.target.value } : item)))}
                data-testid={`model-tier-value-${tier.level}`}
              />
              <button className="icon-btn" title={tr("删除档位")} onClick={() => setTiers(tiers.filter((_, i) => i !== index))}>
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {!tiers.length ? <div className="hint">{tr("还没有档位，点下面的按钮添加。")}</div> : null}
          <button
            className="btn small"
            onClick={() => setTiers([...tiers, { level: nextLevel(new Set(tiers.map((tier) => tier.level))), value: '' }])}
            data-testid="model-tier-add"
          >
            <Plus size={12} /> {tr(" 添加档位 ")}</button>
          <span className="hint">{tr("值留空表示该档不下发任何推理参数。")}</span>
        </div>
      ) : null}
      {hideHead && profile ? (
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="link-btn" onClick={onClear}>
            {tr(" 清除该模型的档案 ")}</button>
        </div>
      ) : null}
    </div>
  );
}
