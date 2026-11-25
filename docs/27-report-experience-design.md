# 27 — AI 助手 `/report` 报表体验优化设计

状态：M1–M4 已实现
日期：2026-11-24
关联：[命令化 Agent 工作流](./11-command-workflows.md) · [AI Agent 设计](./04-ai-agent-design.md) · [能力契约](./16-capability-contract.md)

## 1. 背景与现状

`/report` 已经具备 schema 注入、业务术语/记忆召回、只读查询、`resultRef` 数字溯源、环比/同比、确定性降级和 PPTX/XLSX 导出，不需要推翻重做。当前体验偏弱主要来自四处：

1. **需求理解没有显式产物**：用户主题直接进入 Agent，模型是否理解“给老板看”“为什么下滑”“离目标还差多少”等隐含目的，完全依赖临场发挥。
2. **分析覆盖没有验收标准**：提示词要求 2–5 节，但没有说明一份业务报告至少应回答哪些问题，模型容易用几个 KPI 和两张重复图交差。
3. **报表图表模型过窄**：`ReportBlock` 只支持单序列 `bar/line/pie/stacked`，而现有 `ChartView` 已支持多系列、散点、热力、雷达和双轴，能力没有接入报告。
4. **展示层偏“调试输出”**：桌面图表只有 220px，标题区直接暴露英文 layout；移动端产物详情把整个 `ReportSpec` 渲染成 JSON。

## 2. 目标与非目标

### 2.1 目标

- **G1 理解用户目的**：把一句自然语言扩写成可检查的 `ReportBrief`，明确业务目标、核心问题、分析维度、对比基线和交付重点。
- **G2 分析更完整**：业务报告默认覆盖核心指标、趋势、结构、变化归因、明细与行动建议；诊断/目标/机会类问题自动增加异常、目标差距或贡献度分析。
- **G3 图表更丰富但不冗余**：支持多系列、折线、堆叠、散点、热力、雷达和双轴；每张图必须回答一个明确问题。
- **G4 数字仍然可信**：所有新图表数据继续绑定 `resultRef/resultRefs`，新增数值维度一个也不能绕过来源校验。
- **G5 桌面与移动一致**：桌面获得更好的报表版面，移动端不再显示 JSON，图表和表格可读、可展开。
- **G6 导出不丢信息**：PPTX 保留多系列与可映射图表；无法原生映射的图表在 PPT 中降级为数据表，XLSX 保留全部图表数据。

### 2.2 非目标

- 不做拖拽式 BI、报表设计器或大屏。
- 不为凑数硬加图表；数据形状不支持时明确说明原因。
- 不把预测写成既成事实，不自动编造原因、负责人或期限。
- 不改变 `/report` 的只读边界、连接归属和取消语义。
- 不在本轮引入新的 LLM 调用；需求扩写由确定性规则完成，业务指标到 schema/字段的映射仍由 Agent 负责。

## 3. 用户体验设计

### 3.1 典型输入与隐含需求

| 用户输入 | 识别模式 | 自动扩展的问题 |
|---|---|---|
| `/report 本月经营概览` | overview | 规模如何？趋势如何？结构是否集中？有哪些风险和下一步？ |
| `/report 为什么本周订单下滑` | diagnosis | 下滑多少？从什么时候开始？集中在哪些渠道/商品/地区？是否异常？ |
| `/report 看看离季度目标还差多少` | target | 目标是什么？完成率多少？缺口集中在哪些维度？如何追赶？ |
| `/report 找找增长空间` | opportunity | 哪些维度还有潜力？贡献度如何？优先投入哪里？ |
| `/report 数据质量怎么样` | technical | 完整性、唯一性、新鲜度和异常情况如何？ |

用户明确说出的指标、维度、时间、目标值和对比对象优先级最高；规则只做补全，不覆盖明确意图。

### 3.2 报告内容标准

“足而不堆”是默认业务标准，不是图表数量竞赛：

- 首屏：一句话结论 + 3–5 条要点 + 风险/机会。
- 核心指标：业务读者 4–6 个，技术读者 6–8 个；每个核心指标至少一个同口径基线。
- 趋势：1 张有序时间序列图；时间戳必须分桶。
- 结构：1 张构成/分组图；类别过多时 Top N + 其他，或改为排序条形图。
- 归因：1 张“本期/上期/变化/贡献度”明细表；诊断类问题必须有可用的归因维度。
- 异常：有时间序列时检查离群点，只描述事实，不编原因。
- 行动：1–3 条可执行、可验证建议；无依据时省略，不写空泛建议。
- 图表总数：业务报告通常 2–4 张；只有新增图形能改变读者判断时才增加。

如果缺少时间列、维度列或业务数据，报告必须明确说明哪项分析无法完成，而不是用“数据规模”冒充业务结论。

## 4. 总体架构

```text
/report 用户话术
   │
   ├─ AgentHost（对话内 /report）
   │    └─ buildReportBrief → 注入系统提示 → update_plan → 查数/出图 → 对话交付
   │
   └─ CommandRunner（报告工具/API/定时产物）
        ├─ generateAgentReport
        │    ├─ buildReportBrief → 注入系统提示 → update_plan
        │    ├─ run_sql/analyze_chart/render_chart
        │    └─ compose_report（ReportSpec + resultRef）
        │         → checkReportQuality + checkReportCoverage
        └─ generateReport（本地推理 / Agent 失败降级）
             └─ buildReportBrief → 确定性查数与证据链 → checkReportCoverage
                  ↓
             ReportView / MobileReportView / PPTX / XLSX
```

对话、Agent 产物和确定性降级共享同一份 `ReportBrief` 生成规则与覆盖契约，避免路径漂移；降级报告同时保留 `meta.degraded` 说明，不把固定统计伪装成模型分析。

## 5. ReportBrief：需求扩写契约

新增 `packages/core/src/commands/reportBrief.ts`。需求扩写必须与当前 schema 同时构建，不能先产出脱离数据对象的分析任务。

### 5.1 类型

```ts
type ReportMode = 'overview' | 'diagnosis' | 'target' | 'opportunity' | 'comparison' | 'technical';
type ReportAnalysis =
  | 'metrics' | 'trend' | 'composition' | 'comparison'
  | 'attribution' | 'anomaly' | 'target' | 'forecast' | 'detail' | 'actions';

interface ReportBrief {
  version: 1;
  originalTopic: string;
  normalizedTopic: string;
  mode: ReportMode;
  audience: 'executive' | 'business' | 'technical';
  objective: string;
  questions: string[];
  mentionedMetrics: string[];
  mentionedDimensions: string[];
  baselines: string[];
  analyses: ReportAnalysis[];
  coverage: {
    minMetrics: number;
    maxMetrics: number;
    minCharts: number;
    maxCharts: number;
    requireAttribution: boolean;
    requireTarget: boolean;
    requireAnomaly: boolean;
  };
  clarification?: string;
  grounding: {
    tables: Array<{
      database: string;
      name: string;
      kind: string;
      alias?: string;
      description?: string;
      matchReason: string;
      columns: Array<{
        name: string;
        type: string;
        role: 'metric' | 'dimension' | 'time' | 'id' | 'other';
        alias?: string;
        description?: string;
        nullable?: boolean;
        primaryKey?: boolean;
      }>;
    }>;
    joins: Array<{
      leftTable: string;
      leftColumn: string;
      rightTable: string;
      rightColumn: string;
      source: 'foreign-key' | 'context';
      cardinality?: string;
    }>;
    businessTerms: Array<{ term: string; synonyms: string[]; definition: string }>;
  };
  plan: Array<{
    id: string;
    title: string;
    analyses: ReportAnalysis[];
    tables: string[];
    columns: string[];
    deliverable: string;
  }>;
}
```

### 5.2 Schema 语义对齐

这是需求扩写的硬前置条件：

1. `buildReportBrief` 同时接收 `DatabaseSchema[]`、Agent 表/列元数据、术语表、标准 SQL 示例和用户选定表。
2. 复用现有 `focusTablesForQuestion` 的相关性排序；表名、列名、表/列别名、数据库 comment、术语同义词和已召回的标准 SQL 都参与候选表选择。
3. 候选表必须带完整可用字段、字段类型、角色和业务元数据；角色至少区分指标、维度、时间、主键/外键和其他字段。
4. 候选表按外键和用户登记的关系补充关联对象，计划只能使用明确列出的 JOIN 路径。
5. 用户明确选表优先级最高；同名表通过 database/source 标识区分，禁止跨源 JOIN。
6. 用户说“成交额/客单价/活跃用户”而 schema 叫 `order_amount/aov/dau` 时，brief 必须同时展示业务词、别名/comment 和候选字段，让模型先确认映射再设计指标。
7. 候选字段只是“可用于计划”，不是已确认口径；模型必须先核对术语、标准 SQL、表粒度和字段值，再进入查数步骤。
8. 没有匹配到业务对象时，brief 明确输出“未匹配”，计划第一步改为 `inspect_schema/search_objects`；不得猜一张相近表继续。

### 5.3 推断规则

1. 明确时间、目标、指标、维度原样保留。
2. 模式识别按优先级：technical → target → diagnosis → opportunity → comparison → overview。
3. 多源或“对比/合并”语义启用 comparison；合并场景仍要求逐源同口径，不跨库 JOIN。
4. 未指定基线时，默认环比；主基线是同比时补环比，主基线是环比时补同比；有目标时增加目标达成。
5. 主题过于宽泛且没有业务上下文时，`clarification` 只允许提出一个短问题；有 schema/术语/记忆可推断时不打断用户。
6. `buildReportBrief` 不生成业务数值，不猜测字段口径，只组织分析任务。

### 5.4 分析计划与提示词注入

`brief.plan` 的每一步都必须列出候选表、字段角色和交付物：

1. **对象与口径绑定**：候选表、别名/术语、主外键、时间列、指标列、维度列；先确认业务词到字段的映射。
2. **核心指标与基线**：候选指标/时间字段，输出 4–6 个 KPI 和同比/环比/目标基线。
3. **趋势与结构**：时间列 + 维度列，输出趋势图和构成/分组图。
4. **条件分析**：诊断/目标/机会模式分别绑定归因维度、目标或异常窗口。
5. **汇总与行动**：把已验证数字转成结论、风险和建议。

如果候选字段不完整，计划第一步先 `inspect_schema/profile_column/sample_rows` 确认，不允许直接写聚合 SQL。`formatReportBriefForPrompt(brief)` 输出完整 grounding 与计划，并要求模型用 `update_plan` 展开上述步骤。

## 6. 分析覆盖与质量闸口

新增 `checkReportCoverage(spec, brief?)`，并入现有质量闸口：

- **硬伤**：没有任何数字、headline 空洞、技术术语泄漏、数字无来源，继续按现有规则阻断。
- **覆盖硬伤**：有业务数字但核心指标少于 `minMetrics`，且没有明确的数据不足说明；brief 已匹配到业务对象但完全未使用 grounding 中的可用表/字段时退回补充对象绑定。
- **覆盖提示**：趋势、结构、归因、异常、目标或行动缺失；写入 `meta.qualityNotes`，不反复打回。
- **图表质量**：饼图 3–8 个非负切片；雷达 3–8 个同单位维度；散点至少 2 个点；热力矩阵必须完整；折线/堆叠时间轴必须分桶。
- **重复内容**：同一指标在同一章节重复出现、图表与表格完全重复时给提示。

`compose_report` 增加可选 `coverageExceptions: string[]`，用于说明“缺少时间列”“维度基数为 1”等无法完成的分析。例外必须具体，不能写“数据不足”泛泛带过。

## 7. ReportSpec 图表扩展

`packages/core/src/commands/report.ts` 的 `ReportBlock` 增量扩展，旧字段保持不变：

```ts
type ReportChartType = 'bar' | 'line' | 'pie' | 'stacked' | 'scatter' | 'heatmap' | 'radar';

interface ReportChartSeries {
  name: string;
  values: number[];
}

interface ReportBlock {
  chartType?: ReportChartType;
  xLabel?: string;
  yLabel?: string;
  series?: ReportChartPoint[];       // 兼容旧报告
  extraSeries?: ReportChartSeries[]; // 多系列/堆叠/双轴
  stacked?: boolean;
  dualAxis?: boolean;
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  baselineName?: string;
}
```

规则：

- `series` 继续作为主系列，`extraSeries` 与 `series` 等长。
- `dualAxis` 仅用于一个附加系列的柱状/折线图，不能与堆叠同时开启。
- 散点使用 `scatter`，热力使用 `heatmap`，不再伪装成饼图。
- 所有 `value/baseline/x/y/matrix` 数字必须来自块绑定的工具结果。
- 图表标题、轴标题和单位面向业务读者，不出现表名/列名/SQL。

## 8. 桌面报表展示

改造 `apps/desktop/src/components/ReportView.tsx`：

- 头部显示标题、来源、时间范围、阅读对象；移除直接暴露的 `layout` 英文值。
- 增加“分析与计划”折叠区，展示 `ReportBrief` 的目标、核心问题和分析覆盖。
- 管理层摘要使用更清晰的结论卡片；章节增加序号和结论层级。
- KPI 卡片保持 4–6 个首屏密度，补充基线与同比/目标读数。
- 图表高度从 220px 提升到约 260–280px，传入轴标题、多系列、散点、热力、雷达和双轴配置。
- 表格支持横向滚动、数字右对齐和“再显示 N 行”；不静默裁掉数据。
- 口径、质量提示和证据入口保留，但视觉权重低于正文结论。

## 9. 移动报表展示

新增 `apps/mobile/src/components/ReportView.tsx`，改造 `ArtifactsScreen.tsx`：

- 报告/对比产物优先渲染结构化 `ReportView`，其他产物才保留 JSON。
- 顶部显示标题、时间、来源和阅读对象。
- 管理层摘要、KPI、图表、表格、建议、口径按区块渲染。
- 图表复用 `MobileChart`，支持现有七类图表与多系列。
- 表格使用横向 `ScrollView`，默认展示有限行并提供展开按钮。
- 运行错误、降级说明和质量提示单独展示，不埋进 JSON。

## 10. 导出设计

### 10.1 PPTX

- `DeckChart` 扩展为与 `ReportBlock` 相同的图表字段。
- 多系列柱状/折线/饼图进入原生 PPT 图表。
- 堆叠映射为原生堆叠柱；双轴保留为多系列并注明单位。
- 散点/雷达优先映射原生类型；热力图及无法可靠映射的类型降级为数据表，标题和脚注说明原因。
- 每张图仍可独立成页，分页和截断继续由 `planReportDeck` 统一决定。

### 10.2 XLSX

- 指标、表格和证据链保持现有 sheet。
- 图表数据改为长表：章节、图表、类型、点标签、系列名、值、基线、X、Y、矩阵行列、脚注。
- 散点、热力、多系列数据完整导出，不缺列、不改成字符串。

## 11. 实施阶段

### M1：需求扩写与覆盖契约

- 新增 `reportBrief.ts` 与测试。
- `AgentHost` 和 `reportAgent` 共用 brief 注入。
- 更新 `/report` 命令提示词与 `REPORT_CRAFT`。
- `compose_report` 保存 brief，并接入覆盖质量提示。

### M2：图表数据模型与来源校验

- 扩展 `ReportSpec`、`normalizeReportBlock` 和图表 JSON Schema。
- 更新桌面 `ChartView` 映射。
- 更新 deck/PPTX/XLSX 数据结构与渲染。

### M3：桌面与移动展示

- 桌面报表版面和分析计划折叠区。
- 新增移动 `ReportView`，替换产物 JSON。
- 补充移动图表模型测试。

### M4：回归与验收

- core/gateway/desktop/mobile 相关测试。
- `typecheck`、构建、i18n 校验。
- 启动桌面 Web，使用浏览器验证生成、查看、刷新、导出和移动端报表视图。

## 12. 关键文件清单

| 文件 | 改动 |
|---|---|
| `packages/core/src/commands/reportBrief.ts` | 新增需求扩写与覆盖契约 |
| `packages/core/src/commands/report.ts` | 扩展图表类型与字段 |
| `packages/core/src/commands/reportQuality.ts` | 接入覆盖与图表质量检查 |
| `packages/core/src/commands/reportRender.ts` | brief 展示、deck/Excel 图表扩展 |
| `apps/gateway/src/agentHost.ts` | 对话 `/report` 注入 brief |
| `apps/gateway/src/commandIntents.ts` | 更新报告工作流与覆盖要求 |
| `apps/gateway/src/commands/reportAgent.ts` | brief 生成、持久化、compose 校验 |
| `apps/gateway/src/features/report.ts` | 确定性降级共享 brief、schema grounding 与覆盖提示 |
| `apps/gateway/src/commands/reportCraft.ts` | 更新报告写作原则 |
| `apps/gateway/src/features/reportDeck.ts` | SVG 图表渲染扩展 |
| `apps/gateway/src/commands/export.ts` | PPTX 多系列与降级映射 |
| `apps/desktop/src/components/ReportView.tsx` | 报表版面与图表映射 |
| `apps/mobile/src/components/ReportView.tsx` | 新增结构化报告视图 |
| `apps/mobile/src/screens/ArtifactsScreen.tsx` | 用 ReportView 替换 JSON |
| `apps/mobile/src/styles.ts` | 报告视图样式 |

## 13. 验收标准

- 五类典型提问能生成对应 `ReportBrief`，明确目的、问题和覆盖要求；Agent 与确定性降级产物均持久化 brief。
- 宽泛主题不会只得到“表数量 + 行数”的伪业务报告；缺少业务数据时必须明确说明。
- 业务报告包含 4–6 个有基线的核心指标和至少两张有区分度的图；诊断类包含归因，目标类包含目标差距。
- 新图表的所有数字都能追溯到 `resultRef`，错误引用继续被拒绝。
- 桌面图表高度、轴标题、多系列正确；移动端报告不再出现整段 JSON。
- PPTX 多系列图表正确；XLSX 完整保留散点/热力/多系列数据。
- 旧 `ReportSpec` 仍可渲染，旧四类图表行为不回归。
- 相关测试、类型检查、构建和 i18n 校验通过。

## 14. 风险与权衡

- **生成时间增加**：更多指标和归因查询会增加步数；通过计划合并查询、限制图表数量和复用已有结果控制。
- **模型不遵守计划**：brief 与质量闸口双重约束，覆盖缺口如实提示，不假装完整。
- **图表语义误用**：按数据形状约束类型，保留 `ChartView` 的适用性校验。
- **导出差异**：PPT 无法表达所有图形时用数据表降级，确保信息不丢。
- **旧产物兼容**：只增量扩展字段，不迁移历史 JSON，渲染器对缺省字段继续走旧路径。
