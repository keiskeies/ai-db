import test from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_TOOL_GROUPS, TOOL_NAMES, agentToolCatalog } from '../src/index';

test('Agent 工具目录分组覆盖全部工具且不重复', () => {
  const grouped = AGENT_TOOL_GROUPS.flatMap((group) => group.tools);
  const duplicates = grouped.filter((name, index) => grouped.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `工具被分进多个组：${duplicates.join(', ')}`);
  assert.deepEqual(
    [...TOOL_NAMES].sort(),
    [...grouped].sort(),
    '每个 Agent 工具都要有一个分组，新增工具必须同时补进 AGENT_TOOL_GROUPS',
  );
});

test('目录里的组名不在工具清单内会被指出', () => {
  const unknown = AGENT_TOOL_GROUPS.flatMap((group) => group.tools.filter((name) => !TOOL_NAMES.includes(name)));
  assert.deepEqual(unknown, [], `分组引用了不存在的工具：${unknown.join(', ')}`);
});

test('每个工具都有分组、风险与可用条件', () => {
  const catalog = agentToolCatalog();
  assert.equal(catalog.length, TOOL_NAMES.length);
  for (const entry of catalog) {
    assert.notEqual(entry.groupId, 'other', `${entry.name} 没有归组`);
    assert.ok(entry.groupLabel.length > 0);
    assert.ok(entry.constraint.includes('只读') || entry.constraint.includes('审批') || entry.constraint.includes('分类'), `${entry.name} 缺少可用条件说明`);
  }
  const mcp = catalog.find((entry) => entry.name === 'mcp_call')!;
  assert.equal(mcp.requiresFeature, 'mcp');
  assert.match(mcp.constraint, /总开关/);
  assert.match(mcp.constraint, /反推/);
  assert.match(catalog.find((entry) => entry.name === 'run_sql')!.constraint, /允许多语句/);
});
