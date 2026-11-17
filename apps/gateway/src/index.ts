import { createGateway } from './server';

const gateway = await createGateway();
const { config, server } = gateway;

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[gateway] 端口 ${config.port} 已被占用，无法启动。请停止占用该端口的进程，或换端口（AIDB_PORT）后重试。`);
  } else {
    console.error('[gateway] server error:', err);
  }
  // 监听失败后进程没有服务能力，受控退出而不是留着不监听的空壳。
  process.exit(1);
});

// G7：显式配置 HTTP 超时，防慢速请求攻击与半开连接无限占用资源。
// requestTimeout 只覆盖「请求接收」阶段（请求收全即清除计时器），不含响应
// 输出——已实测验证不误伤 SSE（600ms requestTimeout 下 2.5s SSE 流正常完成）。
// 三者保持 keepAliveTimeout < headersTimeout < requestTimeout 的合理次序。
server.requestTimeout = 120_000;
server.headersTimeout = 60_000;
server.keepAliveTimeout = 10_000;

server.listen(config.port, config.host, () => {
  console.log(`[gateway] AiDB Bridge v${config.version}`);
  console.log(`[gateway] listening on http://${config.host}:${config.port}`);
  console.log(`[gateway] home: ${config.home}`);
  if (!config.production) console.log(`[gateway] dev token: ${config.token}`);
});

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[gateway] ${signal} received, shutting down…`);
  try {
    await gateway.close();
  } catch (err) {
    console.error('[gateway] shutdown error:', err);
  }
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('[gateway] unhandled rejection:', reason));
