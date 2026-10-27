import { useState } from 'react';
import {
  ArrowLeftRight,
  BarChart3,
  Braces,
  Code2,
  Database,
  FileSearch,
  Gauge,
  KeyRound,
  ListTodo,
  Search,
  Sparkles,
  Table2,
  Wrench,
  X,
} from 'lucide-react';
import { useApp } from '../../store';
import { SearchTool } from './SearchTool';
import { QueryBuilderTool } from './QueryBuilderTool';
import { SchemaCompareTool } from './SchemaCompareTool';
import { TransferTool } from './TransferTool';
import { GeneratorTool } from './GeneratorTool';
import { MonitorTool } from './MonitorTool';
import { JobsTool } from './JobsTool';
import { UsersTool } from './UsersTool';
import { DictionaryTool } from './DictionaryTool';
import { DataCompareTool } from './DataCompareTool';
import { AdvancedObjectsTool } from './AdvancedObjectsTool';

const TOOL_LIST = [
  { id: 'search', label: '数据库搜索', desc: '对象与数据全文查找', icon: <FileSearch size={14} /> },
  { id: 'builder', label: '查询构建器', desc: '可视化选表 / 连接 / 条件', icon: <Braces size={14} /> },
  { id: 'compare', label: '结构对比同步', desc: '两个库的 DDL diff', icon: <ArrowLeftRight size={14} /> },
  { id: 'datacompare', label: '数据对比', desc: '行数差异与替换同步', icon: <BarChart3 size={14} /> },
  { id: 'transfer', label: '数据传输', desc: '跨连接复制表与数据', icon: <Table2 size={14} /> },
  { id: 'generate', label: '数据生成', desc: '按列类型造测试数据', icon: <Sparkles size={14} /> },
  { id: 'monitor', label: '服务器监控', desc: '指标 / 会话 / 终止', icon: <Gauge size={14} /> },
  { id: 'jobs', label: '自动化任务', desc: '定时查询与备份', icon: <ListTodo size={14} /> },
  { id: 'users', label: '用户与权限', desc: '账号 / 角色 / 授权', icon: <KeyRound size={14} /> },
  { id: 'dictionary', label: '数据字典', desc: 'Markdown / DDL 导出', icon: <Database size={14} /> },
  { id: 'objects', label: '高级对象', desc: '触发器 / 函数 / 序列', icon: <Code2 size={14} /> },
];

export function ToolsHub() {
  const open = useApp((s) => s.toolsOpen);
  const active = useApp((s) => s.toolsActive);
  const openTools = useApp((s) => s.openTools);
  const close = useApp((s) => s.closeTools);
  const [query, setQuery] = useState('');

  if (!open) return null;
  const visible = TOOL_LIST.filter((tool) => !query || `${tool.label}${tool.desc}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal wide tools-modal" role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>
            <Wrench size={15} /> 工具箱
            <span className="muted" style={{ fontWeight: 400, fontSize: 10.5 }}>Navicat 式生产力工具</span>
          </h2>
          <button className="icon-btn" onClick={close}><X size={15} /></button>
        </div>
        <div className="tools-layout">
          <div className="tools-nav">
            <div className="search-box" style={{ marginBottom: 6 }}>
              <Search size={12} />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索工具…" />
            </div>
            {visible.map((tool) => (
              <button key={tool.id} className={active === tool.id ? 'active' : ''} onClick={() => openTools(tool.id)}>
                {tool.icon}
                <span>
                  <strong>{tool.label}</strong>
                  <em>{tool.desc}</em>
                </span>
              </button>
            ))}
            {!visible.length ? <div className="dash-empty">没有匹配的工具</div> : null}
          </div>
          <div className="tools-content">
            {active === 'search' ? <SearchTool /> : null}
            {active === 'builder' ? <QueryBuilderTool /> : null}
            {active === 'compare' ? <SchemaCompareTool /> : null}
            {active === 'datacompare' ? <DataCompareTool /> : null}
            {active === 'transfer' ? <TransferTool /> : null}
            {active === 'generate' ? <GeneratorTool /> : null}
            {active === 'monitor' ? <MonitorTool /> : null}
            {active === 'jobs' ? <JobsTool /> : null}
            {active === 'users' ? <UsersTool /> : null}
            {active === 'dictionary' ? <DictionaryTool /> : null}
            {active === 'objects' ? <AdvancedObjectsTool /> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
