import assert from 'node:assert/strict';
import test from 'node:test';
import { NO_APPROVAL, enqueueApproval, settleApproval, type ApprovalSlot } from '../src/lib/approvalQueue';

const a = (id: string) => ({ approvalId: id });
const slot = (approval?: ReturnType<typeof a>, queue: ReturnType<typeof a>[] = []): ApprovalSlot<{ approvalId: string }> => ({
  approval,
  approvalQueue: queue,
});

test('空槽时入队直接显示', () => {
  const next = enqueueApproval(slot(), a('A'));
  assert.equal(next.approval?.approvalId, 'A');
  assert.deepEqual(next.approvalQueue, []);
});

test('已有弹窗时后来的排队，不顶掉当前弹窗', () => {
  const prev = slot(a('A'));
  const next = enqueueApproval(prev, a('B'));
  assert.equal(next.approval, undefined, '当前弹窗不能被后来的请求替换');
  assert.deepEqual(next.approvalQueue?.map((x) => x.approvalId), ['B']);
});

test('结算当前弹窗时把队首提上来，其余继续排队', () => {
  const prev = slot(a('A'), [a('B'), a('C')]);
  const first = settleApproval(prev, 'A');
  assert.equal(first.approval?.approvalId, 'B');
  assert.deepEqual(first.approvalQueue?.map((x) => x.approvalId), ['C']);

  const second = settleApproval({ approval: first.approval, approvalQueue: first.approvalQueue ?? [] }, 'B');
  assert.equal(second.approval?.approvalId, 'C');
  assert.deepEqual(second.approvalQueue, []);

  const third = settleApproval({ approval: second.approval, approvalQueue: second.approvalQueue ?? [] }, 'C');
  assert.equal(third.approval, undefined, '队列空了就收摊');
  assert.deepEqual(third.approvalQueue, []);
});

test('结算迟到的 id 不能抹掉当前正在显示的弹窗', () => {
  // 用户点了 A → SSE 已把 B 推上弹窗 → A 的 HTTP 响应才回来。
  // 这是「后面的弹窗弹不出来」的原始成因，必须原样复现并拦住。
  const prev = slot(a('B'));
  const next = settleApproval(prev, 'A');
  assert.deepEqual(next, {}, '非当前 id 的结算不该动任何字段');
});

test('结算队列里排队的 id：只移除它，当前弹窗不动', () => {
  const prev = slot(a('A'), [a('B'), a('C')]);
  const next = settleApproval(prev, 'B');
  assert.equal(next.approval, undefined);
  assert.deepEqual(next.approvalQueue?.map((x) => x.approvalId), ['C']);
});

test('重复到达的同一个 approvalId 只留一份', () => {
  const once = enqueueApproval(slot(), a('A'));
  const twice = enqueueApproval({ approval: once.approval, approvalQueue: once.approvalQueue ?? [] }, a('A'));
  assert.deepEqual(twice, {}, '同一个 id 不该堆第二个弹窗');

  const queued = slot(a('A'), [a('B')]);
  assert.deepEqual(enqueueApproval(queued, a('B')), {}, '队列里已有的 id 同样去重');
});

test('清空常量把槽位与队列一起归零', () => {
  assert.equal(NO_APPROVAL.approval, undefined);
  assert.deepEqual(NO_APPROVAL.approvalQueue, []);
});
