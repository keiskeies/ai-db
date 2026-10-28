import test from 'node:test';
import assert from 'node:assert/strict';
import { rescueXmlToolCalls } from '../src/agent/xmlTools';

const known = (name: string) => ['render_chart', 'run_sql'].includes(name);

test('rescues a complete XML tool call and strips it from the text', () => {
  const text = `我先画个图。
<function_calls>
<invoke name="render_chart">
<parameter name="connectionId">c1</parameter>
<parameter name="sql">SELECT 1</parameter>
<parameter name="type">bar</parameter>
</invoke>
</function_calls>`;
  const rescued = rescueXmlToolCalls(text, known);
  assert.equal(rescued.calls.length, 1);
  assert.equal(rescued.calls[0].name, 'render_chart');
  assert.equal(rescued.calls[0].args.connectionId, 'c1');
  assert.equal(rescued.calls[0].args.sql, 'SELECT 1');
  assert.equal(rescued.text, '我先画个图。');
});

test('still rescues when the model forgets the closing tags', () => {
  const text = `<function_calls>
<invoke name="render_chart">
<parameter name="connectionId">c1</parameter>
<parameter name="sql">SELECT 2</parameter>
<parameter name="title">月度新增量`;
  const rescued = rescueXmlToolCalls(text, known);
  assert.equal(rescued.calls.length, 1);
  assert.equal(rescued.calls[0].args.sql, 'SELECT 2');
  assert.equal(rescued.text, '');
});

test('ignores unknown tools, fenced examples and plain text', () => {
  assert.equal(rescueXmlToolCalls('<invoke name="drop_everything"><parameter name="x">1</parameter></invoke>', known).calls.length, 0);
  assert.equal(rescueXmlToolCalls('示例：\n```xml\n<invoke name="run_sql"><parameter name="sql">SELECT 1</parameter></invoke>\n```', known).calls.length, 0);
  assert.equal(rescueXmlToolCalls('普通回答，没有任何调用', known).calls.length, 0);
});
