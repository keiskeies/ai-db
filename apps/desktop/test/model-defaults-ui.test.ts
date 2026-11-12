import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_OUTPUT_TOKENS, formatTokenSize } from '@aidb/core';

/**
 * 「输入框里显示的默认值」与「参与计算的默认值」必须是同一个来源。
 *
 * 这条约束存在的理由：设置页曾经把 `256K` / `32K` 写成 `placeholder` 字面量，而 core
 * 那边「没填档案」走的是另一套死值（结果预算 16000 字符、max_tokens 4096、中途压缩
 * 关闭）。界面对用户承诺了一个数，代码用的是另一个数——用户照着提示理解行为，就会
 * 理解错。现在两边都只能引用 core 的那两个常数，这里用源码断言钉住：
 * 谁再把字面量塞回输入框，或者把预填值改回空串，这条就红。
 */

const here = dirname(fileURLToPath(import.meta.url));
// test/ → desktop/ → apps/ → 仓库根
const root = resolve(here, '../../..');const source = (rel: string) => readFileSync(join(root, rel), 'utf8');

const settingsModal = source('apps/desktop/src/components/SettingsModal.tsx');
const agentPanel = source('apps/desktop/src/components/AgentPanel.tsx');

/** 取某个 data-testid 所在的那一块 JSX（往后截到最近的自闭合标签结束）。 */
function inputBlock(testId: string): string {
  const marker = `data-testid="${testId}"`;
  const index = settingsModal.indexOf(marker);
  assert.notEqual(index, -1, `找不到 ${marker}`);
  const start = settingsModal.lastIndexOf('<input', index);
  const end = settingsModal.indexOf('/>', index);
  assert.ok(start >= 0 && end > index, `${testId} 的 <input> 形状不符合预期`);
  return settingsModal.slice(start, end);
}

test('上下文窗口输入框预填 core 的默认档位，而不是留空加提示', () => {
  const block = inputBlock('model-context-window');
  assert.match(block, /defaultValue=\{formatTokenSize\(contextWindowOf\(profile\)\)\}/, '预填值必须走 contextWindowOf，与预算计算同一个解析');
  assert.match(block, /placeholder=\{formatTokenSize\(DEFAULT_CONTEXT_WINDOW\)\}/, '占位文案必须由常数算出');
  assert.ok(!/placeholder="256K"/.test(block), '占位文案不许再写字面量：常数一改就会和实际默认值脱节');
});

test('最大输出输入框同样由常数预填', () => {
  const block = inputBlock('model-max-output');
  assert.match(block, /profile\?\.maxOutputTokens \?\? DEFAULT_MAX_OUTPUT_TOKENS/, '没填时输入框显示默认档位');
  assert.match(block, /placeholder=\{formatTokenSize\(DEFAULT_MAX_OUTPUT_TOKENS\)\}/);
  assert.ok(!/placeholder="32K"/.test(block), '同上');
});

test('预填出来的字面就是那两个默认值', () => {
  // 界面上写 "256K"/"32K"，core 里就得是 262144/32768；写歪一位这里就会红，
  // 而不是等用户去猜「我填的 256K 到底生效了没」。
  assert.equal(formatTokenSize(DEFAULT_CONTEXT_WINDOW), '256K');
  assert.equal(formatTokenSize(DEFAULT_MAX_OUTPUT_TOKENS), '32K');
});

test('上下文占用读数用生效窗口，不用原始档案值', () => {
  assert.match(
    agentPanel,
    /contextWindow=\{contextWindowOf\(profile\)\}/,
    '预算按默认档位算，占用百分比也必须按同一个窗口算，否则界面显示「无窗口」而实际在压缩',
  );
});
