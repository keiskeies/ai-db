import { TOOLS } from '@aidb/core';
import type { ToolHandler } from './types';
import { listConnectionsTool, inspectSchemaTool, searchObjectsTool } from './schema';
import { createConnectionTool, probeEngineTool } from './connections';
import { beginTransactionTool, commitTransactionTool, rollbackTransactionTool } from './transaction';
import { runSqlTool, runMqlTool, runRedisTool, runCypherTool, runCqlTool, runAqlTool, vectorSearchTool, searchIndexTool, explainSqlTool, sampleRowsTool, profileColumnTool } from './query';
import { createCollectionTool, deleteCollectionTool, upsertDocumentTool, writeLineProtocolTool, importDocumentsTool, deleteDocumentsTool } from './documents';
import { createTableTool, alterTableTool, dropObjectTool, manageIndexTool } from './ddl';
import { exportResultTool, importCsvTool, backupDatabaseTool, getQueryHistoryTool } from './dataops';
import { updatePlanTool, memoryWriteTool, memorySearchTool } from './agentState';
import { auditDatabaseTool, checkDataQualityTool, generateDataTool, renderChartTool, analyzeChartTool, forecastChartTool, schemaDiffTool, reconDataTool } from './analysis';
import { skillListTool, skillReadTool, skillWriteTool, skillRunTool, skillListFilesTool, skillWorkerRunTool } from './skills';
import { mcpListServersTool, mcpListToolsTool, mcpCallTool } from './mcp';
import { transferDataTool, managePipelineTool } from './transfer';

const entries = [
  listConnectionsTool,
  probeEngineTool,
  createConnectionTool,
  inspectSchemaTool,
  searchObjectsTool,
  beginTransactionTool,
  commitTransactionTool,
  rollbackTransactionTool,
  runSqlTool,
  runMqlTool,
  runRedisTool,
  runCypherTool,
  runCqlTool,
  runAqlTool,
  vectorSearchTool,
  searchIndexTool,
  explainSqlTool,
  sampleRowsTool,
  profileColumnTool,
  createCollectionTool,
  deleteCollectionTool,
  upsertDocumentTool,
  writeLineProtocolTool,
  importDocumentsTool,
  deleteDocumentsTool,
  createTableTool,
  alterTableTool,
  dropObjectTool,
  manageIndexTool,
  exportResultTool,
  importCsvTool,
  backupDatabaseTool,
  getQueryHistoryTool,
  updatePlanTool,
  memoryWriteTool,
  memorySearchTool,
  auditDatabaseTool,
  checkDataQualityTool,
  generateDataTool,
  renderChartTool,
  analyzeChartTool,
  forecastChartTool,
  schemaDiffTool,
  reconDataTool,
  skillListTool,
  skillReadTool,
  skillWriteTool,
  skillRunTool,
  skillListFilesTool,
  skillWorkerRunTool,
  mcpListServersTool,
  mcpListToolsTool,
  mcpCallTool,
  transferDataTool,
  managePipelineTool,
];

export const toolRegistry: ReadonlyMap<string, ToolHandler> = new Map(entries.map((entry) => [entry.name, entry.handler] as const));

// 原 switch 的重复 case 标签编译期就会被挡；注册式同名会静默后者覆盖前者，启动即失败补上这道闸。
if (toolRegistry.size !== entries.length) throw new Error('存在重复注册的工具名');

// 启动自检（C2.4）：与 TOOLS 声明双向对齐，启动即失败，而不是运行期才报 UNKNOWN_TOOL。
const declared = new Set(TOOLS.map((tool) => tool.name));
for (const name of declared) {
  if (!toolRegistry.has(name)) throw new Error(`工具已声明但未注册：${name}`);
}
for (const name of toolRegistry.keys()) {
  if (!declared.has(name)) throw new Error(`工具已注册但未声明：${name}`);
}
