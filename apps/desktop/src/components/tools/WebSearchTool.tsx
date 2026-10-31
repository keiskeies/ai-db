import { useEffect, useState } from 'react';
import { CheckCircle2, Clock, ExternalLink, Globe2, Loader2, Play, RefreshCw, Search, XCircle } from 'lucide-react';
import type { SearchBackendId, SearchSettings } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';

interface BackendInfo {
  id: SearchBackendId;
  label: string;
  needsKey: boolean;
  group: 'free' | 'key';
}

interface HealthInfo {
  id: string;
  status: string;
  lastMs?: number;
  lastAt?: string;
  lastError?: string;
  successes: number;
  failures: number;
}

const KEY_LABEL: Record<string, string> = {
  brave: 'brave API Key',
  tavily: 'tavily API Key',
  serper: 'serper API Key',
  mojeek: 'mojeek API Key',
  deepseek: 'deepseek API Key',
  anthropic: 'anthropic API Key',
  openai: 'openai API Key',
  searxng: 'searxng API Key',
};

const KEY_URL: Record<string, string> = {
  brave: 'https://api.search.brave.com/app/keys',
  tavily: 'https://app.tavily.com/home',
  serper: 'https://serper.dev/api-key',
  mojeek: 'https://www.mojeek.com/services/search/web-search-api/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
};

const KEYED = Object.keys(KEY_LABEL).filter((id) => id !== 'searxng');

/** Rendered before the backend directory arrives (or if it fails); mirrors the gateway list. */
const FALLBACK_BACKENDS: BackendInfo[] = [
  { id: 'exa', label: 'Exa (MCP, 免费)', needsKey: false, group: 'free' },
  { id: 'parallel', label: 'Parallel (MCP, 免费)', needsKey: false, group: 'free' },
  { id: 'duckduckgo', label: 'DuckDuckGo (HTML)', needsKey: false, group: 'free' },
  { id: 'searxng', label: 'SearXNG (元搜索)', needsKey: false, group: 'free' },
  { id: 'brave', label: 'Brave Search', needsKey: true, group: 'key' },
  { id: 'tavily', label: 'Tavily (AI)', needsKey: true, group: 'key' },
  { id: 'serper', label: 'Serper.dev', needsKey: true, group: 'key' },
  { id: 'mojeek', label: 'Mojeek', needsKey: true, group: 'key' },
  { id: 'deepseek', label: 'DeepSeek', needsKey: true, group: 'key' },
  { id: 'anthropic', label: 'Anthropic', needsKey: true, group: 'key' },
  { id: 'openai', label: 'OpenAI', needsKey: true, group: 'key' },
];

const TIME_RANGE: Array<{ value: SearchSettings['timeRange']; label: string }> = [
  { value: 'any', label: '不限' },
  { value: 'day', label: '一天' },
  { value: 'week', label: '一周' },
  { value: 'month', label: '一月' },
  { value: 'year', label: '一年' },
];

export function WebSearchTool() {
  const notify = useApp((s) => s.notify);
  const settings = useApp((s) => s.settings);
  const saveSettings = useApp((s) => s.saveSettings);
  const [form, setForm] = useState<SearchSettings>(settings.search);
  const [backends, setBackends] = useState<BackendInfo[]>([]);
  const [health, setHealth] = useState<HealthInfo[]>([]);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>(settings.search.keyStatus ?? {});
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Array<{ title: string; url: string; snippet: string; source: string; sources?: string[] }>>([]);
  const [reports, setReports] = useState<Array<{ id: string; ok: boolean; count: number; ms: number; error?: string }>>([]);

  useEffect(() => {
    setForm(settings.search);
    setKeyStatus(settings.search.keyStatus ?? {});
  }, [settings.search]);

  const loadBackends = async () => {
    try {
      const data = await api.searchBackends();
      setBackends(data.backends as BackendInfo[]);
      setHealth(data.health);
      setKeyStatus(data.keyStatus);
    } catch (err: any) {
      notify('error', '读取搜索后端失败', err?.message);
    }
  };

  useEffect(() => {
    void loadBackends();
  }, []);

  const toggle = (id: SearchBackendId) => {
    setForm((current) => ({
      ...current,
      enabled: current.enabled.includes(id) ? current.enabled.filter((item) => item !== id) : [...current.enabled, id],
    }));
  };

  const directory = backends.length ? backends : FALLBACK_BACKENDS;
  const free = directory.filter((item) => item.group === 'free');
  const keyed = directory.filter((item) => item.group === 'key');
  const enabledCount = form.enabled.length;
  const keyCount = KEYED.filter((id) => keyStatus[id]).length;

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings({
        search: {
          ...form,
          searchKeys: Object.fromEntries(Object.entries(keys).filter(([, value]) => value.trim())),
        },
      });
      setKeys({});
      await loadBackends();
      notify('success', '搜索设置已保存');
    } catch (err: any) {
      notify('error', '保存搜索设置失败', err?.message);
    } finally {
      setSaving(false);
    }
  };

  const resetHealth = async () => {
    try {
      const data = await api.resetSearchHealth();
      setHealth(data.health);
      notify('success', '已重置后端健康状态');
    } catch (err: any) {
      notify('error', '重置状态失败', err?.message);
    }
  };

  const probe = async (id: string) => {
    setProbing(id);
    try {
      const data = await api.probeSearchBackend(id);
      setHealth((current) => current.map((item) => (item.id === id ? { ...item, ...data.health } : item)));
    } catch (err: any) {
      notify('error', '探测失败', err?.message);
    } finally {
      setProbing(null);
    }
  };

  const run = async () => {
    if (!query.trim()) return;
    setRunning(true);
    try {
      const data = await api.searchQuery({ query: query.trim(), numResults: form.numResults });
      setResults(data.results);
      setReports(data.backends);
      await loadBackends();
    } catch (err: any) {
      notify('error', '搜索失败', err?.message);
    } finally {
      setRunning(false);
    }
  };

  const healthIcon = (id: string) => {
    const item = health.find((entry) => entry.id === id);
    if (!item || item.status === 'idle') return null;
    if (item.status === 'ok') return <span style={{ color: 'var(--success)', fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }}><CheckCircle2 size={10} />{item.lastMs ?? 0}ms</span>;
    return <span style={{ color: 'var(--danger)', fontSize: 10, display: 'inline-flex', alignItems: 'center', gap: 3 }} title={item.lastError}><XCircle size={10} />失败</span>;
  };

  const backendRow = (backend: BackendInfo) => {
    const active = form.enabled.includes(backend.id);
    const ready = !backend.needsKey || keyStatus[backend.id];
    return (
      <label key={backend.id} className="search-backend">
        <input type="checkbox" checked={active} onChange={() => toggle(backend.id)} />
        <span className={`search-status-dot ${ready && active ? 'on' : ''}`} />
        <span style={{ flex: 1 }}>{backend.label}</span>
        {healthIcon(backend.id)}
        <button
          type="button"
          className="btn ghost small"
          title="用固定查询探测该后端"
          onClick={(event) => {
            event.preventDefault();
            void probe(backend.id);
          }}
          disabled={probing === backend.id}
        >
          {probing === backend.id ? <Loader2 size={10} className="spin" /> : <Play size={10} />}
        </button>
      </label>
    );
  };

  const keyField = (id: string) => (
    <div key={id} className="search-key">
      <div className="search-key-head">
        <span>{KEY_LABEL[id]}</span>
        {KEY_URL[id] ? (
          <a href={KEY_URL[id]} target="_blank" rel="noreferrer">
            获取 Key <ExternalLink size={9} />
          </a>
        ) : null}
        <span className={`badge ${keyStatus[id] ? 'read' : ''}`}>{keyStatus[id] ? '已配置' : '未配置'}</span>
      </div>
      <input
        className="input"
        type="password"
        aria-label={KEY_LABEL[id]}
        placeholder={KEY_LABEL[id].toUpperCase().replace(/\s+/g, '_')}
        value={keys[id] ?? ''}
        onChange={(event) => setKeys({ ...keys, [id]: event.target.value })}
      />
      <div className="search-key-hint">填入后保存到凭证库（对应环境变量引用）；留空表示不修改</div>
    </div>
  );

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Globe2 size={15} /> 网络搜索
        <span className="muted">免密钥后端开箱即用；API Key 加密保存；失败自动降级</span>
      </div>
      <div className="tool-scroll">
        <div className="search-settings">
          <div className="search-summary">
            <strong>已启用后端：{enabledCount}/{backends.length || 11}</strong>
            <strong>已配置密钥：{keyCount}/7</strong>
            <div className="spacer" />
            <button className="btn ghost small" onClick={() => void loadBackends()} title="刷新后端与健康状态">
              <RefreshCw size={11} /> 刷新状态
            </button>
          </div>
          <div className="search-desc">
            聚合网络搜索：{backends.length || 11} 个后端并发 fan-out、URL 去重合并。开关后端、填 API Key、调参数，保存即生效。
          </div>

          <div className="search-section">
            <div className="search-section-title">免密钥（开箱即用）</div>
            <div className="search-backend-grid">{free.map(backendRow)}</div>
          </div>

          <div className="search-section">
            <div className="search-section-title">需要 API Key</div>
            <div className="search-backend-grid">{keyed.map(backendRow)}</div>
          </div>

          <div className="search-section">
            <div className="search-section-title">全局参数</div>
            <div className="search-grid">
              <div className="field">
                <label>numResults</label>
                <input className="input" type="number" min={1} max={20} value={form.numResults} onChange={(e) => setForm({ ...form, numResults: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>concurrency</label>
                <input className="input" type="number" min={1} max={11} value={form.concurrency} onChange={(e) => setForm({ ...form, concurrency: Number(e.target.value) })} />
              </div>
              <div className="field">
                <label>backendTimeoutMs</label>
                <input className="input" type="number" min={1000} max={120000} value={form.timeoutMs} onChange={(e) => setForm({ ...form, timeoutMs: Number(e.target.value) })} />
              </div>
            </div>
          </div>

          <div className="search-section">
            <div className="search-section-title">结果策略</div>
            <div className="search-grid">
              <div className="field">
                <label>时间范围</label>
                <select className="input" value={form.timeRange} onChange={(e) => setForm({ ...form, timeRange: e.target.value as SearchSettings['timeRange'] })}>
                  {TIME_RANGE.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label>搜索语言</label>
                <input className="input" placeholder="如 en、zh-CN，留空为默认" value={form.language ?? ''} onChange={(e) => setForm({ ...form, language: e.target.value })} />
              </div>
              <div className="field">
                <label>去重策略</label>
                <select className="input" value={form.dedupe} onChange={(e) => setForm({ ...form, dedupe: e.target.value as SearchSettings['dedupe'] })}>
                  <option value="url">按链接</option>
                  <option value="none">不去重</option>
                </select>
              </div>
              <div className="field">
                <label>相关性重排</label>
                <select className="input" value={form.rerank ? 'on' : 'off'} onChange={(e) => setForm({ ...form, rerank: e.target.value === 'on' })}>
                  <option value="off">关</option>
                  <option value="on">开</option>
                </select>
              </div>
              <div className="field">
                <label>安全搜索</label>
                <select className="input" value={form.safeSearch ? 'on' : 'off'} onChange={(e) => setForm({ ...form, safeSearch: e.target.value === 'on' })}>
                  <option value="on">开</option>
                  <option value="off">关</option>
                </select>
              </div>
              <div className="field">
                <label>结果健康遥测</label>
                <select className="input" value={form.healthTelemetry ? 'on' : 'off'} onChange={(e) => setForm({ ...form, healthTelemetry: e.target.value === 'on' })}>
                  <option value="on">开</option>
                  <option value="off">关</option>
                </select>
              </div>
            </div>
          </div>

          <div className="search-section">
            <div className="search-section-title">API 密钥（保存后写入凭证库，立即生效）</div>
            <div className="search-key-grid">{KEYED.map(keyField)}</div>
          </div>

          <div className="search-section">
            <div className="search-section-title">私有实例可选 Key</div>
            <div className="field" style={{ maxWidth: 420 }}>
              <label>SearXNG 实例地址</label>
              <input className="input" value={form.searxngBaseUrl} onChange={(e) => setForm({ ...form, searxngBaseUrl: e.target.value })} placeholder="https://searx.be" />
            </div>
            <div className="search-key-grid">{keyField('searxng')}</div>
          </div>

          <div className="search-section">
            <div className="search-section-title"><Search size={12} /> 立即测试</div>
            <div className="row" style={{ gap: 6 }}>
              <input className="input" style={{ flex: 1 }} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="输入查询，例如 OpenAI latest news" onKeyDown={(e) => { if (e.key === 'Enter') void run(); }} />
              <button className="btn primary" onClick={() => void run()} disabled={running}>{running ? <Loader2 size={12} className="spin" /> : <Search size={12} />} 搜索</button>
            </div>
            {reports.length ? (
              <div className="search-report">
                {reports.map((item) => `${item.id}: ${item.ok ? `${item.count} 条 / ${item.ms}ms` : `失败 ${item.error ?? ''}`}`).join(' · ')}
              </div>
            ) : null}
            {results.length ? (
              <div className="search-results">
                {results.map((item) => (
                  <div key={`${item.url}-${item.title}`} className="search-result">
                    <a href={item.url} target="_blank" rel="noreferrer">{item.title || item.url}</a>
                    <div className="search-result-snippet">{item.snippet}</div>
                    <div className="search-result-meta">{item.url} · {item.source}{item.sources && item.sources.length > 1 ? ` +${item.sources.length - 1}` : ''}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="search-actions">
            <button className="btn" onClick={() => void resetHealth()}><Clock size={12} /> 重置状态</button>
            <button className="btn primary" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={12} className="spin" /> : null} 保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}