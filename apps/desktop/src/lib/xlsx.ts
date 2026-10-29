import { rowsToCsv } from './importConvert';

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（缺少 ZIP 目录）');
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const chunk = bytes.slice(start, start + compressedSize);
    files.set(name, method === 0 ? chunk : await inflateRaw(chunk));
  }
  return files;
}

function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0] ?? 'A';
  let index = 0;
  for (const char of letters.toUpperCase()) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

/** 读取第一个工作表的单元格，输出与 CSV 导入向导兼容的表头和行。 */
export async function xlsxToCsv(buffer: ArrayBuffer): Promise<string> {
  const files = await unzip(buffer);
  const textOf = (name: string) => {
    const data = files.get(name);
    return data ? new TextDecoder().decode(data) : '';
  };
  const sheetName = [...files.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))[0];
  if (!sheetName) throw new Error('xlsx 里没有工作表');
  const parser = new DOMParser();
  const sheet = parser.parseFromString(textOf(sheetName), 'application/xml');
  if (sheet.querySelector('parsererror')) throw new Error('xlsx 工作表解析失败');
  const shared = parser.parseFromString(textOf('xl/sharedStrings.xml') || '<sst/>', 'application/xml');
  const sharedStrings = [...shared.getElementsByTagName('si')].map((si) => [...si.getElementsByTagName('t')].map((node) => node.textContent ?? '').join(''));
  const rows: string[][] = [];
  for (const row of [...sheet.getElementsByTagName('row')]) {
    const cells: string[] = [];
    for (const cell of [...row.getElementsByTagName('c')]) {
      const index = cell.getAttribute('r') ? columnIndex(cell.getAttribute('r') as string) : cells.length;
      const type = cell.getAttribute('t') ?? '';
      let value = '';
      if (type === 's') {
        value = sharedStrings[Number(cell.getElementsByTagName('v')[0]?.textContent ?? '-1')] ?? '';
      } else if (type === 'inlineStr') {
        value = [...cell.getElementsByTagName('t')].map((node) => node.textContent ?? '').join('');
      } else if (type === 'b') {
        value = cell.getElementsByTagName('v')[0]?.textContent === '1' ? 'TRUE' : 'FALSE';
      } else {
        value = cell.getElementsByTagName('v')[0]?.textContent ?? '';
      }
      while (cells.length < index) cells.push('');
      cells[index] = value;
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
  }
  if (!rows.length) throw new Error('xlsx 工作表没有数据');
  const width = Math.max(...rows.map((row) => row.length));
  return rowsToCsv(rows.map((row) => [...row, ...Array.from({ length: width - row.length }, () => '')]));
}
