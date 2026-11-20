import { randomUUID } from 'node:crypto';
import {
  bundleAgentContext,
  emptyBundle,
  isDuplicateMemory,
  looksLikeSecret,
  mergeMemoryContent,
  rankMemories,
  type AgentContextBundle,
  type AgentContextEntry,
  type AgentMessage,
  type AgentMessageBlock,
  type AgentSessionMeta,
  type AgentResumeCause,
  type Memory,
  type MemoryCandidate,
  type MemoryKind,
  type PermissionMode,
} from '@aidb/core';
import { StoreDb, iso } from './db';

interface SessionRow {
  id: string;
  connection_id: string | null;
  database: string | null;
  title: string;
  summary: string | null;
  model: string | null;
  permission_mode: PermissionMode;
  status: AgentSessionMeta['status'];
  tokens_in: number;
  tokens_out: number;
  turns: number | null;
  steps: number | null;
  cache_hit_tokens: number | null;
  cache_miss_tokens: number | null;
  context_tokens: number | null;
  resume_cause: AgentResumeCause | null;
  created_at: string;
  updated_at: string;
  archived: number;
}

interface MessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: AgentMessage['role'];
  content: string;
  blocks_json: string | null;
  tokens: number | null;
  created_at: string;
}

interface MemoryRow {
  id: string;
  scope_type: Memory['scopeType'];
  scope_key: string;
  kind: MemoryKind;
  title: string;
  content: string;
  tags: string | null;
  synonyms: string | null;
  importance: number;
  confidence: number;
  source_session: string | null;
  source_message: string | null;
  pinned: number;
  archived: number;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentContextRow {
  id: string;
  connection_id: string;
  database_name: string;
  kind: AgentContextEntry['kind'];
  table_name: string;
  column_name: string | null;
  ref_table: string | null;
  ref_column: string | null;
  enabled: number;
  alias: string | null;
  description: string | null;
  created_at: string;
  updated_at: string;
}

/** 业务语义类记忆：召回时走独立配额，不挤占情景记忆的 6 条名额。 */
const BUSINESS_KINDS: MemoryKind[] = ['glossary', 'sql_example'];

const TOOL_RUNS_LIMIT = 1000;

export class AgentRepo {
  private contextCache = new Map<string, { at: number; bundle: AgentContextBundle }>();

  constructor(private db: StoreDb) {}

  // ---------- agent sessions ----------
  private rowToSession(row: SessionRow): AgentSessionMeta {
    return {
      id: row.id,
      connectionId: row.connection_id ?? undefined,
      database: row.database ?? undefined,
      title: row.title,
      summary: row.summary ?? undefined,
      model: row.model ?? undefined,
      permissionMode: row.permission_mode,
      status: row.status,
      tokensIn: row.tokens_in ?? 0,
      tokensOut: row.tokens_out ?? 0,
      turns: row.turns ?? 0,
      steps: row.steps ?? 0,
      cacheHitTokens: row.cache_hit_tokens ?? 0,
      cacheMissTokens: row.cache_miss_tokens ?? 0,
      contextTokens: row.context_tokens ?? 0,
      resume: row.resume_cause ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createSession(input: { connectionId?: string; database?: string; title?: string; model?: string; permissionMode?: PermissionMode } = {}): AgentSessionMeta {
    const id = randomUUID();
    const now = iso();
    this.db.exec(
      'INSERT INTO agent_sessions (id,connection_id,database,title,model,permission_mode,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
      [id, input.connectionId ?? null, input.database ?? null, input.title ?? '新会话', input.model ?? null, input.permissionMode ?? 'ask', 'idle', now, now],
    );
    return this.getSession(id)!;
  }

  getSession(id: string): AgentSessionMeta | undefined {
    const row = this.db.one<SessionRow>('SELECT * FROM agent_sessions WHERE id = ?', [id]);
    return row ? this.rowToSession(row) : undefined;
  }

  /**
   * 列会话。第一个参数兼容旧的「直接传 limit」写法。
   * 未绑定库（database IS NULL）的旧会话在任何库下都返回 —— 它们是"还没选库"时
   * 产生的记录，按库过滤时藏起来会让用户以为历史丢了。
   */
  listSessions(
    opts: number | { connectionId?: string; database?: string; limit?: number; archived?: boolean } = 60,
  ): AgentSessionMeta[] {
    const o = typeof opts === 'number' ? { limit: opts } : opts;
    const where: string[] = ['archived = ?'];
    const args: Array<string | number> = [o.archived ? 1 : 0];
    if (o.connectionId) {
      where.push('connection_id = ?');
      args.push(o.connectionId);
    }
    if (o.database) {
      where.push('(database IS NULL OR database = ?)');
      args.push(o.database);
    }
    const limit = Math.min(200, Math.max(1, o.limit ?? 60));
    return this.db.all<SessionRow>(
      `SELECT * FROM agent_sessions WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ${limit}`,
      args,
    ).map((r) => this.rowToSession(r));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<AgentSessionMeta, 'connectionId' | 'database' | 'title' | 'summary' | 'model' | 'permissionMode' | 'status' | 'tokensIn' | 'tokensOut' | 'turns' | 'steps' | 'cacheHitTokens' | 'cacheMissTokens' | 'contextTokens'>> & { archived?: boolean; resume?: AgentResumeCause | null },
  ): AgentSessionMeta {
    const map: Record<string, string> = {
      connectionId: 'connection_id',
      database: 'database',
      title: 'title',
      summary: 'summary',
      model: 'model',
      permissionMode: 'permission_mode',
      status: 'status',
      tokensIn: 'tokens_in',
      tokensOut: 'tokens_out',
      turns: 'turns',
      steps: 'steps',
      cacheHitTokens: 'cache_hit_tokens',
      cacheMissTokens: 'cache_miss_tokens',
      contextTokens: 'context_tokens',
      archived: 'archived',
      // 传 null 表示清空：新回合开始时必须清掉上一回合的「可以继续」，
      // 而 undefined 在这套 patch 语义里是「本次不改」，清不掉。
      resume: 'resume_cause',
    };
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [iso()];
    for (const [key, column] of Object.entries(map)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    params.push(id);
    this.db.exec(`UPDATE agent_sessions SET ${sets.join(', ')} WHERE id = ?`, params);
    return this.getSession(id)!;
  }

  deleteSession(id: string): void {
    this.db.exec('DELETE FROM agent_sessions WHERE id = ?', [id]);
  }

  appendMessage(input: { sessionId: string; role: AgentMessage['role']; content: string; blocks?: AgentMessageBlock[]; tokens?: number }): AgentMessage {
    const seqRow = this.db.one<{ seq: number }>('SELECT COALESCE(MAX(seq),0) + 1 AS seq FROM messages WHERE session_id = ?', [input.sessionId]);
    const seq = seqRow?.seq ?? 1;
    const message: AgentMessage = {
      id: randomUUID(),
      sessionId: input.sessionId,
      seq,
      role: input.role,
      content: input.content,
      blocks: input.blocks ?? [],
      tokens: input.tokens,
      createdAt: iso(),
    };
    this.db.exec('INSERT INTO messages (id,session_id,seq,role,content,blocks_json,tokens,created_at) VALUES (?,?,?,?,?,?,?,?)', [
      message.id,
      message.sessionId,
      message.seq,
      message.role,
      message.content,
      message.blocks.length ? JSON.stringify(message.blocks) : null,
      message.tokens ?? null,
      message.createdAt,
    ]);
    return message;
  }

  listMessages(sessionId: string, opts: { limit?: number; beforeSeq?: number } = {}): AgentMessage[] {
    const params: unknown[] = [sessionId];
    let where = 'session_id = ?';
    if (opts.beforeSeq !== undefined) {
      where += ' AND seq < ?';
      params.push(opts.beforeSeq);
    }
    // 带上限时取「最近一页」（seq 倒序 + LIMIT）再翻回升序；不传 limit 保持旧的全量升序行为。
    const limit = opts.limit === undefined ? undefined : Math.max(1, Math.min(1000, Math.floor(opts.limit)));
    const rows =
      limit === undefined
        ? this.db.all<MessageRow>(`SELECT * FROM messages WHERE ${where} ORDER BY seq ASC`, params)
        : this.db.all<MessageRow>(`SELECT * FROM messages WHERE ${where} ORDER BY seq DESC LIMIT ${limit}`, params);
    if (limit !== undefined) rows.reverse();
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      seq: r.seq,
      role: r.role,
      content: r.content,
      blocks: r.blocks_json ? (JSON.parse(r.blocks_json) as AgentMessageBlock[]) : [],
      tokens: r.tokens ?? undefined,
      createdAt: r.created_at,
    }));
  }

  addToolRun(input: { id: string; sessionId: string; messageId?: string; tool: string; args?: unknown; result?: unknown; status: string; risk?: string; approval?: string; durationMs?: number }): void {
    const write = (id: string) =>
      this.db.exec(
        'INSERT INTO tool_runs (id,session_id,message_id,tool,args_json,result_json,status,risk,approval,duration_ms,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          input.sessionId,
          input.messageId ?? null,
          input.tool,
          input.args === undefined ? null : JSON.stringify(input.args),
          input.result === undefined ? null : JSON.stringify(input.result),
          input.status,
          input.risk ?? null,
          input.approval ?? null,
          input.durationMs ?? null,
          iso(),
        ],
      );
    // tool_runs.id 直接用了模型给的 tool call id，而它只在单次响应内唯一：
    // 有的服务商/代理会复用固定 id（复跑、重放、离线桩都会），主键一冲突就会把
    // 整轮 agent 抛成 ERR_SQLITE_ERROR。审计写入绝不该毁掉回合，更不该丢掉已有记录，
    // 因此退让成「加后缀再写一条」——两条调用各自留痕。
    try {
      write(input.id);
    } catch (err: any) {
      if (!/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(String(err?.message ?? ''))) throw err;
      // 后缀要在同一毫秒内也唯一：两个并发工具调用可能撞在同一 ms，
      // 那样第二次仍旧冲突，等于没兜住。
      // 后缀用随机串而不是时间戳：同一毫秒内也可能再次冲突。
      write(`${input.id}#${randomUUID().slice(0, 8)}`);
    }
  }

  listToolRuns(sessionId: string): Array<Record<string, unknown>> {
    return this.db.all<Record<string, unknown>>('SELECT * FROM tool_runs WHERE session_id = ? ORDER BY created_at ASC', [sessionId]);
  }

  // ---------- memories ----------
  private rowToMemory(row: MemoryRow): Memory {
    let tags: string[] = [];
    try {
      tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
    } catch {
      tags = [];
    }
    let synonyms: string[] = [];
    try {
      synonyms = row.synonyms ? (JSON.parse(row.synonyms) as string[]) : [];
    } catch {
      synonyms = [];
    }
    return {
      id: row.id,
      scopeType: row.scope_type,
      scopeKey: row.scope_key,
      kind: row.kind,
      title: row.title,
      content: row.content,
      tags,
      synonyms,
      importance: row.importance,
      confidence: row.confidence,
      sourceSession: row.source_session ?? undefined,
      sourceMessage: row.source_message ?? undefined,
      pinned: Boolean(row.pinned),
      archived: Boolean(row.archived),
      useCount: row.use_count,
      lastUsedAt: row.last_used_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listMemories(
    opts: {
      q?: string;
      kind?: string;
      scopeType?: string;
      includeArchived?: boolean;
      limit?: number;
      kinds?: MemoryKind[];
      excludeKinds?: MemoryKind[];
      /** 作用域下推到 SQL：先过滤再取 top-N，避免全库前 500 条把本作用域的记忆挤出去。 */
      scope?: { connectionId?: string; database?: string };
    } = {},
  ): Memory[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeArchived) clauses.push('archived = 0');
    if (opts.kind) {
      clauses.push('kind = ?');
      params.push(opts.kind);
    }
    if (opts.scopeType) {
      clauses.push('scope_type = ?');
      params.push(opts.scopeType);
    }
    if (opts.kinds?.length) {
      clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
      params.push(...opts.kinds);
    } else if (opts.excludeKinds?.length) {
      clauses.push(`kind NOT IN (${opts.excludeKinds.map(() => '?').join(',')})`);
      params.push(...opts.excludeKinds);
    }
    if (opts.scope) {
      const { connectionId, database } = opts.scope;
      const ors = ["scope_type = 'global'"];
      if (connectionId) {
        ors.push("(scope_type = 'connection' AND scope_key = ?)");
        params.push(connectionId);
        ors.push("(scope_type = 'table' AND scope_key LIKE ?)");
        params.push(`${connectionId}/%`);
        if (database) {
          ors.push("(scope_type = 'database' AND scope_key = ?)");
          params.push(`${connectionId}/${database}`);
        }
      }
      clauses.push(`(${ors.join(' OR ')})`);
    }
    if (opts.q) {
      clauses.push('(title LIKE ? OR content LIKE ? OR tags LIKE ? OR synonyms LIKE ?)');
      params.push(`%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`, `%${opts.q}%`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
    return this.db.all<MemoryRow>(`SELECT * FROM memories ${where} ORDER BY pinned DESC, importance DESC, updated_at DESC LIMIT ${limit}`, params).map((r) => this.rowToMemory(r));
  }

  getMemory(id: string): Memory | undefined {
    const row = this.db.one<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id]);
    return row ? this.rowToMemory(row) : undefined;
  }

  createMemory(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): Memory {
    if (looksLikeSecret(`${candidate.title} ${candidate.content}`)) {
      throw new Error('记忆内容疑似包含凭据或密钥，已拒绝写入');
    }
    const scopeType = candidate.scopeType ?? (ctx.database ? 'database' : ctx.connectionId ? 'connection' : 'global');
    const scopeKey =
      candidate.scopeKey ??
      (scopeType === 'connection' && ctx.connectionId
        ? ctx.connectionId
        : scopeType === 'database' && ctx.connectionId && ctx.database
          ? `${ctx.connectionId}/${ctx.database}`
          : '*');
    const now = iso();
    const id = randomUUID();
    this.db.exec(
      `INSERT INTO memories (id,scope_type,scope_key,kind,title,content,tags,synonyms,importance,confidence,source_session,source_message,pinned,archived,use_count,last_used_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,NULL,?,?)`,
      [
        id,
        scopeType,
        scopeKey,
        candidate.kind,
        candidate.title.slice(0, 200),
        candidate.content,
        JSON.stringify(candidate.tags ?? []),
        JSON.stringify(candidate.synonyms ?? []),
        Math.min(1, Math.max(0, candidate.importance ?? 0.5)),
        Math.min(1, Math.max(0, candidate.confidence ?? 0.7)),
        ctx.sessionId ?? null,
        ctx.messageId ?? null,
        now,
        now,
      ],
    );
    return this.getMemory(id)!;
  }

  upsertMemoryCandidate(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): { memory: Memory; merged: boolean } {
    const scopeType = candidate.scopeType ?? (ctx.database ? 'database' : ctx.connectionId ? 'connection' : 'global');
    const scopeKey =
      candidate.scopeKey ??
      (scopeType === 'connection' && ctx.connectionId
        ? ctx.connectionId
        : scopeType === 'database' && ctx.connectionId && ctx.database
          ? `${ctx.connectionId}/${ctx.database}`
          : '*');
    const existing = this.db.all<MemoryRow>('SELECT * FROM memories WHERE scope_type = ? AND scope_key = ? AND kind = ? AND archived = 0', [
      scopeType,
      scopeKey,
      candidate.kind,
    ]).map((r) => this.rowToMemory(r));
    const duplicate = existing.find((m) => isDuplicateMemory(candidate, m));
    if (duplicate) {
      const merged = mergeMemoryContent(duplicate, candidate);
      const tags = [...new Set([...(duplicate.tags ?? []), ...(candidate.tags ?? [])])];
      const synonyms = [...new Set([...(duplicate.synonyms ?? []), ...(candidate.synonyms ?? [])])];
      this.db.exec('UPDATE memories SET title=?, content=?, importance=?, tags=?, synonyms=?, confidence=?, updated_at=? WHERE id=?', [
        merged.title,
        merged.content,
        merged.importance,
        JSON.stringify(tags),
        JSON.stringify(synonyms),
        Math.max(duplicate.confidence, candidate.confidence ?? 0.7),
        merged.updatedAt,
        duplicate.id,
      ]);
      return { memory: this.getMemory(duplicate.id)!, merged: true };
    }
    return { memory: this.createMemory({ ...candidate, scopeType, scopeKey }, ctx), merged: false };
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'kind' | 'importance' | 'confidence' | 'pinned' | 'archived' | 'tags' | 'synonyms'>>,
  ): Memory {
    const sets: string[] = [];
    const params: unknown[] = [];
    const mapping: Record<string, string> = {
      title: 'title',
      content: 'content',
      kind: 'kind',
      importance: 'importance',
      confidence: 'confidence',
      pinned: 'pinned',
      archived: 'archived',
      tags: 'tags',
      synonyms: 'synonyms',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (!(key in patch)) continue;
      let value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (key === 'tags' || key === 'synonyms') value = JSON.stringify(value ?? []);
      if (typeof value === 'boolean') value = value ? 1 : 0;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      params.push(iso(), id);
      this.db.exec(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
    }
    return this.getMemory(id)!;
  }

  deleteMemory(id: string): void {
    this.db.exec('DELETE FROM memories WHERE id = ?', [id]);
  }

  markMemoriesUsed(ids: string[]): void {
    if (!ids.length) return;
    const now = iso();
    const placeholders = ids.map(() => '?').join(',');
    this.db.exec(`UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id IN (${placeholders})`, [now, ...ids]);
  }

  searchMemories(
    query: string,
    ctx: { connectionId?: string; database?: string; limit?: number; kinds?: MemoryKind[]; excludeKinds?: MemoryKind[] } = {},
  ): Memory[] {
    // 作用域与类型在 SQL 里先过滤再取 top-500：记忆总量超过 500 后，
    // 本作用域的记忆不会在排序前就被全库名额截掉。
    const memories = this.listMemories({
      includeArchived: false,
      limit: 500,
      kinds: ctx.kinds,
      excludeKinds: ctx.excludeKinds,
      scope: { connectionId: ctx.connectionId, database: ctx.database },
    });
    const limit = ctx.limit ?? 8;
    if (!query.trim()) {
      return this.uniqueMemories(
        memories.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance),
        limit,
      );
    }
    // 多取一些再按标题去重，否则同一个问题问过几次就会占满召回名额
    const ranked = rankMemories(query, memories, { connectionId: ctx.connectionId, database: ctx.database, limit: limit * 3 });
    const unique = this.uniqueMemories(ranked, limit);
    this.markMemoriesUsed(unique.map((m) => m.id));
    return unique;
  }

  /** 同一问题被反复提问会存成多条同标题的情景记忆；召回按「类型 + 标题」只留排序最前的那条。 */
  private uniqueMemories(list: Memory[], limit: number): Memory[] {
    const seen = new Set<string>();
    const out: Memory[] = [];
    for (const memory of list) {
      const key = `${memory.kind}:${(memory.title ?? '').trim().toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(memory);
      if (out.length >= limit) break;
    }
    return out;
  }

  /**
   * 单轮召回：业务语义（术语 / 示例 SQL）走独立配额，不与情景记忆争名额。
   * 无相关记忆时三类均为空数组，prompt 输出与未引入该机制前完全一致。
   */
  recallForTurn(query: string, ctx: { connectionId?: string; database?: string } = {}): {
    memories: Memory[];
    glossary: Memory[];
    sqlExamples: Memory[];
  } {
    const scope = { connectionId: ctx.connectionId, database: ctx.database };
    const memories = this.searchMemories(query, { ...scope, limit: 6, excludeKinds: BUSINESS_KINDS });
    // 术语与示例 SQL 是常驻业务上下文，即使与本轮问题字面不相关也应注入，故空查询时按重要度兜底。
    const glossary = this.searchMemories(query, { ...scope, limit: 20, kinds: ['glossary'] });
    const sqlExamples = this.searchMemories(query, { ...scope, limit: 3, kinds: ['sql_example'] });
    return { memories, glossary, sqlExamples };
  }

  // ---------- agent context (业务上下文覆盖) ----------
  private rowToAgentContext(row: AgentContextRow): AgentContextEntry {
    return {
      id: row.id,
      connectionId: row.connection_id,
      database: row.database_name,
      kind: row.kind,
      table: row.table_name,
      column: row.column_name ?? undefined,
      refTable: row.ref_table ?? undefined,
      refColumn: row.ref_column ?? undefined,
      enabled: Boolean(row.enabled),
      alias: row.alias ?? undefined,
      description: row.description ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 列出覆盖项。`database` 为 undefined 时返回该连接的全部库配置；
   * 传入具体库名（含空串）时精确匹配，避免把 A 库的配置套到 B 库上。
   */
  listAgentContext(connectionId: string, database?: string): AgentContextEntry[] {
    const rows =
      database === undefined
        ? this.db.all<AgentContextRow>('SELECT * FROM agent_context WHERE connection_id = ? ORDER BY kind, table_name, column_name', [connectionId])
        : this.db.all<AgentContextRow>('SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? ORDER BY kind, table_name, column_name', [
            connectionId,
            database,
          ]);
    return rows.map((r) => this.rowToAgentContext(r));
  }

  /**
   * upsert 表 / 列覆盖。定位键：connection + database + kind + table + column。
   * 传入的字段为 undefined 表示「不改」；传 null 表示「清空」。
   */
  upsertAgentContextEntry(input: {
    id?: string;
    connectionId: string;
    database?: string;
    kind: 'table' | 'column';
    table: string;
    column?: string;
    enabled?: boolean;
    alias?: string | null;
    description?: string | null;
  }): AgentContextEntry {
    if (input.kind === 'column' && !input.column?.trim()) throw new Error('列覆盖必须提供 column');
    this.invalidateAgentContextCache();
    const database = input.database ?? '';
    const table = input.table.trim();
    const column = input.kind === 'column' ? input.column!.trim() : null;
    const now = iso();
    const existing = this.db.one<AgentContextRow>(
      'SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? AND kind = ? AND table_name = ? AND column_name IS ?',
      [input.connectionId, database, input.kind, table, column],
    );
    if (existing) {
      this.db.exec(
        `UPDATE agent_context SET enabled = ?, alias = ?, description = ?, updated_at = ? WHERE id = ?`,
        [
          input.enabled === undefined ? existing.enabled : input.enabled ? 1 : 0,
          input.alias === undefined ? existing.alias : input.alias,
          input.description === undefined ? existing.description : input.description,
          now,
          existing.id,
        ],
      );
      return this.rowToAgentContext(this.db.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [existing.id])!);
    }
    const id = input.id ?? randomUUID();
    this.db.exec(
      `INSERT INTO agent_context (id,connection_id,database_name,kind,table_name,column_name,ref_table,ref_column,enabled,alias,description,created_at,updated_at)
       VALUES (?,?,?,?,?,?,NULL,NULL,?,?,?,?,?)`,
      [id, input.connectionId, database, input.kind, table, column, input.enabled === false ? 0 : 1, input.alias ?? null, input.description ?? null, now, now],
    );
    return this.rowToAgentContext(this.db.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [id])!);
  }

  /** upsert 手工关联关系；定位键为四元组，避免同一关系重复录入。 */
  upsertAgentRelation(input: {
    connectionId: string;
    database?: string;
    table: string;
    column: string;
    refTable: string;
    refColumn: string;
    description?: string | null;
  }): AgentContextEntry {
    const database = input.database ?? '';
    const now = iso();
    this.invalidateAgentContextCache();
    const existing = this.db.one<AgentContextRow>(
      `SELECT * FROM agent_context WHERE connection_id = ? AND database_name = ? AND kind = 'relation'
       AND table_name = ? AND column_name = ? AND ref_table = ? AND ref_column = ?`,
      [input.connectionId, database, input.table.trim(), input.column.trim(), input.refTable.trim(), input.refColumn.trim()],
    );
    if (existing) {
      this.db.exec('UPDATE agent_context SET description = ?, updated_at = ? WHERE id = ?', [
        input.description === undefined ? existing.description : input.description,
        now,
        existing.id,
      ]);
      return this.rowToAgentContext(this.db.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [existing.id])!);
    }
    const id = randomUUID();
    this.db.exec(
      `INSERT INTO agent_context (id,connection_id,database_name,kind,table_name,column_name,ref_table,ref_column,enabled,alias,description,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,NULL,?,?,?)`,
      [id, input.connectionId, database, 'relation', input.table.trim(), input.column.trim(), input.refTable.trim(), input.refColumn.trim(), input.description ?? null, now, now],
    );
    return this.rowToAgentContext(this.db.one<AgentContextRow>('SELECT * FROM agent_context WHERE id = ?', [id])!);
  }

  deleteAgentContext(id: string): void {
    this.invalidateAgentContextCache();
    this.db.exec('DELETE FROM agent_context WHERE id = ?', [id]);
  }

  /** 清空某连接（可选某库）的全部覆盖项，使 Agent 回到未配置的默认行为。 */
  clearAgentContext(connectionId: string, database?: string): number {
    this.invalidateAgentContextCache();
    const result = database
      ? this.db.exec('DELETE FROM agent_context WHERE connection_id = ? AND database_name = ?', [connectionId, database])
      : this.db.exec('DELETE FROM agent_context WHERE connection_id = ?', [connectionId]);
    return result.changes;
  }

  /** 批量启用 / 禁用表（表管理面板的「全选 / 反选 / 仅启用勾选」）。 */
  bulkSetAgentContextTables(input: { connectionId: string; database?: string; tables: string[]; enabled: boolean }): number {
    const database = input.database ?? '';
    let touched = 0;
    this.db.db.exec('BEGIN');
    try {
      for (const raw of input.tables) {
        const table = String(raw).trim();
        if (!table) continue;
        this.upsertAgentContextEntry({ connectionId: input.connectionId, database, kind: 'table', table, enabled: input.enabled });
        touched++;
      }
      this.db.db.exec('COMMIT');
    } catch (err) {
      this.db.db.exec('ROLLBACK');
      throw err;
    }
    return touched;
  }

  /**
   * 聚合为 prompt 可直接消费的结构；无任何配置时返回 inactive bundle。带 30s 缓存，写操作立即失效。
   * 未指定具体库时返回 inactive——无法判断该套用哪个库的配置，宁可退回默认行为也不误伤。
   */
  agentContextBundle(connectionId: string, database?: string): AgentContextBundle {
    if (!database) return emptyBundle({ connectionId, database: '' });
    const key = `${connectionId}\u0000${database}`;
    const now = Date.now();
    const hit = this.contextCache.get(key);
    if (hit && now - hit.at < 30_000) return hit.bundle;
    const bundle = bundleAgentContext(this.listAgentContext(connectionId, database), { connectionId, database });
    this.contextCache.set(key, { at: now, bundle });
    return bundle;
  }

  private invalidateAgentContextCache(): void {
    this.contextCache.clear();
  }

  pruneToolRuns(): void {
    this.db.pruneTable('tool_runs', TOOL_RUNS_LIMIT);
  }
}
