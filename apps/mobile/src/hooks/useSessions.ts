import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentMessage, AgentSessionMeta, PermissionMode } from '@aidb/core';
import { requestWithTimeout, type BridgeClient } from '../bridge';
import { confirmAction, notify } from '../lib/utils';
import { isLiveTurnRunning } from '../components/chat/turnModel';
import type { AgentTurnRef, ApprovalState, LiveTurn, PickerKind } from '../types';

interface SessionOptions {
  activeConnectionId: string | undefined;
  activeDatabase: string | undefined;
  databases: string[];
  databaseReadyFor: string | undefined;
  setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>;
  setActiveDatabase: Dispatch<SetStateAction<string | undefined>>;
  activeConnectionIdRef: { current: string | undefined };
  preferredDatabaseRef: { current: string | undefined };
}

const SESSION_REQUEST_TIMEOUT_MS = 15_000;

interface SessionStateOptions {
  mode: PermissionMode;
  setMode: Dispatch<SetStateAction<PermissionMode>>;
  live: LiveTurn | undefined;
  turnRef: AgentTurnRef;
  setLive: Dispatch<SetStateAction<LiveTurn | undefined>>;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalState[]>>;
  setPicker: Dispatch<SetStateAction<PickerKind>>;
  sessionMutationLockedRef?: { current: boolean };
  scopeLockedRef?: { current: boolean };
}

export function useSessions(client: BridgeClient, options: SessionOptions, state: SessionStateOptions) {
  const { activeConnectionId, activeDatabase, databases, databaseReadyFor, setActiveConnectionId, setActiveDatabase, activeConnectionIdRef, preferredDatabaseRef } = options;
  const { mode, setMode, live, turnRef, setLive, setApprovalQueue, setPicker, sessionMutationLockedRef, scopeLockedRef } = state;
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionView, setSessionView] = useState<'active' | 'archived'>('active');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionMeta, setSessionMeta] = useState<AgentSessionMeta | undefined>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);

  const [sessionMutating, setSessionMutating] = useState(false);
  const localSessionMutationLockedRef = useRef(false);
  const mutationLockedRef = sessionMutationLockedRef ?? localSessionMutationLockedRef;
  const [sessionQuery, setSessionQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);

  const sessionIdRef = useRef<string | undefined>(undefined);
  const sessionMutationSeqRef = useRef(0);
  const sessionsRequestRef = useRef(0);
  const archivedSessionsRequestRef = useRef(0);
  const sessionDetailRequestRef = useRef(0);

  const beginSessionMutation = () => {
    if (mutationLockedRef.current) return 0;
    mutationLockedRef.current = true;
    setSessionMutating(true);
    return ++sessionMutationSeqRef.current;
  };

  const endSessionMutation = (operation: number) => {
    if (sessionMutationSeqRef.current !== operation) return;
    mutationLockedRef.current = false;
    setSessionMutating(false);
  };

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const updateSessionId: Dispatch<SetStateAction<string | undefined>> = (value) => {
    setSessionId((prev) => {
      const next = typeof value === 'function' ? value(prev) : value;
      sessionIdRef.current = next;
      return next;
    });
  };

  const updateSessions: Dispatch<SetStateAction<AgentSessionMeta[]>> = (value) => {
    sessionsRequestRef.current += 1;
    setSessions(value);
  };

  const updateArchivedSessions: Dispatch<SetStateAction<AgentSessionMeta[]>> = (value) => {
    archivedSessionsRequestRef.current += 1;
    setArchivedSessions(value);
  };

  const refreshSessions = async () => {
    const request = ++sessionsRequestRef.current;
    try {
      const result = await client.sessions();
      if (sessionsRequestRef.current === request) setSessions(result.sessions);
    } catch {
      /* ignore */
    }
  };

  const refreshArchivedSessions = async () => {
    const request = ++archivedSessionsRequestRef.current;
    try {
      const result = await client.sessions(true);
      if (archivedSessionsRequestRef.current === request) setArchivedSessions(result.sessions);
    } catch {
      /* ignore */
    }
  };

  const refreshSession = async (id: string, _options: { finalize?: boolean } = {}) => {
    const turn = turnRef.current;
    const request = ++sessionDetailRequestRef.current;
    const matches = () => sessionDetailRequestRef.current === request && sessionIdRef.current === id && turnRef.current === turn;
    let refreshed = false;
    try {
      const detail = await requestWithTimeout(
        (signal) => client.session(id, { signal }),
        SESSION_REQUEST_TIMEOUT_MS,
        '读取会话超时，请重试。',
      );
      if (!matches()) return;
      setSessionMeta(detail.session);
      // turn_end 只表示本次 WebSocket 请求结束；会话仍 running 时不能清掉 live/turn，
      // 否则 SESSION_BUSY 等拒绝路径会连正在运行的回合和停止入口一起抹掉。
      if (detail.session.status === 'running') return;
      setMessages(detail.messages);
      refreshed = true;
    } catch {
      // GET 失败不代表服务端回合已结束；保留 live/turn/approval 所有权，允许后续重试。
      return;
    } finally {
      if (refreshed && matches()) {
        setLive(undefined);
        turnRef.current = undefined;
        setApprovalQueue((queue) => queue.filter((item) => item.generation !== turn?.generation || item.sessionId !== id));
      }
    }
  };

  const guardRunning = () => {
    if (scopeLockedRef?.current || mutationLockedRef.current) {
      notify('Agent 正在处理', '请等当前发送或会话操作完成后再切换会话。');
      return false;
    }
    const running = turnRef.current ? isLiveTurnRunning(turnRef.current) : Boolean(live && isLiveTurnRunning(live));
    if (!running) return true;
    notify('Agent 正在运行', '请先停止当前回合。');
    return false;
  };

  const openSession = async (id: string) => {
    if (!guardRunning()) return;
    const operation = beginSessionMutation();
    if (!operation) return;
    const previousSessionId = sessionIdRef.current;
    const previousTurn = turnRef.current;
    try {
      const detail = await requestWithTimeout(
        (signal) => client.session(id, { signal }),
        SESSION_REQUEST_TIMEOUT_MS,
        '读取会话超时，请重试。',
      );
      if (sessionMutationSeqRef.current !== operation || sessionIdRef.current !== previousSessionId || turnRef.current !== previousTurn) return;
      sessionIdRef.current = id;
      turnRef.current = undefined;
      setSessionId(id);
      setSessionMeta(detail.session);
      setMessages(detail.messages);
      setMode(detail.session.permissionMode);
      setLive(undefined);
      setApprovalQueue([]);
      setPicker(null);
      if (detail.session.connectionId) {
        const sessionDb = detail.session.database;
        if (detail.session.connectionId === activeConnectionIdRef.current) {
          if (sessionDb && sessionDb !== activeDatabase) {
            if (databases.includes(sessionDb)) {
              preferredDatabaseRef.current = undefined;
              setActiveDatabase(sessionDb);
            } else if (databaseReadyFor !== detail.session.connectionId) {
              // 数据库列表尚未返回时先保留会话库，列表回来后校验再应用。
              preferredDatabaseRef.current = sessionDb;
            }
          }
        } else {
          preferredDatabaseRef.current = sessionDb;
          setActiveConnectionId(detail.session.connectionId);
        }
      }
    } catch (err: any) {
      notify('打开会话失败', err?.message ?? '');
    } finally {
      endSessionMutation(operation);
    }
  };

  const newSession = async () => {
    if (!guardRunning()) return;
    const operation = beginSessionMutation();
    if (!operation) return;
    const previousSessionId = sessionIdRef.current;
    const previousTurn = turnRef.current;
    try {
      const created = await requestWithTimeout(
        (signal) => client.createSession({ connectionId: activeConnectionId, database: activeDatabase, permissionMode: mode }, { signal }),
        SESSION_REQUEST_TIMEOUT_MS,
        '创建会话超时，请重试。',
      );
      if (sessionMutationSeqRef.current !== operation || sessionIdRef.current !== previousSessionId || turnRef.current !== previousTurn) return;
      sessionIdRef.current = created.session.id;
      turnRef.current = undefined;
      setSessionId(created.session.id);
      setSessionMeta(created.session);
      setMessages([]);
      setLive(undefined);
      setApprovalQueue([]);
      setPicker(null);
      void refreshSessions();
    } catch (err: any) {
      notify('新建失败', err?.message ?? '');
    } finally {
      endSessionMutation(operation);
    }
  };

  const deleteSession = async (id: string) => {
    if (id === sessionIdRef.current && !guardRunning()) return;
    const operation = beginSessionMutation();
    if (!operation) return;
    try {
      if (!(await confirmAction('删除会话', '会话消息将被永久删除，记忆会保留。', '删除'))) return;
      await requestWithTimeout(
        (signal) => client.deleteSession(id, { signal }),
        SESSION_REQUEST_TIMEOUT_MS,
        '删除会话超时，请重试。',
      );
      if (sessionMutationSeqRef.current === operation && sessionIdRef.current === id) {
        sessionIdRef.current = undefined;
        turnRef.current = undefined;
        setSessionId(undefined);
        setSessionMeta(undefined);
        setMessages([]);
        setLive(undefined);
        setApprovalQueue([]);
      }
      void refreshSessions();
    } catch (err: any) {
      notify('删除失败', err?.message ?? '');
    } finally {
      endSessionMutation(operation);
    }
  };

  const archiveSession = async (id: string, archived: boolean) => {
    if (archived && id === sessionIdRef.current && !guardRunning()) return;
    const operation = beginSessionMutation();
    if (!operation) return;
    try {
      await requestWithTimeout(
        (signal) => client.updateSession(id, { archived }, { signal }),
        SESSION_REQUEST_TIMEOUT_MS,
        '归档操作超时，请重试。',
      );
      if (sessionMutationSeqRef.current !== operation) return;
      // 响应到达后重新读取当前会话，不能使用点击归档时的闭包快照。
      if (archived && sessionIdRef.current === id) {
        sessionIdRef.current = undefined;
        turnRef.current = undefined;
        setSessionId(undefined);
        setSessionMeta(undefined);
        setMessages([]);
        setLive(undefined);
        setApprovalQueue([]);
      }
      void refreshSessions();
      void refreshArchivedSessions();
    } catch (err: any) {
      notify('操作失败', err?.message ?? '');
    } finally {
      endSessionMutation(operation);
    }
  };

  return { sessions, setSessions: updateSessions, archivedSessions, setArchivedSessions: updateArchivedSessions, sessionView, setSessionView, sessionId, setSessionId: updateSessionId, sessionMeta, setSessionMeta, messages, setMessages, sessionMutating, sessionQuery, setSessionQuery, renameTarget, setRenameTarget, sessionIdRef, refreshSessions, refreshArchivedSessions, refreshSession, openSession, newSession, deleteSession, archiveSession };
}
