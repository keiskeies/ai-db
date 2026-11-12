import type { AgentMessageBlock, AgentPlanItem, Risk, ToolResult } from '@aidb/core';

/**
 * 一条回合的渲染形状：按发生顺序排列的条目 + 提出时间线的图表。
 *
 * 为什么要这个中间层：runtime 的事件流本来就是 思考→说话→工具→思考→说话→工具→结论，
 * 但界面以前按「类型」分堆——工具卡堆在折叠里、正文整段堆在折叠外，两边各自有序、
 * 合起来顺序没了。用户读到的就是「所有文字挤在下面，不知道上面在干什么，执行和解释
 * 都对应不上」。这里把两种来源（live 事件的 timeline / 落库的 blocks）归一成同一个序列，
 * 顺序由数据本身决定，渲染不再自己排。
 *
 * 单独成模块而不是留在 AgentPanel 里，是因为「顺序」这件事必须能被钉住：
 * 分堆的 bug 只在真实顺序上看得见，藏在组件里就没法测，下次改渲染又会溜回来。
 */

export interface TurnTool {
  callId: string;
  tool: string;
  args: unknown;
  risk?: Risk;
  status: 'running' | 'ok' | 'error' | 'awaiting';
  result?: ToolResult;
  summary?: string;
  live?: boolean;
}

export type TurnEntry =
  | { kind: 'thinking'; key: string; text: string; step?: number }
  | { kind: 'text'; key: string; text: string; step?: number }
  | { kind: 'tool'; key: string; call: TurnTool };

export interface TurnView {
  /** 按发生顺序排列的时间线条目。 */
  entries: TurnEntry[];
  plan?: AgentPlanItem[];
  charts: Array<{ key: string; result: ToolResult }>;
  toolCount: number;
  /** false = 这条消息来自分段块出现之前存的旧数据，走老版渲染。 */
  stepped: boolean;
  /** 旧数据那条整回合合并的 thinking（只在 stepped=false 时用）。 */
  legacyThinking?: string;
}

/**
 * 时间线上已经交付的一格（正在生成、还没到边界的挂在 live.stream，不在这份里）。
 *
 * 定义放在这里而不是 store：store 是生产者、渲染层是消费者，两边都要这个形状，
 * 让它住在数据形状这一侧，渲染层就不必为了一个类型反向依赖 store。
 */
export type TimelineItem =
  | { kind: 'thinking'; text: string; step?: number }
  | { kind: 'text'; text: string; step?: number }
  | { kind: 'tool'; callId: string };

/** turnFromLive 需要的最小形状（避免为了类型反过来依赖 store）。 */
export interface LiveTurnLike {
  text: string;
  thinking: string;
  tools: Array<{
    callId: string;
    tool: string;
    args: unknown;
    risk?: Risk;
    status: TurnTool['status'];
    result?: ToolResult;
    summary?: string;
  }>;
  timeline: TimelineItem[];
  stream: string;
  streamThinking: string;
  plan: AgentPlanItem[];
}

export function isChartResult(result?: ToolResult): boolean {
  return Boolean((result?.data as Record<string, any> | undefined)?.chart);
}

export function chartsOfResults(results: Iterable<{ callId: string; result?: ToolResult }>): Array<{ key: string; result: ToolResult }> {
  const out: Array<{ key: string; result: ToolResult }> = [];
  for (const item of results) if (item.result && isChartResult(item.result)) out.push({ key: item.callId, result: item.result });
  return out;
}

/** 落库消息 → 时间线。blocks 数组的写入顺序就是事件顺序（见 gateway agentHost.wrappedEmit）。 */
export function turnFromBlocks(blocks: AgentMessageBlock[]): TurnView {
  const results = new Map<string, ToolResult>();
  for (const block of blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const entries: TurnEntry[] = [];
  let toolCount = 0;
  blocks.forEach((block, index) => {
    const key = `${block.type}_${index}`;
    if (block.type === 'text' && block.text) {
      entries.push({ kind: 'text', key, text: block.text, step: block.step });
      return;
    }
    if (block.type === 'thinking' && block.text) {
      // 不带 step 的是旧数据里整回合合并的那一坨，由 legacyThinking 走老渲染
      if (block.step === undefined) return;
      entries.push({ kind: 'thinking', key, text: block.text, step: block.step });
      return;
    }
    if (block.type !== 'tool_call' || !block.callId) return;
    toolCount += 1;
    const result = results.get(block.callId);
    entries.push({
      kind: 'tool',
      key,
      call: {
        callId: block.callId,
        tool: block.tool ?? 'tool',
        args: block.args,
        risk: block.risk,
        // 没有对应结果的调用：回合被中止在半路，结果永远不会来了
        status: result ? (result.ok ? 'ok' : 'error') : 'error',
        result,
      },
    });
  });
  const stepped = entries.some((entry) => entry.kind === 'text' || entry.kind === 'thinking');
  const plan = [...blocks].reverse().find((block) => block.type === 'plan')?.items;
  const charts = chartsOfResults(
    blocks.filter((block) => block.type === 'tool_result' && block.callId).map((block) => ({ callId: block.callId!, result: results.get(block.callId!) })),
  );
  return {
    entries,
    ...(plan ? { plan } : {}),
    charts,
    toolCount,
    stepped,
    legacyThinking: blocks.find((block) => block.type === 'thinking' && block.step === undefined)?.text,
  };
}

/** 正在跑的回合 → 时间线。正在生成、还没到步骤边界的部分接在最后。 */
export function turnFromLive(live: LiveTurnLike): TurnView {
  const byId = new Map(live.tools.map((tool) => [tool.callId, tool]));
  const entries: TurnEntry[] = [];
  live.timeline.forEach((item, index) => {
    if (item.kind === 'tool') {
      const tool = byId.get(item.callId);
      if (!tool) return;
      entries.push({
        kind: 'tool',
        key: `tool_${item.callId}`,
        call: { callId: tool.callId, tool: tool.tool, args: tool.args, risk: tool.risk, status: tool.status, result: tool.result, summary: tool.summary, live: true },
      });
      return;
    }
    // 计划不进时间线：计划卡单独渲染在时间线外面（它要一直看得见，不该跟着步骤滚走）
    entries.push({ kind: item.kind, key: `${item.kind}_${index}`, text: item.text, step: item.step });
  });
  if (live.streamThinking) entries.push({ kind: 'thinking', key: 'thinking_live', text: live.streamThinking });
  if (live.stream) entries.push({ kind: 'text', key: 'text_live', text: live.stream });
  const stepped = entries.some((entry) => entry.kind === 'text' || entry.kind === 'thinking');
  return {
    entries,
    ...(live.plan.length ? { plan: live.plan } : {}),
    charts: chartsOfResults(live.tools),
    toolCount: live.tools.length,
    stepped,
    ...(live.thinking ? { legacyThinking: live.thinking } : {}),
  };
}

/** 时间线里连续的工具条目，折成一段执行过程。 */
export type TurnGroup =
  | { kind: 'entry'; entry: Exclude<TurnEntry, { kind: 'tool' }>; index: number }
  | { kind: 'tools'; start: number; calls: TurnTool[] };

/**
 * 分组只决定「谁可以被折起来」，不改变顺序：
 * 连续的工具卡合成一段可折叠的执行过程，正文与思考各自独立、**不折**——
 * 被藏起来的该是 SQL 与结果表格那类细节，不是模型的解释（「偷偷摸摸就干完了」）。
 */
export function groupTools(entries: TurnEntry[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  entries.forEach((entry, index) => {
    if (entry.kind === 'tool') {
      const tail = groups.at(-1);
      if (tail && tail.kind === 'tools') {
        tail.calls.push(entry.call);
        return;
      }
      groups.push({ kind: 'tools', start: index, calls: [entry.call] });
      return;
    }
    groups.push({ kind: 'entry', entry, index });
  });
  return groups;
}
