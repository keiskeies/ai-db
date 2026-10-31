import { useEffect, useMemo, useState } from 'react';
import { Loader2, Plug, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { builtinMcpServer, type McpServerInfo } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';

const BUILTIN_ORDER = { filesystem: 0, git: 1, web: 2 } as const;

export function McpTool() {
  const notify = useApp((s) => s.notify);
  const features = useApp((s) => s.settings.features);
  const mcpPathHint = useApp((s) => s.mcpPathHint);
  const setMcpPathHint = useApp((s) => s.setMcpPathHint);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, Array<{ name: string; description?: string; risk?: string }>>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      setServers((await api.mcpServers()).servers);
    } catch (err: any) {
      notify('error', '读取 MCP Server 失败', err?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!mcpPathHint) return;
    const filesystem = servers.find((server) => server.builtin === 'filesystem');
    if (!filesystem) return;
    setDrafts((current) => ({ ...current, [filesystem.id]: mcpPathHint }));
    setMcpPathHint(undefined);
  }, [mcpPathHint, servers, setMcpPathHint]);

  const ordered = useMemo(
    () =>
      [...servers].sort((a, b) => {
        const ai = a.builtin ? BUILTIN_ORDER[a.builtin] : 10;
        const bi = b.builtin ? BUILTIN_ORDER[b.builtin] : 10;
        return ai === bi ? a.createdAt.localeCompare(b.createdAt) : ai - bi;
      }),
    [servers],
  );
  const fsNoRoots = servers.some((server) => server.builtin === 'filesystem' && server.enabled && server.args.length === 0);

  const create = async () => {
    if (!name.trim() || !command.trim()) {
      notify('warning', '名称和命令必填');
      return;
    }
    let parsedEnv: Record<string, string> | undefined;
    if (env.trim()) {
      try {
        const raw = JSON.parse(env);
        parsedEnv = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
      } catch {
        notify('warning', '环境变量必须是 JSON 对象');
        return;
      }
    }
    try {
      await api.createMcpServer({
        name: name.trim(),
        command: command.trim(),
        args: args.trim() ? args.trim().split(/\s+/) : [],
        env: parsedEnv,
      });
      setName('');
      setArgs('');
      setEnv('');
      await load();
    } catch (err: any) {
      notify('error', '保存 MCP Server 失败', err?.message);
    }
  };

  const discover = async (server: McpServerInfo) => {
    setChecking(server.id);
    try {
      const result = await api.mcpTools(server.id);
      setTools((current) => ({ ...current, [server.id]: result.tools }));
      notify('success', 'MCP 工具已发现', `${server.name} · ${result.tools.length} 个`);
    } catch (err: any) {
      notify('error', '启动 MCP Server 失败', err?.message);
    } finally {
      setChecking(null);
    }
  };

  const toggleServer = async (server: McpServerInfo) => {
    try {
      await api.updateMcpServer(server.id, { enabled: !server.enabled });
      await load();
    } catch (err: any) {
      notify('error', '更新 MCP Server 失败', err?.message);
    }
  };

  const remove = async (server: McpServerInfo) => {
    if (!window.confirm(`删除 MCP Server「${server.name}」？`)) return;
    try {
      await api.deleteMcpServer(server.id);
      await load();
    } catch (err: any) {
      notify('error', '删除失败', err?.message);
    }
  };

  const addArg = async (server: McpServerInfo) => {
    const value = (drafts[server.id] ?? '').trim();
    if (!value) return;
    if (server.args.includes(value)) {
      setDrafts((current) => ({ ...current, [server.id]: '' }));
      return;
    }
    try {
      await api.updateMcpServer(server.id, { args: [...server.args, value] });
      setDrafts((current) => ({ ...current, [server.id]: '' }));
      await load();
    } catch (err: any) {
      notify('error', '保存配置失败', err?.message);
    }
  };

  const removeArg = async (server: McpServerInfo, value: string) => {
    try {
      await api.updateMcpServer(server.id, { args: server.args.filter((item) => item !== value) });
      await load();
    } catch (err: any) {
      notify('error', '保存配置失败', err?.message);
    }
  };

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Plug size={15} /> MCP 插件
        <span className="muted">内置工具 + stdio 外部 MCP Server · 工具进入 Agent</span>
      </div>
      <div className="tool-scroll">
        {!features.mcp ? <div className="dash-empty" style={{ color: 'var(--warning, #D6B45A)' }}>MCP 工具已在 设置 → MCP 页顶部关闭；配置仍可管理，但 Agent 不会调用。</div> : null}
        {fsNoRoots ? (
          <div className="risk-banner" style={{ marginBottom: 10 }}>
            <strong>文件系统未配置允许目录</strong> — Agent 目前无法读取任何文件。请在下方「文件系统」卡片添加目录（例如 C:\server\kbook\backend），再让 Agent 重试。
          </div>
        ) : null}
        <div className="panel">
          <div className="panel-head">已配置 <span className="badge">{servers.length}</span></div>
          {loading ? <div className="dash-empty"><Loader2 size={14} className="spin" /> 读取中…</div> : null}
          {!loading && !servers.length ? <div className="dash-empty">还没有 MCP Server。可以配置飞书 lark-openapi-mcp、文件系统等 stdio server。</div> : null}
          {ordered.map((server) => {
            const definition = server.builtin ? builtinMcpServer(server.builtin) : undefined;
            const toolList = tools[server.id] ?? [];
            const configBody = (
              <>
                <div className="row" style={{ gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
                  {server.args.map((value) => (
                    <span
                      key={value}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        maxWidth: '100%',
                        padding: '1px 6px',
                        border: '1px solid var(--border-subtle)',
                        borderRadius: 4,
                        fontSize: 10,
                      }}
                    >
                      <span className="mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 420 }}>{value}</span>
                      <button className="icon-btn" title="移除" onClick={() => void removeArg(server, value)}><X size={10} /></button>
                    </span>
                  ))}
                  {!server.args.length ? <span className="muted" style={{ fontSize: 10 }}>（未配置）</span> : null}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    value={drafts[server.id] ?? ''}
                    placeholder={definition?.argsPlaceholder ?? ''}
                    onChange={(e) => setDrafts((current) => ({ ...current, [server.id]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void addArg(server);
                    }}
                  />
                  <button className="btn small" onClick={() => void addArg(server)}><Plus size={11} /> 添加</button>
                </div>
              </>
            );
            return (
              <div key={server.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '6px 0' }}>
                <div className="transfer-row" style={{ border: 0, padding: '4px 0' }}>
                  <span className="badge">{server.enabled ? 'ON' : 'OFF'}</span>
                  <span style={{ flex: 1 }}>
                    <strong>{definition?.title ?? server.name}</strong>
                    {definition ? <span className="badge" style={{ marginLeft: 6 }}>内置</span> : null}
                    <div className="muted" style={{ fontSize: 10 }}>
                      {definition ? `${server.name} · ${definition.description}` : `${server.command} ${server.args.join(' ')}`}
                    </div>
                  </span>
                  <button className="btn small" onClick={() => void toggleServer(server)}>{server.enabled ? '停用' : '启用'}</button>
                  <button className="btn small" onClick={() => void discover(server)} disabled={checking === server.id}>
                    {checking === server.id ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />} 发现工具
                  </button>
                  {definition ? null : (
                    <button className="icon-btn" onClick={() => void remove(server)} title="删除"><Trash2 size={12} /></button>
                  )}
                </div>
                {definition ? (
                  <div style={{ paddingLeft: 18, marginTop: 4 }}>
                    {definition.kind === 'web' ? (
                      <details>
                        <summary className="muted" style={{ fontSize: 10, cursor: 'pointer' }}>
                          高级：限制可访问域名（可选；不填=允许所有公网地址）
                        </summary>
                        <div className="muted" style={{ fontSize: 10, margin: '4px 0' }}>内网与回环地址始终拦截。</div>
                        {configBody}
                      </details>
                    ) : (
                      <>
                        <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
                          {definition.argsLabel}
                          {definition.kind === 'git' ? '（绝对路径；未配置时 Agent 无法读取仓库）' : '（绝对路径；未配置时 Agent 无法访问文件）'}
                        </div>
                        {configBody}
                      </>
                    )}
                  </div>
                ) : null}
                {toolList.length ? (
                  <div style={{ paddingLeft: 18 }}>
                    {toolList.slice(0, 12).map((tool) => (
                      <div key={tool.name} className="muted" style={{ fontSize: 10 }}>
                        <span className="mono">{tool.name}</span>
                        {tool.risk ? <span className="badge" style={{ marginLeft: 4 }}>{tool.risk}</span> : null}
                        {tool.description ? ` — ${tool.description.slice(0, 100)}` : ''}
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <details className="panel" style={{ padding: 10, marginTop: 10 }}>
          <summary className="panel-head" style={{ paddingLeft: 0, cursor: 'pointer' }}>
            新增 MCP Server <span className="muted" style={{ fontWeight: 400 }}>（外部 stdio）</span>
          </summary>
          <div className="tool-row" style={{ padding: 0, border: 0 }}>
            <div className="field" style={{ width: 150 }}>
              <label>名称</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="feishu" />
            </div>
            <div className="field" style={{ width: 130 }}>
              <label>命令</label>
              <input className="input" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 260 }}>
              <label>参数（空格分隔）</label>
              <input className="input" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @larksuiteoapi/lark-mcp ..." />
            </div>
          </div>
          <div className="field" style={{ marginTop: 8 }}>
            <label>环境变量 JSON（可选，加密存储）</label>
            <textarea className="textarea" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} placeholder='{"APP_ID":"…","APP_SECRET":"…"}' />
          </div>
          <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
            飞书 / 企微 / QQ 群机器人请用「设置 → 通知」，不需要 MCP；这里只用于接入外部 MCP 工具。命令会在本机执行，只添加可信的 MCP Server。
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <button className="btn primary" onClick={() => void create()}><Plus size={12} /> 保存</button>
          </div>
        </details>
      </div>
    </div>
  );
}
