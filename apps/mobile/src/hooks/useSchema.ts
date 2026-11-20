import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { ConnectionConfig, TableInfo } from '@aidb/core';
import type { BridgeClient, DataPage } from '../bridge';
import type { PickerKind } from '../types';

export function useSchema(client: BridgeClient, { setPicker, setSelectedTable, setDataPage }: { setPicker: Dispatch<SetStateAction<PickerKind>>; setSelectedTable: Dispatch<SetStateAction<TableInfo | null>>; setDataPage: Dispatch<SetStateAction<DataPage | null>> }) {
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | undefined>();
  const [databases, setDatabases] = useState<string[]>([]);
  const [activeDatabase, setActiveDatabase] = useState<string | undefined>();
  const [databaseReadyFor, setDatabaseReadyFor] = useState<string | undefined>();
  const [tables, setTables] = useState<TableInfo[]>([]);

  const activeConnectionIdRef = useRef<string | undefined>(undefined);
  const activeDatabaseRef = useRef<string | undefined>(undefined);
  const schemaInFlightRef = useRef(false);
  const preferredDatabaseRef = useRef<string | undefined>(undefined);
  const pendingDatabasePickerRef = useRef(false);
  const schemaPendingRef = useRef(false);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);

  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId;
  }, [activeConnectionId]);

  useEffect(() => {
    activeDatabaseRef.current = activeDatabase;
  }, [activeDatabase]);

  const loadSchema = async (connectionId?: string, database?: string) => {
    if (!connectionId) {
      setTables([]);
      return;
    }
    if (schemaInFlightRef.current) {
      // 在飞请求可能早于 invalidate 发出、回来的是旧结构。丢掉这次事件就永久丢了，
      // 所以只记账，等它结束后补跑一次。
      schemaPendingRef.current = true;
      return;
    }
    schemaInFlightRef.current = true;
    try {
      const result = await client.schema(connectionId, database);
      setTables(result.schemas.flatMap((schema) => schema.tables));
    } catch {
      setTables([]);
    } finally {
      schemaInFlightRef.current = false;
      if (schemaPendingRef.current) {
        schemaPendingRef.current = false;
        void loadSchema(connectionId, database);
      }
    }
  };

  useEffect(() => {
    if (!activeConnectionId) {
      setDatabases([]);
      setActiveDatabase(undefined);
      setDatabaseReadyFor(undefined);
      setTables([]);
      return;
    }
    let cancelled = false;
    (async () => {
      let list: string[] = [];
      try {
        list = (await client.databases(activeConnectionId)).databases ?? [];
      } catch {
        list = [];
      }
      if (cancelled) return;
      setDatabases(list);
      const conn = connections.find((item) => item.id === activeConnectionId);
      const preferredSession = preferredDatabaseRef.current;
      preferredDatabaseRef.current = undefined;
      const preferred =
        (preferredSession && list.includes(preferredSession) ? preferredSession : undefined) ??
        (conn?.database && list.includes(conn.database) ? conn.database : undefined) ??
        list[0] ??
        conn?.database;
      setActiveDatabase(preferred);
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
  }, [activeConnectionId, connections]);

  useEffect(() => {
    setSelectedTable(null);
    setDataPage(null);
    setDatabases([]);
    setDatabaseReadyFor(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  useEffect(() => {
    if (!activeConnectionId || databaseReadyFor !== activeConnectionId) return;
    void loadSchema(activeConnectionId, activeDatabase);
    setSelectedTable(null);
    setDataPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, activeDatabase, databaseReadyFor]);

  return { connections, setConnections, activeConnectionId, setActiveConnectionId, databases, activeDatabase, setActiveDatabase, databaseReadyFor, tables, activeConnection, loadSchema, activeConnectionIdRef, activeDatabaseRef, preferredDatabaseRef, pendingDatabasePickerRef };
}
