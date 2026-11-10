/**
 * 审批槽位切换。`approval` 是「正在弹窗的那一个」，`approvalQueue` 是后面的排队者，
 * 两者共同构成一条 FIFO 队列——入队与出队都必须走这两个函数，否则又会出现
 * 「后一个把前一个的弹窗顶掉」或者「前一个结算时顺手抹掉后一个」。
 *
 * 背景：一个回合里 Agent 可以连着要求多次审批（建 5 张表 = 5 次 DDL）。
 * 弹窗只存在一个槽位，而 SSE 事件与用户点击的 approve 请求是两条独立通道：
 * 用户点「允许一次」后，Bridge 会立刻推进到下一个工具调用，
 * 新的 approval_required 完全可能比这次点击的 HTTP 响应更早回到 store。
 * 那时若无条件清空槽位，就会把已经在显示的第二条弹窗抹掉——它会挂在 Bridge
 * 的 5 分钟超时上被自动拒绝，表现为「后面的提问弹窗弹不出来」。
 * 所以结算一律按 approvalId 生效，并且队列显式建模。
 */

export interface ApprovalLike {
  approvalId: string;
}

export interface ApprovalSlot<T extends ApprovalLike> {
  /** 正在弹窗的那一个；undefined 表示当前没有审批要问。 */
  approval?: T;
  /** 排在它后面的，按到达顺序出队。 */
  approvalQueue: T[];
}

/**
 * 入队：没有弹窗就直接显示，已有弹窗就排队。
 *
 * 按 approvalId 去重：SSE 重连或同一回合被桌面端与 bot 同时驱动时，
 * 同一条 approval_required 可能抵达两次，堆两个一样的弹窗只会让用户多点一次。
 */
export function enqueueApproval<T extends ApprovalLike>(prev: ApprovalSlot<T>, next: T): Partial<ApprovalSlot<T>> {
  if (prev.approval?.approvalId === next.approvalId || prev.approvalQueue.some((item) => item.approvalId === next.approvalId)) return {};
  if (!prev.approval) return { approval: next, approvalQueue: prev.approvalQueue };
  return { approvalQueue: [...prev.approvalQueue, next] };
}

/**
 * 结算一个 approvalId：只有它正是当前弹窗时才把队首提上来。
 * 队列里的其它 id 只做移除（用户可能在弹窗上来不及点就被别处的决定结算了）。
 */
export function settleApproval<T extends ApprovalLike>(prev: ApprovalSlot<T>, approvalId: string): Partial<ApprovalSlot<T>> {
  if (prev.approval?.approvalId !== approvalId) {
    const kept = prev.approvalQueue.filter((item) => item.approvalId !== approvalId);
    return kept.length === prev.approvalQueue.length ? {} : { approvalQueue: kept };
  }
  const [next, ...rest] = prev.approvalQueue;
  return { approval: next, approvalQueue: rest };
}

export const NO_APPROVAL: ApprovalSlot<never> = { approval: undefined, approvalQueue: [] };
