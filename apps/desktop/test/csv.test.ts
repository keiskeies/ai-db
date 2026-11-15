import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, toCsv } from '../src/lib/csv';

test('parseCsv splits plain rows and strips the UTF-8 BOM', () => {
  assert.deepEqual(parseCsv('﻿kind,title,content\nglossary,JS,JumpServer\n'), [
    ['kind', 'title', 'content'],
    ['glossary', 'JS', 'JumpServer'],
  ]);
});

test('parseCsv handles quoted commas, escaped quotes and embedded newlines', () => {
  const text = 'a,"b,c","say ""hi""","line1\nline2"\r\nd,e,f,g';
  assert.deepEqual(parseCsv(text), [
    ['a', 'b,c', 'say "hi"', 'line1\nline2'],
    ['d', 'e', 'f', 'g'],
  ]);
});

test('parseCsv skips empty and whitespace-only rows but keeps partially empty ones', () => {
  assert.deepEqual(parseCsv('a,b\n\n  ,\nc,\n'), [
    ['a', 'b'],
    ['c', ''],
  ]);
});

test('parseCsv tolerates a missing trailing newline and CRLF inside quotes', () => {
  assert.deepEqual(parseCsv('"x\r\ny",z'), [['x\r\ny', 'z']]);
  assert.deepEqual(parseCsv('a,b'), [['a', 'b']]);
});

test('toCsv escapes only when required and doubles quotes', () => {
  assert.equal(toCsv([['plain', 'with,comma', 'with"quote', 'with\nnewline']]), 'plain,"with,comma","with""quote","with\nnewline"');
});

test('roundtrip preserves every cell including CRLF and unicode', () => {
  const rows = [
    ['kind', 'title', 'content', 'synonyms'],
    ['glossary', 'JS', 'JumpServer 堡垒机', '堡垒机;跳板机'],
    ['sql_example', '季度,赢单', 'SELECT COUNT(*)\r\nFROM orders WHERE status = "won"', ''],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
  assert.deepEqual(parseCsv('﻿' + toCsv(rows) + '\r\n'), rows);
});