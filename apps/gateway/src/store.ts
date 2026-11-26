import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AgentContextBundle,
  AgentContextEntry,
  AgentEvent,
  AgentMessage,
  AgentMessageBlock,
  AgentSessionMeta,
  AgentResumeCause,
  AppSettings,
  ArtifactInfo,
  ArtifactRunInfo,
  ArtifactScheduleInfo,
  ArtifactSpec,
  ArtifactType,
  AuditEntry,
  BackupInfo,
  ConnectionConfig,
  ConnectionSecret,
  CommandRunEvent,
  DashboardCard,
  DashboardCardInput,
  DashboardScheduleInfo,
  DeviceInfo,
  JobInfo,
  McpServerInfo,
  Memory,
  MemoryCandidate,
  NotificationChannelInfo,
  NotificationChannelType,
  MemoryKind,
  PermissionMode,
  PipelineCredentialInfo,
  PipelineInfo,
  PipelineRunInfo,
  PipelineSpec,
  QueryHistoryItem,
} from '@aidb/core';
import { StoreDb } from './store/db';
import { ConnectionsRepo } from './store/connections';
import { SettingsRepo } from './store/settings';
import { HistoryRepo } from './store/history';
import { AgentRepo } from './store/agent';
import { DashboardsRepo } from './store/dashboards';
import { ArtifactsRepo } from './store/artifacts';
import { IntegrationsRepo } from './store/integrations';
import { JobsRepo } from './store/jobs';
import { RuntimeRepo, type AgentTurnClaim, type AgentTurnStatus, type CommandEventReplay, type RecoveryResult, type StoredEvent } from './store/runtime';
import { AuditRepo } from './store/audit';
import type { ConnectionRow, ConnectionInput, DatabaseBriefRecord } from './store/connections';
import type { ArtifactRunRow } from './store/artifacts';
import type { PipelineCredentialSecret } from './pipeline/types';
export type { ConnectionInput } from './store/connections';
export type { DatabaseBriefRecord } from './store/connections';

/** 裁剪节流：距上次裁剪不足 60s 直接跳过，避免每次插入都触发 O(n) 扫描。 */
const PRUNE_THROTTLE_MS = 60_000;

export class Store {
  private storeDb: StoreDb;
  private connections: ConnectionsRepo;
  private settings: SettingsRepo;
  private history: HistoryRepo;
  private agent: AgentRepo;
  private dashboards: DashboardsRepo;
  private artifacts: ArtifactsRepo;
  private integrations: IntegrationsRepo;
  private jobs: JobsRepo;
  private runtime: RuntimeRepo;
  private audit: AuditRepo;
  private lastPruneAt = 0;

  constructor(dbPath: string, secret: string) {
    this.storeDb = new StoreDb(dbPath, secret);
    try {
      this.connections = new ConnectionsRepo(this.storeDb);
      this.settings = new SettingsRepo(this.storeDb);
      this.history = new HistoryRepo(this.storeDb, this);
      this.agent = new AgentRepo(this.storeDb);
      this.dashboards = new DashboardsRepo(this.storeDb);
      this.artifacts = new ArtifactsRepo(this.storeDb);
      this.integrations = new IntegrationsRepo(this.storeDb);
      this.jobs = new JobsRepo(this.storeDb);
      this.runtime = new RuntimeRepo(this.storeDb);
      this.audit = new AuditRepo(this.storeDb);
      // 旧版本没有保留期，审计/运行表可能已严重超限：启动时强制裁剪一次。
      this.pruneRetention(true);
      this.sweepDataDirs(dbPath);
    } catch (err) {
      this.storeDb.close();
      throw err;
    }
  }

  get db(): DatabaseSync {
    return this.storeDb.db;
  }

  listConnections(): ConnectionConfig[] {
    return this.connections.listConnections();
  }

  getConnectionRow(id: string): ConnectionRow | undefined {
    return this.connections.getConnectionRow(id);
  }

  getConnection(id: string): ConnectionConfig | undefined {
    return this.connections.getConnection(id);
  }

  getConnectionSecret(id: string): ConnectionSecret {
    return this.connections.getConnectionSecret(id);
  }

  createConnection(input: ConnectionInput): ConnectionConfig {
    return this.connections.createConnection(input);
  }

  updateConnection(id: string, patch: Partial<ConnectionInput>): ConnectionConfig {
    return this.connections.updateConnection(id, patch);
  }

  deleteConnection(id: string): void {
    this.connections.deleteConnection(id);
  }

  touchConnection(id: string): void {
    this.connections.touchConnection(id);
  }

  // ---------- database briefs (AI_DB.md) ----------
  getDatabaseBrief(connectionId: string, database?: string): DatabaseBriefRecord | undefined {
    return this.connections.getDatabaseBrief(connectionId, database);
  }

  saveDatabaseBrief(record: Omit<DatabaseBriefRecord, 'scopeKey' | 'updatedAt'>): DatabaseBriefRecord {
    return this.connections.saveDatabaseBrief(record);
  }

  renameGroup(from: string, to: string): number {
    return this.connections.renameGroup(from, to);
  }

  deleteGroup(name: string): number {
    return this.connections.deleteGroup(name);
  }

  // ---------- schema cache ----------
  getSchemaCache(connectionId: string, database: string): { payload: string; fetchedAt: string } | undefined {
    return this.connections.getSchemaCache(connectionId, database);
  }

  setSchemaCache(connectionId: string, database: string, payload: unknown): void {
    this.connections.setSchemaCache(connectionId, database, payload);
  }

  clearSchemaCache(connectionId: string): void {
    this.connections.clearSchemaCache(connectionId);
  }

  // ---------- backups ----------
  addBackup(input: Omit<BackupInfo, 'id' | 'createdAt'>): BackupInfo {
    return this.connections.addBackup(input);
  }

  listBackups(connectionId?: string): BackupInfo[] {
    return this.connections.listBackups(connectionId);
  }

  deleteBackup(id: string): void {
    this.connections.deleteBackup(id);
  }

  getSettings(): AppSettings {
    return this.settings.getSettings();
  }

  publicSettings(): AppSettings {
    return this.settings.publicSettings();
  }

  getSearchApiKey(id: string): string | undefined {
    return this.settings.getSearchApiKey(id);
  }

  searchKeyStatus(): Record<string, boolean> {
    return this.settings.searchKeyStatus();
  }

  saveSearchKeys(input: Record<string, unknown> | undefined): void {
    this.settings.saveSearchKeys(input);
  }

  saveSettings(next: AppSettings): AppSettings {
    return this.settings.saveSettings(next);
  }

  /** 取某个模型配置已保存的密钥；默认配置回退到旧版单模型密钥。 */
  getModelApiKey(id: string): string | undefined {
    return this.settings.getModelApiKey(id);
  }

  // ---------- query history ----------
  addHistory(item: Omit<QueryHistoryItem, 'id' | 'createdAt'>): QueryHistoryItem {
    const result = this.history.addHistory(item);
    this.pruneRetention();
    return result;
  }

  listHistory(opts: { connectionId?: string; search?: string; limit?: number } = {}): QueryHistoryItem[] {
    return this.history.listHistory(opts);
  }

  setHistoryFavorite(id: string, favorite: boolean): boolean {
    return this.history.setHistoryFavorite(id, favorite);
  }

  clearHistory(): void {
    this.history.clearHistory();
  }

  // ---------- snippets ----------
  listSnippets(): Array<{ id: string; name: string; sql: string; tags: string[]; createdAt: string }> {
    return this.history.listSnippets();
  }

  createSnippet(input: { name: string; sql: string; tags?: string[] }): { id: string } {
    return this.history.createSnippet(input);
  }

  deleteSnippet(id: string): void {
    this.history.deleteSnippet(id);
  }

  createSession(input: { connectionId?: string; database?: string; title?: string; model?: string; permissionMode?: PermissionMode } = {}): AgentSessionMeta {
    return this.agent.createSession(input);
  }

  getSession(id: string): AgentSessionMeta | undefined {
    return this.agent.getSession(id);
  }

  /**
   * 列会话。第一个参数兼容旧的「直接传 limit」写法。
   * 未绑定库（database IS NULL）的旧会话在任何库下都返回 —— 它们是"还没选库"时
   * 产生的记录，按库过滤时藏起来会让用户以为历史丢了。
   */
  listSessions(
    opts: number | { connectionId?: string; database?: string; limit?: number; archived?: boolean } = 60,
  ): AgentSessionMeta[] {
    return this.agent.listSessions(opts);
  }

  updateSession(
    id: string,
    patch: Partial<Pick<AgentSessionMeta, 'connectionId' | 'database' | 'title' | 'summary' | 'model' | 'permissionMode' | 'status' | 'tokensIn' | 'tokensOut' | 'turns' | 'steps' | 'cacheHitTokens' | 'cacheMissTokens' | 'contextTokens'>> & { archived?: boolean; resume?: AgentResumeCause | null },
  ): AgentSessionMeta {
    return this.agent.updateSession(id, patch);
  }

  deleteSession(id: string): void {
    this.agent.deleteSession(id);
  }

  appendMessage(input: { sessionId: string; role: AgentMessage['role']; content: string; blocks?: AgentMessageBlock[]; tokens?: number }): AgentMessage {
    return this.agent.appendMessage(input);
  }

  listMessages(sessionId: string, opts: { limit?: number; beforeSeq?: number } = {}): AgentMessage[] {
    return this.agent.listMessages(sessionId, opts);
  }

  addToolRun(input: { id: string; sessionId: string; messageId?: string; tool: string; args?: unknown; result?: unknown; status: string; risk?: string; approval?: string; durationMs?: number }): void {
    this.agent.addToolRun(input);
    this.pruneRetention();
  }

  listToolRuns(sessionId: string): Array<Record<string, unknown>> {
    return this.agent.listToolRuns(sessionId);
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
    return this.agent.listMemories(opts);
  }

  getMemory(id: string): Memory | undefined {
    return this.agent.getMemory(id);
  }

  createMemory(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): Memory {
    return this.agent.createMemory(candidate, ctx);
  }

  upsertMemoryCandidate(candidate: MemoryCandidate, ctx: { connectionId?: string; database?: string; sessionId?: string; messageId?: string } = {}): { memory: Memory; merged: boolean } {
    return this.agent.upsertMemoryCandidate(candidate, ctx);
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<Memory, 'title' | 'content' | 'kind' | 'importance' | 'confidence' | 'pinned' | 'archived' | 'tags' | 'synonyms'>>,
  ): Memory {
    return this.agent.updateMemory(id, patch);
  }

  deleteMemory(id: string): void {
    this.agent.deleteMemory(id);
  }

  markMemoriesUsed(ids: string[]): void {
    this.agent.markMemoriesUsed(ids);
  }

  searchMemories(
    query: string,
    ctx: { connectionId?: string; database?: string; limit?: number; kinds?: MemoryKind[]; excludeKinds?: MemoryKind[] } = {},
  ): Memory[] {
    return this.agent.searchMemories(query, ctx);
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
    return this.agent.recallForTurn(query, ctx);
  }

  /**
   * 列出覆盖项。`database` 为 undefined 时返回该连接的全部库配置；
   * 传入具体库名（含空串）时精确匹配，避免把 A 库的配置套到 B 库上。
   */
  listAgentContext(connectionId: string, database?: string): AgentContextEntry[] {
    return this.agent.listAgentContext(connectionId, database);
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
    return this.agent.upsertAgentContextEntry(input);
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
    return this.agent.upsertAgentRelation(input);
  }

  deleteAgentContext(id: string): void {
    this.agent.deleteAgentContext(id);
  }

  /** 清空某连接（可选某库）的全部覆盖项，使 Agent 回到未配置的默认行为。 */
  clearAgentContext(connectionId: string, database?: string): number {
    return this.agent.clearAgentContext(connectionId, database);
  }

  /** 批量启用 / 禁用表（表管理面板的「全选 / 反选 / 仅启用勾选」）。 */
  bulkSetAgentContextTables(input: { connectionId: string; database?: string; tables: string[]; enabled: boolean }): number {
    return this.agent.bulkSetAgentContextTables(input);
  }

  /**
   * 聚合为 prompt 可直接消费的结构；无任何配置时返回 inactive bundle。带 30s 缓存，写操作立即失效。
   * 未指定具体库时返回 inactive——无法判断该套用哪个库的配置，宁可退回默认行为也不误伤。
   */
  agentContextBundle(connectionId: string, database?: string): AgentContextBundle {
    return this.agent.agentContextBundle(connectionId, database);
  }

  claimTurn(input: { id: string; sessionId: string; ownerId: string; idempotencyKey: string; deadlineAt?: string }): AgentTurnClaim {
    return this.runtime.claimTurn(input);
  }

  getTurn(id: string): AgentTurnClaim | undefined {
    return this.runtime.getTurn(id);
  }

  listTurns(sessionId: string, limit?: number): AgentTurnClaim[] {
    return this.runtime.listTurns(sessionId, limit);
  }

  finishTurn(id: string, ownerId: string, status: Exclude<AgentTurnStatus, 'running'>, abortCause?: string, terminalEvent?: AgentEvent): boolean {
    return this.runtime.finishTurn(id, ownerId, status, abortCause, terminalEvent);
  }

  setTurnAbortCause(id: string, ownerId: string, cause: string): void {
    this.runtime.setTurnAbortCause(id, ownerId, cause);
  }

  appendAgentEvent(turnId: string, seq: number, event: AgentEvent): void {
    this.runtime.appendAgentEvent(turnId, seq, event);
  }

  agentEvents(turnId: string, after?: number, limit?: number): { events: StoredEvent<AgentEvent>[]; firstSeq?: number; lastSeq: number } {
    return this.runtime.agentEvents(turnId, after, limit);
  }

  appendCommandEvent(runId: string, seq: number, event: CommandRunEvent): void {
    this.runtime.appendCommandEvent(runId, seq, event);
  }

  commandEventReplay(runId: string, after?: number): CommandEventReplay {
    return this.runtime.commandEventReplay(runId, after);
  }

  commandEvents(runId: string, after?: number): StoredEvent<CommandRunEvent>[] {
    return this.runtime.commandEvents(runId, after);
  }

  recoverInterrupted(): RecoveryResult {
    return this.runtime.recoverInterrupted();
  }

  pruneRuntime(): void {
    this.runtime.pruneRuntime();
  }

  listDashboardCards(connectionId: string, database?: string): DashboardCard[] {
    return this.dashboards.listDashboardCards(connectionId, database);
  }

  dashboardCard(id: string): DashboardCard | undefined {
    return this.dashboards.dashboardCard(id);
  }

  insertDashboardCard(input: DashboardCardInput): DashboardCard {
    return this.dashboards.insertDashboardCard(input);
  }

  /** 逐字段更新：undefined 表示不改，null 表示清空该字段。 */
  updateDashboardCard(
    id: string,
    patch: Omit<Partial<DashboardCardInput>, 'timeColumn'> & {
      timeColumn?: string | null;
      lastResult?: DashboardCard['lastResult'];
      lastStatus?: 'ok' | 'error';
      lastError?: string;
      schemaHash?: string | null;
    },
  ): DashboardCard | undefined {
    return this.dashboards.updateDashboardCard(id, patch);
  }

  deleteDashboardCard(id: string): void {
    this.dashboards.deleteDashboardCard(id);
  }

  /**
   * 整批替换草稿卡片：只删 pinned = 0 的行，用户固定的卡片不受影响。
   * 生成器因此永远无法「重设」掉用户攒下的看板。
   */
  setDraftCards(connectionId: string, database: string | undefined, cards: DashboardCardInput[]): DashboardCard[] {
    return this.dashboards.setDraftCards(connectionId, database, cards);
  }

  /** 丢弃当前作用域的全部草稿，保留固定卡片。 */
  discardDashboardDrafts(connectionId: string, database?: string): number {
    return this.dashboards.discardDashboardDrafts(connectionId, database);
  }

  reorderDashboardCards(ids: string[]): DashboardCard[] {
    return this.dashboards.reorderDashboardCards(ids);
  }

  removeDashboardScope(connectionId: string, database?: string): number {
    return this.dashboards.removeDashboardScope(connectionId, database);
  }

  getDashboardSchedule(connectionId: string, database?: string): DashboardScheduleInfo | undefined {
    return this.dashboards.getDashboardSchedule(connectionId, database);
  }

  /** 只列出启用中的定时，供调度器轮询。 */
  listDashboardSchedules(): DashboardScheduleInfo[] {
    return this.dashboards.listDashboardSchedules();
  }

  setDashboardSchedule(input: {
    connectionId: string;
    database?: string;
    intervalSeconds: number;
    enabled: boolean;
    notifyChannels?: string[];
  }): DashboardScheduleInfo | undefined {
    return this.dashboards.setDashboardSchedule(input);
  }

  markDashboardScheduleRun(connectionId: string, database: string | undefined, status: 'ok' | 'error', error?: string): void {
    this.dashboards.markDashboardScheduleRun(connectionId, database, status, error);
  }

  removeDashboardSchedule(connectionId: string, database?: string): void {
    this.dashboards.removeDashboardSchedule(connectionId, database);
  }

  listArtifacts(opts: { type?: ArtifactType; limit?: number; offset?: number } = {}): ArtifactInfo[] {
    return this.artifacts.listArtifacts(opts);
  }

  getArtifact(id: string): ArtifactInfo | undefined {
    return this.artifacts.getArtifact(id);
  }

  createArtifact(input: {
    type: ArtifactType;
    title: string;
    spec: ArtifactSpec;
    status?: 'draft' | 'ready' | 'running' | 'error';
    originSessionId?: string;
    scheduleId?: string;
  }): ArtifactInfo {
    return this.artifacts.createArtifact(input);
  }

  updateArtifact(id: string, patch: { title?: string; spec?: ArtifactSpec; status?: 'draft' | 'ready' | 'running' | 'error'; scheduleId?: string | null }): ArtifactInfo {
    return this.artifacts.updateArtifact(id, patch);
  }

  deleteArtifact(id: string): void {
    this.artifacts.deleteArtifact(id);
  }

  addArtifactRun(input: {
    artifactId: string;
    status: ArtifactRunRow['status'];
    input?: unknown;
    steps?: unknown;
    result?: unknown;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
  }): ArtifactRunInfo {
    const result = this.artifacts.addArtifactRun(input);
    this.pruneRetention();
    return result;
  }

  updateArtifactRun(
    id: string,
    patch: Partial<Pick<ArtifactRunInfo, 'status' | 'steps' | 'result' | 'error' | 'finishedAt' | 'durationMs'>>,
  ): ArtifactRunInfo {
    return this.artifacts.updateArtifactRun(id, patch);
  }

  getArtifactRun(id: string): ArtifactRunInfo | undefined {
    return this.artifacts.getArtifactRun(id);
  }

  listArtifactRuns(artifactId: string, limit = 20): ArtifactRunInfo[] {
    return this.artifacts.listArtifactRuns(artifactId, limit);
  }

  getArtifactSchedule(artifactId: string): ArtifactScheduleInfo | undefined {
    return this.artifacts.getArtifactSchedule(artifactId);
  }

  listArtifactSchedules(): ArtifactScheduleInfo[] {
    return this.artifacts.listArtifactSchedules();
  }

  upsertArtifactSchedule(artifactId: string, input: { intervalSeconds: number; enabled?: boolean; refreshNarrative?: boolean }): ArtifactScheduleInfo {
    return this.artifacts.upsertArtifactSchedule(artifactId, input);
  }

  deleteArtifactSchedule(artifactId: string): void {
    this.artifacts.deleteArtifactSchedule(artifactId);
  }

  setArtifactScheduleNotifyChannels(artifactId: string, channelIds: string[]): ArtifactScheduleInfo {
    return this.artifacts.setArtifactScheduleNotifyChannels(artifactId, channelIds);
  }

  markArtifactScheduleRun(artifactId: string, status: 'ok' | 'error', error?: string): void {
    this.artifacts.markArtifactScheduleRun(artifactId, status, error);
  }

  listMcpServers(): McpServerInfo[] {
    return this.integrations.listMcpServers();
  }

  getMcpServer(id: string): McpServerInfo | undefined {
    return this.integrations.getMcpServer(id);
  }

  getMcpServerEnv(id: string): Record<string, string> {
    return this.integrations.getMcpServerEnv(id);
  }

  createMcpServer(input: { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }): McpServerInfo {
    return this.integrations.createMcpServer(input);
  }

  /** Seed a first-party built-in without overwriting the user's toggles or paths. */
  seedMcpServer(input: { id: string; name: string; command: string; args?: string[]; enabled?: boolean }): void {
    this.integrations.seedMcpServer(input);
  }

  updateMcpServer(
    id: string,
    patch: { name?: string; command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean },
  ): McpServerInfo {
    return this.integrations.updateMcpServer(id, patch);
  }

  deleteMcpServer(id: string): void {
    this.integrations.deleteMcpServer(id);
  }

  // ---------- skill secrets ----------
  listSkillSecretNames(skillId: string): string[] {
    return this.integrations.listSkillSecretNames(skillId);
  }

  getSkillSecrets(skillId: string, names: string[]): Record<string, string> {
    return this.integrations.getSkillSecrets(skillId, names);
  }

  setSkillSecret(skillId: string, name: string, value: string): void {
    this.integrations.setSkillSecret(skillId, name, value);
  }

  deleteSkillSecret(skillId: string, name: string): void {
    this.integrations.deleteSkillSecret(skillId, name);
  }

  listNotificationChannels(): NotificationChannelInfo[] {
    return this.integrations.listNotificationChannels();
  }

  getNotificationChannel(id: string): NotificationChannelInfo | undefined {
    return this.integrations.getNotificationChannel(id);
  }

  getNotificationChannelConfig<T = Record<string, unknown>>(id: string): T | null {
    return this.integrations.getNotificationChannelConfig<T>(id);
  }

  createNotificationChannel(input: {
    name: string;
    type: NotificationChannelType;
    config: Record<string, unknown>;
    summary?: string;
    enabled?: boolean;
  }): NotificationChannelInfo {
    return this.integrations.createNotificationChannel(input);
  }

  updateNotificationChannel(
    id: string,
    patch: { name?: string; config?: Record<string, unknown>; summary?: string; enabled?: boolean },
  ): NotificationChannelInfo {
    return this.integrations.updateNotificationChannel(id, patch);
  }

  deleteNotificationChannel(id: string): void {
    this.integrations.deleteNotificationChannel(id);
  }

  // ---------- devices ----------
  createDevice(input: { name: string; platform: string; tokenHash: string; scope?: DeviceInfo['scope']; connectionIds?: string[] }): DeviceInfo {
    return this.integrations.createDevice(input);
  }

  findDeviceByTokenHash(hash: string): DeviceInfo | undefined {
    return this.integrations.findDeviceByTokenHash(hash);
  }

  listDevices(): DeviceInfo[] {
    return this.integrations.listDevices();
  }

  listDeviceConnectionPermissions(deviceId: string): string[] {
    return this.integrations.listDeviceConnectionPermissions(deviceId);
  }

  canDeviceAccessConnection(deviceId: string, connectionId: string): boolean {
    return this.integrations.canDeviceAccessConnection(deviceId, connectionId);
  }

  setDeviceConnectionPermissions(deviceId: string, connectionIds: string[]): string[] {
    return this.integrations.setDeviceConnectionPermissions(deviceId, connectionIds);
  }

  revokeDevice(id: string): void {
    this.integrations.revokeDevice(id);
  }

  listJobs(): JobInfo[] {
    return this.jobs.listJobs();
  }

  getJob(id: string): JobInfo | undefined {
    return this.jobs.getJob(id);
  }

  createJob(input: { name: string; connectionId: string; database?: string; type: 'query' | 'backup' | 'pipeline'; sql?: string; payload?: JobInfo['payload']; intervalSeconds: number; enabled?: boolean }): JobInfo {
    return this.jobs.createJob(input);
  }

  updateJob(id: string, patch: Partial<Pick<JobInfo, 'name' | 'database' | 'sql' | 'payload' | 'intervalSeconds' | 'enabled' | 'type'>>): JobInfo {
    return this.jobs.updateJob(id, patch);
  }

  deleteJob(id: string): void {
    this.jobs.deleteJob(id);
  }

  markJobRun(id: string, status: 'ok' | 'error' | 'running', error?: string): void {
    this.jobs.markJobRun(id, status, error);
  }

  listPipelines(): PipelineInfo[] {
    return this.jobs.listPipelines();
  }

  getPipeline(id: string): PipelineInfo | undefined {
    return this.jobs.getPipeline(id);
  }

  createPipeline(input: { name: string; description?: string; connectionId?: string; database?: string; spec: PipelineSpec }): PipelineInfo {
    return this.jobs.createPipeline(input);
  }

  updatePipeline(
    id: string,
    patch: Partial<Pick<PipelineInfo, 'name' | 'description' | 'connectionId' | 'database' | 'spec' | 'enabled'>>,
  ): PipelineInfo {
    return this.jobs.updatePipeline(id, patch);
  }

  deletePipeline(id: string): void {
    this.jobs.deletePipeline(id);
  }

  /** 增量断点只在运行成功后回写，失败保留旧值，下次仍从同一水位继续。 */
  setPipelineState(id: string, state: Record<string, unknown>): void {
    this.jobs.setPipelineState(id, state);
  }

  resetPipelineState(id: string): void {
    this.jobs.resetPipelineState(id);
  }

  markPipelineRun(id: string, status: 'ok' | 'error' | 'running', error?: string): void {
    this.jobs.markPipelineRun(id, status, error);
  }

  recordPipelineRun(run: PipelineRunInfo): void {
    this.jobs.recordPipelineRun(run);
  }

  listPipelineRuns(pipelineId: string, limit = 20): PipelineRunInfo[] {
    return this.jobs.listPipelineRuns(pipelineId, limit);
  }

  getPipelineRun(id: string): PipelineRunInfo | undefined {
    return this.jobs.getPipelineRun(id);
  }

  // ---------- pipeline credentials ----------
  /** 凭证与流水线定义分库存储：spec 里只留 id，AI 生成或导出都不会带出密钥。 */
  listPipelineCredentials(): PipelineCredentialInfo[] {
    return this.jobs.listPipelineCredentials();
  }

  createPipelineCredential(input: { name: string; kind: PipelineCredentialInfo['kind']; secret: Record<string, unknown> }): PipelineCredentialInfo {
    return this.jobs.createPipelineCredential(input);
  }

  getPipelineCredentialSecret(id: string): PipelineCredentialSecret | null {
    return this.jobs.getPipelineCredentialSecret(id);
  }

  deletePipelineCredential(id: string): void {
    this.jobs.deletePipelineCredential(id);
  }

  // ---------- audit ----------
  addAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'> & { createdAt?: string }): AuditEntry {
    const result = this.audit.addAudit(entry);
    this.pruneRetention();
    return result;
  }

  listAudit(opts: { limit?: number; offset?: number; connectionId?: string; actor?: string } = {}): AuditEntry[] {
    return this.audit.listAudit(opts);
  }

  close(): void {
    this.storeDb.close();
  }

  /**
   * 启动清扫附件/导出/skill 产物目录（7 天 + 500MB 上限）。dbPath 默认是 <home>/aidb.db，
   * 以其所在目录推导数据根；AIDB_DB 指向别处时跟随该目录，目录不存在则静默跳过。
   * 动态引入 attachments：避免 store 静态依赖它而把整条驱动链拉进存储层；清扫失败绝不阻塞启动。
   */
  private sweepDataDirs(dbPath: string): void {
    if (!dbPath || dbPath === ':memory:') return;
    const home = dirname(dbPath);
    void import('./attachments')
      .then((m) => m.sweepDataDirs([join(home, 'attachments'), join(home, 'exports'), join(home, 'skill-runs')]))
      .catch(() => undefined);
  }

  /**
   * 保留期裁剪统一入口：历史 / 审计 / 工具运行 / 产物运行共用一个节流窗口，
   * 高频写入时最多每 60s 扫一次，而不是每次插入都 O(n)。
   * 非强制裁剪延迟到 setImmediate 执行：node:sqlite 是同步 API，上万行的 DELETE
   * 不该卡在触发它的那次写请求里；节流窗口在调度时就占住，避免堆积多个裁剪任务。
   */
  private pruneScheduled = false;
  private pruneRetention(force = false): void {
    if (force) {
      this.lastPruneAt = Date.now();
      this.runPrune();
      return;
    }
    const now = Date.now();
    if (now - this.lastPruneAt < PRUNE_THROTTLE_MS || this.pruneScheduled) return;
    this.lastPruneAt = now;
    this.pruneScheduled = true;
    setImmediate(() => {
      this.pruneScheduled = false;
      try {
        this.runPrune();
      } catch (err) {
        // 裁剪是后台治理：库已关闭等失败不能炸进程，下个节流窗口再试。
        console.error('[store] 保留期裁剪失败', err);
      }
    });
  }

  private runPrune(): void {
    this.history.pruneHistory();
    this.audit.pruneAuditLog();
    this.agent.pruneToolRuns();
    this.artifacts.pruneArtifactRuns();
    this.runtime.pruneRuntime();
  }

  /** 立即裁剪一次（不受节流限制），供启动与测试 / 手动维护使用。 */
  pruneNow(): void {
    this.pruneRetention(true);
  }
}
