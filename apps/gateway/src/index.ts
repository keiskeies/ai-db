import { createGateway } from './server';

const gateway = await createGateway();
const { config, server } = gateway;

server.on('error', (err) => {
  console.error('[gateway] server error:', err);
  process.exitCode = 1;
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
