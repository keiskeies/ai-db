export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function rowsToCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n');
}

export function jsonToCsv(text: string): string {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { rows?: unknown[] })?.rows)
      ? (parsed as { rows: unknown[] }).rows
      : [parsed];
  if (!list.length) throw new Error('JSON 没有记录');
  if (Array.isArray(list[0])) return rowsToCsv(list as unknown[][]);
  const records = list as Array<Record<string, unknown>>;
  const headers = [...new Set(records.flatMap((row) => Object.keys(row ?? {})))];
  if (!headers.length) throw new Error('JSON 记录没有字段');
  return rowsToCsv([headers, ...records.map((row) => headers.map((key) => row?.[key]))]);
}

export function xmlToCsv(text: string): string {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML 解析失败');
  let records: Element[] = [];
  for (const tag of ['row', 'record', 'item']) {
    const found = [...doc.getElementsByTagName(tag)].filter((element) => element.children.length);
    if (found.length > records.length) records = found;
  }
  if (records.length) {
    const headers = [...new Set(records.flatMap((record) => [...record.children].map((child) => child.tagName)))];
    const rows = records.map((record) => headers.map((tag) => [...record.children].find((child) => child.tagName === tag)?.textContent ?? ''));
    return rowsToCsv([headers, ...rows]);
  }
  // Excel 2003 XML Spreadsheet：<Worksheet><Table><Row><Cell><Data>
  const spreadsheetRows = [...doc.getElementsByTagName('Row')].filter((row) => row.getElementsByTagName('Cell').length);
  if (!spreadsheetRows.length) throw new Error('XML 里没有 <row>/<record>/<item> 或 Excel SpreadsheetML <Row> 记录');
  const table = spreadsheetRows.map((row) => {
    const cells: string[] = [];
    for (const cell of [...row.getElementsByTagName('Cell')]) {
      const indexAttr = cell.getAttribute('ss:Index') ?? cell.getAttributeNS('urn:schemas-microsoft-com:office:spreadsheet', 'Index');
      const index = indexAttr ? Number(indexAttr) - 1 : cells.length;
      while (cells.length < index) cells.push('');
      cells[index] = cell.getElementsByTagName('Data')[0]?.textContent ?? '';
    }
    return cells;
  });
  return rowsToCsv(table);
}
