#!/usr/bin/env node
/**
 * 仓库内等价入口（保留给现有文档/测试/E2E 使用）。
 * 正式发布物是 packages/aidb-mcp 的 @aidb/mcp，逻辑以 bin/server.mjs 为准，
 * 这里只做转发，避免两份实现漂移。
 */
import '../packages/aidb-mcp/bin/server.mjs';
