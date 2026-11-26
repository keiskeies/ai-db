import { useMemo } from 'react';
import { Platform, ScrollView, View } from 'react-native';
import * as Linking from 'expo-linking';
import { colors } from '../theme';
import { styles } from '../styles';
import { Text } from './base';

type MdAlign = 'left' | 'center' | 'right';

type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ depth: number; text: string }> }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; align: MdAlign[]; rows: string[][] };

const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const MD_HR = /^(?:-{3,}|\*{3,}|_{3,})$/;
const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const mdTableRow = (line: string): string[] => {
  let content = line.trim();
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  return content.split('|').map((cell) => cell.trim());
};

const mdTableSeparator = (line: string): boolean => {
  if (!line.includes('|')) return false;
  const cells = mdTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s/g, '')));
};

const mdTableAlign = (line: string): MdAlign[] =>
  mdTableRow(line).map((cell) => {
    const token = cell.replace(/\s/g, '');
    if (token.startsWith(':') && token.endsWith(':')) return 'center';
    return token.endsWith(':') ? 'right' : 'left';
  });

const mdIsBlockStart = (lines: string[], index: number): boolean => {
  const trimmed = lines[index]?.trim() ?? '';
  if (!trimmed) return true;
  if (/^```/.test(trimmed) || MD_HEADING.test(trimmed) || MD_HR.test(trimmed)) return true;
  if (trimmed.startsWith('>') || MD_LIST.test(lines[index] ?? '')) return true;
  return trimmed.includes('|') && index + 1 < lines.length && mdTableSeparator(lines[index + 1]);
};

const mdJoinLines = (lines: string[]): string =>
  lines.reduce((acc, line) => {
    if (!acc) return line;
    const glued = /[\u2e80-\u9fff\u3000-\u303f]$/.test(acc) || /^[\u2e80-\u9fff\u3000-\u303f]/.test(line);
    return acc + (glued ? '' : ' ') + line;
  }, '');

function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', code: code.join('\n') });
      continue;
    }

    const heading = MD_HEADING.exec(trimmed);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (MD_HR.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (trimmed.includes('|') && index + 1 < lines.length && mdTableSeparator(lines[index + 1])) {
      const header = mdTableRow(trimmed);
      const align = mdTableAlign(lines[index + 1]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(mdTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: mdJoinLines(quote) });
      continue;
    }

    if (MD_LIST.test(line)) {
      const ordered = /\d/.test(MD_LIST.exec(line)![2]);
      const start = ordered ? parseInt(MD_LIST.exec(line)![2], 10) || 1 : 1;
      const items: Array<{ depth: number; text: string }> = [];
      while (index < lines.length) {
        const match = MD_LIST.exec(lines[index]);
        if (!match) break;
        const indent = match[1].replace(/\t/g, '  ').length;
        items.push({ depth: Math.min(3, Math.floor(indent / 2)), text: match[3].trim() });
        index += 1;
        while (index < lines.length && lines[index].trim() && !MD_LIST.test(lines[index]) && !mdIsBlockStart(lines, index) && /^\s{2,}/.test(lines[index])) {
          items[items.length - 1].text += ' ' + lines[index].trim();
          index += 1;
        }
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !mdIsBlockStart(lines, index))) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: mdJoinLines(paragraph) });
  }
  return blocks;
}

const MD_INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

/** Markdown 内容来自模型/数据库，链接必须在调用平台 opener 前再次做绝对 URL 白名单校验。 */
export function getSafeMarkdownUrl(raw: string): string | null {
  if (/[\\\s\u0000-\u001f\u007f-\u009f]/u.test(raw)) return null;
  const value = raw;
  if (!value || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    if (!parsed.hostname || parsed.username || parsed.password) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

export function openMarkdownLink(raw: string): void {
  const url = getSafeMarkdownUrl(raw);
  if (!url) return;
  if (Platform.OS === 'web') {
    // Expo Linking 的 Web 实现会替换当前页面地址；新标签 + noopener 保留应用与内存凭据。
    if (typeof window === 'undefined' || typeof window.open !== 'function') return;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch {
      /* 浏览器可能阻止弹窗；绝不回退到顶层导航。 */
    }
    return;
  }
  void Linking.openURL(url).catch(() => undefined);
}

function Inline({ text, style }: { text: string; style?: any }) {
  const parts = text.split(MD_INLINE).filter(Boolean);
  return (
    <Text style={[styles.mdText, style]}>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={styles.mdBold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('__') && part.endsWith('__')) return <Text key={index} style={styles.mdBold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={styles.mdCode}>{part.slice(1, -1)}</Text>;
        if (part.startsWith('~~') && part.endsWith('~~')) return <Text key={index} style={styles.mdStrike}>{part.slice(2, -2)}</Text>;
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (link) {
          if (!getSafeMarkdownUrl(link[2])) return <Text key={index}>{link[1]}</Text>;
          return (
            <Text key={index} style={styles.mdLink} onPress={() => openMarkdownLink(link[2])}>
              {link[1]}
            </Text>
          );
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={index} style={styles.mdItalic}>{part.slice(1, -1)}</Text>;
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}

const mdTextWidth = (value: string): number =>
  Array.from(value).reduce((sum, char) => sum + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(char) ? 10.5 : 6), 0);

function MarkdownTable({ header, align, rows }: { header: string[]; align: MdAlign[]; rows: string[][] }) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const cellAt = (row: string[], column: number) => row[column] ?? '';
  const numeric = Array.from({ length: columns }, (_, column) =>
    rows.some((row) => cellAt(row, column).trim() !== '') &&
    rows.every((row) => cellAt(row, column).trim() === '' || /^(?:[—–-]|[-+¥$€]?[\d,]+(\.\d+)?%?)$/.test(cellAt(row, column).trim())),
  );
  const widths = Array.from({ length: columns }, (_, column) => {
    const widest = Math.max(...[header[column] ?? '', ...rows.map((row) => cellAt(row, column))].map(mdTextWidth), 2);
    return Math.max(62, Math.min(210, Math.round(widest + 16)));
  });
  const cellStyle = (column: number, lastRow = false) => [
    styles.mdTableCell,
    column === columns - 1 && styles.mdTableCellLast,
    lastRow && styles.mdTableCellLastRow,
    { width: widths[column], alignItems: numeric[column] || align[column] === 'right' ? 'flex-end' : align[column] === 'center' ? 'center' : 'flex-start' } as any,
  ];
  return (
    <View style={styles.mdTableWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.mdTableRow, styles.mdTableHeadRow]}>
            {Array.from({ length: columns }, (_, column) => (
              <View key={column} style={cellStyle(column)}>
                <Inline text={cellAt(header, column)} style={styles.mdTableHeadText} />
              </View>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={[styles.mdTableRow, rowIndex % 2 === 1 && { backgroundColor: colors.elevated }]}>
              {Array.from({ length: columns }, (_, column) => (
                <View key={column} style={cellStyle(column, rowIndex === rows.length - 1)}>
                  <Inline text={cellAt(row, column)} style={styles.mdTableCellText} />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: 7 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const style = block.level === 1 ? styles.mdH1 : block.level === 2 ? styles.mdH2 : block.level === 3 ? styles.mdH3 : styles.mdH4;
            return <Inline key={index} text={block.text} style={style} />;
          }
          case 'paragraph':
            return <Inline key={index} text={block.text} style={styles.mdParagraph} />;
          case 'list':
            return (
              <View key={index} style={{ gap: 3 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.mdListRow, { paddingLeft: item.depth * 14 }]}>
                    <Text style={styles.mdListMarker}>{block.ordered ? `${block.start + itemIndex}.` : '•'}</Text>
                    <Inline text={item.text} style={styles.mdListText} />
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={index} style={styles.mdQuoteBlock}>
                <Inline text={block.text} style={styles.mdQuoteText} />
              </View>
            );
          case 'code':
            return (
              <View key={index} style={styles.codeBlock}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.codeText}>{block.code.trim()}</Text>
                </ScrollView>
              </View>
            );
          case 'hr':
            return <View key={index} style={styles.mdHr} />;
          case 'table':
            return <MarkdownTable key={index} header={block.header} align={block.align} rows={block.rows} />;
          default:
            return null;
        }
      })}
    </View>
  );
}
