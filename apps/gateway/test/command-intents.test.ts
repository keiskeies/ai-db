import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_INTENTS, commandIntent, parseCommandIntent } from '../src/commandIntents';

test('every command mode has a default task, timeout and no-form instruction', () => {
  for (const [id, intent] of Object.entries(COMMAND_INTENTS)) {
    assert.equal(intent.id, id);
    assert.ok(intent.defaultTask.length > 10, `${id} 缺少默认任务`);
    assert.ok(intent.timeoutMs >= 60_000, `${id} 超时过短`);
    assert.match(intent.instruction, /Do not ask them to write SQL/);
    assert.match(intent.instruction, /never open a form/i);
  }
  assert.equal(commandIntent('COMPARE')?.id, 'compare');
  assert.equal(commandIntent('unknown'), undefined);
});

test('bare commands map to a default task; user text wins when present', () => {
  const bare = parseCommandIntent('/compare');
  assert.equal(bare?.id, 'compare');
  assert.equal(bare?.argument, undefined);
  assert.equal(bare?.task, commandIntent('compare')?.defaultTask);
  assert.match(bare?.task ?? '', /对比当前库/);

  const withText = parseCommandIntent('/compare 最近 30 天 vs 上一个 30 天的订单数');
  assert.equal(withText?.argument, '最近 30 天 vs 上一个 30 天的订单数');
  assert.equal(withText?.task, '最近 30 天 vs 上一个 30 天的订单数');
  assert.equal(parseCommandIntent('普通问题'), null);
  assert.equal(parseCommandIntent('/init'), null);
});

test('compare mode demands same-caliber tools, a table and a grouped chart instead of hand math', () => {
  const text = commandIntent('compare')!.instruction;
  assert.match(text, /same metric definition/);
  assert.match(text, /grouped bar chart/);
  assert.match(text, /recon_data/);
  assert.match(text, /never to compare periods/);
  assert.match(text, /compact comparison table/);
});

test('diff, recon and fix modes name their authoritative tools and evidence shape', () => {
  assert.match(commandIntent('diff')!.instruction, /schema_diff/);
  assert.match(commandIntent('diff')!.instruction, /Destructive changes/);
  assert.match(commandIntent('recon')!.instruction, /recon_data/);
  assert.match(commandIntent('recon')!.instruction, /matched, different, missing-left, missing-right/);
  assert.match(commandIntent('fix')!.instruction, /audit_database/);
  assert.match(commandIntent('fix')!.instruction, /Do not execute writes automatically/);
  assert.match(commandIntent('fix')!.instruction, /repair SQL/);
});

test('report mode structures conclusions and charts rather than dumping rows', () => {
  const text = commandIntent('report')!.instruction;
  assert.match(text, /top-line summary/);
  assert.match(text, /render_chart/);
  assert.match(text, /Do not paste raw result sets/);
});
