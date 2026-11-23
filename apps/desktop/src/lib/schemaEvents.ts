import { authToken } from './api';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: 'agent' | 'user';
  at: string;
}

export interface ConnectionsChangedEvent {
  type: 'connections_changed';
  connectionId: string;
  change: 'created' | 'updated' | 'deleted';
  at: string;
}

interface Handlers {
  /** 收到某连接的结构变更。 */
  onChange: (event: SchemaChangedEvent) => void;
  /** 连接成员或配置变化后重新拉取连接列表。 */
  onConnectionsChange: (event: ConnectionsChangedEvent) => void;
  /** 重连成功——用于补偿断线期间丢失的事件。 */
  onReconnect: () => void;
}

const MAX_BACKOFF_MS = 30000;
// 契约 K3：每 30s 发一帧应用层 ping，10s 内没有任何入站消息（pong 或其它）就判死连接。
// 半开的 WS 不会触发 onclose，只有主动探测才能发现；判死后 close 交给 onclose 走指数退避重连。
const PING_INTERVAL_MS = 30000;
const PONG_TIMEOUT_MS = 10000;

/**
 * 订阅网关的结构与连接列表变更广播。
 *
 * 只负责连接与重连，业务语义（什么时候重新拉 schema / 连接列表）由调用方决定。
 * 两种"不必再试"的情形必须终态化，否则会变成安静的无限重连：
 * - 没有 token：生产 Web 构建没带 #token= 时就是这样，连了也会被 4401。
 * - 服务端 4401：令牌无效或被吊销，重试多少次都一样。
 */
export function startSchemaEvents({ onChange, onConnectionsChange, onReconnect }: Handlers): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let pongTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  // 首次连上不算"断线重连"：启动时本来就会加载，不必多刷一次。
  let connectedOnce = false;

  const clearHeartbeat = () => {
    if (pingTimer) clearInterval(pingTimer);
    if (pongTimer) clearTimeout(pongTimer);
    pingTimer = undefined;
    pongTimer = undefined;
  };

  const connect = () => {
    if (disposed) return;
    const token = authToken();
    if (!token) return; // 终态：没有凭据，不自欺欺人地重试。

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
    socket = ws;

    ws.onopen = () => {
      attempt = 0;
      if (connectedOnce) onReconnect();
      connectedOnce = true;
      clearHeartbeat();
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {
          return;
        }
        // 服务端尚未实现 pong 时这里会到期并重连——退避已有，不会形成风暴。
        if (pongTimer) clearTimeout(pongTimer);
        pongTimer = setTimeout(() => {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        }, PONG_TIMEOUT_MS);
      }, PING_INTERVAL_MS);
    };

    ws.onmessage = (frame) => {
      // 任何入站消息（pong 或业务帧）都说明通道还活着，解除死连接判定。
      if (pongTimer) {
        clearTimeout(pongTimer);
        pongTimer = undefined;
      }
      let parsed: any;
      try {
        parsed = JSON.parse(String(frame.data));
      } catch {
        return;
      }
      if (parsed?.type === 'pong') return;
      if (parsed?.type === 'connections_changed' && typeof parsed.connectionId === 'string') {
        onConnectionsChange({
          type: 'connections_changed',
          connectionId: parsed.connectionId,
          change: parsed.change === 'created' || parsed.change === 'deleted' ? parsed.change : 'updated',
          at: String(parsed.at ?? ''),
        });
        return;
      }
      if (parsed?.type !== 'schema_changed' || typeof parsed.connectionId !== 'string') return;
      onChange({
        type: 'schema_changed',
        connectionId: parsed.connectionId,
        cause: parsed.cause === 'agent' ? 'agent' : 'user',
        at: String(parsed.at ?? ''),
      });
    };

    ws.onclose = (event) => {
      clearHeartbeat();
      socket = undefined;
      if (disposed) return;
      // 4401 是服务端明确的"你没资格"，重连只会得到同一个答案。
      if (event.code === 4401) return;
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    // onerror 之后一定会跟一个 onclose，重连交给 onclose，避免同一次故障排两次队。
    ws.onerror = () => undefined;
  };

  connect();

  return () => {
    disposed = true;
    clearHeartbeat();
    if (retryTimer) clearTimeout(retryTimer);
    const current = socket;
    socket = undefined;
    current?.close();
  };
}
