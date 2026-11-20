import type { AgentMessageBlock, AgentPlanItem, Risk, ToolResult } from '@aidb/core';
import type { LiveTool, LiveTurn } from '../../types';
import type { ChartShape } from '../chart/model';

export function chartOf(result?: ToolResult): ChartShape | undefined {
  const data = result?.data as Record<string, any> | undefined;
  return (data?.chart as ChartShape | undefined) ?? undefined;
}

/**
 * 一条回合的时间线（思考 / 正文 / 工具 / 图表，按发生顺序）。与桌面端 AgentPanel 的
 * TurnView 同一套结构，理由也一样：正文和工具分两堆渲染会把顺序抹掉，
 * 读的人不知道上面在干什么。
 */
export interface MobileTurnEntry {
  kind: 'thinking' | 'text' | 'tool' | 'chart';
  key: string;
  text?: string;
  /** 这一步属于第几步。桌面端用它把同一步的思考/解释/SQL 框进同一段，移动端同一套口径。 */
  step?: number;
  call?: { callId: string; tool: string; args: unknown; risk?: Risk; status: LiveTool['status']; result?: ToolResult; summary?: string };
}

export function mobileTurnFromBlocks(blocks: AgentMessageBlock[]): { entries: MobileTurnEntry[]; plan?: AgentPlanItem[]; toolCount: number; stepped: boolean; legacyThinking?: string } {
  const results = new Map<string, ToolResult>();
  for (const block of blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const entries: MobileTurnEntry[] = [];
  let toolCount = 0;
  blocks.forEach((block, index) => {
    const key = `${block.type}_${index}`;
    if (block.type === 'text' && block.text) {
      entries.push({ kind: 'text', key, text: block.text, step: block.step });
      return;
    }
    if (block.type === 'thinking' && block.text) {
      if (block.step === undefined) return;
      entries.push({ kind: 'thinking', key, text: block.text, step: block.step });
      return;
    }
    if (block.type !== 'tool_call' || !block.callId) return;
    toolCount += 1;
    const result = results.get(block.callId);
    entries.push({
      // 图表结果不钻工具卡：它在这一格就地渲染，正文才能和图穿插着读
      kind: chartOf(result) ? 'chart' : 'tool',
      key,
      call: { callId: block.callId, tool: block.tool ?? 'tool', args: block.args, risk: block.risk, status: result ? (result.ok ? 'ok' : 'error') : 'error', result },
    });
  });
  // 旧数据在步边界先正文后思考（旧 runtime 交付反序）；同步内正文→思考相邻是它的签名，纠正回先想后说。
  for (let i = 0; i + 1 < entries.length; i++) {
    const a = entries[i];
    const b = entries[i + 1];
    if (a.kind === 'text' && b.kind === 'thinking' && a.step !== undefined && a.step === b.step) {
      entries[i] = b;
      entries[i + 1] = a;
    }
  }
  return {
    entries,
    toolCount,
    stepped: entries.some((entry) => entry.kind === 'text' || entry.kind === 'thinking'),
    legacyThinking: blocks.find((block) => block.type === 'thinking' && block.step === undefined)?.text,
  };
}

export function mobileTurnFromLive(live: LiveTurn): { entries: MobileTurnEntry[]; toolCount: number; stepped: boolean } {
  const byId = new Map(live.tools.map((tool) => [tool.callId, tool]));
  const entries: MobileTurnEntry[] = [];
  live.timeline.forEach((item, index) => {
    if (item.kind === 'tool') {
      const tool = byId.get(item.callId);
      if (!tool) return;
      entries.push({ kind: chartOf(tool.result) ? 'chart' : 'tool', key: `tool_${tool.callId}`, call: { ...tool } });
      return;
    }
    entries.push({ kind: item.kind, key: `${item.kind}_${index}`, text: item.text, step: item.step });
  });
  if (live.streamThinking) entries.push({ kind: 'thinking', key: 'thinking_live', text: live.streamThinking });
  if (live.stream) entries.push({ kind: 'text', key: 'text_live', text: live.stream });
  return { entries, toolCount: live.tools.length, stepped: entries.some((entry) => entry.kind === 'text' || entry.kind === 'thinking') };
}
