import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentSettings, AgentSessionMeta, ConnectionConfig, PermissionMode } from '@aidb/core';
import type { BootstrapData, BridgeClient } from '../bridge';
import { notify } from '../lib/utils';

export function useBootstrap(client: BridgeClient, { setConnections, setSessions, setActiveConnectionId, setMode }: { setConnections: Dispatch<SetStateAction<ConnectionConfig[]>>; setSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>; setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>; setMode: Dispatch<SetStateAction<PermissionMode>> }) {
  const [boot, setBoot] = useState<BootstrapData | null>(null);
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
      const conn = data.connections[0];
      if (conn) setActiveConnectionId(conn.id);
      setMode('readonly');
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
