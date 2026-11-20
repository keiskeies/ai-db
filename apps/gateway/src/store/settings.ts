import { DEFAULT_SETTINGS, type AgentModelConfig, type AgentModelEntry, type AppSettings } from '@aidb/core';
import { StoreDb } from './db';

const PROVIDER_KINDS = ['local', 'anthropic', 'openai', 'ollama'] as const;

const round = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

/** 清洗模型来源列表；空列表时用旧版单模型字段合成一个默认连接，保证升级后行为不变。 */
function normalizeModelConfigs(
  raw: unknown,
  legacy: Pick<AgentModelConfig, 'provider' | 'preset' | 'baseUrl'> & { model: string },
): AgentModelConfig[] {
  const seen = new Set<string>();
  const list: AgentModelConfig[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = entry as { id?: unknown; name?: unknown; provider?: unknown; preset?: unknown; baseUrl?: unknown; models?: unknown; model?: unknown };
    const id = typeof item?.id === 'string' ? item.id.trim() : '';
    const provider = PROVIDER_KINDS.find((kind) => kind === item?.provider);
    if (!id || !provider || seen.has(id)) continue;
    // 兼容早期「一条配置一个模型」的存档：没有 models 数组时读单个 model。
    const source: unknown[] = Array.isArray(item.models) ? item.models : typeof item.model === 'string' ? [item.model] : [];
    const models: AgentModelEntry[] = [];
    const seenModels = new Set<string>();
    for (const value of source) {
      const id = typeof value === 'string' ? value.trim() : typeof (value as AgentModelEntry | null)?.id === 'string' ? (value as AgentModelEntry).id.trim() : '';
      if (!id || seenModels.has(id)) continue;
      const rawName = typeof value === 'object' && value ? (value as { name?: unknown }).name : undefined;
      seenModels.add(id);
      models.push({ id, name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined });
    }
    if (!models.length) continue;
    seen.add(id);
    list.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : undefined,
      provider,
      preset: typeof item.preset === 'string' && item.preset ? item.preset : undefined,
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      models,
    });
  }
  if (!list.length) {
    list.push({
      id: 'default',
      provider: legacy.provider,
      preset: legacy.preset,
      baseUrl: legacy.baseUrl,
      models: [{ id: legacy.model?.trim() || 'local' }],
    });
  }
  return list;
}

export class SettingsRepo {
  constructor(private db: StoreDb) {}

  // ---------- settings ----------
  private getSetting(key: string): string | undefined {
    return this.db.one<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])?.value;
  }

  private setSetting(key: string, value: string): void {
    this.db.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
  }

  getSettings(): AppSettings {
    let stored: Partial<AppSettings> = {};
    const raw = this.getSetting('app');
    if (raw) {
      try {
        stored = JSON.parse(raw);
      } catch {
        stored = {};
      }
    }
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...stored,
      agent: { ...DEFAULT_SETTINGS.agent, ...(stored.agent ?? {}) },
      embedding: { ...DEFAULT_SETTINGS.embedding, ...(stored.embedding ?? {}) },
      features: { ...DEFAULT_SETTINGS.features, ...(stored.features ?? {}) },
      search: { ...DEFAULT_SETTINGS.search, ...(stored.search ?? {}) },
    };
    merged.historyLimit = round(merged.historyLimit, 10, 100_000, DEFAULT_SETTINGS.historyLimit);
    merged.historyRetentionDays = round(merged.historyRetentionDays, 0, 3650, DEFAULT_SETTINGS.historyRetentionDays);
    // 旧默认把 DuckDuckGo/SearXNG 一起开着，而这台网络里两者都连不上（DNS 污染 / 公共实例禁用 JSON）。
    // 没被用户手动改过的搜索设置迁移到新默认，改过的原样保留。
    if (merged.search.enabled.join(',') === 'exa,parallel,duckduckgo,searxng') merged.search.enabled = [...DEFAULT_SETTINGS.search.enabled];
    if (merged.search.searxngBaseUrl === 'https://searx.be') merged.search.searxngBaseUrl = DEFAULT_SETTINGS.search.searxngBaseUrl;
    // 旧版本 compactionThreshold 存的是 token 数（默认 24000），语义已改为「占窗口的百分比」。
    // 没被用户改过（仍是旧默认）的迁移到新默认 70；用户改过的按 token 数无法可靠换算成百分比，
    // 为安全起见也落到新默认，避免一个几百 token 的旧值被当成 0.x% 把历史压缩到几乎全删。
    if (typeof merged.agent.compactionThreshold === 'number' && merged.agent.compactionThreshold > 1000) {
      merged.agent.compactionThreshold = DEFAULT_SETTINGS.agent.compactionThreshold;
    }
    const enc = this.getSetting('agentApiKey');
    const decrypted = this.db.box.decrypt<{ apiKey: string }>(enc);
    const legacyKey = decrypted?.apiKey;
    // 多模型配置：列表与当前项在读取时物化成 agent 上的 provider/baseUrl/model/apiKey，
    // 让运行时（provider 创建、能力档案、会话记录）继续只认单模型字段。
    const modelConfigs = normalizeModelConfigs(merged.agent.modelConfigs, merged.agent);
    const active = modelConfigs.find((item) => item.id === merged.agent.activeModelId) ?? modelConfigs[0];
    const activeModel = active.models.some((entry) => entry.id === merged.agent.model) ? merged.agent.model : active.models[0].id;
    const modelKeys = this.readModelKeys();
    const keyOf = (id: string) => modelKeys[id] ?? (id === 'default' ? legacyKey : undefined);
    merged.agent.modelConfigs = modelConfigs;
    merged.agent.activeModelId = active.id;
    merged.agent.provider = active.provider;
    merged.agent.preset = active.preset;
    merged.agent.baseUrl = active.baseUrl;
    merged.agent.model = activeModel;
    merged.agent.apiKey = keyOf(active.id);
    delete merged.agent.modelKeys;
    merged.agent.modelApiKeyStatus = Object.fromEntries(modelConfigs.map((item) => [item.id, Boolean(keyOf(item.id))]));
    if (process.env.AIDB_API_KEY) merged.agent.apiKey = process.env.AIDB_API_KEY;
    merged.agent.hasApiKey = Boolean(merged.agent.apiKey);
    const embeddingEnc = this.getSetting('embeddingApiKey');
    const embeddingKey = this.db.box.decrypt<{ apiKey: string }>(embeddingEnc);
    if (embeddingKey?.apiKey) merged.embedding.apiKey = embeddingKey.apiKey;
    if (process.env.AIDB_EMBEDDING_API_KEY) merged.embedding.apiKey = process.env.AIDB_EMBEDDING_API_KEY;
    merged.embedding.hasApiKey = Boolean(merged.embedding.apiKey);
    return merged;
  }

  publicSettings(): AppSettings {
    const settings = this.getSettings();
    return {
      ...settings,
      agent: { ...settings.agent, apiKey: undefined, modelKeys: undefined, hasApiKey: Boolean(settings.agent.apiKey) },
      embedding: { ...settings.embedding, apiKey: undefined, hasApiKey: Boolean(settings.embedding.apiKey) },
      search: { ...settings.search, keyStatus: this.searchKeyStatus(), searchKeys: undefined },
    };
  }

  private readSearchKeys(): Record<string, string> {
    const decrypted = this.db.box.decrypt<{ keys?: Record<string, string> }>(this.getSetting('searchApiKeys'));
    return decrypted?.keys && typeof decrypted.keys === 'object' ? decrypted.keys : {};
  }

  private writeSearchKeys(keys: Record<string, string>): void {
    const entries = Object.entries(keys).filter(([, value]) => typeof value === 'string' && value.length > 0);
    if (entries.length) this.setSetting('searchApiKeys', this.db.box.encrypt({ keys: Object.fromEntries(entries) }));
    else this.db.exec("DELETE FROM settings WHERE key = 'searchApiKeys'");
  }

  getSearchApiKey(id: string): string | undefined {
    return this.readSearchKeys()[id];
  }

  searchKeyStatus(): Record<string, boolean> {
    const keys = this.readSearchKeys();
    return Object.fromEntries(['brave', 'tavily', 'serper', 'mojeek', 'deepseek', 'anthropic', 'openai', 'searxng'].map((id) => [id, Boolean(keys[id])]));
  }

  saveSearchKeys(input: Record<string, unknown> | undefined): void {
    if (!input || typeof input !== 'object') return;
    const keys = this.readSearchKeys();
    let changed = false;
    for (const [id, value] of Object.entries(input)) {
      if (!['brave', 'tavily', 'serper', 'mojeek', 'deepseek', 'anthropic', 'openai', 'searxng'].includes(id)) continue;
      if (typeof value !== 'string') continue;
      if (value === '__CLEAR__') {
        if (keys[id]) {
          delete keys[id];
          changed = true;
        }
      } else if (value.trim()) {
        keys[id] = value.trim();
        changed = true;
      }
    }
    if (changed) this.writeSearchKeys(keys);
  }

  saveSettings(next: AppSettings): AppSettings {
    const current = this.getSettings();
    const incomingKey = next.agent.apiKey;
    let apiKey = current.agent.apiKey;
    let keyChanged = false;
    if (incomingKey === '__CLEAR__') {
      apiKey = undefined;
      keyChanged = true;
    } else if (incomingKey !== undefined && incomingKey !== '') {
      apiKey = incomingKey;
      keyChanged = true;
    }
    const incomingEmbeddingKey = next.embedding?.apiKey;
    let embeddingKey = current.embedding.apiKey;
    let embeddingKeyChanged = false;
    if (incomingEmbeddingKey === '__CLEAR__') {
      embeddingKey = undefined;
      embeddingKeyChanged = true;
    } else if (incomingEmbeddingKey !== undefined && incomingEmbeddingKey !== '') {
      embeddingKey = incomingEmbeddingKey;
      embeddingKeyChanged = true;
    }
    const incomingKeys = next.agent.modelKeys ?? {};
    const modelKeys = this.readModelKeys();
    let modelKeysChanged = false;
    for (const [id, value] of Object.entries(incomingKeys)) {
      if (!id || typeof value !== 'string') continue;
      if (value === '__CLEAR__') {
        if (modelKeys[id]) {
          delete modelKeys[id];
          modelKeysChanged = true;
        }
      } else if (value.trim()) {
        modelKeys[id] = value.trim();
        modelKeysChanged = true;
      }
    }
    const modelConfigs = normalizeModelConfigs(next.agent.modelConfigs, current.agent);
    const activeModelId = modelConfigs.some((item) => item.id === next.agent.activeModelId) ? next.agent.activeModelId : modelConfigs[0].id;
    // 兼容旧调用：没有切换连接时，直接改 agent.provider/baseUrl/model 视为修改当前连接；
    // 新模型名（例如旧版单模型输入框）补进当前连接的模型列表。
    const syncedConfigs =
      activeModelId === current.agent.activeModelId
        ? modelConfigs.map((item) => {
            if (item.id !== activeModelId) return item;
            const model = next.agent.model?.trim();
            return {
              ...item,
              provider: next.agent.provider,
              preset: next.agent.preset,
              baseUrl: next.agent.baseUrl,
              models: model && !item.models.some((entry) => entry.id === model) ? [...item.models, { id: model }] : item.models,
            };
          })
        : modelConfigs;
    const sanitized: AppSettings = {
      ...next,
      historyLimit: round(next.historyLimit, 10, 100_000, DEFAULT_SETTINGS.historyLimit),
      historyRetentionDays: round(next.historyRetentionDays, 0, 3650, DEFAULT_SETTINGS.historyRetentionDays),
      agent: {
        ...next.agent,
        apiKey: undefined,
        hasApiKey: Boolean(apiKey ?? process.env.AIDB_API_KEY),
        modelConfigs: syncedConfigs,
        activeModelId,
        modelKeys: undefined,
        modelApiKeyStatus: undefined,
      },
      embedding: {
        ...next.embedding,
        apiKey: undefined,
        hasApiKey: Boolean(embeddingKey ?? process.env.AIDB_EMBEDDING_API_KEY),
      },
      search: {
        ...next.search,
        keyStatus: undefined,
        searchKeys: undefined,
      },
    };
    this.setSetting('app', JSON.stringify(sanitized));
    this.saveSearchKeys(next.search?.searchKeys);
    if (keyChanged) this.setAgentApiKey(apiKey);
    if (modelKeysChanged) this.setModelKeys(modelKeys);
    if (embeddingKeyChanged) this.setEmbeddingApiKey(embeddingKey);
    return this.getSettings();
  }

  private setAgentApiKey(apiKey: string | undefined): void {
    if (apiKey) this.setSetting('agentApiKey', this.db.box.encrypt({ apiKey }));
    else this.db.exec("DELETE FROM settings WHERE key = 'agentApiKey'");
  }

  private readModelKeys(): Record<string, string> {
    const decrypted = this.db.box.decrypt<{ keys?: Record<string, string> }>(this.getSetting('agentModelKeys'));
    return decrypted?.keys && typeof decrypted.keys === 'object' ? decrypted.keys : {};
  }

  private setModelKeys(keys: Record<string, string>): void {
    const entries = Object.entries(keys).filter(([id, value]) => id && value);
    if (entries.length) this.setSetting('agentModelKeys', this.db.box.encrypt({ keys: Object.fromEntries(entries) }));
    else this.db.exec("DELETE FROM settings WHERE key = 'agentModelKeys'");
  }

  /** 取某个模型配置已保存的密钥；默认配置回退到旧版单模型密钥。 */
  getModelApiKey(id: string): string | undefined {
    const key = this.readModelKeys()[id];
    if (key) return key;
    if (id !== 'default') return undefined;
    return this.db.box.decrypt<{ apiKey: string }>(this.getSetting('agentApiKey'))?.apiKey;
  }

  private setEmbeddingApiKey(apiKey: string | undefined): void {
    if (apiKey) this.setSetting('embeddingApiKey', this.db.box.encrypt({ apiKey }));
    else this.db.exec("DELETE FROM settings WHERE key = 'embeddingApiKey'");
  }
}
