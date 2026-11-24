import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import AdmZip from 'adm-zip';
import { toXlsx, toXlsxSheets, writeExportFile } from '../src/xlsx';

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

test('toXlsxSheets 产出真正多 sheet 的工作簿', async () => {
  const zip = await toXlsxSheets([
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

test('重名与非法字符的 sheet 名被修掉', async () => {
  const book = inspect(
    await toXlsxSheets([
      { name: 'A/B', columns: ['x'], rows: [[1]] },
      { name: 'A/B', columns: ['x'], rows: [[2]] },
      { name: '   ', columns: ['x'], rows: [[3]] },
    ]),
  );
  assert.deepEqual(book.names, ['A B', 'A B (2)', 'Sheet3']);
});

test('sheet 名不超过 Excel 的 31 字符上限', async () => {
  const long = '渠道明细统计口径说明补充标题长度超过三十个字符上限的部分应当被截断掉才对';
  const book = inspect(await toXlsxSheets([{ name: long, columns: ['x'], rows: [[1]] }]));
  assert.equal(book.names[0]?.length, 31);
});

test('单表导出与多 sheet 共用同一个写入器', async () => {
  const book = inspect(await toXlsx(['列', '数值'], [['值', 7], [null, null]]));
  assert.equal(book.sheetData.length, 1);
  assert.match(book.sheetData[0] ?? '', /值/);
  assert.match(book.sheetData[0] ?? '', /<v>7<\/v>/);
  // 空单元格写空标签，而不是写出 "null" 文本。
  assert.doesNotMatch(book.sheetData[0] ?? '', /null/);
});

test('导出单元格公式注入被中和：= + @ - 开头转为纯文本', async () => {
  const zip = await toXlsx(['值'], [['=SUM(A1:A999)'], ['+1+2'], ['@cmd'], ['-1'], ['正常文本'], [5]]);
  const sheet = inspect(zip).sheetData[0] ?? '';
  // 中和后值以 ' 开头，公式不再被执行；正常文本与数值原样保留。
  assert.match(sheet, /'=SUM\(A1:A999\)/, '= 前缀应被中和');
  assert.match(sheet, /'\+1\+2/, '+ 前缀应被中和');
  assert.match(sheet, /'@cmd/, '@ 前缀应被中和');
  assert.match(sheet, /'-1/, '- 前缀应被中和');
  assert.match(sheet, /正常文本/);
  assert.match(sheet, />5</, '数值不应被破坏');
  assert.doesNotMatch(sheet, /<v>=/, '中和后的值不应再进入公式节点');
});

test('大表分块构建后仍是合法工作簿（跨 chunk 边界行号连续）', async () => {
  // 行数跨过 2000 行的分块阈值，验证分块拼接没有丢行 / 错行号。
  const rows = Array.from({ length: 4321 }, (_, i) => [i, `行${i}`]);
  const book = inspect(await toXlsx(['n', 'label'], rows));
  const sheet = book.sheetData[0] ?? '';
  assert.match(sheet, /<row r="2">/);
  assert.match(sheet, /<row r="2001">/);
  assert.match(sheet, /<row r="4322">/);
  assert.equal((sheet.match(/<row /g) ?? []).length, rows.length + 1);
});

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aidb-xlsx-'));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test('writeExportFile 异步落盘 xlsx 并返回元数据（契约 K4）', () =>
  withDir(async (dir) => {
    const file = await writeExportFile({
      dir,
      format: 'xlsx',
      columns: ['a', 'b'],
      rows: [[1, 'x'], [2, 'y']],
      tableName: '订单',
      engine: 'sqlite',
    });
    assert.ok(file.path.startsWith(dir));
    assert.ok(file.path.endsWith('.xlsx'));
    assert.equal(file.rows, 2);
    assert.equal(file.bytes, readFileSync(file.path).length);
    const book = inspect(readFileSync(file.path));
    assert.match(book.sheetData[0] ?? '', /<v>1<\/v>/);
  }));

test('writeExportFile 多 sheet 元数据 rows 为各 sheet 行数之和', () =>
  withDir(async (dir) => {
    const file = await writeExportFile({
      dir,
      format: 'xlsx',
      columns: [],
      rows: [],
      engine: 'sqlite',
      sheets: [
        { name: 's1', columns: ['a'], rows: [[1], [2]] },
        { name: 's2', columns: ['b'], rows: [[3]] },
      ],
    });
    assert.equal(file.rows, 3);
    assert.equal(inspect(readFileSync(file.path)).sheetData.length, 2);
  }));

test('writeExportFile csv/json/xml/sql 分批落盘内容可解析', () =>
  withDir(async (dir) => {
    const columns = ['id', 'name'];
    // 跨过 1000 行分批阈值，验证批边界没有丢行 / 多分隔符。
    const rows = Array.from({ length: 2500 }, (_, i) => [i, `名,称"${i}`]);
    const csv = await writeExportFile({ dir, format: 'csv', columns, rows, engine: 'sqlite' });
    const csvText = readFileSync(csv.path, 'utf8');
    assert.ok(csvText.startsWith('\uFEFFid,name\r\n'));
    assert.equal(csvText.split('\r\n').filter((line) => line !== '').length, rows.length + 1);
    assert.equal(csv.rows, 2500);

    const json = await writeExportFile({ dir, format: 'json', columns, rows, engine: 'sqlite' });
    const parsed = JSON.parse(readFileSync(json.path, 'utf8')) as Array<{ id: number; name: string }>;
    assert.equal(parsed.length, 2500);
    assert.equal(parsed[2499]?.name, '名,称"2499');

    const xml = await writeExportFile({ dir, format: 'xml', columns, rows, engine: 'sqlite' });
    const xmlText = readFileSync(xml.path, 'utf8');
    assert.equal((xmlText.match(/<row>/g) ?? []).length, 2500);
    assert.ok(xmlText.endsWith('</rows>\n'));

    const sql = await writeExportFile({ dir, format: 'sql', columns, rows, tableName: 't', engine: 'sqlite' });
    const sqlText = readFileSync(sql.path, 'utf8');
    assert.equal((sqlText.match(/INSERT INTO/g) ?? []).length, 2500);
  }));

test('writeExportFile 并发同名导出使用不同文件，取消任务不删他人产物', () =>
  withDir(async (dir) => {
    const input = { dir, format: 'csv' as const, columns: ['id'], rows: [[1], [2]], tableName: 'same', engine: 'sqlite' as const };
    const [first, second] = await Promise.all([writeExportFile(input), writeExportFile(input)]);
    assert.notEqual(first.path, second.path);
    assert.equal(readFileSync(first.path, 'utf8'), readFileSync(second.path, 'utf8'));

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(writeExportFile({ ...input, signal: controller.signal }), { code: 'ABORTED' });
    assert.deepEqual(readdirSync(dir).sort(), [basename(first.path), basename(second.path)].sort());
    assert.ok(readdirSync(dir).every((name) => !name.endsWith('.tmp')));
    assert.equal(existsSync(first.path), true);
  }));

test('writeExportFile 空结果集各格式仍产出合法文件', () =>
  withDir(async (dir) => {
    const json = await writeExportFile({ dir, format: 'json', columns: ['a'], rows: [], engine: 'sqlite' });
    assert.deepEqual(JSON.parse(readFileSync(json.path, 'utf8')), []);
    const csv = await writeExportFile({ dir, format: 'csv', columns: ['a'], rows: [], engine: 'sqlite' });
    assert.equal(readFileSync(csv.path, 'utf8'), '\uFEFFa\r\n');
    const xlsx = await writeExportFile({ dir, format: 'xlsx', columns: ['a'], rows: [], engine: 'sqlite' });
    assert.equal(xlsx.rows, 0);
    assert.equal(inspect(readFileSync(xlsx.path)).sheetData.length, 1);
  }));