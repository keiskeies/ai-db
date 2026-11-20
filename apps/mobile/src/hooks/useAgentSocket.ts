import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { AgentMessage, AgentSessionMeta, PermissionMode } from '@aidb/core';
import type { BridgeClient } from '../bridge';
import { notify } from '../lib/utils';
import type { ApprovalState, LiveTurn } from '../types';

export function useAgentSocket(client: BridgeClient, { activeConnectionId, activeDatabase, sessionId, mode, input, pendingImages, approval, setSessionId, setSessionMeta, setMessages, setInput, setPendingImages, setLive, setApprovalQueue, setConnected, loadSchema, refreshSession, refreshSessions, sessionIdRef, activeConnectionIdRef, activeDatabaseRef }: { activeConnectionId: string | undefined; activeDatabase: string | undefined; sessionId: string | undefined; mode: PermissionMode; input: string; pendingImages: Array<{ id: string; mime: string }>; approval: ApprovalState | undefined; setSessionId: Dispatch<SetStateAction<string | undefined>>; setSessionMeta: Dispatch<SetStateAction<AgentSessionMeta | undefined>>; setMessages: Dispatch<SetStateAction<AgentMessage[]>>; setInput: Dispatch<SetStateAction<string>>; setPendingImages: Dispatch<SetStateAction<Array<{ id: string; mime: string }>>>; setLive: Dispatch<SetStateAction<LiveTurn | undefined>>; setApprovalQueue: Dispatch<SetStateAction<ApprovalState[]>>; setConnected: Dispatch<SetStateAction<boolean>>; loadSchema: (connectionId?: string, database?: string) => Promise<void>; refreshSession: (id: string) => Promise<void>; refreshSessions: () => Promise<void>; sessionIdRef: { current: string | undefined }; activeConnectionIdRef: { current: string | undefined }; activeDatabaseRef: { current: string | undefined } }) {
  const wsRef = useRef<WebSocket | null>(null);

  const handlerRef = useRef<(event: any) => void>(() => undefined);

  const handleWsEvent = (event: any) => {
    if (event.type === 'ping' || event.type === 'pong') return;
    if (event.type === 'schema_changed') {
      if (event.connectionId === activeConnectionIdRef.current) void loadSchema(event.connectionId, activeDatabase);
      return;
    }
    if (event.type === 'turn_end') {
      const sid = sessionIdRef.current;
      if (sid) {
        setTimeout(() => {
          void refreshSession(sid);
          void refreshSessions();
        }, 200);
      }
      return;
    }
    if (event.type === 'error') {
      setLive((prev) => (prev ? { ...prev, status: 'error', error: event.message } : prev));
      setApprovalQueue([]);
      return;
    }
    if (event.type === 'approval_required') {
      setLive((prev) => (prev ? { ...prev, status: 'awaiting' } : prev));
      setApprovalQueue((q) =>
        q.some((i) => i.approvalId === event.approvalId)
          ? q
          : [...q, { approvalId: event.approvalId, tool: event.call.tool, args: event.call.args, risk: event.call.risk, summary: event.call.summary, sql: event.call.sql }]
      );
      return;
    }
    if (event.type === 'approval_resolved') {
      setApprovalQueue((q) => q.filter((i) => i.approvalId !== event.approvalId));
      setLive((prev) => (prev ? { ...prev, status: 'streaming' } : prev));
      return;
    }
    setLive((prev) => {
      if (!prev) return prev;
      const next: LiveTurn = { ...prev, tools: prev.tools.map((t) => ({ ...t })), plan: [...prev.plan], memories: [...prev.memories], timeline: [...prev.timeline] };
      /** 已入账正文；text_replace 只能改写当前这一步，不能把前面说过的话抹掉。 */
      const committedText = () => next.timeline.filter((item) => item.kind === 'text').map((item) => item.text).join('\n\n');
      switch (event.type) {
        case 'text_delta':
          next.text += event.text;
          next.stream += event.text;
          break;
        case 'text_replace':
          next.stream = event.text;
          next.text = [committedText(), event.text].filter(Boolean).join('\n\n');
          break;
        case 'thinking_delta':
          next.thinking += event.text;
          next.streamThinking += event.text;
          break;
        // 步骤边界：这一步的话说完了，下面接它的工具。顺序即渲染顺序。
        case 'step_text':
          next.timeline.push({ kind: 'text', text: event.text, step: event.step });
          next.stream = '';
          break;
        case 'step_thinking':
          next.timeline.push({ kind: 'thinking', text: event.text, step: event.step });
          next.streamThinking = '';
          break;
        case 'tool_call':
          next.tools.push({ callId: event.callId, tool: event.tool, args: event.args, risk: event.risk, status: 'running', summary: event.summary });
          next.timeline.push({ kind: 'tool', callId: event.callId });
          break;
        case 'tool_result': {
          const tool = next.tools.find((t) => t.callId === event.callId);
          if (tool) {
            tool.status = event.result.ok ? 'ok' : 'error';
            tool.result = event.result;
          }
          next.status = 'streaming';
          break;
        }
        case 'plan':
          next.plan = event.items;
          break;
        case 'memory_used':
          next.memories = event.memories;
          break;
        case 'done':
          next.status = 'done';
          break;
        case 'aborted':
          next.status = 'aborted';
          // 事由由 runtime 给：'用户中止' 或 '模型连接无响应（可继续）'。
          // 移动端原本一律显示「已中止」，于是连接死了也像是在说用户自己按的停止。
          next.abortReason = event.reason;
          break;
        default:
          break;
      }
      return next;
    });
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
          if (disposed) return;
          setConnected(true);
          // 断线期间的事件不会补发；重连后补刷一次当前连接。
          // 库必须一起带上，并且从 ref 读：这个 effect 的依赖是 [client]，
          // 闭包里的 activeDatabase 会停在首屏那一刻（常常还是 undefined）。
          // 不带库 = MySQL 这类没有默认库的连接直接 400 NO_DATABASE。
          if (activeConnectionIdRef.current) void loadSchema(activeConnectionIdRef.current, activeDatabaseRef.current);
        };
        ws.onmessage = (event) => {
          try {
            handlerRef.current(JSON.parse(String(event.data)));
          } catch {
            /* ignore */
          }
        };
        ws.onclose = () => {
          if (disposed) return;
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
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [client]);

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      notify('Bridge 未连接', '正在重连，请稍后再试。');
      return;
    }
    try {
      let sid = sessionId;
      if (!sid) {
        const created = await client.createSession({ connectionId: activeConnectionId, database: activeDatabase, permissionMode: mode });
        sid = created.session.id;
        setSessionId(sid);
        sessionIdRef.current = sid;
        setSessionMeta(created.session);
        setMessages([]);
        void refreshSessions();
      }
      const attachments = [...new Set([...text.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
      const images = pendingImages.map((item) => item.id);
      setInput('');
      setPendingImages([]);
      setApprovalQueue([]);
      setLive({
        userText: text,
        text: '',
        thinking: '',
        tools: [],
        timeline: [],
        stream: '',
        streamThinking: '',
        plan: [],
        status: 'streaming',
        startedAt: Date.now(),
        memories: [],
      });
      ws.send(JSON.stringify({ type: 'turn', sessionId: sid, text, mode, attachments, images, connectionId: activeConnectionId, database: activeDatabase }));
    } catch (err: any) {
      notify('发送失败', err?.message ?? '');
    }
  };

  const stop = async () => {
    if (sessionId) {
      try {
        await client.abort(sessionId);
      } catch {
        /* ignore */
      }
    }
  };

  const resolveApproval = async (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => {
    const current = approval;
    if (!current) return;
    try {
      await client.approve(current.approvalId, decision, scope);
    } catch (err: any) {
      notify('授权失败', err?.message ?? '');
    } finally {
      setApprovalQueue((q) => q.filter((i) => i.approvalId !== current.approvalId));
    }
  };

  return { send, stop, resolveApproval };
}
