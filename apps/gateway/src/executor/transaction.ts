import { defineTool, ok, agentTxKey } from './types';

export const beginTransactionTool = defineTool('begin_transaction', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  const conn = s.requireConnection(call, ctx);
  const database = s.databaseOf(call, conn);
  const result = await s.manager.beginTransaction(agentTxKey(ctx), conn.id, { database, actor: 'agent' });
  return ok(started, '事务已开启', result);
});

export const commitTransactionTool = defineTool('commit_transaction', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  // requireConnection 仍要调：它负责校验连接存在并把连接 id 补进 ctx，
  // 删掉会改变错误行为。只是不再需要它的返回值。
  s.requireConnection(call, ctx);
  const result = await s.manager.commitTransaction(agentTxKey(ctx), 'agent');
  return ok(started, '事务已提交', result);
});

export const rollbackTransactionTool = defineTool('rollback_transaction', async (call, ctx, s) => {
  const a = call.args;
  const started = s.started;
  s.requireConnection(call, ctx);
  const result = await s.manager.rollbackTransaction(agentTxKey(ctx), 'agent');
  return ok(started, '事务已回滚', result);
});
