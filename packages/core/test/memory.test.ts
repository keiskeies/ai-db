import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHeuristicMemories, isDuplicateMemory, jaccard, looksLikeSecret, rankMemories } from '../src/agent/memory';
import type { Memory } from '../src/types';

const now = Date.now();
const iso = new Date(now).toISOString();

function mem(partial: Partial<Memory> & { id: string; title: string; content: string }): Memory {
  return {
    scopeType: 'connection',
    scopeKey: 'c1',
    kind: 'fact',
    tags: [],
    importance: 0.6,
    confidence: 0.7,
    pinned: false,
    archived: false,
    useCount: 0,
    createdAt: iso,
    updatedAt: iso,
    ...partial,
  };
}

test('ranks relevant memories and prefers matching connection scope', () => {
  const memories = [
    mem({ id: 'a', title: '订单金额单位是分', content: 'orders.total_cents 以分为单位', scopeKey: 'c1' }),
    mem({ id: 'b', title: '用户偏好深色主题', content: 'UI theme preference' }),
    mem({ id: 'c', title: '订单金额单位为元', content: '另一个连接的约定', scopeKey: 'c2' }),
  ];
  const ranked = rankMemories('订单金额单位', memories, { connectionId: 'c1', limit: 3 });
  assert.ok(ranked.length >= 1);
  assert.equal(ranked[0].id, 'a');
  assert.ok(ranked[0].score > ranked[ranked.length - 1].score);
});

test('pinned memories survive empty lexical match', () => {
  const memories = [mem({ id: 'p', title: '固定规则', content: '全局口径', pinned: true })];
  const ranked = rankMemories('完全不同的话题', memories, {});
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, 'p');
});

test('dedupe detects near-identical memories', () => {
  const a = mem({ id: 'a', title: '订单金额单位是分', content: '订单金额单位是分，展示时除以 100' });
  const candidate = { title: '订单金额单位是分', content: '订单金额单位是分，展示时除以100' };
  assert.ok(isDuplicateMemory(candidate, a));
  assert.ok(jaccard('abc def', 'abc def') === 1);
});

test('heuristic extraction only captures explicit remember statements', () => {
  const candidates = extractHeuristicMemories('记住：订单金额单位是分。展示时除以 100。', { connectionId: 'c1' });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'fact');
  assert.equal(candidates[0].scopeKey, 'c1');
  assert.match(candidates[0].content, /订单金额单位是分/);
  assert.equal(extractHeuristicMemories('查一下 users 有多少行').length, 0);
});

test('rejects secret-looking memory content', () => {
  assert.ok(looksLikeSecret('password: hunter2'));
  assert.ok(looksLikeSecret('API_KEY=sk-123456'));
  assert.equal(extractHeuristicMemories('记住：数据库密码: abc123', {}).length, 0);
});
