/** 各家大模型服务的快捷配置：协议、默认接入地址与常用模型名。 */

export type ProviderKind = 'local' | 'anthropic' | 'openai' | 'ollama';

export type PresetGroup = '本地 / 自建' | '国内服务' | '国际服务';

export interface ProviderPreset {
  /** 存入 AgentSettings.preset 的稳定标识。 */
  id: string;
  label: string;
  kind: ProviderKind;
  group: PresetGroup;
  baseUrl: string;
  /** 接入地址留空时也允许保存（本地服务通常无鉴权）。 */
  keyRequired: boolean;
  /** 拉取不到模型列表时展示的候选模型。 */
  models: string[];
  defaultModel: string;
  color: string;
  docs?: string;
  note?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'local',
    label: '内置离线推理',
    kind: 'local',
    group: '本地 / 自建',
    baseUrl: '',
    keyRequired: false,
    models: ['local'],
    defaultModel: 'local',
    color: '#8B5CF6',
    note: '无需任何外部服务，支持建表/查询/备份等 22 个工具，复杂推理建议接云端模型。',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    group: '本地 / 自建',
    baseUrl: 'http://127.0.0.1:11434/v1',
    keyRequired: false,
    models: ['qwen3:8b', 'llama3.1:8b', 'deepseek-r1:8b', 'gpt-oss:20b'],
    defaultModel: 'qwen3:8b',
    color: '#1D1D1F',
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    note: '模型列表读 /api/tags，对话走 OpenAI 兼容的 /v1/chat/completions。',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'openai',
    group: '本地 / 自建',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    models: ['local-model'],
    defaultModel: 'local-model',
    color: '#2C2A4A',
    note: '需在 LM Studio 里开启 Local Server。',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    kind: 'openai',
    group: '本地 / 自建',
    baseUrl: 'http://127.0.0.1:8000/v1',
    keyRequired: false,
    models: ['Qwen/Qwen3-8B'],
    defaultModel: 'Qwen/Qwen3-8B',
    color: '#7C3AED',
    note: 'OpenAI 兼容 server，模型名与 --served-model-name 一致。',
  },
  {
    id: 'custom',
    label: '自定义 OpenAI 兼容',
    kind: 'openai',
    group: '本地 / 自建',
    baseUrl: '',
    keyRequired: false,
    models: [],
    defaultModel: '',
    color: '#7D8B9A',
    note: '任何实现了 /chat/completions 与 /models 的服务都可以接。',
  },
  {
    id: 'deepseek',
    label: '深度求索 DeepSeek',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.deepseek.com/v1',
    keyRequired: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    color: '#4D6BFE',
    docs: 'https://api-docs.deepseek.com/',
  },
  {
    id: 'kimi',
    label: '月之暗面 Kimi',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyRequired: true,
    models: ['kimi-k2-0905-preview', 'kimi-latest', 'moonshot-v1-8k'],
    defaultModel: 'kimi-k2-0905-preview',
    color: '#0F0F1A',
    docs: 'https://platform.moonshot.cn/docs',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyRequired: true,
    models: ['glm-4.5', 'glm-4-plus', 'glm-4-flash'],
    defaultModel: 'glm-4.5',
    color: '#3B5BFE',
    docs: 'https://docs.bigmodel.cn/',
  },
  {
    id: 'qwen',
    label: '阿里云百炼 通义千问',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyRequired: true,
    models: ['qwen-plus', 'qwen-max', 'qwen3-235b-a22b'],
    defaultModel: 'qwen-plus',
    color: '#FF6A00',
    docs: 'https://help.aliyun.com/zh/model-studio/',
  },
  {
    id: 'doubao',
    label: '火山方舟 豆包',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    keyRequired: true,
    models: ['doubao-pro-32k', 'doubao-1-5-pro-32k-250115'],
    defaultModel: 'doubao-pro-32k',
    color: '#E5322F',
    docs: 'https://www.volcengine.com/docs/82379',
    note: '多数场景要填推理接入点 ID（ep-xxxxxxxx）。',
  },
  {
    id: 'qianfan',
    label: '百度千帆 文心',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    keyRequired: true,
    models: ['ernie-4.0-8k', 'ernie-speed-128k'],
    defaultModel: 'ernie-4.0-8k',
    color: '#2932E1',
    docs: 'https://cloud.baidu.com/doc/WENXINWORKSHOP/s/Flkcozt4i',
  },
  {
    id: 'hunyuan',
    label: '腾讯混元',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keyRequired: true,
    models: ['hunyuan-large', 'hunyuan-turbo', 'hunyuan-pro'],
    defaultModel: 'hunyuan-large',
    color: '#0A6CFF',
    docs: 'https://cloud.tencent.com/document/product/1729',
  },
  {
    id: 'spark',
    label: '讯飞星火',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    keyRequired: true,
    models: ['generalv3.5', 'generalv3', 'x1'],
    defaultModel: 'generalv3.5',
    color: '#2B7CF6',
    docs: 'https://www.xfyun.cn/doc/spark/Agent-HTTP%E8%BF%9E%E6%8E%A5%E6%8E%A5%E5%85%A5.html',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.minimaxi.com/v1',
    keyRequired: true,
    models: ['MiniMax-Text-01', 'abab7-chat-preview'],
    defaultModel: 'MiniMax-Text-01',
    color: '#E61F4A',
    docs: 'https://www.minimaxi.com/document/guides/chat%20model/V2',
  },
  {
    id: 'lingyi',
    label: '零一万物 Yi',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.lingyiwanwu.com/v1',
    keyRequired: true,
    models: ['yi-lightning', 'yi-large'],
    defaultModel: 'yi-lightning',
    color: '#F0A202',
    docs: 'https://platform.lingyiwanwu.com/docs',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    kind: 'openai',
    group: '国内服务',
    baseUrl: 'https://api.siliconflow.cn/v1',
    keyRequired: true,
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen3-32B'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    color: '#1B72E8',
    docs: 'https://docs.siliconflow.cn/',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    group: '国际服务',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'],
    defaultModel: 'gpt-4o-mini',
    color: '#10A37F',
    docs: 'https://platform.openai.com/docs',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    kind: 'anthropic',
    group: '国际服务',
    baseUrl: 'https://api.anthropic.com',
    keyRequired: true,
    models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514',
    color: '#D97757',
    docs: 'https://docs.anthropic.com/',
    note: '走 Anthropic Messages API，鉴权用 x-api-key。',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    group: '国际服务',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    defaultModel: 'llama-3.3-70b-versatile',
    color: '#F55036',
    docs: 'https://console.groq.com/docs',
  },
  {
    id: 'mistral',
    label: 'Mistral AI',
    kind: 'openai',
    group: '国际服务',
    baseUrl: 'https://api.mistral.ai/v1',
    keyRequired: true,
    models: ['mistral-large-latest', 'mistral-small-latest'],
    defaultModel: 'mistral-large-latest',
    color: '#FA5200',
    docs: 'https://docs.mistral.ai/',
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    kind: 'openai',
    group: '国际服务',
    baseUrl: 'https://api.x.ai/v1',
    keyRequired: true,
    models: ['grok-4', 'grok-3'],
    defaultModel: 'grok-4',
    color: '#1F1F23',
    docs: 'https://docs.x.ai/',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter 聚合',
    kind: 'openai',
    group: '国际服务',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    models: ['deepseek/deepseek-chat', 'anthropic/claude-sonnet-4', 'openai/gpt-4o-mini'],
    defaultModel: 'deepseek/deepseek-chat',
    color: '#8B8BF5',
    docs: 'https://openrouter.ai/docs',
    note: '一个 Key 可调多家模型，模型名形如 vendor/model。',
  },
];

export function presetById(id?: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export function presetsByGroup(): Array<{ group: PresetGroup; presets: ProviderPreset[] }> {
  const groups: PresetGroup[] = ['本地 / 自建', '国内服务', '国际服务'];
  return groups.map((group) => ({ group, presets: PROVIDER_PRESETS.filter((preset) => preset.group === group) }));
}

/** 根据协议与接入地址反查预设，用于回显已保存的配置。 */
export function matchPreset(kind: ProviderKind, baseUrl: string): ProviderPreset | undefined {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  return PROVIDER_PRESETS.find((preset) => preset.kind === kind && preset.baseUrl.replace(/\/+$/, '') === normalized);
}

export const OLLAMA_CHAT_SUFFIX = '/v1';

/** Ollama 的对话端点是 OpenAI 兼容的 /v1，模型列表在原生 /api/tags。 */
export function ollamaOrigin(baseUrl: string): string {
  try {
    const url = new URL(baseUrl.trim());
    return `${url.protocol}//${url.host}`;
  } catch {
    return baseUrl.trim().replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  }
}
