import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConnectionConfig, TableInfo } from '@aidb/core';
import type { BridgeClient, DataPage } from '../bridge';
import type { PickerKind } from '../types';

export function useSchema(client: BridgeClient, { setPicker, setSelectedTable, setDataPage, scopeLockedRef, sessionMutationLockedRef }: { setPicker: Dispatch<SetStateAction<PickerKind>>; setSelectedTable: Dispatch<SetStateAction<TableInfo | null>>; setDataPage: Dispatch<SetStateAction<DataPage | null>>; scopeLockedRef?: { current: boolean }; sessionMutationLockedRef?: { current: boolean } }) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | undefined>();
  const [databases, setDatabases] = useState<string[]>([]);
  const [activeDatabase, setActiveDatabase] = useState<string | undefined>();
  const [databaseReadyFor, setDatabaseReadyFor] = useState<string | undefined>();
  const [tables, setTables] = useState<TableInfo[]>([]);

  const activeConnectionIdRef = useRef<string | undefined>(undefined);
  const activeDatabaseRef = useRef<string | undefined>(undefined);
  const databaseReadyForRef = useRef<string | undefined>(undefined);
  const schemaRequestRef = useRef(0);
  const preferredDatabaseRef = useRef<string | undefined>(undefined);
  const pendingDatabasePickerRef = useRef(false);
  const schemaPendingRef = useRef<{ connectionId: string; database?: string } | undefined>(undefined);

  const updateActiveConnectionId: Dispatch<SetStateAction<string | undefined>> = (value) => {
    schemaRequestRef.current += 1;
    schemaPendingRef.current = undefined;
    setActiveConnectionId((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      activeConnectionIdRef.current = next;
      return next;
    });
  };

  const updateActiveDatabase: Dispatch<SetStateAction<string | undefined>> = (value) => {
    schemaRequestRef.current += 1;
    schemaPendingRef.current = undefined;
    setActiveDatabase((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      activeDatabaseRef.current = next;
      return next;
    });
  };

  const activeConnection = connections.find((c) => c.id === activeConnectionId);

  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId;
  }, [activeConnectionId]);

  useEffect(() => {
    activeDatabaseRef.current = activeDatabase;
  }, [activeDatabase]);

  const loadSchema = async (connectionId?: string, database?: string) => {
    const request = ++schemaRequestRef.current;
    if (!connectionId) {
      schemaPendingRef.current = undefined;
      setTables([]);
      return;
    }
    const snapshot = { connectionId, database };
    schemaPendingRef.current = snapshot;
    const isLatest = () => schemaRequestRef.current === request
      && schemaPendingRef.current?.connectionId === connectionId
      && schemaPendingRef.current?.database === database;
    try {
      const result = await client.schema(connectionId, database);
      if (isLatest()) setTables(result.schemas.flatMap((schema) => schema.tables));
    } catch {
      if (isLatest()) setTables([]);
    } finally {
      if (schemaRequestRef.current === request) schemaPendingRef.current = undefined;
    }
  };

  const scopeBlocked = (scopeLockedRef?.current ?? false) || (sessionMutationLockedRef?.current ?? false);

  useEffect(() => {
    if (!activeConnectionId) {
      databaseReadyForRef.current = undefined;
      setDatabases([]);
      updateActiveDatabase(undefined);
      setDatabaseReadyFor(undefined);
      setTables([]);
      return;
    }
    if (scopeBlocked) return;
    let cancelled = false;
    (async () => {
      let list: string[];
      try {
        list = (await client.databases(activeConnectionId)).databases ?? [];
      } catch {
        // 列表失败时尚未校验 preferredDatabase，保留它供下次加载使用。
        return;
      }
      if (cancelled || scopeLockedRef?.current || sessionMutationLockedRef?.current) return;
      const wasReady = databaseReadyForRef.current === activeConnectionId;
      const currentDatabase = activeDatabaseRef.current;
      setDatabases(list);
      const conn = connections.find((item) => item.id === activeConnectionId);
      const preferredSession = preferredDatabaseRef.current;
      preferredDatabaseRef.current = undefined;
      const preferred =
        (preferredSession && list.includes(preferredSession) ? preferredSession : undefined) ??
        (wasReady && currentDatabase && list.includes(currentDatabase) ? currentDatabase : undefined) ??
        (conn?.database && list.includes(conn.database) ? conn.database : undefined) ??
        list[0] ??
        conn?.database;
      updateActiveDatabase(preferred);
      databaseReadyForRef.current = activeConnectionId;
      setDatabaseReadyFor(activeConnectionId);
      if (pendingDatabasePickerRef.current) {
        pendingDatabasePickerRef.current = false;
        if (list.length > 1) setPicker('databases');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, scopeBlocked]);

  useEffect(() => {
    schemaRequestRef.current += 1;
    schemaPendingRef.current = undefined;
    setSelectedTable(null);
    setDataPage(null);
    setDatabases([]);
    databaseReadyForRef.current = undefined;
    setDatabaseReadyFor(undefined);
    setTables([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  useEffect(() => {
    if (!activeConnectionId || databaseReadyFor !== activeConnectionId) return;
    void loadSchema(activeConnectionId, activeDatabase);
    setSelectedTable(null);
    setDataPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, activeDatabase, databaseReadyFor]);

  return { connections, setConnections, activeConnectionId, setActiveConnectionId: updateActiveConnectionId, databases, activeDatabase, setActiveDatabase: updateActiveDatabase, databaseReadyFor, tables, activeConnection, loadSchema, activeConnectionIdRef, activeDatabaseRef, preferredDatabaseRef, pendingDatabasePickerRef };
}
