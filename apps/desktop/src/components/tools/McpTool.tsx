import { useEffect, useState } from 'react';
import { Loader2, Plug, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { McpServerInfo } from '@aidb/core';
import { api } from '../../lib/api';
import { useApp } from '../../store';

export function McpTool() {
  const notify = useApp((s) => s.notify);
  const features = useApp((s) => s.settings.features);
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState<string | null>(null);
  const [tools, setTools] = useState<Record<string, Array<{ name: string; description?: string }>>>({});
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

  return (
    <div className="tool-pane">
      <div className="tool-pane-head">
        <Plug size={15} /> MCP 插件
        <span className="muted">stdio 启动外部 MCP Server · 工具进入 Agent</span>
      </div>
      <div className="tool-scroll">
        {!features.mcp ? <div className="dash-empty" style={{ color: 'var(--warning, #D6B45A)' }}>MCP 工具已在 设置 → MCP 页顶部关闭；配置仍可管理，但 Agent 不会调用。</div> : null}
        <div className="panel" style={{ padding: 10, marginBottom: 10 }}>
          <div className="panel-head" style={{ paddingLeft: 0 }}>新增 MCP Server</div>
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
        </div>
        <div className="panel">
          <div className="panel-head">已配置 <span className="badge">{servers.length}</span></div>
          {loading ? <div className="dash-empty"><Loader2 size={14} className="spin" /> 读取中…</div> : null}
          {!loading && !servers.length ? <div className="dash-empty">还没有 MCP Server。可以配置飞书 lark-openapi-mcp、文件系统等 stdio server。</div> : null}
          {servers.map((server) => (
            <div key={server.id} style={{ borderBottom: '1px solid var(--border-subtle)', padding: '6px 0' }}>
              <div className="transfer-row" style={{ border: 0, padding: '4px 0' }}>
                <span className="badge">{server.enabled ? 'ON' : 'OFF'}</span>
                <span style={{ flex: 1 }}>
                  <strong>{server.name}</strong>
                  <div className="muted" style={{ fontSize: 10 }}>{server.command} {server.args.join(' ')}</div>
                </span>
                <button className="btn small" onClick={() => void toggleServer(server)}>{server.enabled ? '停用' : '启用'}</button>
                <button className="btn small" onClick={() => void discover(server)} disabled={checking === server.id}>
                  {checking === server.id ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />} 发现工具
                </button>
                <button className="icon-btn" onClick={() => void remove(server)} title="删除"><Trash2 size={12} /></button>
              </div>
              {tools[server.id]?.length ? (
                <div style={{ paddingLeft: 18 }}>
                  {tools[server.id].slice(0, 12).map((tool) => (
                    <div key={tool.name} className="muted" style={{ fontSize: 10 }}>
                      <span className="mono">{tool.name}</span>{tool.description ? ` — ${tool.description.slice(0, 100)}` : ''}
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
