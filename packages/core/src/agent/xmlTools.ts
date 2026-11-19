import type { ToolCall } from './types';

/**
 * XML 参数全是文本，但下游按真实类型判定（dryRun === true、Array.isArray(items)）。
 * 不还原类型时 dryRun:"true" 会静默变成真执行。只还原无歧义的形状：
 * 布尔字面量、纯数字、JSON 对象/数组；其余（SQL、名字、普通文本）保持字符串。
 */
function coerceParam(raw: string): unknown {
  const text = raw.trim();
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      return JSON.parse(text);
    } catch {
      return raw;
    }
  }
  return raw;
}

/**
 * 有些模型把工具调用当普通文本吐出来（Anthropic 风格的 <function_calls><invoke>），
 * 结构化解析拿不到，就直接甩给用户看了。这里把能救的调用捞回来，并从正文里删掉。
 */
export function rescueXmlToolCalls(text: string, known: (name: string) => boolean): { text: string; calls: ToolCall[] } {
  const firstInvoke = text.indexOf('<invoke');
  if (firstInvoke < 0) return { text, calls: [] };
  // 代码块里贴的示例不当作真实调用
  const fence = text.indexOf('```');
  if (fence >= 0 && fence < firstInvoke) return { text, calls: [] };

  const calls: ToolCall[] = [];
  const invokeRe = /<invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:<\/invoke>|(?=<invoke\s)|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = invokeRe.exec(text)) !== null) {
    const name = match[1].trim();
    if (!known(name)) continue;
    const args: Record<string, unknown> = {};
    const paramRe = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;
    let param: RegExpExecArray | null;
    while ((param = paramRe.exec(match[2])) !== null) {
      args[param[1].trim()] = coerceParam(param[2]);
    }
    calls.push({ id: `xml_${Date.now().toString(36)}_${calls.length}`, name, args });
  }
  if (!calls.length) return { text, calls: [] };
  // 截断在第一个 XML 标记处：残缺的闭合标签不该留在正文里
  const start = Math.min(...[text.indexOf('<function_calls'), firstInvoke].filter((index) => index >= 0));
  return { text: text.slice(0, start).trimEnd(), calls };
}
