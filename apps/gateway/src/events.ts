/**
 * 结构变更事件总线。
 *
 * 只负责「把结构变了这个事实送到所有在线客户端」。不带变更明细（见设计文档 §2 非目标），
 * 由客户端自己重新拉一次 schema。放在网关而非 @aidb/core：只有网关生产这类事件，
 * 客户端只需要事件形状，用本地 interface 声明即可。
 */
export type SchemaChangeCause = 'agent' | 'user';

export interface SchemaChangedEvent {
  type: 'schema_changed';
  connectionId: string;
  cause: SchemaChangeCause;
  /** ISO 时间戳，仅用于日志与排障。 */
  at: string;
}

export class GatewayEvents {
  private listeners = new Set<(event: SchemaChangedEvent) => void>();

  emitSchemaChanged(event: SchemaChangedEvent): void {
    for (const listener of this.listeners) {
      // 一个坏监听不能拖垮触发它的那次 DB 操作：DB 已经改完了，事件只是通知。
      try {
        listener(event);
      } catch (err) {
        console.error('[events] schema_changed listener failed', err);
      }
    }
  }

  onSchemaChanged(listener: (event: SchemaChangedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
