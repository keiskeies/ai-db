import type { ToolRisk } from './types';
import { TOOLS } from './tools';

export interface AgentToolGroup {
  id: string;
  label: string;
  /** Feature switch that removes the whole group from the Agent when off. */
  requiresFeature?: 'skills' | 'mcp';
  tools: string[];
}

/**
 * Display grouping for the read-only Agent tool catalog. Grouping lives here
 * (not in the UI) so a new tool without a home fails the coverage test.
 */
export const AGENT_TOOL_GROUPS: AgentToolGroup[] = [
  { id: 'connection', label: '连接与结构', tools: ['list_connections', 'inspect_schema', 'search_objects', 'get_query_history'] },
  {
    id: 'sql',
    label: 'SQL 执行与事务',
    tools: ['run_sql', 'explain_sql', 'sample_rows', 'profile_column', 'begin_transaction', 'commit_transaction', 'rollback_transaction'],
  },
  {
    id: 'dialect',
    label: '多方言语句与检索',
    tools: ['run_mql', 'run_redis', 'run_cypher', 'run_cql', 'run_aql', 'search_index', 'vector_search'],
  },
  {
    id: 'document',
    label: '集合与文档',
    tools: ['create_collection', 'delete_collection', 'upsert_document', 'import_documents', 'delete_documents', 'write_line_protocol'],
  },
  {
    id: 'structure',
    label: '表结构与数据变更',
    tools: ['create_table', 'alter_table', 'drop_object', 'manage_index', 'import_csv', 'export_result', 'generate_data'],
  },
  { id: 'analysis', label: '分析、图表与体检', tools: ['audit_database', 'check_data_quality', 'render_chart', 'analyze_chart', 'forecast_chart'] },
  { id: 'compare', label: '对比与迁移', tools: ['schema_diff', 'recon_data', 'transfer_data'] },
  { id: 'ops', label: '运维', tools: ['backup_database'] },
  { id: 'plan', label: '计划与记忆', tools: ['update_plan', 'memory_write', 'memory_search'] },
  {
    id: 'skill',
    label: 'Skill',
    requiresFeature: 'skills',
    tools: ['skill_list', 'skill_read', 'skill_write', 'skill_run', 'skill_list_files', 'skill_worker_run'],
  },
  { id: 'mcp', label: 'MCP', requiresFeature: 'mcp', tools: ['mcp_list_servers', 'mcp_list_tools', 'mcp_call'] },
];

const RISK_TEXT: Record<ToolRisk, string> = {
  read: '只读，直接执行',
  write: '写操作：连接只读时拒绝，询问模式需审批',
  ddl: '结构变更：连接只读时拒绝，询问模式需审批',
  destructive: '破坏性：始终审批（生产环境强制）',
  dynamic: '按语句/参数实时分类后决定',
};

export interface AgentToolEntry {
  name: string;
  description: string;
  risk: ToolRisk;
  groupId: string;
  groupLabel: string;
  requiresFeature?: 'skills' | 'mcp';
  /** Human-readable availability constraint; describes what gates the tool today. */
  constraint: string;
}

const GROUP_BY_TOOL = new Map<string, AgentToolGroup>();
for (const group of AGENT_TOOL_GROUPS) {
  for (const name of group.tools) if (!GROUP_BY_TOOL.has(name)) GROUP_BY_TOOL.set(name, group);
}

/** Extra gates that are per-tool rather than per-risk. */
const TOOL_NOTES: Record<string, string> = {
  run_sql: '多语句写脚本受 设置 → 查询「允许多语句」约束',
  mcp_call: '省略 server 时按内置工具名反推所属 Server',
};

export function agentToolCatalog(): AgentToolEntry[] {
  return TOOLS.map((tool) => {
    const group = GROUP_BY_TOOL.get(tool.name);
    const constraint = [group?.requiresFeature === 'mcp' ? '受 设置 → MCP 与工具 总开关；远程与机器人回合不下发' : undefined, group?.requiresFeature === 'skills' ? '受 设置 → Skills 总开关' : undefined, RISK_TEXT[tool.risk], TOOL_NOTES[tool.name]]
      .filter(Boolean)
      .join('；');
    return {
      name: tool.name,
      description: tool.description,
      risk: tool.risk,
      groupId: group?.id ?? 'other',
      groupLabel: group?.label ?? '其他',
      requiresFeature: group?.requiresFeature,
      constraint,
    };
  });
}
