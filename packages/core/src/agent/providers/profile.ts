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
const FALLBACK_MAX_OUTPUT_TOKENS = 4096;

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

/** 实际下发给服务商的 max_tokens：模型档案优先，缺省交给 provider 兜底。 */
export function maxOutputTokensOf(agent: AgentSettings, profile = getModelProfile(agent)): number | undefined {
  const value = profile?.maxOutputTokens;
  return value && value > 0 ? Math.floor(value) : undefined;
}

/**
 * 历史消息的 token 预算。
 * 基线沿用压缩阈值的一半（给输出和系统提示词留余量），模型声明了上下文窗口时再按窗口收紧，
 * 因此没有配置档案的行为与改造前完全一致。
 */
export function historyTokenBudget(agent: AgentSettings, profile = getModelProfile(agent)): number {
  const configured = Math.max(MIN_HISTORY_TOKENS, Math.floor((agent.compactionThreshold || MIN_HISTORY_TOKENS * 2) / 2));
  const room = roomInWindow(profile, agent);
  if (!room) return configured;
  return Math.max(MIN_HISTORY_TOKENS, Math.min(configured, Math.floor(room)));
}

/** 窗口扣掉输出与系统提示词后的余量；没声明窗口的模型返回 undefined（= 不设限）。 */
function roomInWindow(profile: ModelProfile | undefined, agent: AgentSettings): number | undefined {
  const window = profile?.contextWindow;
  if (!window || window <= 0) return undefined;
  return window - (maxOutputTokensOf(agent, profile) ?? FALLBACK_MAX_OUTPUT_TOKENS) - PROMPT_RESERVE_TOKENS;
}

/**
 * 单条工具结果给模型看的字符预算。
 *
 * 之前是写死的 16000 字符：200K 窗口的模型也只喂 16K，一次 JOIN 出来的宽表被砍掉大半，
 * 模型只能反复补问；128K 的本地小模型用同一个值又偏大，几步就把窗口挤爆。
 * 现在按「窗口 − 已用 − 输出 − 提示词余量」算出剩余空间，取其中一部分给单条结果：
 * 开局宽松，越跑越紧，天然和上下文占用联动。
 */
const RESULT_SHARE = 0.3;
/** 下限：再挤也要给够一次像样的取样，否则小窗口模型完全读不到数据。 */
const MIN_RESULT_CHARS = 6000;
/** 上限：单条结果再大模型也读不进去，而且序列化本身会拖慢回合。 */
const MAX_RESULT_CHARS = 200000;
/** token→字符的折算率，取保守值（中英混排 + JSON 语法字符）。 */
const CHARS_PER_TOKEN = 3;
/** 没有模型档案时的兜底，与改造前的写死值一致。 */
const FALLBACK_RESULT_CHARS = 16000;

export function modelResultCharBudget(options: { contextWindow?: number; usedTokens?: number; maxOutputTokens?: number }): number {
  const window = options.contextWindow;
  if (!window || window <= 0) return FALLBACK_RESULT_CHARS;
  const used = Number.isFinite(options.usedTokens) ? Math.max(0, options.usedTokens ?? 0) : 0;
  const room = window - used - (options.maxOutputTokens ?? FALLBACK_MAX_OUTPUT_TOKENS) - PROMPT_RESERVE_TOKENS;
  if (room <= 0) return MIN_RESULT_CHARS;
  return Math.min(MAX_RESULT_CHARS, Math.max(MIN_RESULT_CHARS, Math.floor(room * RESULT_SHARE * CHARS_PER_TOKEN)));
}

