import type { AgentSettings, ModelInputModality, ModelProfile, ModelReasoningTier } from '../../types';

/** 界面可选的推理档位标识；服务商自定义档位（如 deepseek 的 xhigh）也允许直接填。 */
export const TIER_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** 新建一个支持推理的模型时的默认档位表；value 为空即「关闭思考」（不发送该参数）。 */
export const DEFAULT_REASONING_TIERS: ModelReasoningTier[] = [
  { level: 'off', value: '' },
  { level: 'low', value: 'low' },
  { level: 'medium', value: 'medium' },
  { level: 'high', value: 'high' },
];

/** 上下文窗口扣除输出与系统提示词后，留给历史消息的估算余量。 */
const PROMPT_RESERVE_TOKENS = 8000;
const MIN_HISTORY_TOKENS = 4000;

/**
 * 没填模型档案时的默认档位。这两个数**同时是**设置页输入框的占位文案与预填值
 * （`SettingsModal` 用它们做 `defaultValue`）：界面上写出来的数，就是实际参与计算的数。
 *
 * 「显示一个值、实际用另一个值」这种分裂本身是坑：以前这里是「没声明窗口 = 不设限」，
 * 各处退回互不相同的死值（结果预算 16000 字符、输出 4096、压缩线 48000），而设置页的
 * `256K` 只是提示文字、不参与任何计算。结果是最常见的状态——接了个不自报窗口的网关、
 * 没人手填档案——恰好拿不到中途压缩（`midContextTokenBudget` 返回 0 = 关闭），
 * 长回合只能一路顶到服务商硬报超限。
 *
 * 自检：改这两个数时，设置页的占位文案与预填值由它们算出，会自动跟着变；
 * `packages/core/src/agent/providers/models.ts` 里**探测到的**值优先于这里。
 */
export const DEFAULT_CONTEXT_WINDOW = 256 * 1024; // 262144，与设置页的 256K 一致
export const DEFAULT_MAX_OUTPUT_TOKENS = 32 * 1024; // 32768，与设置页的 32K 一致

/** 接受 262144 / "256K" / "1M" 三种写法，无法解析时返回 undefined。 */
export function parseTokenSize(input: string | number | undefined): number | undefined {
  if (typeof input === 'number') return Number.isFinite(input) && input > 0 ? Math.floor(input) : undefined;
  const text = (input ?? '').toString().trim().replace(/[,\s]/g, '');
  if (!text) return undefined;
  const matched = text.match(/^(\d+(?:\.\d+)?)([km])?$/i);
  if (!matched) return undefined;
  const value = Number(matched[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const unit = matched[2]?.toLowerCase();
  const factor = unit === 'k' ? 1024 : unit === 'm' ? 1024 * 1024 : 1;
  return Math.floor(value * factor);
}

export function formatTokenSize(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens)) return '';
  if (tokens % (1024 * 1024) === 0) return `${tokens / (1024 * 1024)}M`;
  if (tokens % 1024 === 0) return `${tokens / 1024}K`;
  if (tokens >= 1024 * 1024) return `${(tokens / (1024 * 1024)).toFixed(1)}M`;
  return `${tokens}`;
}

export function getModelProfile(agent: AgentSettings, model = agent.model): ModelProfile | undefined {
  if (!model) return undefined;
  return agent.modelProfiles?.[model];
}

/** 返回新的 settings（不可变更新，供界面直接塞进 form state）。 */
export function withModelProfile(agent: AgentSettings, model: string, profile: ModelProfile): AgentSettings {
  const next = { ...(agent.modelProfiles ?? {}) };
  if (model) next[model] = profile;
  return { ...agent, modelProfiles: next };
}

export function withoutModelProfile(agent: AgentSettings, model: string): AgentSettings {
  const next = { ...(agent.modelProfiles ?? {}) };
  delete next[model];
  return { ...agent, modelProfiles: next, reasoningTier: undefined };
}

export function inputsOf(profile?: ModelProfile): ModelInputModality[] {
  return profile?.inputs?.length ? profile.inputs : ['text'];
}

export function supportsInput(profile: ModelProfile | undefined, modality: ModelInputModality): boolean {
  return inputsOf(profile).includes(modality);
}

/** 当前选中的档位；未配置推理、选了 off 或 value 为空时返回 undefined，表示不下发任何推理参数。 */
export function activeReasoningTier(agent: AgentSettings, profile = getModelProfile(agent)): ModelReasoningTier | undefined {
  if (!profile?.reasoning || !profile.reasoningTiers?.length) return undefined;
  const level = agent.reasoningTier;
  if (!level || level === 'off') return undefined;
  const tier = profile.reasoningTiers.find((item) => item.level === level);
  return tier?.value?.trim() ? tier : undefined;
}

/**
 * 实际下发给服务商的 max_tokens：模型档案优先，没填就是设置页写着的那个默认值。
 * 这里不返回 undefined——返回 undefined 等于「由 provider 兜底」，而 provider 的兜底
 * 是另一个数，界面上看不见。一个数只在一个地方定义。
 */
export function maxOutputTokensOf(agent: AgentSettings, profile = getModelProfile(agent)): number {
  const value = profile?.maxOutputTokens;
  return value && value > 0 ? Math.floor(value) : DEFAULT_MAX_OUTPUT_TOKENS;
}

/** 生效的上下文窗口：档案声明优先，没填按默认档位算（= 设置页预填的 256K）。 */
export function contextWindowOf(profile: ModelProfile | undefined): number {
  const value = profile?.contextWindow;
  return value && value > 0 ? Math.floor(value) : DEFAULT_CONTEXT_WINDOW;
}

/** 历史压缩触发线：占上下文窗口的百分比。 */
const COMPACTION_PERCENT_DEFAULT = 70;

/**
 * 历史消息的 token 预算。
 *
 * 「压缩阈值」按「占上下文窗口的百分比」解释（compactionThreshold 存 0-100，默认 70）：
 * 历史最多能占到窗口的多少，超过就压缩。随窗口自动缩放——32K 模型压缩线约 22K，
 * 1M 模型约 734K，同一次设置跨模型有效，不再为每个模型手调一个写死的 token 数。
 *
 * 预算 = min(窗口×百分比, 窗口−输出−提示词余量)，兜底不小于 MIN_HISTORY_TOKENS。
 * 窗口没填时用 DEFAULT_CONTEXT_WINDOW，口径和声明了窗口完全一致。
 */
export function historyTokenBudget(agent: AgentSettings, profile = getModelProfile(agent)): number {
  const room = roomInWindow(profile, agent);
  const percent = agent.compactionThreshold > 0 ? agent.compactionThreshold : COMPACTION_PERCENT_DEFAULT;
  const byPercent = Math.floor((room + PROMPT_RESERVE_TOKENS) * (percent / 100));
  return Math.max(MIN_HISTORY_TOKENS, Math.min(byPercent, Math.floor(room)));
}

/** 窗口扣掉输出与系统提示词后的余量。窗口没填 = 默认档位，所以永远有值。 */
function roomInWindow(profile: ModelProfile | undefined, agent: AgentSettings): number {
  return contextWindowOf(profile) - maxOutputTokensOf(agent, profile) - PROMPT_RESERVE_TOKENS;
}

/**
 * schema 段在「窗口 − 输出 − 提示词余量」里允许占的比例。
 *
 * 这里是提示词侧唯一的「schema 多大」策略：分档决定哪些表值得展开，这个比例只当
 * 天花板。留 0.35 是因为 system 段还要装历史、业务上下文、记忆与 brief，全给 schema
 * 会把 historyTokenBudget 的空间吃光（两者共用同一个窗口）。
 */
const SCHEMA_ROOM_SHARE = 0.35;
/** 极小窗口的下限：再挤也要装得下若干表名，否则模型完全看不见这个库。 */
const MIN_SCHEMA_TOKENS = 1200;

/**
 * schema 段的 token 上限。窗口/输出没填时按默认档位算——不再有「0 = 不设限」这一档，
 * 因为「不设限」在提示词侧等于「按旧的固定档办」，而固定档不认识 256K 这个默认值。
 * 与 historyTokenBudget / midContextTokenBudget 共用同一套余量常量，避免两处口径不一致。
 */
export function schemaTokenBudget(options: { contextWindow?: number; maxOutputTokens?: number }): number {
  const window = contextWindowOf(options);
  const room = window - (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) - PROMPT_RESERVE_TOKENS;
  if (room <= 0) return MIN_SCHEMA_TOKENS;
  return Math.max(MIN_SCHEMA_TOKENS, Math.floor(room * SCHEMA_ROOM_SHARE));
}

/**
 * 单条工具结果预算的参数：占剩余空间的份额 + 上下限 + token→字符折算率。
 * 预算本身见下面的 modelResultCharBudget。
 */
const RESULT_SHARE = 0.3;
/** 下限：再挤也要给够一次像样的取样，否则小窗口模型完全读不到数据。 */
const MIN_RESULT_CHARS = 6000;
/** 上限：单条结果再大模型也读不进去，而且序列化本身会拖慢回合。 */
const MAX_RESULT_CHARS = 200000;
/** token→字符的折算率，取保守值（中英混排 + JSON 语法字符）。 */
const CHARS_PER_TOKEN = 3;

/**
 * 单条工具结果的字符预算。
 *
 * 之前是写死的 16000 字符：200K 窗口的模型也只喂 16K，一次 JOIN 出来的宽表被砍掉大半，
 * 模型只能反复补问；128K 的本地小模型用同一个值又偏大，几步就把窗口挤爆。
 * 现在按「窗口 − 已用 − 输出 − 提示词余量」算出剩余空间，取其中一部分给单条结果：
 * 开局宽松，越跑越紧，天然和上下文占用联动。窗口没填按 DEFAULT_CONTEXT_WINDOW 算——
 * 这也是「填了 256K 档案」和「什么都没填」必须得到同一个预算的原因，否则设置页上
 * 写着的数字就只是装饰。
 */
export function modelResultCharBudget(options: { contextWindow?: number; usedTokens?: number; maxOutputTokens?: number }): number {
  const window = contextWindowOf(options);
  const used = Number.isFinite(options.usedTokens) ? Math.max(0, options.usedTokens ?? 0) : 0;
  const room = window - used - (options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) - PROMPT_RESERVE_TOKENS;
  if (room <= 0) return MIN_RESULT_CHARS;
  return Math.min(MAX_RESULT_CHARS, Math.max(MIN_RESULT_CHARS, Math.floor(room * RESULT_SHARE * CHARS_PER_TOKEN)));
}

/**
 * 长工具回合的中途总上下文 token 预算。窗口扣掉输出与提示词余量「之后」的剩余空间，
 * runtime 在 contextTokens 超过它时压缩最早的工具往返。
 *
 * 窗口没填按 DEFAULT_CONTEXT_WINDOW 算，于是这一手**总是开着**。以前它把「没声明窗口」
 * 当成 0 = 关闭，而没声明恰恰是最常见的状态，于是长回合唯一的自保机制在最需要它的
 * 配置下失效，只能等服务商硬报 context 超限。
 *
 * 窗口的过载线取「窗口 − 输出 − 提示词余量」，比结果预算抓得更紧一点，给压缩留出
 * 执行余量——压缩本身也要占一点 token，不能在刚好顶满窗口时才动手。
 */
export function midContextTokenBudget(contextWindow: number | undefined, maxOutputTokens?: number): number {
  const window = contextWindowOf({ contextWindow });
  const output = maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const budget = window - output - PROMPT_RESERVE_TOKENS;
  // 留 10% 剪辑余量（压缩前后的边界抖动），同时至少比 0 大
  return Math.max(1, Math.floor(budget * 0.9));
}

