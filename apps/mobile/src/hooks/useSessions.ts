import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentMessage, AgentSessionMeta, PermissionMode } from '@aidb/core';
import type { BridgeClient } from '../bridge';
import { confirmAction, notify } from '../lib/utils';
import type { LiveTurn, PickerKind } from '../types';

export function useSessions(client: BridgeClient, { activeConnectionId, activeDatabase, databases, setActiveConnectionId, setActiveDatabase, activeConnectionIdRef, preferredDatabaseRef }: { activeConnectionId: string | undefined; activeDatabase: string | undefined; databases: string[]; setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>; setActiveDatabase: Dispatch<SetStateAction<string | undefined>>; activeConnectionIdRef: { current: string | undefined }; preferredDatabaseRef: { current: string | undefined } }, { mode, setMode, setLive, setPicker }: { mode: PermissionMode; setMode: Dispatch<SetStateAction<PermissionMode>>; setLive: Dispatch<SetStateAction<LiveTurn | undefined>>; setPicker: Dispatch<SetStateAction<PickerKind>> }) {
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionView, setSessionView] = useState<'active' | 'archived'>('active');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionMeta, setSessionMeta] = useState<AgentSessionMeta | undefined>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  const [sessionQuery, setSessionQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);

  const sessionIdRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const refreshSessions = async () => {
    try {
      const result = await client.sessions();
      setSessions(result.sessions);
    } catch {
      /* ignore */
    }
  };

  const refreshArchivedSessions = async () => {
    try {
      const result = await client.sessions(true);
      setArchivedSessions(result.sessions);
    } catch {
      /* ignore */
    }
  };

  const refreshSession = async (id: string) => {
    try {
      const detail = await client.session(id);
      setMessages(detail.messages);
      setSessionMeta(detail.session);
    } catch {
      /* ignore */
    } finally {
      setLive(undefined);
    }
  };

  const openSession = async (id: string) => {
    try {
      const detail = await client.session(id);
      setSessionId(id);
      setSessionMeta(detail.session);
      setMessages(detail.messages);
      setMode(detail.session.permissionMode);
      setLive(undefined);
      setPicker(null);
      if (detail.session.connectionId) {
        const sessionDb = detail.session.database;
        if (detail.session.connectionId === activeConnectionIdRef.current) {
          if (sessionDb && sessionDb !== activeDatabase && databases.includes(sessionDb)) setActiveDatabase(sessionDb);
        } else {
          preferredDatabaseRef.current = sessionDb;
          setActiveConnectionId(detail.session.connectionId);
        }
      }
    } catch (err: any) {
      notify('打开会话失败', err?.message ?? '');
    }
  };

  const newSession = async () => {
    try {
      const created = await client.createSession({ connectionId: activeConnectionId, database: activeDatabase, permissionMode: mode });
      setSessionId(created.session.id);
      setSessionMeta(created.session);
      setMessages([]);
      setLive(undefined);
      setPicker(null);
      void refreshSessions();
    } catch (err: any) {
      notify('新建失败', err?.message ?? '');
    }
  };

  const deleteSession = async (id: string) => {
    if (!(await confirmAction('删除会话', '会话消息将被永久删除，记忆会保留。', '删除'))) return;
    try {
      await client.deleteSession(id);
      if (sessionId === id) {
        setSessionId(undefined);
        setSessionMeta(undefined);
        setMessages([]);
      }
      void refreshSessions();
    } catch (err: any) {
      notify('删除失败', err?.message ?? '');
    }
  };

  return { sessions, setSessions, archivedSessions, setArchivedSessions, sessionView, setSessionView, sessionId, setSessionId, sessionMeta, setSessionMeta, messages, setMessages, sessionQuery, setSessionQuery, renameTarget, setRenameTarget, sessionIdRef, refreshSessions, refreshArchivedSessions, refreshSession, openSession, newSession, deleteSession };
}
