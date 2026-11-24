import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AgentMessage, AgentSessionMeta, PermissionMode } from '@aidb/core';
import { requestWithTimeout, type BridgeClient } from '../bridge';
import { notify } from '../lib/utils';
import { applyAgentEvent, isLiveTurnRunning } from '../components/chat/turnModel';
import type { AgentTurnContext, AgentTurnRef, ApprovalState, LiveTurn } from '../types';

interface SendSnapshot {
  input: string;
  images: Array<{ id: string; mime: string }>;
  approvals: ApprovalState[];
  connectionId: string | undefined;
  database: string | undefined;
  sessionId: string | undefined;
  turn: AgentTurnContext | undefined;
  generation: number;
}

interface PendingSend {
  operation: number;
  turn: AgentTurnContext;
  snapshot: SendSnapshot;
  previousLive: LiveTurn | undefined;
}

const SESSION_REQUEST_TIMEOUT_MS = 15_000;

interface AgentSocketOptions {
  live: LiveTurn | undefined;
  mode: PermissionMode;
  input: string;
  pendingImages: Array<{ id: string; mime: string }>;
  uploadingImageRef: { current: boolean };
  approval: ApprovalState | undefined;
  approvalQueue: ApprovalState[];
  setSessionId: Dispatch<SetStateAction<string | undefined>>;
  setSessionMeta: Dispatch<SetStateAction<AgentSessionMeta | undefined>>;
  setMessages: Dispatch<SetStateAction<AgentMessage[]>>;
  setInput: Dispatch<SetStateAction<string>>;
  setPendingImages: Dispatch<SetStateAction<Array<{ id: string; mime: string }>>>;
  setLive: Dispatch<SetStateAction<LiveTurn | undefined>>;
  setApprovalQueue: Dispatch<SetStateAction<ApprovalState[]>>;
  setConnected: Dispatch<SetStateAction<boolean>>;
  loadSchema: (connectionId?: string, database?: string) => Promise<void>;
  refreshSession: (id: string, options?: { finalize?: boolean }) => Promise<void>;
  refreshSessions: () => Promise<void>;
  sessionIdRef: { current: string | undefined };
  activeConnectionIdRef: { current: string | undefined };
  activeDatabaseRef: { current: string | undefined };
  turnRef: AgentTurnRef;
  sessionMutationLockedRef?: { current: boolean };
  scopeLockedRef?: { current: boolean };
}

export function useAgentSocket(client: BridgeClient, options: AgentSocketOptions) {
  const {
    live, mode, input, pendingImages, uploadingImageRef, approval, approvalQueue,
    setSessionId, setSessionMeta, setMessages, setInput, setPendingImages, setLive, setApprovalQueue,
    setConnected, loadSchema, refreshSession, refreshSessions, sessionIdRef, activeConnectionIdRef,
    activeDatabaseRef, turnRef, sessionMutationLockedRef, scopeLockedRef,
  } = options;
  const wsRef = useRef<WebSocket | null>(null);
  const liveRef = useRef<LiveTurn | undefined>(undefined);
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const stoppingRef = useRef(false);
  const pendingSendRef = useRef<PendingSend | undefined>(undefined);
  const sendOperationRef = useRef(0);
  const sendControllerRef = useRef<AbortController | undefined>(undefined);
  const generationRef = useRef(0);
  const refreshTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const handlerRef = useRef<(event: any) => void>(() => undefined);
  liveRef.current = live;

  const updateLive = (turn: AgentTurnContext, event: any) => {
    const prev = liveRef.current;
    if (!prev || prev.sessionId !== turn.sessionId || prev.generation !== turn.generation) return;
    const next = applyAgentEvent(prev, event);
    liveRef.current = next;
    turn.status = next.status;
    if (next.turnId) turn.turnId = next.turnId;
    setLive(next);
  };

  const clearTurnApprovals = (turn: AgentTurnContext) => {
    setApprovalQueue((queue) => queue.filter((item) => item.generation !== turn.generation || item.sessionId !== turn.sessionId));
  };

  const refreshTurn = (turn: AgentTurnContext, finalize: boolean) => {
    void refreshSession(turn.sessionId, { finalize }).finally(() => {
      void refreshSessions();
    });
  };

  const restoreDraft = (snapshot: SendSnapshot) => {
    setInput((prev) => prev === snapshot.input || !prev ? snapshot.input : prev);
    setPendingImages((prev) => {
      const present = new Set(prev.map((item) => item.id));
      return [...prev, ...snapshot.images.filter((item) => !present.has(item.id))];
    });
    setApprovalQueue((prev) => {
      const present = new Set(prev.map((item) => item.approvalId));
      return [...prev, ...snapshot.approvals.filter((item) => !present.has(item.approvalId))];
    });
  };

  const restoreSend = (pending: PendingSend) => {
    if (turnRef.current === pending.turn) {
      setApprovalQueue((queue) => queue.filter((item) => item.sessionId !== pending.turn.sessionId || item.generation !== pending.turn.generation));
      turnRef.current = pending.snapshot.turn;
      liveRef.current = pending.previousLive;
      setLive(pending.previousLive);
    }
    restoreDraft(pending.snapshot);
  };

  const acceptSend = (pending: PendingSend) => {
    const turn = turnRef.current;
    const currentLive = liveRef.current;
    if (sendOperationRef.current !== pending.operation
      || pendingSendRef.current !== pending
      || turn !== pending.turn
      || !turn || !isLiveTurnRunning(turn)
      || !currentLive || currentLive.sessionId !== turn.sessionId
      || currentLive.generation !== turn.generation || !isLiveTurnRunning(currentLive)) return;
    const imageIds = new Set(pending.snapshot.images.map((item) => item.id));
    setInput((prev) => prev === pending.snapshot.input ? '' : prev);
    setPendingImages((prev) => prev.filter((item) => !imageIds.has(item.id)));
    const sentApprovals = new Set(pending.snapshot.approvals.map((item) => item.approvalId));
    setApprovalQueue((prev) => prev.filter((item) => !sentApprovals.has(item.approvalId)));
    return true;
  };

  const handleWsEvent = (event: any) => {
    if (!event || typeof event.type !== 'string') return;
    if (event.type === 'ping') {
      const ws = wsRef.current;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (event.type === 'pong') return;
    if (event.type === 'schema_changed') {
      if (event.connectionId === activeConnectionIdRef.current) void loadSchema(event.connectionId, activeDatabaseRef.current);
      return;
    }

    const turn = turnRef.current;
    if (!turn) return;
    if (event.sessionId !== undefined && event.sessionId !== turn.sessionId) return;
    const pending = pendingSendRef.current?.turn === turn ? pendingSendRef.current : undefined;
    if (event.turnId !== undefined) {
      if (turn.turnId && event.turnId !== turn.turnId) return;
      if (!turn.turnId && ['start', 'done', 'aborted'].includes(event.type)) turn.turnId = event.turnId;
    }
    const live = liveRef.current;
    if (!live || live.sessionId !== turn.sessionId || live.generation !== turn.generation) return;

    if (pending && event.type === 'start' && event.turnId) {
      if (acceptSend(pending)) pendingSendRef.current = undefined;
    } else if (pending && ['done', 'aborted', 'error'].includes(event.type)) {
      pendingSendRef.current = undefined;
      restoreSend(pending);
      notify('发送失败', event.type === 'error' ? event.message ?? '服务端拒绝了发送。' : '服务端未确认回合已启动。');
      return;
    }
    if (event.type === 'turn_end') {
      if (isLiveTurnRunning(turn) && !event.turnId) return;
      const timer = setTimeout(() => {
        refreshTimersRef.current.delete(timer);
        if (turnRef.current === turn && liveRef.current?.generation === turn.generation) refreshTurn(turn, true);
      }, 200);
      refreshTimersRef.current.add(timer);
      return;
    }
    if (!isLiveTurnRunning(turn) && !['usage', 'turn_usage', 'suggestions'].includes(event.type)) return;

    if (event.type === 'approval_required') {
      setApprovalQueue((queue) => queue.some((item) => item.approvalId === event.approvalId)
        ? queue
        : [...queue, {
            approvalId: event.approvalId,
            sessionId: turn.sessionId,
            turnId: turn.turnId,
            generation: turn.generation,
            tool: event.call.tool,
            args: event.call.args,
            risk: event.call.risk,
            summary: event.call.summary,
            sql: event.call.sql,
          }]);
    } else if (event.type === 'approval_resolved') {
      setApprovalQueue((queue) => queue.filter((item) => item.approvalId !== event.approvalId));
    } else if (['done', 'aborted', 'error'].includes(event.type)) {
      clearTurnApprovals(turn);
    }
    updateLive(turn, event);
  };
  handlerRef.current = handleWsEvent;

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      if (disposed) return;
      try {
        const ws = new WebSocket(client.wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          if (disposed || wsRef.current !== ws) return;
          setConnected(true);
          if (activeConnectionIdRef.current) void loadSchema(activeConnectionIdRef.current, activeDatabaseRef.current);
          const turn = turnRef.current;
          if (turn && isLiveTurnRunning(turn)) refreshTurn(turn, false);
        };
        ws.onmessage = (message) => {
          if (disposed || wsRef.current !== ws) return;
          try {
            handlerRef.current(JSON.parse(String(message.data)));
          } catch {
            /* ignore malformed frame */
          }
        };
        ws.onclose = () => {
          if (disposed || wsRef.current !== ws) return;
          wsRef.current = null;
          setConnected(false);
          timer = setTimeout(connect, 2500);
        };
        ws.onerror = () => undefined;
      } catch {
        if (!disposed) timer = setTimeout(connect, 3000);
      }
    };
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      for (const refreshTimer of refreshTimersRef.current) clearTimeout(refreshTimer);
      refreshTimersRef.current.clear();
      sendOperationRef.current += 1;
      generationRef.current += 1;
      pendingSendRef.current = undefined;
      sendControllerRef.current?.abort(new Error('连接已关闭，发送已取消。'));
      sendControllerRef.current = undefined;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [client]);

  const send = async () => {
    const text = input.trim();
    if (!text || sendingRef.current) return;
    if (sessionMutationLockedRef?.current) {
      notify('会话正在切换', '请等当前会话操作完成后再发送。');
      return;
    }
    if (uploadingImageRef.current) {
      notify('图片上传中', '请等待全部图片上传完成后再发送。');
      return;
    }
    const previousLive = liveRef.current;
    const previousTurn = turnRef.current;
    if ((previousLive && isLiveTurnRunning(previousLive)) || (previousTurn && isLiveTurnRunning(previousTurn))) {
      notify('Agent 正在运行', '请先停止当前回合。');
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      notify('Bridge 未连接', '正在重连，请稍后再试。');
      return;
    }

    const snapshot = {
      input,
      images: pendingImages.map((item) => ({ ...item })),
      approvals: [...approvalQueue],
      connectionId: activeConnectionIdRef.current,
      database: activeDatabaseRef.current,
      sessionId: sessionIdRef.current,
      turn: turnRef.current,
      generation: generationRef.current,
    };
    const operation = ++sendOperationRef.current;
    const controller = new AbortController();
    sendControllerRef.current = controller;
    sendingRef.current = true;
    setSending(true);
    if (scopeLockedRef) scopeLockedRef.current = true;
    let sentTurn: AgentTurnContext | undefined;
    let switchedSession = false;
    let sessionCommitted = Boolean(snapshot.sessionId);
    try {
      let sid = snapshot.sessionId;
      if (!sid) {
        const created = await requestWithTimeout(
          (signal) => client.createSession({ connectionId: snapshot.connectionId, database: snapshot.database, permissionMode: mode }, { signal }),
          SESSION_REQUEST_TIMEOUT_MS,
          '创建会话超时，请重试。',
          controller,
        );
        if (sendOperationRef.current !== operation) return;
        sid = created.session.id;
        if (sessionIdRef.current !== snapshot.sessionId
          || turnRef.current !== snapshot.turn
          || generationRef.current !== snapshot.generation
          || activeConnectionIdRef.current !== snapshot.connectionId
          || activeDatabaseRef.current !== snapshot.database) {
          switchedSession = true;
          throw new Error('会话或数据范围已切换，请重试。');
        }
        setSessionId(sid);
        sessionIdRef.current = sid;
        setSessionMeta(created.session);
        setMessages([]);
        sessionCommitted = true;
        void refreshSessions();
      }
      if (sendOperationRef.current !== operation) return;
      if (turnRef.current !== snapshot.turn || sessionIdRef.current !== sid) {
        switchedSession = true;
        throw new Error('会话已切换，请重试。');
      }
      const attachments = [...new Set([...text.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]))];
      const imageIds = snapshot.images.map((item) => item.id);
      const generation = ++generationRef.current;
      const turn: AgentTurnContext = { sessionId: sid, generation, status: 'streaming' };
      const nextLive: LiveTurn = {
        sessionId: sid,
        generation,
        userText: text,
        ...(imageIds.length ? { userImages: imageIds } : {}),
        text: '',
        thinking: '',
        tools: [],
        timeline: [],
        stream: '',
        streamThinking: '',
        plan: [],
        status: 'streaming',
        pendingApprovalIds: [],
        suggestions: [],
        startedAt: Date.now(),
        tokensIn: 0,
        tokensOut: 0,
        steps: 0,
        modelCalls: 0,
        contextTokens: 0,
        modelDurationMs: 0,
        memories: [],
      };
      sentTurn = turn;
      turnRef.current = turn;
      liveRef.current = nextLive;
      setLive(nextLive);
      const pending: PendingSend = { operation, turn, snapshot, previousLive };
      pendingSendRef.current = pending;
      ws.send(JSON.stringify({
        type: 'turn', sessionId: sid, text, mode, attachments,
        images: imageIds,
        connectionId: snapshot.connectionId,
        database: snapshot.database,
      }));
    } catch (err: any) {
      if (sendOperationRef.current !== operation) return;
      if (sentTurn && pendingSendRef.current?.turn === sentTurn) pendingSendRef.current = undefined;
      if (controller.signal.aborted) {
        generationRef.current += 1;
        if (!sessionCommitted) restoreDraft(snapshot);
        notify('发送失败', err?.message ?? '');
        return;
      }
      if (!sessionCommitted && (sessionIdRef.current !== snapshot.sessionId
        || turnRef.current !== snapshot.turn
        || generationRef.current !== snapshot.generation)) switchedSession = true;
      if (!switchedSession && sentTurn && turnRef.current === sentTurn) {
        turnRef.current = snapshot.turn;
        liveRef.current = previousLive;
        setLive(previousLive);
      }
      if (!switchedSession) restoreDraft(snapshot);
      notify('发送失败', err?.message ?? '');
    } finally {
      if (sendOperationRef.current === operation) {
        sendControllerRef.current = undefined;
        sendingRef.current = false;
        setSending(false);
        if (scopeLockedRef) scopeLockedRef.current = Boolean(liveRef.current && isLiveTurnRunning(liveRef.current));
      }
    }
  };

  const cancelSend = () => {
    if (!sendingRef.current) return false;
    sendOperationRef.current += 1;
    generationRef.current += 1;
    const pending = pendingSendRef.current;
    pendingSendRef.current = undefined;
    if (pending) restoreSend(pending);
    const controller = sendControllerRef.current;
    sendControllerRef.current = undefined;
    controller?.abort(new Error('已取消发送。'));
    sendingRef.current = false;
    setSending(false);
    if (scopeLockedRef) scopeLockedRef.current = Boolean(liveRef.current && isLiveTurnRunning(liveRef.current));
    return true;
  };

  const stop = async () => {
    if (sendingRef.current) {
      cancelSend();
      return;
    }
    const sid = sessionIdRef.current;
    const turn = turnRef.current;
    if (!sid || !turn || !isLiveTurnRunning(turn) || stoppingRef.current) return;
    stoppingRef.current = true;
    try {
      const result = await client.abort(sid, 10_000);
      if (!result?.ok) throw new Error('服务端未确认停止，请重试。');
      if (turnRef.current !== turn || sessionIdRef.current !== sid) return;
      const current = liveRef.current;
      if (!current || current.sessionId !== sid || current.generation !== turn.generation || !isLiveTurnRunning(current)) return;
      const pending = pendingSendRef.current;
      if (pending?.turn === turn) {
        pendingSendRef.current = undefined;
        restoreSend(pending);
        return;
      }
      const stopped: LiveTurn = {
        ...current,
        status: 'aborted',
        abortCause: 'user',
        abortReason: '已停止',
        endedAt: Date.now(),
        pendingApprovalIds: [],
      };
      turn.status = 'aborted';
      liveRef.current = stopped;
      setLive(stopped);
      clearTurnApprovals(turn);
    } catch (err: any) {
      if (turnRef.current === turn && isLiveTurnRunning(turn)) {
        notify('停止失败', err?.name === 'AbortError' ? '停止请求超时，服务端可能仍在运行，请重试。' : err?.message ?? '请检查 Bridge 连接后重试。');
      }
    } finally {
      stoppingRef.current = false;
    }
  };

  const resolveApproval = async (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => {
    const current = approval;
    const turn = turnRef.current;
    if (!current || !turn || !isLiveTurnRunning(turn)) return;
    if ((current.sessionId && current.sessionId !== turn.sessionId)
      || (current.turnId && turn.turnId && current.turnId !== turn.turnId)
      || (current.generation !== undefined && current.generation !== turn.generation)) return;
    try {
      await client.approve(current.approvalId, decision, scope);
    } catch (err: any) {
      notify('授权失败', err?.message ?? '');
      return;
    }
    setApprovalQueue((queue) => queue.filter((item) => item.approvalId !== current.approvalId));
    const prev = liveRef.current;
    if (!prev || prev.sessionId !== turn.sessionId || prev.generation !== turn.generation || !isLiveTurnRunning(prev)) return;
    const pendingApprovalIds = prev.pendingApprovalIds.filter((id) => id !== current.approvalId);
    const next = { ...prev, pendingApprovalIds, status: pendingApprovalIds.length ? 'awaiting' as const : 'streaming' as const };
    liveRef.current = next;
    turn.status = next.status;
    setLive(next);
  };

  return { send, stop, cancelSend, resolveApproval, sending };
}
