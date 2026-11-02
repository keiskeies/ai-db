import { authToken } from './api';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: 'agent' | 'user';
  at: string;
}

interface Handlers {
  /** 收到某连接的结构变更。 */
  onChange: (event: SchemaChangedEvent) => void;
  /** 重连成功——用于补偿断线期间丢失的事件。 */
  onReconnect: () => void;
}

const MAX_BACKOFF_MS = 30000;

/**
 * 订阅网关的结构变更广播。
 *
 * 只负责连接与重连，业务语义（什么时候真正去拉 schema）由调用方决定。
 * 两种"不必再试"的情形必须终态化，否则会变成安静的无限重连：
 * - 没有 token：生产 Web 构建没带 #token= 时就是这样，连了也会被 4401。
 * - 服务端 4401：令牌无效或被吊销，重试多少次都一样。
 */
export function startSchemaEvents({ onChange, onReconnect }: Handlers): () => void {
  let disposed = false;
  let socket: WebSocket | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  // 首次连上不算"断线重连"：启动时本来就会加载，不必多刷一次。
  let connectedOnce = false;

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
    };

    ws.onmessage = (frame) => {
      let parsed: any;
      try {
        parsed = JSON.parse(String(frame.data));
      } catch {
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
    if (retryTimer) clearTimeout(retryTimer);
    const current = socket;
    socket = undefined;
    current?.close();
  };
}
