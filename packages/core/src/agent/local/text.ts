/**
 * 离线推理器的回复文案。
 *
 * 只有两条语言线：中文与英文。其余界面语言回落到英文——规则模式没有翻译层，
 * 硬塞半套德语文案比统一用英文更糟。数据（表名、列名、注释、数字、SQL）不在这里，
 * 它们来自库本身，不该被界面语言改写。
 */
export type LocalLang = 'zh' | 'en';

export function localLang(locale?: string): LocalLang {
  if (!locale) return 'zh';
  return /^zh/i.test(locale) ? 'zh' : 'en';
}

export interface LocalText {
  help(tables: string): string;
  needTable(names: string): string;
  noTables: string;
  allHidden(count: number): string;
  listTables(list: string, total: number): string;
  describeMissing(names: string): string;
  hiddenTable(name: string): string;
  sample(table: string, rows: string): string;
  count(table: string, value: unknown): string;
  group(rows: string): string;
  windowOf(source: string): string;
  preamble(input: { intent: string; table: string; axis?: string; notes?: string }): string;
  conclusion: {
    single(value: string, measure: string, window: string): string;
    empty: string;
    noRows: string;
    grouped(head: string, groups: number, total: string, window: string, top: string, topValue: string): string;
  };
  chartAnswer(title: string, lines: string, note: string): string;
  analyzeAnswer(input: { what: string; axis: string; sum: string; avg: string; max: string; argmax: string; min: string; argmin: string; sql: string }): string;
  forecastAnswer(method: string, lines: string, note: string): string;
  appliedFilters(filters: string): string;
}

const zh: LocalText = {
  help: (tables) =>
    `我是 AiDB 的本地离线助手，不需要 API Key。能做的事：\n\n` +
    `- 列出表和列、搜索对象（“有哪些表”“找一下名字含 order 的表”）\n- 看结构和样例数据\n` +
    `- 计数、分组、合计、占比、趋势、Top-N（可追问：“那按城市呢”“只看已支付的”）\n` +
    `- 直接说 SQL 执行；也能直接贴 Cypher / MQL / Redis 命令 / CQL / AQL\n` +
    `- 建表、增删列、建索引、删除表（需审批）\n- 生成示例数据、备份、导出、导入 CSV\n` +
    `- 结构对比、数据对账、事务（开启/提交/回滚）、查询历史\n` +
    `- 图表：柱状/折线/饼/散点/热力/雷达/堆叠\n- 记忆：说“记住：…”保存偏好\n\n` +
    `直接说需求即可，例如：\n- “看看 orders 表结构”\n- “按 status 统计订单金额并画柱状图”\n` +
    `- “创建表 tasks，包含 id 自增主键, title 文本, done 布尔”\n\n` +
    `> 我只覆盖规则明确的指令；开放式分析、管道编排请配置云端模型。${tables}`,
  needTable: (names) => `请指定表名。当前可用：${names || '（无表）'}。`,
  noTables: '当前库没有表。可以让我创建一个，例如：“创建表 tasks，包含 id 自增主键, title 文本”。',
  allHidden: (count) => `当前库的 ${count} 张表都被「Agent 上下文」设置隐藏了，我看不到任何可用对象。请到 工具箱 → Agent 上下文 启用需要的表。`,
  listTables: (list, total) => `当前库共有 **${total}** 张表：\n\n${list}`,
  describeMissing: (names) => `请指定要查看的表名。当前可用：${names || '（无）'}。`,
  hiddenTable: (name) => `\`${name}\` 被「Agent 上下文」设置隐藏了，我不会绕过它去查别的表。请到 工具箱 → Agent 上下文 启用这张表，或换一张已启用的表提问。`,
  sample: (table, rows) => `\`${table}\` 的样例数据：\n\n${rows || '（没有行）'}`,
  count: (table, value) => `\`${table}\` 共 **${value}** 行。`,
  group: (rows) => `分组统计结果：\n\n${rows}`,
  windowOf: (source) => `（${source}）`,
  preamble: ({ intent, table, axis, notes }) => {
    if (intent === 'chart') return `我把 \`${table}\` 汇总后渲染图表${axis ? `（横轴 ${axis}）` : ''}${notes ? `：${notes}` : ''}。`;
    if (intent === 'analyze') return `我在 Bridge 侧算好 \`${table}\` 的统计量，不自己估数${notes ? `：${notes}` : ''}。`;
    return notes ? `我在 \`${table}\` 上按条件统计：${notes}。` : `我在 \`${table}\` 上按条件统计。`;
  },
  conclusion: {
    single: (value, measure, window) => `**${value}** —— 这是${measure}${window}。`,
    empty: '查询没有返回行。',
    noRows: '查询返回 0 行：条件可能过紧，或这段时间确实没有数据。',
    grouped: (head, groups, total, window, top, topValue) =>
      `按 ${head} 分成 ${groups} 组${total ? `，合计 **${total}**` : ''}${window}。最高的是 ${top}${topValue ? `（${topValue}）` : ''}。`,
  },
  chartAnswer: (title, lines, note) => `图表已生成并显示在上方工具卡中：**${title}**。\n\n${lines || '没有可绘制的数据。'}${note}`,
  analyzeAnswer: (i) =>
    `${i.what}按 \`${i.axis}\` 统计：合计 **${i.sum}**，均值 ${i.avg}，最高 ${i.argmax}（${i.max}），最低 ${i.argmin}（${i.min}）。数字由 Bridge 计算，不是估算。\n\n\`\`\`sql\n${i.sql}\n\`\`\``,
  forecastAnswer: (method, lines, note) => `按**${method}**外推：\n\n${lines || '（没有可外推的数据）'}\n\n> ${note}`,
  appliedFilters: (filters) => `条件：${filters}`,
};

const en: LocalText = {
  help: (tables) =>
    `I'm AiDB's built-in offline assistant — no API key needed. I can:\n\n` +
    `- list tables and columns, search objects ("which tables exist", "find tables named order*")\n- show structure and sample rows\n` +
    `- count, group, sum, share, trend, Top-N (and follow-ups like "by city", "only paid ones")\n` +
    `- run SQL you type, or run Cypher / MQL / Redis commands / CQL / AQL directly\n` +
    `- create tables, add/drop columns, indexes, drop tables (with approval)\n- generate sample data, backup, export, import CSV\n` +
    `- compare schemas, reconcile data, transactions (begin/commit/rollback), query history\n` +
    `- charts: bar / line / pie / scatter / heatmap / radar / stacked\n- memory: say "remember: ..." to save a preference\n\n` +
    `Just describe what you need, e.g.\n- "show the orders table structure"\n- "orders by status as a bar chart"\n` +
    `- "create table tasks with id auto-increment primary key, title text, done boolean"\n\n` +
    `> I only cover well-specified requests; open-ended analysis and pipelines need a cloud model.${tables}`,
  needTable: (names) => `Which table? Available: ${names || '(none)'}.`,
  noTables: 'This database has no tables yet. I can create one, e.g. "create table tasks with id auto-increment primary key, title text".',
  allHidden: (count) => `All ${count} tables here are hidden by the Agent context. Enable the ones you need in Toolbox → Agent context.`,
  listTables: (list, total) => `This database has **${total}** tables:\n\n${list}`,
  describeMissing: (names) => `Which table's structure? Available: ${names || '(none)'}.`,
  hiddenTable: (name) => `\`${name}\` is hidden by the Agent context. I won't route around it — enable it in Toolbox → Agent context or ask about another table.`,
  sample: (table, rows) => `Sample rows from \`${table}\`:\n\n${rows || '(no rows)'}`,
  count: (table, value) => `\`${table}\` has **${value}** rows.`,
  group: (rows) => `Grouped result:\n\n${rows}`,
  windowOf: (source) => ` (${source})`,
  preamble: ({ intent, table, axis, notes }) => {
    if (intent === 'chart') return `I aggregate \`${table}\` and render a chart${axis ? ` (x-axis: ${axis})` : ''}${notes ? `. ${notes}` : '.'}`;
    if (intent === 'analyze') return `I compute the statistics on the Bridge side over \`${table}\`${notes ? `. ${notes}` : '.'}`;
    return notes ? `Querying \`${table}\`: ${notes}.` : `Querying \`${table}\`.`;
  },
  conclusion: {
    single: (value, measure, window) => `**${value}** — that's ${measure}${window}.`,
    empty: 'The query returned no rows.',
    noRows: '0 rows: the filters may be too narrow, or there is no data in that window.',
    grouped: (head, groups, total, window, top, topValue) =>
      `By ${head}: ${groups} groups${total ? `, total **${total}**` : ''}${window}. Top is ${top}${topValue ? ` (${topValue})` : ''}.`,
  },
  chartAnswer: (title, lines, note) => `Chart rendered above: **${title}**.\n\n${lines || 'Nothing to plot.'}${note}`,
  analyzeAnswer: (i) =>
    `${i.what} by \`${i.axis}\`: total **${i.sum}**, average ${i.avg}, max ${i.argmax} (${i.max}), min ${i.argmin} (${i.min}). Computed by the Bridge, not estimated.\n\n\`\`\`sql\n${i.sql}\n\`\`\``,
  forecastAnswer: (method, lines, note) => `Forecast (**${method}**):\n\n${lines || '(nothing to extrapolate)'}\n\n> ${note}`,
  appliedFilters: (filters) => `Filters: ${filters}`,
};

export function localText(lang: LocalLang): LocalText {
  return lang === 'en' ? en : zh;
}
