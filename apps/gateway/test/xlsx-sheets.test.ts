import test from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { toXlsx, toXlsxSheets } from '../src/xlsx';

/** 解出工作簿：sheet 名在 workbook.xml，单元格在各 sheetN.xml。 */
function inspect(zip: Buffer) {
  const archive = new AdmZip(zip);
  const entries = new Map(archive.getEntries().map((entry) => [entry.entryName, entry.getData().toString('utf8')]));
  const workbook = entries.get('xl/workbook.xml') ?? '';
  return {
    entries,
    workbook,
    names: [...workbook.matchAll(/name="([^"]*)"/g)].map((match) => match[1]),
    sheetData: [...entries.keys()]
      .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
      .sort()
      .map((name) => entries.get(name) ?? ''),
  };
}

test('toXlsxSheets 产出真正多 sheet 的工作簿', () => {
  const zip = toXlsxSheets([
    { name: '管理层摘要', columns: ['章节', '内容'], rows: [['概览', '订单量上涨']] },
    { name: '渠道明细', columns: ['渠道', '单量'], rows: [['广告', 10], ['自然', 5.5]] },
  ]);
  const book = inspect(zip);
  assert.deepEqual(book.names, ['管理层摘要', '渠道明细']);
  assert.equal(book.sheetData.length, 2);
  assert.match(book.sheetData[1] ?? '', /广告/);
  // 数字必须是数值单元格，Excel 才能求和 / 透视。
  assert.match(book.sheetData[1] ?? '', /<v>5\.5<\/v>/);
  // 每个 sheet 都要在 content types 与 rels 里各登记一次，否则 Excel 拒绝打开。
  const types = book.entries.get('[Content_Types].xml') ?? '';
  const rels = book.entries.get('xl/_rels/workbook.xml.rels') ?? '';
  assert.equal((types.match(/worksheets\/sheet2\.xml/g) ?? []).length, 1);
  assert.equal((rels.match(/worksheets\/sheet2\.xml/g) ?? []).length, 1);
});

test('重名与非法字符的 sheet 名被修掉', () => {
  const book = inspect(
    toXlsxSheets([
      { name: 'A/B', columns: ['x'], rows: [[1]] },
      { name: 'A/B', columns: ['x'], rows: [[2]] },
      { name: '   ', columns: ['x'], rows: [[3]] },
    ]),
  );
  assert.deepEqual(book.names, ['A B', 'A B (2)', 'Sheet3']);
});

test('sheet 名不超过 Excel 的 31 字符上限', () => {
  const long = '渠道明细统计口径说明补充标题长度超过三十个字符上限的部分应当被截断掉才对';
  const book = inspect(toXlsxSheets([{ name: long, columns: ['x'], rows: [[1]] }]));
  assert.equal(book.names[0]?.length, 31);
});

test('单表导出与多 sheet 共用同一个写入器', () => {
  const book = inspect(toXlsx(['列', '数值'], [['值', 7], [null, null]]));
  assert.equal(book.sheetData.length, 1);
  assert.match(book.sheetData[0] ?? '', /值/);
  assert.match(book.sheetData[0] ?? '', /<v>7<\/v>/);
  // 空单元格写空标签，而不是写出 "null" 文本。
  assert.doesNotMatch(book.sheetData[0] ?? '', /null/);
});
