/**
 * 网关变更事件总线。
 *
 * 只负责把「结构变了」或「连接列表变了」送到所有在线客户端，不带变更明细；
 * 客户端按事件类型重新拉取 schema 或连接列表。放在网关而非 @aidb/core：
 * 只有网关生产这类事件，客户端用本地 interface 声明形状即可。
 */
export type SchemaChangeCause = 'agent' | 'user';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: SchemaChangeCause;
  /** ISO 时间戳，仅用于日志与排障。 */
  at: string;
}

export interface ConnectionsChangedEvent {
  type: 'connections_changed';
  connectionId: string;
  change: 'created' | 'updated' | 'deleted';
  at: string;
}

export class GatewayEvents {
  private schemaListeners = new Set<(event: SchemaChangedEvent) => void>();
  private connectionListeners = new Set<(event: ConnectionsChangedEvent) => void>();

  emitSchemaChanged(event: SchemaChangedEvent): void {
    for (const listener of this.schemaListeners) {
      // 一个坏监听不能拖垮触发它的那次 DB 操作：DB 已经改完了，事件只是通知。
      try {
        listener(event);
      } catch (err) {
        console.error('[events] schema_changed listener failed', err);
      }
    }
  }

  onSchemaChanged(listener: (event: SchemaChangedEvent) => void): () => void {
    this.schemaListeners.add(listener);
    return () => this.schemaListeners.delete(listener);
  }

  emitConnectionsChanged(event: ConnectionsChangedEvent): void {
    for (const listener of this.connectionListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[events] connections_changed listener failed', err);
      }
    }
  }

  onConnectionsChanged(listener: (event: ConnectionsChangedEvent) => void): () => void {
    this.connectionListeners.add(listener);
    return () => this.connectionListeners.delete(listener);
  }
}
