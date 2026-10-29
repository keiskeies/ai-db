import { rowsToCsv } from './importConvert';

const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

interface CfbEntry {
  name: string;
  type: number;
  start: number;
  size: number;
}

function u16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function u32(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function rkValue(rk: number): number {
  let value: number;
  if ((rk & 0x02) !== 0) value = (rk | 0) >> 2;
  else {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setUint32(0, rk & 0xfffffffc, false);
    value = view.getFloat64(0, false);
  }
  return (rk & 0x01) !== 0 ? value / 100 : value;
}

function biffText(data: Uint8Array, offset: number): string {
  const length = u16(data, offset);
  const flags = data[offset + 2];
  const start = offset + 3;
  if ((flags & 0x01) === 0) {
    let text = '';
    for (let i = 0; i < length; i += 1) text += String.fromCharCode(data[start + i]);
    return text;
  }
  return new TextDecoder('utf-16le').decode(data.subarray(start, start + length * 2));
}

function parseWorkbook(workbook: Uint8Array): string {
  const records: Array<{ id: number; data: Uint8Array }> = [];
  for (let offset = 0; offset + 4 <= workbook.length; ) {
    const id = u16(workbook, offset);
    const length = u16(workbook, offset + 2);
    records.push({ id, data: workbook.subarray(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  const sharedStrings: string[] = [];
  for (const record of records) {
    if (record.id !== 0x00fc) continue;
    const unique = u32(record.data, 4);
    let offset = 8;
    while (sharedStrings.length < unique && offset + 3 <= record.data.length) {
      const length = u16(record.data, offset);
      const flags = record.data[offset + 2];
      const start = offset + 3;
      if ((flags & 0x01) !== 0) {
        sharedStrings.push(new TextDecoder('utf-16le').decode(record.data.subarray(start, start + length * 2)));
        offset = start + length * 2;
      } else {
        let text = '';
        for (let i = 0; i < length; i += 1) text += String.fromCharCode(record.data[start + i]);
        sharedStrings.push(text);
        offset = start + length;
      }
    }
    break;
  }

  const cells = new Map<number, Map<number, string>>();
  let inSheet = false;
  const setCell = (row: number, column: number, value: string) => {
    if (!cells.has(row)) cells.set(row, new Map());
    cells.get(row)?.set(column, value);
  };
  for (const record of records) {
    const data = record.data;
    if (record.id === 0x0809) {
      const type = u16(data, 2);
      if (type === 0x0010) inSheet = true;
      else if (inSheet) break;
      continue;
    }
    if (!inSheet) continue;
    if (record.id === 0x000a) break;
    if (record.id === 0x00fd && data.length >= 10) {
      setCell(u16(data, 0), u16(data, 2), sharedStrings[u32(data, 6)] ?? '');
    } else if (record.id === 0x0204 && data.length >= 8) {
      setCell(u16(data, 0), u16(data, 2), biffText(data, 6));
    } else if (record.id === 0x0203 && data.length >= 14) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      setCell(u16(data, 0), u16(data, 2), String(view.getFloat64(6, true)));
    } else if (record.id === 0x027e && data.length >= 10) {
      setCell(u16(data, 0), u16(data, 2), String(rkValue(u32(data, 6))));
    } else if (record.id === 0x00bd && data.length >= 12) {
      const row = u16(data, 0);
      const first = u16(data, 2);
      const count = Math.floor((data.length - 6) / 6);
      for (let i = 0; i < count; i += 1) setCell(row, first + i, String(rkValue(u32(data, 4 + i * 6 + 2))));
    } else if (record.id === 0x0205 && data.length >= 8) {
      const value = data[6] ? 'TRUE' : 'FALSE';
      setCell(u16(data, 0), u16(data, 2), data[7] ? '#ERR' : value);
    } else if (record.id === 0x0006 && data.length >= 14) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const marker = u16(data, 6);
      if (marker === 0xffff) {
        if (data[8] === 0x00 && data.length >= 12) {
          setCell(u16(data, 0), u16(data, 2), biffText(data, 12));
        } else {
          setCell(u16(data, 0), u16(data, 2), data[8] === 0x01 ? (data[10] ? 'TRUE' : 'FALSE') : '#ERR');
        }
      } else {
        setCell(u16(data, 0), u16(data, 2), String(view.getFloat64(6, true)));
      }
    }
  }
  if (!cells.size) throw new Error('.xls 工作表没有数据');
  const rows: string[][] = [];
  for (const row of [...cells.keys()].sort((a, b) => a - b)) {
    const values = cells.get(row) as Map<number, string>;
    const width = Math.max(...values.keys()) + 1;
    rows.push(Array.from({ length: width }, (_, index) => values.get(index) ?? ''));
  }
  return rowsToCsv(rows);
}

/** 读取 BIFF8 (.xls) 的第一个工作表；仅支持 CFB/BIFF8，老 BIFF5 会明确报错。 */
export function xlsToCsv(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 512 || view.getUint32(0, true) !== 0xe011cfd0) throw new Error('不是有效的 .xls（CFB 头不匹配）');
  const sectorSize = 1 << view.getUint16(30, true);
  const miniSize = 1 << view.getUint16(32, true);
  const numFat = view.getUint32(44, true);
  const dirStart = view.getUint32(48, true);
  const miniCutoff = view.getUint32(56, true);
  const miniFatStart = view.getUint32(60, true);
  const numMiniFat = view.getUint32(64, true);
  const difatStart = view.getUint32(68, true);
  const numDifat = view.getUint32(72, true);
  const sectorOffset = (id: number) => 512 + id * sectorSize;

  const difat: number[] = [];
  for (let i = 0; i < 109; i += 1) {
    const id = view.getUint32(76 + i * 4, true);
    if (id !== FREE_SECTOR) difat.push(id);
  }
  let difatSector = difatStart;
  for (let i = 0; i < numDifat && difatSector !== END_OF_CHAIN && difatSector !== FREE_SECTOR; i += 1) {
    const offset = sectorOffset(difatSector);
    const perSector = sectorSize / 4 - 1;
    for (let j = 0; j < perSector; j += 1) {
      const id = view.getUint32(offset + j * 4, true);
      if (id !== FREE_SECTOR) difat.push(id);
    }
    difatSector = view.getUint32(offset + perSector * 4, true);
  }
  const fat: number[] = [];
  for (const id of difat.slice(0, numFat)) {
    const offset = sectorOffset(id);
    for (let j = 0; j < sectorSize / 4; j += 1) fat.push(view.getUint32(offset + j * 4, true));
  }
  const readChain = (start: number, table: number[], source: Uint8Array, offsetOf: (id: number) => number, step: number): Uint8Array => {
    const chunks: Uint8Array[] = [];
    const seen = new Set<number>();
    let id = start;
    while (id !== END_OF_CHAIN && id !== FREE_SECTOR && id < table.length && !seen.has(id)) {
      seen.add(id);
      chunks.push(source.subarray(offsetOf(id), offsetOf(id) + step));
      id = table[id];
    }
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  };
  const directory = readChain(dirStart, fat, bytes, sectorOffset, sectorSize);
  const entries: CfbEntry[] = [];
  for (let offset = 0; offset + 128 <= directory.length; offset += 128) {
    const nameLength = u16(directory, offset + 64);
    if (!nameLength) continue;
    const name = new TextDecoder('utf-16le').decode(directory.subarray(offset, offset + Math.max(0, nameLength - 2)));
    entries.push({ name, type: directory[offset + 66], start: u32(directory, offset + 116), size: u32(directory, offset + 120) });
  }
  const root = entries.find((entry) => entry.type === 5);
  const workbookEntry = entries.find((entry) => entry.type === 2 && (entry.name === 'Workbook' || entry.name === 'Book'));
  if (!workbookEntry) throw new Error('.xls 里没有 Workbook 流（旧版 BIFF5 暂不支持）');
  let workbook: Uint8Array;
  if (workbookEntry.size >= miniCutoff) {
    workbook = readChain(workbookEntry.start, fat, bytes, sectorOffset, sectorSize).subarray(0, workbookEntry.size);
  } else {
    const miniStream = root ? readChain(root.start, fat, bytes, sectorOffset, sectorSize) : new Uint8Array();
    const miniFatRaw = numMiniFat ? readChain(miniFatStart, fat, bytes, sectorOffset, sectorSize) : new Uint8Array();
    const miniFat: number[] = [];
    for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) miniFat.push(u32(miniFatRaw, i));
    const chunks = readChain(workbookEntry.start, miniFat, miniStream, (id) => id * miniSize, miniSize);
    workbook = chunks.subarray(0, workbookEntry.size);
  }
  return parseWorkbook(workbook);
}
