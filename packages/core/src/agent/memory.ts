import type { Memory, MemoryCandidate, MemoryKind, MemoryScopeType } from '../types';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'was', 'were', 'be', 'with', 'this', 'that', 'it', 'as', 'by', 'at', 'from',
  '我', '你', '他', '她', '它', '的', '了', '吗', '呢', '和', '是', '在', '有', '请', '帮', '一下', '这个', '那个', '什么', '怎么', '如何', '可以',
]);

const SECRET_RE = /(password|passwd|secret|token|api[_-]?key|private\s*key|密码|密钥|口令)\s*[:=：]\s*\S+/i;

export function looksLikeSecret(text: string): boolean {
  return SECRET_RE.test(text);
}

export function tokenize(text: string): string[] {
  const raw = text.toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]/g) ?? [];
  const set = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const tok = raw[i];
    if (tok.length > 1 || /[a-z0-9]/.test(tok)) {
      if (!STOPWORDS.has(tok)) set.add(tok);
    } else if (!STOPWORDS.has(tok)) {
      set.add(tok);
    }
    if (i + 1 < raw.length && /[\u4e00-\u9fff]/.test(tok) && /[\u4e00-\u9fff]/.test(raw[i + 1])) {
      const bigram = tok + raw[i + 1];
      if (!STOPWORDS.has(bigram)) set.add(bigram);
    }
  }
  return [...set];
}

export interface RankContext {
  connectionId?: string;
  database?: string;
  table?: string;
  now?: number;
  limit?: number;
}

export type ScoredMemory = Memory & { score: number };

function scopeScore(mem: Memory, ctx: RankContext): number {
  if (mem.scopeType === 'global') return 0.45;
  if (mem.scopeType === 'connection' && ctx.connectionId && mem.scopeKey === ctx.connectionId) return 0.9;
  if (mem.scopeType === 'database' && ctx.connectionId && ctx.database) {
    if (mem.scopeKey === `${ctx.connectionId}/${ctx.database}`) return 1;
  }
  if (mem.scopeType === 'table' && ctx.connectionId && ctx.table) {
    if (mem.scopeKey === `${ctx.connectionId}/${ctx.table}` || mem.scopeKey.endsWith(`/${ctx.table}`)) return 1.05;
  }
  return 0.25;
}

export function rankMemories(query: string, memories: Memory[], ctx: RankContext = {}): ScoredMemory[] {
  const now = ctx.now ?? Date.now();
  const qTokens = tokenize(query);
  const qSet = new Set(qTokens);
  if (!qTokens.length) return [];
  const df = new Map<string, number>();
  const docs = memories.map((m) => {
    const tokens = tokenize(`${m.title} ${m.content} ${(m.tags || []).join(' ')}`);
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    return { m, tokens };
  });
  const N = memories.length || 1;
  const scored: ScoredMemory[] = [];
  for (const { m, tokens } of docs) {
    if (m.archived) continue;
    let lex = 0;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const t of qSet) {
      const f = tf.get(t);
      if (!f) continue;
      const idf = Math.log(1 + N / (1 + (df.get(t) ?? 0)));
      lex += idf * (1 + Math.log(f));
    }
    lex = lex / Math.sqrt(qTokens.length + 2);
    const days = Math.max(0, (now - new Date(m.updatedAt || m.createdAt).getTime()) / 86400000);
    const recency = Math.exp(-days / 90);
    const score =
      0.55 * Math.min(1, lex / 1.6) +
      0.25 * scopeScore(m, ctx) +
      0.15 * m.importance +
      0.05 * recency +
      (m.pinned ? 0.3 : 0);
    if (score > 0.05 || m.pinned) scored.push({ ...m, score });
  }
  scored.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score);
  return scored.slice(0, ctx.limit ?? 6);
}

export function jaccard(a: string, b: string): number {
  const A = new Set(tokenize(a));
  const B = new Set(tokenize(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isDuplicateMemory(candidate: { title: string; content: string }, existing: Memory): boolean {
  return jaccard(`${candidate.title} ${candidate.content}`, `${existing.title} ${existing.content}`) >= 0.75;
}

export function mergeMemoryContent(existing: Memory, candidate: { title: string; content: string; importance?: number }, now = new Date().toISOString()): Partial<Memory> {
  return {
    title: candidate.title.length > existing.title.length ? candidate.title : existing.title,
    content: candidate.content.length >= existing.content.length ? candidate.content : existing.content,
    importance: Math.max(existing.importance, candidate.importance ?? 0.5),
    updatedAt: now,
  };
}

export interface ExtractDefaults {
  connectionId?: string;
  sessionId?: string;
}

/** Conservative offline extraction: only explicit remember/preference statements. */
export function extractHeuristicMemories(userText: string, defaults: ExtractDefaults = {}): MemoryCandidate[] {
  const text = userText.trim();
  if (!text || looksLikeSecret(text)) return [];
  const trigger = /(?:记住|记一下|remember|以后|下次|默认|偏好|习惯)/i.test(text);
  if (!trigger) return [];
  let content = text
    .replace(/^.*?(?:请?记住|记一下|remember)[:：,，\s]*/i, '')
    .replace(/^.*?(以后|下次)[:：,，\s]*/i, '')
    .trim();
  if (content.length < 4) content = text;
  const kind: MemoryKind = /(偏好|喜欢|习惯|默认|prefer|always)/i.test(text) ? 'preference' : 'fact';
  const scopeType: MemoryScopeType = defaults.connectionId ? 'connection' : 'global';
  const title = content.length > 26 ? `${content.slice(0, 26)}…` : content;
  return [
    {
      kind,
      title,
      content,
      tags: tokenize(content).slice(0, 6),
      importance: kind === 'preference' ? 0.75 : 0.65,
      confidence: 0.6,
      scopeType,
      scopeKey: scopeType === 'connection' ? (defaults.connectionId as string) : '*',
    },
  ];
}

export function formatMemoryBlock(memories: Memory[]): string {
  if (!memories.length) return '(none)';
  return memories.map((m) => `- [${m.id}] ${m.kind}: ${m.title} — ${m.content}`).join('\n');
}

export function emptyMemory(): Memory {
  const now = new Date().toISOString();
  return {
    id: '',
    scopeType: 'global',
    scopeKey: '*',
    kind: 'fact',
    title: '',
    content: '',
    tags: [],
    importance: 0.5,
    confidence: 0.7,
    pinned: false,
    archived: false,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}
