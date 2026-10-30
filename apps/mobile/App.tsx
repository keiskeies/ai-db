import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  AtSign,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  History,
  Loader2,
  Lock,
  MessageSquarePlus,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  X,
} from 'lucide-react-native';
import type {
  AgentEvent,
  AgentMessage,
  AgentMessageBlock,
  AgentPlanItem,
  AgentSessionMeta,
  ConnectionConfig,
  Memory,
  PermissionMode,
  Risk,
  TableInfo,
  ToolResult,
} from '@aidb/core';
import {
  BridgeClient,
  BridgeError,
  claimPairing,
  clearBridgeConfig,
  loadBridgeConfig,
  normalizeBaseUrl,
  saveBridgeConfig,
  type BootstrapData,
  type BridgeConfig,
  type DataPage,
} from './src/bridge';
import { CommandSheet } from './src/CommandSheet';
import { colors, modeLabels, radius, riskColor, riskLabels } from './src/theme';

type TabKey = 'chat' | 'data' | 'connections' | 'memory' | 'settings';

interface LiveTool {
  callId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  status: 'running' | 'ok' | 'error' | 'awaiting';
  summary?: string;
  result?: ToolResult;
}

interface LiveTurn {
  userText: string;
  text: string;
  thinking: string;
  tools: LiveTool[];
  plan: AgentPlanItem[];
  status: 'streaming' | 'awaiting' | 'done' | 'aborted' | 'error';
  error?: string;
  startedAt: number;
  memories: Array<{ id: string; title: string; kind: string }>;
}

interface ApprovalState {
  approvalId: string;
  tool: string;
  args: unknown;
  risk: Risk;
  summary: string;
  sql?: string;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [config, setConfig] = useState<BridgeConfig | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      let saved = await loadBridgeConfig();
      if (Platform.OS === 'web') {
        const search = (globalThis as any).location?.search ?? '';
        const params = new URLSearchParams(search);
        const bridge = params.get('bridge');
        const token = params.get('token');
        if (bridge && token) {
          saved = { baseUrl: normalizeBaseUrl(bridge), token };
          await saveBridgeConfig(saved);
        }
      }
      setConfig(saved);
      setReady(true);
    })();
  }, []);

  if (!ready) {
    return (
      <View style={styles.splash}>
        <View style={styles.logo}><Text style={styles.logoText}>AI</Text></View>
        <ActivityIndicator color={colors.accent} style={{ marginTop: 16 }} />
      </View>
    );
  }

  if (!config) return <PairScreen onConnected={(cfg) => setConfig(cfg)} />;
  return (
    <Main
      config={config}
      onDisconnect={async () => {
        await clearBridgeConfig();
        setConfig(null);
      }}
    />
  );
}

function PairScreen({ onConnected }: { onConnected: (config: BridgeConfig) => void }) {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState('http://192.168.1.10:8787');
  const [method, setMethod] = useState<'pair' | 'token'>('pair');
  const [code, setCode] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const baseUrl = normalizeBaseUrl(url);
      if (method === 'pair') {
        if (!/^\d{6}$/.test(code.trim())) throw new Error('请输入 6 位配对码');
        const result = await claimPairing(baseUrl, code.trim(), Platform.OS);
        const cfg = { baseUrl, token: result.token };
        await saveBridgeConfig(cfg);
        onConnected(cfg);
      } else {
        if (!token.trim()) throw new Error('请输入访问令牌');
        const cfg = { baseUrl, token: token.trim() };
        await new BridgeClient(cfg).health();
        await saveBridgeConfig(cfg);
        onConnected(cfg);
      }
    } catch (err: any) {
      setError(err?.message ?? '连接失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.pairWrap, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 30 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.logoLarge}><Text style={styles.logoLargeText}>AI</Text></View>
        <Text style={styles.pairTitle}>AiDB Studio</Text>
        <Text style={styles.pairSubtitle}>移动端通过 Bridge 安全访问数据库。会话、记忆与桌面端同步。</Text>

        <View style={styles.card}>
          <Text style={styles.label}>Bridge 地址</Text>
          <TextInput
            testID="m-bridge-url"
            style={styles.input}
            value={url}
            onChangeText={setUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="http://192.168.1.10:8787"
            placeholderTextColor={colors.muted}
          />
          <View style={styles.segment}>
            <Pressable style={[styles.segmentItem, method === 'pair' && styles.segmentActive]} onPress={() => setMethod('pair')}>
              <Text style={[styles.segmentText, method === 'pair' && styles.segmentTextActive]}>配对码</Text>
            </Pressable>
            <Pressable style={[styles.segmentItem, method === 'token' && styles.segmentActive]} onPress={() => setMethod('token')}>
              <Text style={[styles.segmentText, method === 'token' && styles.segmentTextActive]}>访问令牌</Text>
            </Pressable>
          </View>
          {method === 'pair' ? (
            <>
              <Text style={styles.label}>6 位配对码</Text>
              <TextInput
                testID="m-pair-code"
                style={[styles.input, styles.codeInput]}
                value={code}
                onChangeText={setCode}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="000000"
                placeholderTextColor={colors.muted}
              />
              <Text style={styles.hint}>在桌面端打开「设置 → Bridge → 为移动端配对」生成，5 分钟内有效。</Text>
            </>
          ) : (
            <>
              <Text style={styles.label}>访问令牌</Text>
              <TextInput
                testID="m-token"
                style={styles.input}
                value={token}
                onChangeText={setToken}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                placeholder="dev-token"
                placeholderTextColor={colors.muted}
              />
              <Text style={styles.hint}>令牌来自 Bridge 启动日志或桌面端配对结果；生产环境请使用 TLS。</Text>
            </>
          )}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Pressable testID="m-connect" style={[styles.primaryButton, busy && { opacity: 0.6 }]} onPress={() => void connect()} disabled={busy}>
            {busy ? <ActivityIndicator color="#0b0d0d" size="small" /> : <Sparkles size={15} color="#0b0d0d" />}
            <Text style={styles.primaryButtonText}>{busy ? '连接中…' : '连接 Bridge'}</Text>
          </Pressable>
        </View>

        <View style={styles.pairNotes}>
          <Lock size={12} color={colors.muted} />
          <Text style={styles.pairNoteText}>凭据只保存在设备安全存储；数据库密码从不下发到移动端。</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Main({ config, onDisconnect }: { config: BridgeConfig; onDisconnect: () => void }) {
  const insets = useSafeAreaInsets();
  const client = useMemo(() => new BridgeClient(config), [config]);
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<TabKey>('chat');
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | undefined>();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionMeta, setSessionMeta] = useState<AgentSessionMeta | undefined>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [live, setLive] = useState<LiveTurn | undefined>();
  const [approval, setApproval] = useState<ApprovalState | undefined>();
  const [mode, setMode] = useState<PermissionMode>('readonly');
  const [input, setInput] = useState('');
  const [picker, setPicker] = useState<'sessions' | 'connections' | 'tables' | null>(null);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [dataPage, setDataPage] = useState<DataPage | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const handlerRef = useRef<(event: any) => void>(() => undefined);
  const scrollRef = useRef<ScrollView>(null);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const busy = live?.status === 'streaming' || live?.status === 'awaiting';

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

  const loadSchema = async (connectionId?: string) => {
    if (!connectionId) {
      setTables([]);
      return;
    }
    try {
      const result = await client.schema(connectionId);
      setTables(result.schemas.flatMap((schema) => schema.tables));
    } catch {
      setTables([]);
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
      if (conn) {
        setActiveConnectionId(conn.id);
        void loadSchema(conn.id);
      }
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

  useEffect(() => {
    if (!activeConnectionId) return;
    void loadSchema(activeConnectionId);
    setSelectedTable(null);
    setDataPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId]);

  const handleWsEvent = (event: any) => {
    if (event.type === 'ping' || event.type === 'pong') return;
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
      setApproval(undefined);
      return;
    }
    if (event.type === 'approval_required') {
      setLive((prev) => (prev ? { ...prev, status: 'awaiting' } : prev));
      setApproval({
        approvalId: event.approvalId,
        tool: event.call.tool,
        args: event.call.args,
        risk: event.call.risk,
        summary: event.call.summary,
        sql: event.call.sql,
      });
      return;
    }
    if (event.type === 'approval_resolved') {
      setApproval(undefined);
      setLive((prev) => (prev ? { ...prev, status: 'streaming' } : prev));
      return;
    }
    setLive((prev) => {
      if (!prev) return prev;
      const next: LiveTurn = { ...prev, tools: prev.tools.map((t) => ({ ...t })), plan: [...prev.plan], memories: [...prev.memories] };
      switch (event.type) {
        case 'text_delta':
          next.text += event.text;
          break;
        case 'text_replace':
          next.text = event.text;
          break;
        case 'thinking_delta':
          next.thinking += event.text;
          break;
        case 'tool_call':
          next.tools.push({ callId: event.callId, tool: event.tool, args: event.args, risk: event.risk, status: 'running', summary: event.summary });
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
        ws.onopen = () => !disposed && setConnected(true);
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

  useEffect(() => {
    if (live) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    }
  }, [live?.text, live?.tools.length, live?.status, live?.plan, messages.length]);

  useEffect(() => {
    if (tab === 'memory') void loadMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const loadMemories = async (q = memoryQuery) => {
    setMemoryLoading(true);
    try {
      const result = await client.memories(q);
      setMemories(result.memories);
    } catch (err: any) {
      Alert.alert('加载失败', err?.message ?? '');
    } finally {
      setMemoryLoading(false);
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
      if (detail.session.connectionId) setActiveConnectionId(detail.session.connectionId);
    } catch (err: any) {
      Alert.alert('打开会话失败', err?.message ?? '');
    }
  };

  const newSession = async () => {
    try {
      const created = await client.createSession({ connectionId: activeConnectionId, permissionMode: mode });
      setSessionId(created.session.id);
      setSessionMeta(created.session);
      setMessages([]);
      setLive(undefined);
      setPicker(null);
      void refreshSessions();
    } catch (err: any) {
      Alert.alert('新建失败', err?.message ?? '');
    }
  };

  const deleteSession = (id: string) => {
    Alert.alert('删除会话', '会话消息将被永久删除，记忆会保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: async () => {
          try {
            await client.deleteSession(id);
            if (sessionId === id) {
              setSessionId(undefined);
              setSessionMeta(undefined);
              setMessages([]);
            }
            void refreshSessions();
          } catch (err: any) {
            Alert.alert('删除失败', err?.message ?? '');
          }
        },
      },
    ]);
  };

  const send = async () => {
    const text = input.trim();
    if (!text) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== 1) {
      Alert.alert('Bridge 未连接', '正在重连，请稍后再试。');
      return;
    }
    try {
      let sid = sessionId;
      if (!sid) {
        const created = await client.createSession({ connectionId: activeConnectionId, permissionMode: mode });
        sid = created.session.id;
        setSessionId(sid);
        sessionIdRef.current = sid;
        setSessionMeta(created.session);
        setMessages([]);
        void refreshSessions();
      }
      const attachments = [...new Set([...text.matchAll(/@([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
      setInput('');
      setApproval(undefined);
      setLive({
        userText: text,
        text: '',
        thinking: '',
        tools: [],
        plan: [],
        status: 'streaming',
        startedAt: Date.now(),
        memories: [],
      });
      ws.send(JSON.stringify({ type: 'turn', sessionId: sid, text, mode, attachments, connectionId: activeConnectionId }));
    } catch (err: any) {
      Alert.alert('发送失败', err?.message ?? '');
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
    if (!approval) return;
    try {
      await client.approve(approval.approvalId, decision, scope);
      setApproval(undefined);
    } catch (err: any) {
      Alert.alert('授权失败', err?.message ?? '');
    }
  };

  const openTable = async (table: TableInfo, offset = 0) => {
    if (!activeConnectionId) return;
    setSelectedTable(table);
    setDataLoading(true);
    try {
      const page = await client.data(activeConnectionId, table.name, 50, offset);
      setDataPage(page);
    } catch (err: any) {
      Alert.alert('加载失败', err?.message ?? '');
    } finally {
      setDataLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await bootstrap();
    await refreshSessions();
    if (activeConnectionId) await loadSchema(activeConnectionId);
    setRefreshing(false);
  };

  if (loading) {
    return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[styles.hint, { marginTop: 10 }]}>正在连接 Bridge…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={[styles.splash, { paddingHorizontal: 24 }]}>
        <ShieldAlert size={30} color={colors.danger} />
        <Text style={[styles.pairTitle, { fontSize: 18, marginTop: 12 }]}>连接失败</Text>
        <Text style={[styles.hint, { textAlign: 'center' }]}>{error}</Text>
        <Pressable style={styles.primaryButton} onPress={() => void bootstrap()}>
          <RefreshCw size={14} color="#0b0d0d" />
          <Text style={styles.primaryButtonText}>重试</Text>
        </Pressable>
        <Pressable onPress={() => void onDisconnect()} style={{ marginTop: 12 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>重新配对</Text>
        </Pressable>
      </View>
    );
  }

  const connName = activeConnection?.name ?? '未选择连接';
  const provider = boot?.settings.agent.provider === 'local' ? 'Local' : boot?.settings.agent.provider;

  return (
    <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <CommandSheet
        visible={commandOpen}
        onClose={() => setCommandOpen(false)}
        bridge={client}
        connections={connections}
        activeConnectionId={activeConnectionId}
      />
      <View style={[styles.topSafe, { paddingTop: insets.top }]} />
      <View style={styles.topbar}>
        <View style={styles.brandRow}>
          <View style={styles.logoSmall}><Text style={styles.logoSmallText}>AI</Text></View>
          <View>
            <Text style={styles.brand}>AiDB Studio</Text>
            <Text style={styles.brandSub}>{provider} · {connected ? 'Bridge 在线' : '重连中…'}</Text>
          </View>
        </View>
        <View style={[styles.connChip, !connected && { opacity: 0.5 }]}>
          <View style={[styles.statusDot, { backgroundColor: connected ? colors.success : colors.warning }]} />
          <Text style={styles.connChipText} numberOfLines={1}>{connName}</Text>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        {tab === 'chat' ? (
          <ChatScreen
            sessionMeta={sessionMeta}
            connection={activeConnection}
            connections={connections}
            sessions={sessions}
            messages={messages}
            live={live}
            input={input}
            setInput={setInput}
            mode={mode}
            setMode={setMode}
            busy={busy}
            connected={connected}
            onSend={() => void send()}
            onStop={() => void stop()}
            onNew={() => void newSession()}
            onOpenSessions={() => setPicker('sessions')}
            onOpenConnections={() => setPicker('connections')}
            onOpenTables={() => setPicker('tables')}
            onOpenCommands={() => setCommandOpen(true)}
            onOpenRecent={(id) => void openSession(id)}
            scrollRef={scrollRef}
            tables={tables}
          />
        ) : null}

        {tab === 'data' ? (
          selectedTable ? (
            <TableDataScreen
              table={selectedTable}
              page={dataPage}
              loading={dataLoading}
              onBack={() => {
                setSelectedTable(null);
                setDataPage(null);
              }}
              onRefresh={() => void openTable(selectedTable, dataPage?.offset ?? 0)}
              onPage={(offset) => void openTable(selectedTable, offset)}
            />
          ) : (
            <View style={{ flex: 1 }}>
              <ScreenHeading icon={<Table2 size={16} color={colors.accent} />} title="数据" subtitle={`${connName} · ${tables.length} 个对象`} action={
                <Pressable style={styles.iconButton} onPress={() => activeConnectionId && void loadSchema(activeConnectionId)}>
                  <RefreshCw size={15} color={colors.text} />
                </Pressable>
              } />
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {tables.map((table) => (
                  <Pressable key={table.name} testID={`m-table-${table.name}`} style={styles.listRow} onPress={() => void openTable(table)}>
                    <Table2 size={15} color={colors.accent} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{table.name}</Text>
                      <Text style={styles.listMeta}>
                        {table.type === 'view' ? '视图' : `${table.columns?.length ?? 0} 列`}
                        {table.rowEstimate !== undefined ? ` · ~${table.rowEstimate} 行` : ''}
                      </Text>
                    </View>
                    <ChevronRight size={14} color={colors.muted} />
                  </Pressable>
                ))}
                {!tables.length ? <Text style={styles.hint}>当前连接没有表，或尚未加载结构。</Text> : null}
                <Text style={styles.hint}>移动端为只读浏览；写操作请交给桌面端或 AI 助手并在授权后执行。</Text>
              </ScrollView>
            </View>
          )
        ) : null}

        {tab === 'connections' ? (
          <View style={{ flex: 1 }}>
            <ScreenHeading icon={<Database size={16} color={colors.accent} />} title="连接" subtitle="由 Bridge 统一管理" />
            <ScrollView
              contentContainerStyle={{ padding: 14, gap: 8 }}
              refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refreshAll()} tintColor={colors.accent} />}
            >
              {connections.map((conn) => (
                <Pressable
                  key={conn.id}
                  style={[styles.connCard, conn.id === activeConnectionId && { borderColor: colors.accent }]}
                  onPress={() => {
                    setActiveConnectionId(conn.id);
                    setTab('data');
                  }}
                >
                  <View style={styles.connCardHead}>
                    <Database size={14} color={colors.accent} />
                    <Text style={styles.listTitle} numberOfLines={1}>{conn.name}</Text>
                    {conn.id === activeConnectionId ? <Check size={14} color={colors.success} /> : null}
                  </View>
                  <Text style={styles.listMeta}>
                    {conn.engine} · {conn.environment.toUpperCase()} {conn.readonly ? '· 只读' : ''}
                  </Text>
                  {conn.note ? <Text style={[styles.hint, { marginTop: 4 }]} numberOfLines={2}>{conn.note}</Text> : null}
                </Pressable>
              ))}
              <View style={styles.noteCard}>
                <ShieldAlert size={14} color={colors.muted} />
                <Text style={styles.hint}>连接的新增与编辑在桌面端完成；移动端通过 Bridge 读取，不保存数据库凭据。</Text>
              </View>
            </ScrollView>
          </View>
        ) : null}

        {tab === 'memory' ? (
          <View style={{ flex: 1 }}>
            <ScreenHeading icon={<Brain size={16} color={colors.agent} />} title="记忆" subtitle={`${memories.length} 条 · 跨会话召回`} />
            <View style={styles.searchRow}>
              <Search size={14} color={colors.muted} />
              <TextInput
                style={styles.searchInput}
                value={memoryQuery}
                onChangeText={setMemoryQuery}
                placeholder="搜索记忆…"
                placeholderTextColor={colors.muted}
                returnKeyType="search"
                onSubmitEditing={() => void loadMemories()}
              />
              <Pressable style={styles.iconButton} onPress={() => void loadMemories()}>
                <Search size={14} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
              {memoryLoading ? <ActivityIndicator color={colors.accent} /> : null}
              {memories.map((memory) => (
                <View key={memory.id} style={styles.memoryCard}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.memoryKind}>{memory.kind}</Text>
                    <Text style={styles.listMeta}>{memory.scopeType} · {timeAgo(memory.updatedAt)}</Text>
                  </View>
                  <Text style={styles.memoryTitle}>{memory.title}</Text>
                  <Text style={styles.memoryContent}>{memory.content}</Text>
                  <Pressable
                    style={styles.pinRow}
                    onPress={async () => {
                      try {
                        await client.updateMemory(memory.id, { pinned: !memory.pinned });
                        void loadMemories();
                      } catch {
                        /* ignore */
                      }
                    }}
                  >
                    <Check size={11} color={memory.pinned ? colors.warning : colors.muted} />
                    <Text style={[styles.listMeta, memory.pinned && { color: colors.warning }]}>{memory.pinned ? '已置顶' : '置顶'}</Text>
                  </Pressable>
                </View>
              ))}
              {!memories.length && !memoryLoading ? <Text style={styles.hint}>还没有记忆。与 AI 对话时它会自动沉淀事实、偏好与结论。</Text> : null}
            </ScrollView>
          </View>
        ) : null}

        {tab === 'settings' ? (
          <SettingsScreen boot={boot} config={config} mode={mode} connected={connected} onDisconnect={onDisconnect} onMode={setMode} />
        ) : null}
      </View>

      <BottomTabs tab={tab} setTab={setTab} busy={busy} bottom={insets.bottom} />

      {picker === 'sessions' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>会话</Text>
                <Pressable style={styles.primarySmall} onPress={() => void newSession()}>
                  <Plus size={13} color="#0b0d0d" />
                  <Text style={styles.primarySmallText}>新会话</Text>
                </Pressable>
                <Pressable style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView>
                {sessions.map((session) => (
                  <Pressable key={session.id} style={[styles.sessionRow, session.id === sessionId && { backgroundColor: colors.accentSoft }]} onPress={() => void openSession(session.id)}>
                    <TerminalSquare size={14} color={colors.agent} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle} numberOfLines={1}>{session.title}</Text>
                      <Text style={styles.listMeta}>{timeAgo(session.updatedAt)} · {modeLabels[session.permissionMode]}</Text>
                    </View>
                    <Pressable hitSlop={8} onPress={() => deleteSession(session.id)}>
                      <Trash2 size={14} color={colors.muted} />
                    </Pressable>
                  </Pressable>
                ))}
                {!sessions.length ? <Text style={[styles.hint, { padding: 14 }]}>还没有会话</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

      {picker === 'connections' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>选择连接</Text>
                <Pressable style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              {connections.map((conn) => (
                <Pressable
                  key={conn.id}
                  style={[styles.sessionRow, conn.id === activeConnectionId && { backgroundColor: colors.accentSoft }]}
                  onPress={() => {
                    setActiveConnectionId(conn.id);
                    setPicker(null);
                  }}
                >
                  <Database size={14} color={colors.accent} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listTitle}>{conn.name}</Text>
                    <Text style={styles.listMeta}>{conn.engine} · {conn.environment}</Text>
                  </View>
                  {conn.id === activeConnectionId ? <Check size={14} color={colors.success} /> : null}
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
      ) : null}

      {picker === 'tables' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '70%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>引用表</Text>
                <Pressable style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView>
                {tables.map((table) => (
                  <Pressable
                    key={table.name}
                    style={styles.sessionRow}
                    onPress={() => {
                      setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${table.name} `);
                      setPicker(null);
                    }}
                  >
                    <Table2 size={14} color={colors.accent} />
                    <Text style={styles.listTitle}>{table.name}</Text>
                    <Text style={styles.listMeta}>{table.columns?.length ?? 0} 列</Text>
                  </Pressable>
                ))}
                {!tables.length ? <Text style={[styles.hint, { padding: 14 }]}>当前连接没有可引用表</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

      {approval ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => void resolveApproval('deny', 'once')}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.sheetHead}>
                <ShieldAlert size={17} color={colors.warning} />
                <Text style={styles.sheetTitle}>需要授权</Text>
                <View style={[styles.riskBadge, { borderColor: riskColor(approval.risk) }]}>
                  <Text style={[styles.riskText, { color: riskColor(approval.risk) }]}>{riskLabels[approval.risk] ?? approval.risk}</Text>
                </View>
              </View>
              <Text style={styles.approvalTool}>{approval.tool}</Text>
              <Text style={styles.approvalSummary}>{approval.summary}</Text>
              {approval.sql ? (
                <ScrollView style={styles.approvalSql}>
                  <Text style={styles.codeText}>{approval.sql}</Text>
                </ScrollView>
              ) : null}
              {approval.risk === 'destructive' ? (
                <Text style={[styles.hint, { color: colors.danger, marginBottom: 8 }]}>破坏性操作：可能永久删除数据，Agent 会按设置先尝试备份。</Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => void resolveApproval('deny', 'once')}>
                  <Text style={styles.secondaryButtonText}>拒绝</Text>
                </Pressable>
                <Pressable style={[styles.paleButton, { flex: 1 }]} onPress={() => void resolveApproval('allow', 'once')}>
                  <Text style={styles.paleButtonText}>仅此一次</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable style={[styles.paleButton, { flex: 1 }]} onPress={() => void resolveApproval('allow', 'session')}>
                  <Text style={styles.paleButtonText}>本会话允许</Text>
                </Pressable>
                <Pressable style={[styles.primaryButton, { flex: 1, marginTop: 0 }]} onPress={() => void resolveApproval('allow', 'always')}>
                  <Text style={styles.primaryButtonText}>始终允许</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}
    </KeyboardAvoidingView>
  );
}

function ChatScreen({
  sessionMeta,
  connection,
  sessions,
  messages,
  live,
  input,
  setInput,
  mode,
  setMode,
  busy,
  connected,
  onSend,
  onStop,
  onNew,
  onOpenSessions,
  onOpenConnections,
  onOpenTables,
  onOpenCommands,
  onOpenRecent,
  scrollRef,
  tables,
}: {
  sessionMeta?: AgentSessionMeta;
  connection?: ConnectionConfig;
  connections: ConnectionConfig[];
  sessions: AgentSessionMeta[];
  messages: AgentMessage[];
  live?: LiveTurn;
  input: string;
  setInput: (text: string) => void;
  mode: PermissionMode;
  setMode: (mode: PermissionMode) => void;
  busy: boolean;
  connected: boolean;
  onSend: () => void;
  onStop: () => void;
  onNew: () => void;
  onOpenSessions: () => void;
  onOpenConnections: () => void;
  onOpenTables: () => void;
  onOpenCommands: () => void;
  onOpenRecent: (id: string) => void;
  scrollRef: React.RefObject<ScrollView>;
  tables: TableInfo[];
}) {
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.chatHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chatTitle} numberOfLines={1}>{sessionMeta?.title ?? 'AI 助手'}</Text>
          <Pressable style={styles.connInline} onPress={onOpenConnections}>
            <Database size={11} color={colors.muted} />
            <Text style={styles.listMeta} numberOfLines={1}>{connection?.name ?? '未选择连接'}</Text>
            <ChevronDown size={11} color={colors.muted} />
          </Pressable>
        </View>
        <Pressable testID="m-sessions" style={styles.iconButton} onPress={onOpenSessions}>
          <History size={16} color={colors.text} />
        </Pressable>
        <Pressable testID="m-new-session" style={styles.iconButton} onPress={onNew}>
          <MessageSquarePlus size={16} color={colors.text} />
        </Pressable>
      </View>

      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: 14, paddingBottom: 24, gap: 14 }}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
      >
        {!messages.length && !live ? (
          <View style={styles.chatEmpty}>
            <View style={styles.agentAvatarLarge}><Sparkles size={22} color={colors.agent} /></View>
            <Text style={styles.emptyTitle}>AI 数据库搭档</Text>
            <Text style={styles.emptyHint}>用自然语言查询、建表、排查。工具调用、审批与记忆在桌面与移动端同步。</Text>
            <View style={styles.capList}>
              {[
                '给数据库做一次体检',
                tables.find((t) => t.name === 'orders') ? '按 status 统计 orders 并画柱状图' : '按分组统计并画柱状图',
                tables.find((t) => t.name === 'orders') ? '检查 orders 的空值、重复主键' : '检查当前表的空值、重复主键',
                '备份当前数据库',
              ].map((prompt) => (
                <Pressable key={prompt} style={styles.capItem} onPress={() => setInput(prompt)}>
                  <TerminalSquare size={12} color={colors.agent} />
                  <Text style={styles.capText}>{prompt}</Text>
                </Pressable>
              ))}
            </View>
            {sessions.length ? (
              <View style={{ width: '100%', marginTop: 16 }}>
                <Text style={styles.sectionLabel}>最近会话</Text>
                {sessions.slice(0, 3).map((session) => (
                  <Pressable key={session.id} style={styles.recentRow} onPress={() => onOpenRecent(session.id)}>
                    <TerminalSquare size={12} color={colors.agent} />
                    <Text style={styles.recentText} numberOfLines={1}>{session.title}</Text>
                    <Text style={styles.listMeta}>{timeAgo(session.updatedAt)}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}

        {messages.map((message) =>
          message.role === 'user' ? (
            <UserBubble key={message.id} text={message.content} />
          ) : (
            <AssistantMessage key={message.id} message={message} />
          ),
        )}

        {live ? (
          <>
            <UserBubble text={live.userText} />
            <View style={{ gap: 10 }}>
              {live.memories.length ? (
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}>
                  {live.memories.map((memory) => (
                    <View key={memory.id} style={styles.memoryPill}>
                      <Brain size={9} color={colors.muted} />
                      <Text style={styles.memoryPillText} numberOfLines={1}>{memory.title}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {live.thinking ? <ThinkingBlock text={live.thinking} /> : null}
              {live.text ? <Markdown text={live.text} /> : busy ? (
                <View style={styles.loadingRow}>
                  <Loader2 size={12} color={colors.agent} />
                  <Text style={styles.listMeta}>{live.status === 'awaiting' ? '等待授权…' : '正在处理…'}</Text>
                </View>
              ) : null}
              {live.tools.map((tool) => (
                <MobileToolCard key={tool.callId} tool={tool.tool} args={tool.args} risk={tool.risk} status={tool.status} result={tool.result} summary={tool.summary} />
              ))}
              {live.plan.length ? <PlanCard items={live.plan} /> : null}
              {live.error ? <Text style={styles.error}>{live.error}</Text> : null}
              {!busy ? (
                <Text style={styles.turnEnd}>
                  {live.status === 'aborted' ? '已中止' : live.status === 'error' ? '失败' : '已完成'} · {live.tools.length} 次工具 · {Math.max(1, Math.round((Date.now() - live.startedAt) / 1000))}s
                </Text>
              ) : null}
            </View>
          </>
        ) : null}
      </ScrollView>

      <View style={styles.composer}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 5, paddingBottom: 7 }}>
          {MODES.map((value) => (
            <Pressable key={value} style={[styles.modeChip, mode === value && styles.modeChipActive]} onPress={() => setMode(value)}>
              {value === 'readonly' ? <Lock size={9} color={mode === value ? colors.accent : colors.muted} /> : null}
              <Text style={[styles.modeChipText, mode === value && { color: colors.accent }]}>{modeLabels[value]}</Text>
            </Pressable>
          ))}
          <View style={styles.modeHint}>
            <Text style={styles.listMeta}>{connected ? 'Bridge 在线' : '重连中…'}</Text>
          </View>
        </ScrollView>
        <View style={styles.inputBox}>
          <Pressable style={styles.iconButton} onPress={onOpenCommands} testID="m-commands">
            <TerminalSquare size={15} color={colors.accent} />
          </Pressable>
          <Pressable style={styles.iconButton} onPress={onOpenTables}>
            <AtSign size={15} color={colors.muted} />
          </Pressable>
          <TextInput
            testID="m-chat-input"
            style={styles.chatInput}
            value={input}
            onChangeText={setInput}
            placeholder="描述目标，或输入 SQL…"
            placeholderTextColor={colors.muted}
            multiline
            maxLength={6000}
          />
          {busy ? (
            <Pressable style={[styles.sendButton, { backgroundColor: colors.danger }]} onPress={onStop}>
              <Square size={13} color="#0b0d0d" />
            </Pressable>
          ) : (
            <Pressable testID="m-send" style={[styles.sendButton, (!input.trim() || !connected) && { opacity: 0.4 }]} onPress={onSend} disabled={!input.trim() || !connected}>
              <Send size={14} color="#0b0d0d" />
            </Pressable>
          )}
        </View>
        <Text style={styles.composerHint}>移动端默认只读 · Enter 发送 · @ 引用表</Text>
      </View>
    </View>
  );
}

function TableDataScreen({
  table,
  page,
  loading,
  onBack,
  onRefresh,
  onPage,
}: {
  table: TableInfo;
  page: DataPage | null;
  loading: boolean;
  onBack: () => void;
  onRefresh: () => void;
  onPage: (offset: number) => void;
}) {
  const result = page?.batch.sets[0];
  const limit = page?.limit ?? 50;
  const offset = page?.offset ?? 0;
  const current = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil((page?.total ?? 0) / limit));
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable style={styles.iconButton} onPress={onBack}>
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{table.name}</Text>
          <Text style={styles.listMeta}>只读 · {page?.total ?? '?'} 行</Text>
        </View>
        <Pressable style={styles.iconButton} onPress={onRefresh}>
          <RefreshCw size={15} color={colors.text} />
        </Pressable>
      </View>
      {loading ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 24 }}>
        {(result?.rows ?? []).map((row, rowIndex) => (
          <View key={rowIndex} style={styles.rowCard}>
            <Text style={styles.rowIndex}>#{offset + rowIndex + 1}</Text>
            {(result?.columns ?? []).map((column, colIndex) => (
              <View key={column.name} style={styles.fieldRow}>
                <Text style={styles.fieldName}>{column.name}</Text>
                <Text style={styles.fieldValue} numberOfLines={4}>
                  {row[colIndex] === null || row[colIndex] === undefined
                    ? 'NULL'
                    : typeof row[colIndex] === 'object'
                      ? JSON.stringify(row[colIndex])
                      : String(row[colIndex])}
                </Text>
              </View>
            ))}
          </View>
        ))}
        {!loading && !(result?.rows ?? []).length ? <Text style={styles.hint}>没有数据</Text> : null}
      </ScrollView>
      <View style={styles.pager}>
        <Pressable style={[styles.pagerButton, offset <= 0 && { opacity: 0.4 }]} disabled={offset <= 0} onPress={() => onPage(Math.max(0, offset - limit))}>
          <ChevronLeft size={14} color={colors.text} />
        </Pressable>
        <Text style={styles.listMeta}>{current} / {totalPages}</Text>
        <Pressable style={[styles.pagerButton, current >= totalPages && { opacity: 0.4 }]} disabled={current >= totalPages} onPress={() => onPage(offset + limit)}>
          <ChevronRight size={14} color={colors.text} />
        </Pressable>
      </View>
    </View>
  );
}

function SettingsScreen({
  boot,
  config,
  mode,
  connected,
  onDisconnect,
  onMode,
}: {
  boot: BootstrapData | null;
  config: BridgeConfig;
  mode: PermissionMode;
  connected: boolean;
  onDisconnect: () => void;
  onMode: (mode: PermissionMode) => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeading icon={<SettingsIcon size={16} color={colors.accent} />} title="设置" subtitle="Bridge 与 Agent" />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>BRIDGE</Text>
          <Text style={styles.settingValue}>{config.baseUrl}</Text>
          <Text style={styles.listMeta}>令牌：{config.token.slice(0, 6)}••••••</Text>
          <View style={styles.rowBetween}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <View style={[styles.statusDot, { backgroundColor: connected ? colors.success : colors.warning }]} />
              <Text style={styles.listMeta}>{connected ? 'WebSocket 已连接' : '正在重连'}</Text>
            </View>
            <Text style={styles.listMeta}>v{boot?.version ?? '0.1.0'}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>AGENT</Text>
          <Text style={styles.settingValue}>{boot?.settings.agent.provider === 'local' ? 'Local（离线）' : boot?.settings.agent.model}</Text>
          <Text style={styles.listMeta}>{boot?.tools.length ?? 18} 个工具 · 四层记忆 · {boot?.sessions.length ?? 0} 个会话</Text>
          <Text style={[styles.sectionLabel, { marginTop: 12 }]}>默认权限</Text>
          <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
            {MODES.map((value) => (
              <Pressable key={value} style={[styles.modeChip, mode === value && styles.modeChipActive]} onPress={() => onMode(value)}>
                <Text style={[styles.modeChipText, mode === value && { color: colors.accent }]}>{modeLabels[value]}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.hint, { marginTop: 8 }]}>移动端新会话默认只读；破坏性操作即使在全自动模式下也需要审批。</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>数据</Text>
          <Text style={styles.listMeta}>{boot?.connections.length ?? 0} 个连接 · {boot?.settings.agent.autoMemory ? '自动记忆开启' : '自动记忆关闭'} · {boot?.settings.agent.snapshotBeforeWrite ? '写前备份开启' : '写前备份关闭'}</Text>
        </View>

        <Pressable style={styles.secondaryButton} onPress={() => Alert.alert('解除配对', '将清除设备上的 Bridge 地址与令牌。', [{ text: '取消', style: 'cancel' }, { text: '解除', style: 'destructive', onPress: onDisconnect }])}>
          <Text style={[styles.secondaryButtonText, { color: colors.danger }]}>解除配对</Text>
        </Pressable>

        <Text style={[styles.hint, { textAlign: 'center', marginTop: 6 }]}>AiDB Studio v0.1.0 · Android / iOS / Web</Text>
      </ScrollView>
    </View>
  );
}

function ScreenHeading({ icon, title, subtitle, action }: { icon: React.ReactNode; title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <View style={styles.screenHeading}>
      {icon}
      <View style={{ flex: 1 }}>
        <Text style={styles.screenTitle}>{title}</Text>
        {subtitle ? <Text style={styles.listMeta}>{subtitle}</Text> : null}
      </View>
      {action}
    </View>
  );
}

function BottomTabs({ tab, setTab, busy, bottom }: { tab: TabKey; setTab: (tab: TabKey) => void; busy: boolean; bottom: number }) {
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: 'chat', label: '对话', icon: <Sparkles size={17} color={tab === 'chat' ? colors.agent : colors.muted} /> },
    { key: 'data', label: '数据', icon: <Table2 size={17} color={tab === 'data' ? colors.accent : colors.muted} /> },
    { key: 'connections', label: '连接', icon: <Database size={17} color={tab === 'connections' ? colors.accent : colors.muted} /> },
    { key: 'memory', label: '记忆', icon: <Brain size={17} color={tab === 'memory' ? colors.agent : colors.muted} /> },
    { key: 'settings', label: '设置', icon: <SettingsIcon size={17} color={tab === 'settings' ? colors.accent : colors.muted} /> },
  ];
  return (
    <View style={[styles.bottomTabs, { paddingBottom: Math.max(bottom, 6) }]}>
      {tabs.map((item) => (
        <Pressable key={item.key} testID={`m-tab-${item.key}`} style={styles.bottomTab} onPress={() => setTab(item.key)}>
          <View>
            {item.icon}
            {item.key === 'chat' && busy ? <View style={styles.busyDot} /> : null}
          </View>
          <Text style={[styles.bottomLabel, tab === item.key && { color: item.key === 'chat' || item.key === 'memory' ? colors.agent : colors.accent }]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

function UserBubble({ text }: { text: string }) {
  return (
    <View style={styles.userRow}>
      <Text style={styles.promptMark}>❯</Text>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{text}</Text>
      </View>
    </View>
  );
}

function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Pressable style={styles.thinking} onPress={() => setOpen(!open)}>
      <Text style={styles.listMeta}>{open ? '▾' : '▸'} 思考过程</Text>
      {open ? <Text style={[styles.listMeta, { marginTop: 5, lineHeight: 17 }]}>{text}</Text> : null}
    </Pressable>
  );
}

function AssistantMessage({ message }: { message: AgentMessage }) {
  const results = new Map<string, ToolResult>();
  for (const block of message.blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const thinking = message.blocks.find((b) => b.type === 'thinking')?.text;
  const tools = message.blocks.filter((b) => b.type === 'tool_call').length;
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}>
        <View style={styles.agentAvatar}><Sparkles size={10} color={colors.agent} /></View>
        <Text style={styles.listMeta}>AiDB Agent</Text>
      </View>
      <View style={{ paddingLeft: 26, gap: 10 }}>
        {thinking ? <ThinkingBlock text={thinking} /> : null}
        {message.content ? <Markdown text={message.content} /> : null}
        {message.blocks.map((block, index) => {
          if (block.type === 'tool_call') {
            const result = block.callId ? results.get(block.callId) : undefined;
            return (
              <MobileToolCard
                key={`${message.id}_${block.callId ?? index}`}
                tool={block.tool ?? 'tool'}
                args={block.args}
                risk={block.risk}
                status={result ? (result.ok ? 'ok' : 'error') : 'error'}
                result={result}
              />
            );
          }
          if (block.type === 'plan') return <PlanCard key={`${message.id}_plan_${index}`} items={block.items ?? []} />;
          return null;
        })}
        {tools ? <Text style={styles.turnEnd}>{tools} 次工具调用</Text> : null}
      </View>
    </View>
  );
}

function MobileToolCard({
  tool,
  args,
  risk,
  status,
  result,
  summary,
}: {
  tool: string;
  args: unknown;
  risk?: Risk;
  status: LiveTool['status'];
  result?: ToolResult;
  summary?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const sql = args && typeof args === 'object' ? (args as Record<string, unknown>).sql : undefined;
  const data = result?.data as Record<string, any> | undefined;
  const chart = data?.chart as { title?: string; series?: Array<{ label: string; value: number }> } | undefined;
  const chartMax = Math.max(1, ...(chart?.series ?? []).map((point) => point.value));
  return (
    <Pressable style={[styles.toolCard, status === 'error' && { borderLeftColor: colors.danger }, status === 'awaiting' && { borderLeftColor: colors.warning }]} onPress={() => setOpen(!open)}>
      <View style={styles.toolHead}>
        {status === 'running' ? <Loader2 size={11} color={colors.agent} /> : status === 'ok' ? <Check size={11} color={colors.success} /> : <X size={11} color={colors.danger} />}
        <Text style={styles.toolName}>{tool}</Text>
        <Text style={styles.toolSummary} numberOfLines={1}>{summary ?? (typeof sql === 'string' ? sql.replace(/\s+/g, ' ') : '')}</Text>
        <Text style={[styles.riskBadgeText, { color: riskColor(risk) }]}>{riskLabels[risk ?? ''] ?? ''}</Text>
      </View>
      {open ? (
        <View style={styles.toolBody}>
          <Text style={styles.toolLabel}>参数</Text>
          <Text style={styles.codeText}>{typeof sql === 'string' ? String(sql) : JSON.stringify(args, null, 2).slice(0, 1600)}</Text>
          {result ? (
            <>
              <Text style={styles.toolLabel}>结果</Text>
              <Text style={[styles.listMeta, { color: result.ok ? colors.success : colors.danger }]}>{result.summary}</Text>
              {result.error ? <Text style={[styles.hint, { color: colors.danger, marginTop: 4 }]}>{result.error.message}</Text> : null}
              {chart?.series?.length ? (
                <View style={{ marginTop: 7, gap: 4 }}>
                  <Text style={[styles.listMeta, { color: colors.text }]}>{chart.title}</Text>
                  {chart.series.slice(0, 8).map((point) => (
                    <View key={point.label} style={{ gap: 2 }}>
                      <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                        <Text style={[styles.listMeta, { flex: 1 }]} numberOfLines={1}>{point.label}</Text>
                        <Text style={[styles.listMeta, { color: colors.text }]}>{point.value.toLocaleString()}</Text>
                      </View>
                      <View style={{ height: 4, backgroundColor: colors.elevated, borderRadius: 2, overflow: 'hidden' }}>
                        <View style={{ width: `${Math.max(3, (point.value / chartMax) * 100)}%`, height: 4, backgroundColor: colors.agent }} />
                      </View>
                    </View>
                  ))}
                </View>
              ) : null}
              {Array.isArray(data?.findings) && data.findings.length ? (
                <View style={{ marginTop: 6, gap: 5 }}>
                  {data.findings.slice(0, 5).map((finding: any, index: number) => (
                    <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: finding.severity === 'high' ? colors.danger : finding.severity === 'medium' ? colors.warning : colors.muted, paddingLeft: 6 }}>
                      <Text style={[styles.listMeta, { color: colors.text }]}>{String(finding.severity).toUpperCase()} · {finding.title}</Text>
                      <Text style={styles.listMeta} numberOfLines={3}>{finding.detail}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {!chart && data?.columns && data?.rows ? (
                <ScrollView horizontal style={{ marginTop: 6 }}>
                  <View>
                    {(data.rows as unknown[][]).slice(0, 5).map((row, i) => (
                      <Text key={i} style={[styles.codeText, { marginTop: 3 }]}>
                        {row.map((value) => (value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value))).join(' · ').slice(0, 160)}
                      </Text>
                    ))}
                  </View>
                </ScrollView>
              ) : null}
              {data?.path ? <Text style={[styles.codeText, { marginTop: 4 }]}>{String(data.path)}</Text> : null}
            </>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function PlanCard({ items }: { items: AgentPlanItem[] }) {
  if (!items.length) return null;
  return (
    <View style={styles.planCard}>
      <Text style={styles.sectionLabel}>计划 · {items.filter((i) => i.status === 'done').length}/{items.length}</Text>
      {items.map((item) => (
        <View key={item.id} style={styles.planRow}>
          <Text style={[styles.planIcon, item.status === 'done' && { color: colors.success }, item.status === 'doing' && { color: colors.agent }]}>
            {item.status === 'done' ? '✓' : item.status === 'doing' ? '◐' : '○'}
          </Text>
          <Text style={[styles.planText, item.status === 'done' && { color: colors.muted, textDecorationLine: 'line-through' }]}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}

function Inline({ text, style }: { text: string; style?: any }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return (
    <Text style={[styles.mdText, style]}>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={styles.mdBold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={styles.mdCode}>{part.slice(1, -1)}</Text>;
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}

function Markdown({ text }: { text: string }) {
  const chunks = text.split('```');
  return (
    <View style={{ gap: 6 }}>
      {chunks.map((chunk, index) => {
        if (index % 2 === 1) {
          const code = chunk.replace(/^[a-zA-Z]+\n/, '');
          return (
            <View key={index} style={styles.codeBlock}>
              <Text style={styles.codeText}>{code.trim()}</Text>
            </View>
          );
        }
        return (
          <View key={index} style={{ gap: 3 }}>
            {chunk.split('\n').map((line, lineIndex) => {
              const trimmed = line.trim();
              if (!trimmed) return null;
              if (trimmed.startsWith('# ')) return <Text key={lineIndex} style={styles.mdHeading}>{trimmed.slice(2)}</Text>;
              if (/^\|?[\s:-]+\|/.test(trimmed)) return null;
              if (trimmed.startsWith('|')) {
                return <Text key={lineIndex} style={styles.mdTable}>{trimmed.replace(/\|/g, ' │ ')}</Text>;
              }
              if (/^[-*]\s+/.test(trimmed)) return <Inline key={lineIndex} text={`• ${trimmed.replace(/^[-*]\s+/, '')}`} style={styles.mdBullet} />;
              if (/^\d+\.\s+/.test(trimmed)) return <Inline key={lineIndex} text={trimmed} style={styles.mdBullet} />;
              if (trimmed.startsWith('>')) return <Inline key={lineIndex} text={trimmed.replace(/^>\s*/, '')} style={styles.mdQuote} />;
              return <Inline key={lineIndex} text={trimmed} />;
            })}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
  logo: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  logoText: { color: '#fff', fontWeight: '800', fontSize: 17 },
  logoLarge: { width: 64, height: 64, borderRadius: 18, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  logoLargeText: { color: '#fff', fontWeight: '800', fontSize: 23 },
  logoSmall: { width: 30, height: 30, borderRadius: 9, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  logoSmallText: { color: '#fff', fontWeight: '800', fontSize: 11 },
  pairWrap: { paddingHorizontal: 20, flexGrow: 1, justifyContent: 'center' },
  pairTitle: { fontSize: 24, fontWeight: '700', color: colors.text, textAlign: 'center', marginTop: 16, letterSpacing: -0.5 },
  pairSubtitle: { color: colors.secondary, textAlign: 'center', fontSize: 12.5, lineHeight: 19, marginTop: 8, marginBottom: 24 },
  card: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.lg, padding: 14, gap: 6 },
  label: { color: colors.secondary, fontSize: 11, marginTop: 6 },
  input: { height: 42, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.elevated, paddingHorizontal: 12, color: colors.text, fontSize: 13 },
  codeInput: { letterSpacing: 6, fontSize: 20, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  error: { color: colors.danger, fontSize: 11.5, marginTop: 8, lineHeight: 17 },
  primaryButton: { height: 42, borderRadius: radius.md, backgroundColor: colors.agent, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 14 },
  primaryButtonText: { color: '#1a120d', fontWeight: '700', fontSize: 13 },
  secondaryButton: { height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel },
  secondaryButtonText: { color: colors.secondary, fontSize: 12.5 },
  paleButton: { height: 40, borderRadius: radius.md, backgroundColor: colors.elevated, alignItems: 'center', justifyContent: 'center' },
  paleButtonText: { color: colors.text, fontSize: 12.5 },
  primarySmall: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.agent, paddingHorizontal: 9, height: 26, borderRadius: 7 },
  primarySmallText: { color: '#1a120d', fontSize: 11, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: colors.elevated, borderRadius: radius.md, padding: 3, marginTop: 10, marginBottom: 6 },
  segmentItem: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  segmentActive: { backgroundColor: colors.bg },
  segmentText: { color: colors.muted, fontSize: 12 },
  segmentTextActive: { color: colors.text, fontWeight: '600' },
  pairNotes: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 18, paddingHorizontal: 6 },
  pairNoteText: { flex: 1, color: colors.muted, fontSize: 10.5, lineHeight: 16 },

  app: { flex: 1, backgroundColor: colors.bg },
  topSafe: { backgroundColor: colors.panel },
  topbar: { height: 52, backgroundColor: colors.panel, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  brand: { color: colors.text, fontSize: 13, fontWeight: '700' },
  brandSub: { color: colors.muted, fontSize: 9.5, marginTop: 1 },
  connChip: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: colors.elevated, borderRadius: 999, paddingHorizontal: 9, height: 26, maxWidth: 150 },
  connChipText: { color: colors.secondary, fontSize: 10.5, flexShrink: 1 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  iconButton: { width: 34, height: 34, borderRadius: 9, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.elevated },

  chatHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  chatTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  connInline: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  chatEmpty: { alignItems: 'center', paddingTop: 26, paddingHorizontal: 10 },
  agentAvatarLarge: { width: 48, height: 48, borderRadius: 14, backgroundColor: colors.agentSoft, alignItems: 'center', justifyContent: 'center' },
  agentAvatar: { width: 19, height: 19, borderRadius: 6, backgroundColor: colors.agentSoft, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { color: colors.text, fontSize: 17, fontWeight: '700', marginTop: 12 },
  emptyHint: { color: colors.muted, fontSize: 11.5, lineHeight: 18, textAlign: 'center', marginTop: 6 },
  capList: { width: '100%', gap: 6, marginTop: 16 },
  capItem: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 11, height: 38 },
  capText: { color: colors.secondary, fontSize: 12 },
  sectionLabel: { color: colors.muted, fontSize: 9.5, letterSpacing: 0.8, textTransform: 'uppercase', fontWeight: '600' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 7, height: 34, borderBottomWidth: 1, borderBottomColor: colors.border },
  recentText: { color: colors.secondary, fontSize: 11.5, flex: 1 },

  userRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  promptMark: { color: colors.agent, fontWeight: '700', fontSize: 13, marginTop: 2 },
  userBubble: { flex: 1, backgroundColor: colors.elevated, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 8 },
  userText: { color: colors.text, fontSize: 12.5, lineHeight: 19 },

  mdText: { color: colors.secondary, fontSize: 12.5, lineHeight: 19 },
  mdBullet: { color: colors.secondary, fontSize: 12.5, lineHeight: 20, paddingLeft: 2 },
  mdHeading: { color: colors.text, fontSize: 14, fontWeight: '700', marginTop: 4 },
  mdBold: { color: colors.text, fontWeight: '700' },
  mdCode: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.text, fontSize: 11 },
  mdTable: { color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 9.5, lineHeight: 15 },
  mdQuote: { color: colors.secondary, borderLeftWidth: 2, borderLeftColor: colors.agent, paddingLeft: 8 },
  codeBlock: { backgroundColor: colors.code, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 9 },
  codeText: { color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10.5, lineHeight: 16 },
  memoryPill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, maxWidth: '70%' },
  memoryPillText: { color: colors.muted, fontSize: 9.5 },
  loadingRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  turnEnd: { color: colors.muted, fontSize: 9.5, textAlign: 'center', marginTop: 4 },

  thinking: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 8, backgroundColor: colors.panel },
  toolCard: { borderWidth: 1, borderColor: colors.border, borderLeftWidth: 2, borderLeftColor: colors.agent, borderRadius: radius.sm, backgroundColor: colors.panel },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  toolName: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, fontWeight: '600' },
  toolSummary: { color: colors.muted, fontSize: 9.5, flex: 1 },
  riskBadgeText: { fontSize: 8, fontWeight: '700' },
  toolBody: { borderTopWidth: 1, borderTopColor: colors.border, padding: 8, gap: 3 },
  toolLabel: { color: colors.muted, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 },
  planCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 9, gap: 5, backgroundColor: colors.panel },
  planRow: { flexDirection: 'row', gap: 7, alignItems: 'flex-start' },
  planIcon: { color: colors.muted, fontSize: 10, width: 12 },
  planText: { flex: 1, color: colors.secondary, fontSize: 11.5, lineHeight: 17 },

  composer: { borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.panel, paddingHorizontal: 10, paddingTop: 8 },
  modeChip: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 23, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.elevated },
  modeChipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  modeChipText: { color: colors.muted, fontSize: 9.5 },
  modeHint: { justifyContent: 'center', marginLeft: 'auto', paddingHorizontal: 4 },
  inputBox: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: 4, paddingVertical: 4 },
  chatInput: { flex: 1, minHeight: 36, maxHeight: 120, color: colors.text, fontSize: 12.5, lineHeight: 18, paddingTop: 8, paddingBottom: 8, paddingHorizontal: 4 },
  sendButton: { width: 34, height: 34, borderRadius: 10, backgroundColor: colors.agent, alignItems: 'center', justifyContent: 'center', marginBottom: 1 },
  composerHint: { color: colors.muted, fontSize: 9, marginTop: 5, marginBottom: 6, textAlign: 'center' },

  screenHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  screenTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 12, height: 52 },
  listTitle: { color: colors.text, fontSize: 12.5, fontWeight: '600' },
  listMeta: { color: colors.muted, fontSize: 10, marginTop: 1 },
  connCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12, gap: 4 },
  connCardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  noteCard: { flexDirection: 'row', gap: 8, alignItems: 'flex-start', backgroundColor: colors.elevated, borderRadius: radius.md, padding: 10, marginTop: 4 },
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  searchInput: { flex: 1, color: colors.text, fontSize: 12.5, height: 32 },
  memoryCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 11 },
  memoryKind: { color: colors.agent, fontSize: 9, textTransform: 'uppercase', letterSpacing: 0.6 },
  memoryTitle: { color: colors.text, fontSize: 12.5, fontWeight: '600', marginTop: 3 },
  memoryContent: { color: colors.secondary, fontSize: 11.5, lineHeight: 17, marginTop: 3 },
  pinRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 7 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },

  tableHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 10, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  rowCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 10, gap: 4 },
  rowIndex: { color: colors.muted, fontSize: 9, marginBottom: 2 },
  fieldRow: { flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  fieldName: { width: 96, color: colors.muted, fontSize: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  fieldValue: { flex: 1, color: colors.secondary, fontSize: 11, lineHeight: 16 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.panel },
  pagerButton: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.elevated },

  bottomTabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.panel, paddingTop: 6 },
  bottomTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingBottom: 2 },
  bottomLabel: { color: colors.muted, fontSize: 9 },
  busyDot: { position: 'absolute', right: -3, top: -1, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.agent },

  modalBackdrop: { flex: 1, backgroundColor: 'rgba(5,8,12,0.7)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: colors.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, borderWidth: 1, borderColor: colors.borderStrong, padding: 14 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 10 },
  sheetTitle: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
  sessionRow: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 8, height: 48, borderRadius: radius.sm },
  riskBadge: { borderWidth: 1, borderRadius: 999, paddingHorizontal: 6, paddingVertical: 1 },
  riskText: { fontSize: 8.5, fontWeight: '700' },
  approvalTool: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, marginBottom: 4 },
  approvalSummary: { color: colors.secondary, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  approvalSql: { maxHeight: 150, backgroundColor: colors.code, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, padding: 8 },
  settingValue: { color: colors.text, fontSize: 12.5, marginTop: 4 },
});
