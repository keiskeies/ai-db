import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentSettings, AgentSessionMeta, ConnectionConfig, PermissionMode } from '@aidb/core';
import type { BootstrapData, BridgeClient } from '../bridge';
import { notify } from '../lib/utils';

export function useBootstrap(client: BridgeClient, { setConnections, setSessions, setActiveConnectionId, setMode, activeConnectionIdRef, scopeLockedRef, sessionMutationLockedRef }: { setConnections: Dispatch<SetStateAction<ConnectionConfig[]>>; setSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>; setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>; setMode: Dispatch<SetStateAction<PermissionMode>>; activeConnectionIdRef: { current: string | undefined }; scopeLockedRef: { current: boolean }; sessionMutationLockedRef: { current: boolean } }) {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const initializedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const saveAgent = async (patch: Record<string, unknown>) => {
    try {
      const result = await client.updateSettings({ agent: patch as unknown as AgentSettings });
      setBoot((prev) => (prev ? { ...prev, settings: result.settings } : prev));
    } catch (err: any) {
      notify('保存失败', err?.message ?? '无法更新模型设置');
    }
  };

  const bootstrap = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await client.bootstrap();
      setBoot(data);
      setConnections(data.connections);
      setSessions(data.sessions);
      const locked = scopeLockedRef.current || sessionMutationLockedRef.current;
      if (!locked) {
        const current = data.connections.find((conn) => conn.id === activeConnectionIdRef.current);
        // 后续刷新只修复已不存在的连接；不能无条件跳回 connections[0]。
        if (!initializedRef.current || !current) {
          const conn = current ?? data.connections[0];
          if (conn) setActiveConnectionId(conn.id);
        }
        if (!initializedRef.current) setMode('readonly');
      }
      initializedRef.current = true;
    } catch (err: any) {
      setError(err?.message ?? '无法连接 Bridge');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  return { boot, loading, error, connected, setConnected, bootstrap, saveAgent };
}
