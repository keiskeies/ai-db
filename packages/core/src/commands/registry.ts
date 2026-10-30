import type { CommandDefinition, CommandId } from './types';

const READ_ONLY_REPORT_TOOLS = [
  'inspect_schema',
  'search_objects',
  'run_sql',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'analyze_chart',
  'forecast_chart',
  'render_chart',
  'memory_search',
  'update_plan',
];

const FIX_TOOLS = [
  'inspect_schema',
  'search_objects',
  'run_sql',
  'explain_sql',
  'sample_rows',
  'profile_column',
  'audit_database',
  'check_data_quality',
  'backup_database',
  'begin_transaction',
  'commit_transaction',
  'rollback_transaction',
  'update_plan',
  'memory_search',
];

export const COMMANDS: CommandDefinition[] = [
  {
    id: 'report',
    aliases: ['/报表'],
    title: { zh: '生成报告', en: 'Report' },
    description: { zh: '把数据变成可保存、可刷新、可导出的报告', en: 'Turn data into a saved, refreshable report' },
    group: 'analysis',
    icon: 'file-chart',
    sources: { min: 1, max: 4, allowSameConnection: true, database: 'optional' },
    execution: 'hybrid',
    maxRisk: 'read',
    artifact: 'report',
    allowedTools: READ_ONLY_REPORT_TOOLS,
    extraTools: ['compose_report'],
    slots: [
      { key: 'sources', kind: 'sources', label: { zh: '数据源', en: 'Sources' }, required: true },
      { key: 'topic', kind: 'text', label: { zh: '报告主题', en: 'Topic' }, required: true, placeholder: '例如：本周订单与履约情况' },
      { key: 'period', kind: 'period', label: { zh: '时间范围', en: 'Period' } },
      { key: 'tables', kind: 'tables', label: { zh: '关注表', en: 'Tables' }, advanced: true },
      {
        key: 'format',
        kind: 'enum',
        label: { zh: '输出', en: 'Output' },
        required: true,
        default: 'screen',
        options: [
          { value: 'screen', label: { zh: '屏幕', en: 'Screen' } },
          { value: 'xlsx', label: { zh: 'Excel', en: 'Excel' } },
          { value: 'pdf', label: { zh: 'PDF', en: 'PDF' } },
          { value: 'pptx', label: { zh: 'PPT', en: 'PPT' } },
        ],
      },
    ],
    prompt: '按用户语义选择 sections / comparison / merged / mixed 布局；数字必须来自工具结果引用，不得手写。',
  },
  {
    id: 'compare',
    aliases: ['/对比'],
    title: { zh: '分析对比', en: 'Compare' },
    description: { zh: '两个时间段、分组、查询或数据源的同口径对比', en: 'Compare two periods, segments, queries or sources' },
    group: 'analysis',
    icon: 'arrows-left-right',
    sources: { min: 1, max: 2, allowSameConnection: true, database: 'optional' },
    execution: 'hybrid',
    maxRisk: 'read',
    artifact: 'compare',
    allowedTools: READ_ONLY_REPORT_TOOLS,
    extraTools: ['compose_report'],
    slots: [
      { key: 'sources', kind: 'sources', label: { zh: '数据源', en: 'Sources' }, required: true },
      { key: 'metric', kind: 'text', label: { zh: '对比指标', en: 'Metric' }, required: true, placeholder: '例如：订单额，按天' },
      { key: 'leftLabel', kind: 'text', label: { zh: 'A 侧', en: 'Side A' }, required: true, placeholder: '例如：本周' },
      { key: 'rightLabel', kind: 'text', label: { zh: 'B 侧', en: 'Side B' }, required: true, placeholder: '例如：上周' },
      { key: 'queryA', kind: 'text', label: { zh: 'A 侧 SQL', en: 'Side A SQL' }, advanced: true, placeholder: '留空则对比最大表的行数' },
      { key: 'queryB', kind: 'text', label: { zh: 'B 侧 SQL', en: 'Side B SQL' }, advanced: true, placeholder: '留空则对比最大表的行数' },
      { key: 'period', kind: 'period', label: { zh: '参考时间范围', en: 'Period' }, advanced: true },
    ],
    prompt: '两侧必须使用相同口径的查询；差值、占比和贡献度由网关计算，不得手写。',
  },
  {
    id: 'diff',
    aliases: ['/结构对比', '/schema-diff'],
    title: { zh: '结构对比', en: 'Schema diff' },
    description: { zh: '两个库的结构差异与目标方言 DDL', en: 'Schema differences and target-dialect DDL' },
    group: 'compare',
    icon: 'git-compare',
    sources: { min: 2, max: 2, allowSameConnection: true, database: 'optional' },
    execution: 'deterministic',
    maxRisk: 'read',
    artifact: 'diff',
    slots: [
      { key: 'sources', kind: 'sources', label: { zh: '源 A / 源 B', en: 'Source A / B' }, required: true },
      { key: 'tables', kind: 'tables', label: { zh: '限定对象', en: 'Tables' }, advanced: true },
      { key: 'includeDrops', kind: 'boolean', label: { zh: '包含删除', en: 'Include drops' }, default: false, advanced: true },
    ],
  },
  {
    id: 'recon',
    aliases: ['/对账', '/data-diff'],
    title: { zh: '数据对账', en: 'Reconcile' },
    description: { zh: '两个源的行级对账，支持 SQL 表与 Redis 键空间', en: 'Row-level reconciliation across SQL tables and Redis keyspaces' },
    group: 'compare',
    icon: 'list-checks',
    sources: { min: 2, max: 2, allowSameConnection: true, database: 'optional' },
    execution: 'deterministic',
    maxRisk: 'read',
    artifact: 'recon',
    form: 'recon',
    slots: [
      { key: 'sources', kind: 'sources', label: { zh: '左侧 / 右侧', en: 'Left / right' }, required: true },
      { key: 'mapping', kind: 'mapping', label: { zh: '键与字段映射', en: 'Key and field mapping' }, required: true },
      {
        key: 'level',
        kind: 'enum',
        label: { zh: '对账级别', en: 'Level' },
        required: true,
        default: 'counts',
        options: [
          { value: 'counts', label: { zh: '数量', en: 'Counts' } },
          { value: 'keys', label: { zh: '键级', en: 'Keys' } },
          { value: 'fields', label: { zh: '字段级', en: 'Fields' } },
        ],
      },
      { key: 'maxKeys', kind: 'number', label: { zh: '键上限', en: 'Max keys' }, default: 200000, advanced: true },
    ],
  },
  {
    id: 'fix',
    aliases: ['/体检', '/修复'],
    title: { zh: '体检与修复', en: 'Check & fix' },
    description: { zh: '数据库体检、修复计划与安全执行', en: 'Database checkup, repair plan and safe execution' },
    group: 'ops',
    icon: 'wrench',
    sources: { min: 1, max: 1, allowSameConnection: true, database: 'optional' },
    execution: 'hybrid',
    maxRisk: 'destructive',
    artifact: 'fix',
    allowedTools: FIX_TOOLS,
    extraTools: ['submit_fix_plan'],
    slots: [
      { key: 'sources', kind: 'sources', label: { zh: '连接', en: 'Connection' }, required: true },
      {
        key: 'mode',
        kind: 'enum',
        label: { zh: '模式', en: 'Mode' },
        required: true,
        default: 'check',
        options: [
          { value: 'check', label: { zh: '只检查', en: 'Check only' } },
          { value: 'repair', label: { zh: '生成并执行修复', en: 'Plan and repair' } },
        ],
      },
      { key: 'tables', kind: 'tables', label: { zh: '范围', en: 'Tables' }, advanced: true },
    ],
    prompt: '体检与修复必须遵循备份、dry-run、审批、验证的安全链；只读连接禁止执行修复。',
  },
  {
    id: 'ask',
    aliases: [],
    title: { zh: '自由提问', en: 'Ask' },
    description: { zh: '不启动命令，直接与 Agent 对话', en: 'Talk to the agent without a command' },
    group: 'general',
    icon: 'message-circle',
    sources: { min: 0, max: 1, allowSameConnection: true, database: 'optional' },
    execution: 'agent',
    maxRisk: 'destructive',
    slots: [],
  },
];

export const COMMAND_IDS: CommandId[] = COMMANDS.map((command) => command.id);

const normalizedAlias = (value: string): string => value.trim().toLowerCase();

export function getCommand(idOrAlias: string): CommandDefinition | undefined {
  const key = normalizedAlias(idOrAlias);
  return COMMANDS.find(
    (command) => command.id === key || command.aliases.some((alias) => normalizedAlias(alias) === key),
  );
}

export function commandAliases(): string[] {
  return COMMANDS.flatMap((command) => [command.id, ...command.aliases]);
}
