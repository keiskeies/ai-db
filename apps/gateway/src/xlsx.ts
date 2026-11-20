import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { deflateRaw } from 'node:zlib';
import { escapeCsv, neutralizeFormula, toSqlInserts, type ExportInput, type XlsxSheet } from './exportFormat';

export type { XlsxSheet } from './exportFormat';

// 等价 zlib.promises.deflateRaw：tsx/esbuild 的 CJS interop 不会把 node:zlib 上惰性的
// promises getter 拷到默认导入对象上，直接 promisify 回调版，行为一致（都走 libuv 线程池）。
const deflateRawAsync = promisify(deflateRaw);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function escapeXml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cellRef(index: number, row: number): string {
  let value = index + 1;
  let letters = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return `${letters}${row}`;
}

function cellXml(value: unknown, ref: string): string {
  const open = `<c r="${ref}"`;
  if (value === null || value === undefined) return `${open}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `${open}><v>${value}</v></c>`;
  if (typeof value === 'bigint') return `${open}><v>${value.toString()}</v></c>`;
  if (typeof value === 'boolean') return `${open} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `${open} t="inlineStr"><is><t xml:space="preserve">${escapeXml(neutralizeFormula(String(value)))}</t></is></c>`;
}

/** 每攒够一批行就落成 Buffer，避免 20 万行时「逐行字符串数组 + 整体 join + Buffer 拷贝」多份峰值内存。 */
const SHEET_CHUNK_ROWS = 2000;
/** 文本格式导出的分批写入行数：批与批之间让出事件循环，导出不再一次性占住主线程。 */
const EXPORT_BATCH_ROWS = 1000;

async function buildSheetXml(sheet: XlsxSheet): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let pending =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  pending += `<row r="1">${sheet.columns.map((column, position) => cellXml(column, cellRef(position, 1))).join('')}</row>`;
  for (let i = 0; i < sheet.rows.length; i += 1) {
    const row = sheet.rows[i] ?? [];
    const r = i + 2;
    pending += `<row r="${r}">${row.map((value, position) => cellXml(value, cellRef(position, r))).join('')}</row>`;
    if ((i + 1) % SHEET_CHUNK_ROWS === 0) {
      chunks.push(Buffer.from(pending, 'utf8'));
      pending = '';
      // 大表构建是纯 CPU 同步操作，定期让出事件循环，避免长导出饿死其它请求。
      if ((i + 1) % (SHEET_CHUNK_ROWS * 10) === 0) await new Promise((resolve) => setImmediate(resolve));
    }
  }
  pending += '</sheetData></worksheet>';
  chunks.push(Buffer.from(pending, 'utf8'));
  return Buffer.concat(chunks);
}

/**
 * 顺序写入 zip 条目：deflate 走 zlib 线程池（异步），且每个条目压缩完即释放原始数据，
 * 峰值内存 ≈ 已压缩部分 + 单个未压缩条目，而不是整本工作簿的原始 XML。
 */
class ZipWriter {
  private parts: Buffer[] = [];
  private central: Buffer[] = [];
  private offset = 0;
  private count = 0;

  async add(name: string, content: string | Buffer): Promise<void> {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const compressed = await deflateRawAsync(data);
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    this.parts.push(local, nameBuf, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(this.offset, 42);
    this.central.push(entry, nameBuf);
    this.offset += local.length + nameBuf.length + compressed.length;
    this.count += 1;
  }

  finish(): Buffer {
    const centralBuf = Buffer.concat(this.central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(this.count, 8);
    eocd.writeUInt16LE(this.count, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(this.offset, 16);
    return Buffer.concat([...this.parts, centralBuf, eocd]);
  }
}

export async function toXlsx(columns: string[], rows: unknown[][]): Promise<Buffer> {
  return toXlsxSheets([{ name: 'Sheet1', columns, rows }]);
}

/**
 * 多 sheet 工作簿。报告的表格块各占一张表：
 * 把表格压成「章节 | 类型 | 内容」三列再拼上 `a | b | c`，业务读者就没法拿去用了。
 */
export async function toXlsxSheets(sheets: XlsxSheet[]): Promise<Buffer> {
  const safe = (name: string, index: number): string => {
    const cleaned = String(name ?? '').replace(/[\\/:*?[\]]/g, ' ').trim().slice(0, 31);
    return cleaned || `Sheet${index + 1}`;
  };
  // 同名 sheet 会让 Excel 直接拒绝打开，重名时加序号。
  const names: string[] = [];
  const used = new Map<string, number>();
  sheets.forEach((sheet, index) => {
    const base = safe(sheet.name, index);
    const count = used.get(base.toLowerCase()) ?? 0;
    used.set(base.toLowerCase(), count + 1);
    names.push(count ? `${base.slice(0, 27)} (${count + 1})` : base);
  });

  const overrides = sheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const sheetEntries = names
    .map((name, index) => `<sheet name="${escapeXml(name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  const relationships = sheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');

  const writer = new ZipWriter();
  await writer.add(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      overrides +
      '</Types>',
  );
  await writer.add(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  );
  await writer.add(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
  );
  await writer.add(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
  );
  for (let index = 0; index < sheets.length; index += 1) {
    // 逐 sheet「构建 → 压缩 → 释放」，多 sheet 大表也不会同时驻留所有原始 XML。
    const xml = await buildSheetXml(sheets[index]!);
    await writer.add(`xl/worksheets/sheet${index + 1}.xml`, xml);
  }
  return writer.finish();
}

/**
 * 契约 K4：导出直接落盘，返回元数据（不再把整份文件内容驻留内存 / 返回大 Buffer）。
 * 文本格式分批写文件；xlsx 由异步压缩生成。调用方（routes/executor/commands）需 await。
 */
export async function writeExportFile(input: ExportInput): Promise<{ path: string; bytes: number; rows: number }> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeBase = (input.baseName || input.tableName || 'query').replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40);
  const filePath = join(input.dir, `${safeBase}-${stamp}.${input.format}`);
  const rowCount = input.sheets?.length ? input.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0) : input.rows.length;

  if (input.format === 'xlsx') {
    const buffer = input.sheets?.length ? await toXlsxSheets(input.sheets) : await toXlsx(input.columns, input.rows);
    await fsp.writeFile(filePath, buffer);
  } else {
    const handle = await fsp.open(filePath, 'w');
    try {
      if (input.format === 'csv') {
        await handle.writeFile('\uFEFF' + input.columns.map(escapeCsv).join(',') + '\r\n');
        for (let i = 0; i < input.rows.length; i += EXPORT_BATCH_ROWS) {
          const batch = input.rows.slice(i, i + EXPORT_BATCH_ROWS);
          await handle.writeFile(batch.map((row) => row.map(escapeCsv).join(',')).join('\r\n') + '\r\n');
        }
      } else if (input.format === 'xml') {
        const tag = (value: string) => {
          const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, '_');
          return /^[A-Za-z_]/.test(cleaned) ? cleaned : `col_${cleaned}`;
        };
        await handle.writeFile('<?xml version="1.0" encoding="UTF-8"?>\n<rows>\n');
        for (let i = 0; i < input.rows.length; i += EXPORT_BATCH_ROWS) {
          const batch = input.rows.slice(i, i + EXPORT_BATCH_ROWS);
          const xmlRows = batch
            .map((row) => '  <row>' + input.columns.map((column, index) => `<${tag(column)}>${escapeXml(row[index])}</${tag(column)}>`).join('') + '</row>')
            .join('\n');
          await handle.writeFile(xmlRows + '\n');
        }
        if (!input.rows.length) await handle.writeFile('\n');
        await handle.writeFile('</rows>\n');
      } else if (input.format === 'json') {
        if (!input.rows.length) {
          await handle.writeFile('[]');
        } else {
          await handle.writeFile('[\n');
          for (let i = 0; i < input.rows.length; i += EXPORT_BATCH_ROWS) {
            const batch = input.rows.slice(i, i + EXPORT_BATCH_ROWS);
            const text = batch
              .map((row) => '  ' + JSON.stringify(Object.fromEntries(input.columns.map((c, index) => [c, row[index] === undefined ? null : row[index]]))))
              .join(',\n');
            const hasMore = i + EXPORT_BATCH_ROWS < input.rows.length;
            await handle.writeFile(text + (hasMore ? ',\n' : '\n'));
          }
          await handle.writeFile(']');
        }
      } else {
        await handle.writeFile(`-- AiDB Studio export (${new Date().toISOString()})\n`);
        for (let i = 0; i < input.rows.length; i += EXPORT_BATCH_ROWS) {
          const batch = input.rows.slice(i, i + EXPORT_BATCH_ROWS);
          await handle.writeFile(toSqlInserts(input.engine, input.tableName || 'exported_data', input.columns, batch) + '\n');
        }
        if (!input.rows.length) await handle.writeFile('\n');
      }
    } finally {
      await handle.close();
    }
  }
  const stat = await fsp.stat(filePath);
  return { path: filePath, bytes: stat.size, rows: rowCount };
}