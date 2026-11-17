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
