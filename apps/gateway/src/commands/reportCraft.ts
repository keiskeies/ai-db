/**
 * 汇报文案的公共原则。两个消费者必须是同一套规则：
 * - /report 的 Agent 提示词（英文，给模型看）；
 * - 内置 skill `aidb-report`（中文，给用户和子 Agent 看）。
 * 各写一版必然漂移，所以放在这里共用。
 */
export const REPORT_CRAFT = `## How to write this report (business audience, not a DBA)
- Lead with the answer: the executive headline is the single most important conclusion, and every section starts with a one-sentence conclusion before its numbers.
- Rank by meaning, not by table order: the biggest change, the biggest risk and the biggest opportunity come first; background comes last.
- Every number needs a reference point. A bare figure means nothing to a reader: pair it with the previous period, the same period last year, a target, or the share of a total.
- Use business wording in titles, labels and conclusions. Never expose table names, column names, SQL verbs or row-estimate jargon ("orders", "COUNT(*)", "is_deleted=0") in what the reader sees; put those in assumptions/notes instead.
- Say what is happening, why it may be happening, and what the reader should do next. Mark any cause you have not proven as a hypothesis; a correlation you have not checked is not a finding.
- Keep each takeaway to one sentence with at most two numbers. If a section has nothing material to report, say so in one sentence instead of padding it.
- Only include a chart that changes the reader's understanding. A chart that repeats the sentence above it is noise.`;

export const REPORT_CRAFT_ZH = `# AiDB 报告写作

## 原则

1. 结论先行：开头一段管理层摘要，每节第一句写结论，再给数字和依据。
2. 数字必须有参照：每个数字都要配环比、同比、目标或占比；孤零零的数字对读者没有意义。
3. 数字只来自工具结果或 resultRef；不手写、不重算、不跨口径相加，差值由应用计算。
4. 业务语言：标题与结论里不出现表名、列名、SQL 关键字和行数口径；口径写进脚注。
5. 区分事实与推测：推测必须标注“推测”，并说明依据。
6. 异常优先：先写变化最大、风险最高的指标，再写背景。
7. 每节至少回答一个问题：发生了什么、为什么、下一步做什么。
8. 建议可执行、可验证，并给出预期影响；没有依据时不要编造负责人和期限。

## 参考结构

- 管理层摘要：一句话结论 + 2–4 条要点 + 本期风险。
- 概览：3–5 个关键指标，带对比基线与时间范围。
- 趋势：按时间轴描述拐点，指出最大增幅/降幅。
- 结构：按分组给出占比与贡献度。
- 异常：列出异常值、影响面和可能原因。
- 建议：可执行、可验证，避免空泛表述。`;
