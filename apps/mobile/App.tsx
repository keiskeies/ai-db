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
  Switch,
  useColorScheme,
  Text as RNText,
  TextInput as RNTextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import * as Linking from 'expo-linking';
import Zeroconf from 'react-native-zeroconf';
import * as Sharing from 'expo-sharing';
import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  Archive,
  ArchiveRestore,
  AtSign,
  BarChart3,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Database,
  FileCode2,
  Gauge,
  History,
  ImagePlus,
  Loader2,
  Lock,
  MessageSquarePlus,
  Pencil,
  Plus,
  RefreshCw,
  ScanLine,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react-native';
import { COMMANDS, parsePairingPayload } from '@aidb/core';
import type {
  AgentEvent,
  AgentSettings,
  AgentMessage,
  AgentMessageBlock,
  AgentPlanItem,
  AgentSessionMeta,
  QueryBatchResult,
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
import { colors, modeLabels, radius, riskColor, riskLabels, setPalette, type ThemeResolved } from './src/theme';
import { setLocale, translate, type Locale } from './src/i18n';

type TabKey = 'chat' | 'data' | 'tools' | 'connections' | 'memory' | 'settings';

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

function Text(props: React.ComponentProps<typeof RNText>) {
  const children = React.Children.map(props.children, (child) => (typeof child === 'string' ? translate(child) : child));
  return <RNText {...props}>{children}</RNText>;
}

function TextInput(props: React.ComponentProps<typeof RNTextInput>) {
  return <RNTextInput {...props} placeholder={props.placeholder ? translate(props.placeholder) : props.placeholder} />;
}

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];
const modeDescriptions: Record<PermissionMode, string> = {
  readonly: '只查询，不允许任何写入或结构变更',
  ask: '每次写入、DDL 或破坏性操作都先询问',
  auto: '非破坏性操作自动执行，破坏性操作仍询问',
  full: '在审批策略允许的范围内全部自动执行',
};

/** RN Web 没有实现带按钮的 Alert：统一用浏览器原生确认/提示，避免按钮点了没反应。 */
function notify(title: string, message: string): void {
  const heading = translate(title);
  const body = translate(message);
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${heading}

${body}`);
    return;
  }
  Alert.alert(heading, body);
}

async function shareBase64(base64: string, format: string): Promise<void> {
  if (Platform.OS === 'web') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const mime = format === 'csv' ? 'text/csv' : format === 'json' ? 'application/json' : 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `export-${Date.now()}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const path = `${FileSystem.cacheDirectory}export-${Date.now()}.${format}`;
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
}

function humanBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function quoteIdent(name: string, engine: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  if (engine === 'sqlserver') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

function confirmAction(title: string, message: string, confirmLabel = '确定'): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(`${title}

${message}`) : false);
  }
  return new Promise((resolve) => {
    Alert.alert(
      translate(title),
      translate(message),
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

export default function App() {
  const scheme = useColorScheme();
  const [themeMode, setThemeMode] = useState<'dark' | 'light' | 'system'>(() => {
    try {
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('aidb.mobile.theme') : null;
      return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
    } catch {
      return 'system';
    }
  });
  const resolvedTheme: ThemeResolved = themeMode === 'system' ? (scheme === 'light' ? 'light' : 'dark') : themeMode;
  applyTheme(resolvedTheme);
  const [locale, setLocaleState] = useState<Locale>(() => {
    try {
      return typeof localStorage !== 'undefined' && localStorage.getItem('aidb.mobile.locale') === 'en' ? 'en' : 'zh';
    } catch {
      return 'zh';
    }
  });
  setLocale(locale);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('aidb.mobile.locale', locale);
    } catch {
      /* ignore */
    }
  }, [locale]);
  useEffect(() => {
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('aidb.mobile.theme', themeMode);
    } catch {
      /* ignore */
    }
  }, [themeMode]);
  return (
    <SafeAreaProvider>
      <StatusBar style={resolvedTheme === 'light' ? 'dark' : 'light'} />
      <Root themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeMode={setThemeMode} locale={locale} onLocale={setLocaleState} />
    </SafeAreaProvider>
  );
}

function Root({ themeMode, resolvedTheme, onThemeMode, locale, onLocale }: { themeMode: 'dark' | 'light' | 'system'; resolvedTheme: ThemeResolved; onThemeMode: (mode: 'dark' | 'light' | 'system') => void; locale: Locale; onLocale: (locale: Locale) => void }) {
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
      themeMode={themeMode}
      resolvedTheme={resolvedTheme}
      onThemeMode={onThemeMode}
      locale={locale}
      onLocale={onLocale}
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
  useEffect(() => {
    const apply = (raw: string | null) => {
      if (!raw) return;
      try {
        const parsed = Linking.parse(raw);
        if (parsed.hostname !== 'pair' && parsed.path !== 'pair') return;
        const params = (parsed.queryParams ?? {}) as Record<string, unknown>;
        if (typeof params.url === 'string') setUrl(params.url);
        if (typeof params.code === 'string') {
          setCode(params.code);
          setMethod('pair');
        }
      } catch {
        /* 忽略非配对深链 */
      }
    };
    void Linking.getInitialURL().then(apply);
    const subscription = Linking.addEventListener('url', (event) => apply(event.url));
    return () => subscription.remove();
  }, []);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState<Array<{ url: string; version?: string }>>([]);
  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const openScanner = async () => {
    setScanError(null);
    scannedRef.current = false;
    if (Platform.OS === 'web' && typeof window !== 'undefined' && !window.isSecureContext) {
      setError('浏览器要求 HTTPS 才能使用相机；请改用 https 地址打开，或手动输入 Bridge 地址与配对码。');
      return;
    }
    const next = permission?.granted ? permission : await requestPermission();
    if (!next.granted) {
      setError('未获得相机权限，可在系统设置中开启，或手动输入 Bridge 地址与配对码。');
      return;
    }
    setScannerOpen(true);
  };

  const handleScan = ({ data }: { data: string }) => {
    if (scannedRef.current) return;
    try {
      const paired = parsePairingPayload(data);
      scannedRef.current = true;
      setUrl(paired.url);
      setCode(paired.code);
      setMethod('pair');
      setScannerOpen(false);
      setError(null);
    } catch (err: any) {
      setScanError(err?.message ?? '无法识别二维码');
    }
  };

  const discoverMdns = async (): Promise<Array<{ url: string; version?: string }>> => {
    if (Platform.OS === 'web') return [];
    return new Promise((resolve) => {
      const found: Array<{ url: string; version?: string }> = [];
      let zeroconf: Zeroconf | undefined;
      const finish = () => {
        clearTimeout(timer);
        try {
          zeroconf?.stop();
          zeroconf?.removeAllListeners();
        } catch {
          /* ignore */
        }
        resolve(found);
      };
      const timer = setTimeout(finish, 4000);
      try {
        zeroconf = new Zeroconf();
        zeroconf.on('resolved', (service: any) => {
          const host = (service.addresses ?? []).find((address: string) => /^\d+\.\d+\.\d+\.\d+$/.test(address)) ?? service.host;
          if (!host) return;
          const entry = { url: `http://${host}:${service.port}`, version: service.txt?.version };
          if (!found.some((item) => item.url === entry.url)) found.push(entry);
        });
        zeroconf.on('error', () => finish());
        zeroconf.scan('aidb', 'tcp', 'local.');
      } catch {
        finish();
      }
    });
  };

  const discover = async () => {
    setDiscovering(true);
    setDiscovered([]);
    try {
      const mdns = await discoverMdns();
      if (mdns.length) {
        setDiscovered(mdns);
        return;
      }
      const parsed = new URL(normalizeBaseUrl(url));
      const match = /^(\d+\.\d+\.\d+)\.\d+$/.exec(parsed.hostname);
      if (!match) throw new Error('请先填写一个局域网 IP，例如 192.168.1.10');
      if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.protocol === 'https:' && parsed.protocol === 'http:') {
        throw new Error('HTTPS 页面不能扫描 HTTP 地址，请改用 https Bridge 或手动输入');
      }
      const port = parsed.port || '8787';
      const hosts = Array.from({ length: 254 }, (_, index) => `${match[1]}.${index + 1}`);
      const found: Array<{ url: string; version?: string }> = [];
      let cursor = 0;
      const workers = Array.from({ length: 24 }, async () => {
        while (cursor < hosts.length) {
          const host = hosts[cursor++];
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 700);
          try {
            const response = await fetch(`http://${host}:${port}/api/health`, { signal: controller.signal });
            if (response.ok) {
              const body = await response.json().catch(() => null);
              found.push({ url: `http://${host}:${port}`, version: body?.version });
            }
          } catch {
            /* 忽略不可达主机 */
          } finally {
            clearTimeout(timer);
          }
        }
      });
      await Promise.all(workers);
      setDiscovered(found.sort((a, b) => a.url.localeCompare(b.url)));
      if (!found.length) setError('没有发现同一网段的 Bridge；请确认 Bridge 绑定 0.0.0.0 且端口为 ' + port);
    } catch (err: any) {
      setError(err?.message ?? '扫描失败');
    } finally {
      setDiscovering(false);
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const baseUrl = normalizeBaseUrl(url);
      if (method === 'pair') {
        if (!/^\d{6}$/.test(code.trim())) throw new Error('请输入 6 位配对码');
        const result = await claimPairing(baseUrl, code.trim(), Platform.OS);
        const cfg = { baseUrl, token: result.token, deviceId: result.device?.id };
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
          <View style={styles.labelRow}>
            <Text style={[styles.label, { marginTop: 0 }]}>Bridge 地址</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Pressable testID="m-discover" onPress={() => void discover()} hitSlop={8} style={styles.scanLink}>
                <Search size={13} color={colors.accent} />
                <Text style={styles.scanLinkText}>{discovering ? '扫描中…' : '发现附近'}</Text>
              </Pressable>
              <Pressable testID="m-scan-qr" onPress={() => void openScanner()} hitSlop={8} style={styles.scanLink}>
                <ScanLine size={13} color={colors.accent} />
                <Text style={styles.scanLinkText}>扫码配对</Text>
              </Pressable>
            </View>
          </View>
          {discovered.length ? (
            <View style={{ gap: 6, marginTop: 8 }}>
              {discovered.map((item) => (
                <Pressable key={item.url} testID={`m-discovered-${item.url}`} style={styles.modeChip} onPress={() => setUrl(item.url)}>
                  <Text style={styles.modeChipText}>{item.url}{item.version ? ` · v${item.version}` : ''}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
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
      <Modal visible={scannerOpen} animationType="slide" onRequestClose={() => setScannerOpen(false)}>
        <View style={styles.scanWrap}>
          {permission?.granted ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={scannerOpen ? handleScan : undefined}
            />
          ) : null}
          <View style={[styles.scanHead, { paddingTop: insets.top + 12 }]}>
            <Text style={styles.scanTitle}>扫描桌面端二维码</Text>
            <Pressable onPress={() => setScannerOpen(false)} hitSlop={12} testID="m-scan-close">
              <X size={22} color="#fff" />
            </Pressable>
          </View>
          <View pointerEvents="none" style={styles.scanFrame} />
          <View style={[styles.scanFoot, { paddingBottom: insets.bottom + 24 }]}>
            <Text style={styles.scanHint}>把桌面「为移动端配对」的二维码放入框内</Text>
            {scanError ? <Text style={styles.scanError}>{scanError}</Text> : null}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function Main({ config, onDisconnect, themeMode, resolvedTheme, onThemeMode, locale, onLocale }: { config: BridgeConfig; onDisconnect: () => void; themeMode: 'dark' | 'light' | 'system'; resolvedTheme: ThemeResolved; onThemeMode: (mode: 'dark' | 'light' | 'system') => void; locale: Locale; onLocale: (locale: Locale) => void }) {
  const insets = useSafeAreaInsets();
  const client = useMemo(() => new BridgeClient(config), [config]);
  const [boot, setBoot] = useState<BootstrapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<TabKey>('chat');
  const [connections, setConnections] = useState<ConnectionConfig[]>([]);
  const [activeConnectionId, setActiveConnectionId] = useState<string | undefined>();
  const [databases, setDatabases] = useState<string[]>([]);
  const [activeDatabase, setActiveDatabase] = useState<string | undefined>();
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [sessions, setSessions] = useState<AgentSessionMeta[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<AgentSessionMeta[]>([]);
  const [sessionView, setSessionView] = useState<'active' | 'archived'>('active');
  const [sessionId, setSessionId] = useState<string | undefined>();
  const [sessionMeta, setSessionMeta] = useState<AgentSessionMeta | undefined>();
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [live, setLive] = useState<LiveTurn | undefined>();
  const [approval, setApproval] = useState<ApprovalState | undefined>();
  const [mode, setMode] = useState<PermissionMode>('readonly');
  const [input, setInput] = useState('');
  const [pendingImages, setPendingImages] = useState<Array<{ id: string; mime: string }>>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [picker, setPicker] = useState<'sessions' | 'databases' | 'connections' | 'tables' | null>(null);
  const [selectedTable, setSelectedTable] = useState<TableInfo | null>(null);
  const [dataPage, setDataPage] = useState<DataPage | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [sessionQuery, setSessionQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<{ id?: string; kind: string; title: string; content: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [toolPage, setToolPage] = useState<'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | 'commands' | null>(null);
  const [toolTable, setToolTable] = useState<string | undefined>(undefined);
  const [toolSql, setToolSql] = useState<string | undefined>(undefined);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const activeConnectionIdRef = useRef<string | undefined>(undefined);
  const schemaInFlightRef = useRef(false);
  const preferredDatabaseRef = useRef<string | undefined>(undefined);
  const schemaPendingRef = useRef(false);
  const handlerRef = useRef<(event: any) => void>(() => undefined);
  const scrollRef = useRef<ScrollView>(null);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const busy = live?.status === 'streaming' || live?.status === 'awaiting';

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    activeConnectionIdRef.current = activeConnectionId;
  }, [activeConnectionId]);

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

  const saveAgent = async (patch: Record<string, unknown>) => {
    try {
      const result = await client.updateSettings({ agent: patch as unknown as AgentSettings });
      setBoot((prev) => (prev ? { ...prev, settings: result.settings } : prev));
    } catch (err: any) {
      notify('保存失败', err?.message ?? '无法更新模型设置');
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

  useEffect(() => {
    if (!activeConnectionId) {
      setDatabases([]);
      setActiveDatabase(undefined);
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
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, connections]);

  useEffect(() => {
    if (!activeConnectionId) return;
    void loadSchema(activeConnectionId, activeDatabase);
    setSelectedTable(null);
    setDataPage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConnectionId, activeDatabase]);

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
        ws.onopen = () => {
          if (disposed) return;
          setConnected(true);
          // 断线期间的事件不会补发；重连后补刷一次当前连接。
          if (activeConnectionIdRef.current) void loadSchema(activeConnectionIdRef.current);
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
      notify('加载失败', err?.message ?? '');
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
      if (detail.session.connectionId) {
        preferredDatabaseRef.current = detail.session.database;
        setActiveConnectionId(detail.session.connectionId);
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

  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        base64: true,
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: Math.max(1, 4 - pendingImages.length),
      });
      if (result.canceled || !result.assets?.length) return;
      setUploadingImage(true);
      for (const asset of result.assets) {
        if (!asset.base64) continue;
        const uploaded = await client.uploadAttachment(asset.base64, asset.mimeType ?? 'image/jpeg');
        setPendingImages((prev) => (prev.length >= 4 ? prev : [...prev, { id: uploaded.attachment.id, mime: asset.mimeType ?? 'image/jpeg' }]));
      }
    } catch (err: any) {
      notify('上传失败', err?.message ?? '');
    } finally {
      setUploadingImage(false);
    }
  };

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
    if (!approval) return;
    try {
      await client.approve(approval.approvalId, decision, scope);
      setApproval(undefined);
    } catch (err: any) {
      notify('授权失败', err?.message ?? '');
    }
  };

  const openTable = async (table: TableInfo, offset = 0) => {
    if (!activeConnectionId) return;
    setSelectedTable(table);
    setDataLoading(true);
    try {
      const page = await client.data(activeConnectionId, table.name, 50, offset, activeDatabase);
      setDataPage(page);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    } finally {
      setDataLoading(false);
    }
  };

  const refreshAll = async () => {
    setRefreshing(true);
    await bootstrap();
    await refreshSessions();
    if (activeConnectionId) await loadSchema(activeConnectionId, activeDatabase);
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
      <Modal visible={commandOpen} transparent animationType="slide" onRequestClose={() => setCommandOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '80%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>命令</Text>
              <Pressable style={styles.iconButton} testID="m-command-close" onPress={() => setCommandOpen(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            <Text style={styles.hint}>选一个目的即可，Agent 会自己理解并执行，不需要填参数。</Text>
            <ScrollView>
              {COMMANDS.filter((command) => command.id !== 'ask').map((command) => (
                <Pressable
                  key={command.id}
                  style={styles.sessionRow}
                  testID={`m-command-${command.id}`}
                  onPress={() => {
                    setCommandOpen(false);
                    setInput(`/${command.id} `);
                  }}
                >
                  <TerminalSquare size={14} color={colors.agent} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listTitle}>{command.title.zh}</Text>
                    <Text style={styles.listMeta} numberOfLines={2}>{command.description.zh}</Text>
                  </View>
                  <Text style={{ color: colors.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10 }}>/{command.id}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
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
            onOpenSessions={() => { setPicker('sessions'); setSessionView('active'); void refreshSessions(); void refreshArchivedSessions(); }}
            onOpenConnections={() => setPicker('connections')}
            onOpenTables={() => setPicker('tables')}
            onOpenCommands={() => setCommandOpen(true)}
            onOpenRecent={(id) => void openSession(id)}
            scrollRef={scrollRef}
            tables={tables}
            agentSettings={boot?.settings.agent}
            onSaveAgent={(patch) => void saveAgent(patch)}
            databases={databases}
            database={activeDatabase}
            onOpenDatabases={() => setPicker('databases')}
            pendingImages={pendingImages}
            uploadingImage={uploadingImage}
            onPickImage={() => void pickImage()}
            onRemoveImage={(id) => setPendingImages((prev) => prev.filter((item) => item.id !== id))}
          />
        ) : null}

        {tab === 'data' ? (
          selectedTable ? (
            <TableDataScreen
              client={client}
              table={selectedTable}
              page={dataPage}
              loading={dataLoading}
              connection={activeConnection}
              database={activeDatabase}
              onBack={() => {
                setSelectedTable(null);
                setDataPage(null);
              }}
              onRefresh={() => void openTable(selectedTable, dataPage?.offset ?? 0)}
              onPage={(offset) => void openTable(selectedTable, offset)}
              onDesign={() => {
                setToolTable(selectedTable.name);
                setTab('tools');
                setToolPage('table');
              }}
              onChanged={() => void openTable(selectedTable, dataPage?.offset ?? 0)}
            />
          ) : (
            <View style={{ flex: 1 }}>
              <ScreenHeading icon={<Table2 size={16} color={colors.accent} />} title="数据" subtitle={`${connName}${databases.length > 1 && activeDatabase ? ' · ' + activeDatabase : ''} · ${tables.length} 个对象`} action={
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

        {tab === 'tools' ? (
          toolPage === 'query' ? (
            <QueryScreen client={client} connection={activeConnection} database={activeDatabase} initialSql={toolSql} onBack={() => setToolPage(null)} />
          ) : toolPage === 'backups' ? (
            <BackupScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'dashboards' ? (
            <DashboardScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'io' ? (
            <ImportExportScreen client={client} connection={activeConnection} database={activeDatabase} tables={tables} onBack={() => setToolPage(null)} />
          ) : toolPage === 'table' ? (
            <TableDesignScreen client={client} connection={activeConnection} database={activeDatabase} tables={tables} initialTable={toolTable} onBack={() => setToolPage(null)} />
          ) : toolPage === 'dictionary' ? (
            <DictionaryScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'monitor' ? (
            <MonitorScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'search' ? (
            <SearchScreen client={client} connection={activeConnection} database={activeDatabase} onBack={() => setToolPage(null)} />
          ) : toolPage === 'history' ? (
            <HistoryScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} onPick={(sql) => { setToolSql(sql); setToolPage('query'); }} />
          ) : toolPage === 'audit' ? (
            <AuditScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'artifacts' ? (
            <ArtifactsScreen client={client} onBack={() => setToolPage(null)} />
          ) : toolPage === 'users' ? (
            <UsersScreen client={client} connection={activeConnection} onBack={() => setToolPage(null)} />
          ) : toolPage === 'commands' ? (
            <CommandScreen client={client} connections={connections} activeConnection={activeConnection} onBack={() => setToolPage(null)} />
          ) : (
            <ToolsScreen
              connection={activeConnection}
              database={activeDatabase}
              connections={connections}
              tables={tables}
              sessions={sessions}
              memories={memories}
              onRunPrompt={(text) => {
                setInput(text);
                setTab('chat');
              }}
              onRunCommand={(id) => {
                setInput(`/${id} `);
                setTab('chat');
              }}
              onOpen={(page) => {
                if (page === 'query') setToolSql(undefined);
                setToolPage(page);
              }}
            />
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
                  testID={`m-connection-${conn.id}`}
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
                    {conn.id === activeConnectionId && activeDatabase && databases.length > 1 ? ` · ${activeDatabase}` : ''}
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
            <ScreenHeading
              icon={<Brain size={16} color={colors.agent} />}
              title="记忆"
              subtitle={`${memories.length} 条 · 跨会话召回`}
              action={
                <Pressable testID="m-memory-new" style={styles.iconButton} onPress={() => setMemoryDraft({ kind: 'fact', title: '', content: '' })}>
                  <Plus size={16} color={colors.text} />
                </Pressable>
              }
            />
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
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
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
                    <Pressable style={styles.pinRow} onPress={() => setMemoryDraft({ id: memory.id, kind: memory.kind, title: memory.title, content: memory.content })}>
                      <Pencil size={11} color={colors.muted} />
                      <Text style={styles.listMeta}>编辑</Text>
                    </Pressable>
                    <Pressable
                      style={styles.pinRow}
                      onPress={async () => {
                        if (!(await confirmAction('删除记忆', memory.title, '删除'))) return;
                        try {
                          await client.deleteMemory(memory.id);
                          void loadMemories();
                        } catch (err: any) {
                          notify('删除失败', err?.message ?? '');
                        }
                      }}
                    >
                      <Trash2 size={11} color={colors.muted} />
                      <Text style={styles.listMeta}>删除</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
              {!memories.length && !memoryLoading ? <Text style={styles.hint}>还没有记忆。与 AI 对话时它会自动沉淀事实、偏好与结论。</Text> : null}
            </ScrollView>
          </View>
        ) : null}

        {tab === 'settings' ? (
          <SettingsScreen client={client} boot={boot} config={config} mode={mode} connected={connected} onDisconnect={onDisconnect} onMode={setMode} themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeMode={onThemeMode} locale={locale} onLocale={onLocale} />
        ) : null}
      </View>

      <BottomTabs tab={tab} setTab={setTab} busy={busy} bottom={insets.bottom} />

      {memoryDraft ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setMemoryDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{memoryDraft.id ? '编辑记忆' : '新建记忆'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setMemoryDraft(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={{ padding: 14, gap: 10 }}>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {(['fact', 'preference', 'schema', 'procedural'] as const).map((kind) => (
                    <Pressable
                      key={kind}
                      style={[styles.modeChip, memoryDraft.kind === kind && styles.modeChipActive]}
                      onPress={() => setMemoryDraft({ ...memoryDraft, kind })}
                    >
                      <Text style={[styles.modeChipText, memoryDraft.kind === kind && { color: colors.accent }]}>{kind}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  testID="m-memory-title"
                  style={styles.input}
                  value={memoryDraft.title}
                  onChangeText={(title) => setMemoryDraft({ ...memoryDraft, title })}
                  placeholder="标题，例如「GMV 口径」"
                  placeholderTextColor={colors.muted}
                />
                <TextInput
                  testID="m-memory-content"
                  style={[styles.input, { height: 110, textAlignVertical: 'top', paddingTop: 10 }]}
                  value={memoryDraft.content}
                  onChangeText={(content) => setMemoryDraft({ ...memoryDraft, content })}
                  placeholder="内容：事实、口径或流程"
                  placeholderTextColor={colors.muted}
                  multiline
                />
                <Pressable
                  testID="m-memory-save"
                  style={styles.primaryButton}
                  onPress={async () => {
                    const title = memoryDraft.title.trim();
                    const content = memoryDraft.content.trim();
                    if (!title || !content) {
                      notify('无法保存', '标题和内容都不能为空');
                      return;
                    }
                    try {
                      if (memoryDraft.id) await client.updateMemory(memoryDraft.id, { kind: memoryDraft.kind, title, content });
                      else await client.createMemory({ kind: memoryDraft.kind, title, content });
                      setMemoryDraft(null);
                      void loadMemories();
                    } catch (err: any) {
                      notify('保存失败', err?.message ?? '');
                    }
                  }}
                >
                  <Text style={styles.primaryButtonText}>保存</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
      ) : null}

      {picker === 'databases' ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '70%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>选择数据库</Text>
                <Pressable testID="m-databases-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView>
                {databases.map((name) => (
                  <Pressable
                    key={name}
                    testID={`m-database-${name}`}
                    style={[styles.sessionRow, activeDatabase === name && { backgroundColor: colors.accentSoft }]}
                    onPress={() => {
                      setActiveDatabase(name);
                      setPicker(null);
                    }}
                  >
                    <Database size={14} color={colors.accent} />
                    <Text style={[styles.listTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text>
                    {activeDatabase === name ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                ))}
                {!databases.length ? <Text style={[styles.hint, { padding: 14 }]}>当前连接没有可切换的数据库。</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}

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
                <Pressable testID="m-sessions-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={styles.searchRow}>
                <Search size={14} color={colors.muted} />
                <TextInput
                  style={styles.searchInput}
                  value={sessionQuery}
                  onChangeText={setSessionQuery}
                  placeholder="搜索会话…"
                  placeholderTextColor={colors.muted}
                  autoCorrect={false}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 8 }}>
                {(['active', 'archived'] as const).map((view) => (
                  <Pressable key={view} style={[styles.modeChip, sessionView === view && styles.modeChipActive]} onPress={() => setSessionView(view)}>
                    <Text style={[styles.modeChipText, sessionView === view && { color: colors.accent }]}>{view === 'active' ? `活跃 ${sessions.length}` : `已归档 ${archivedSessions.length}`}</Text>
                  </Pressable>
                ))}
              </View>
              <ScrollView>
                {(sessionView === 'archived' ? archivedSessions : sessions)
                  .filter((session) => !sessionQuery.trim() || session.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                  .map((session) => (
                    <Pressable key={session.id} style={[styles.sessionRow, session.id === sessionId && { backgroundColor: colors.accentSoft }]} onPress={() => void openSession(session.id)}>
                      <TerminalSquare size={14} color={colors.agent} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listTitle} numberOfLines={1}>{session.title}</Text>
                        <Text style={styles.listMeta}>{timeAgo(session.updatedAt)} · {modeLabels[session.permissionMode]}</Text>
                      </View>
                      <Pressable
                        testID={`m-session-archive-${session.id}`}
                        hitSlop={8}
                        style={{ paddingHorizontal: 6 }}
                        onPress={async () => {
                          try {
                            await client.updateSession(session.id, { archived: sessionView === 'active' });
                            await refreshSessions();
                            await refreshArchivedSessions();
                            if (sessionView === 'active' && sessionId === session.id) {
                              setSessionId(undefined);
                              setSessionMeta(undefined);
                              setMessages([]);
                            }
                          } catch (err: any) {
                            notify('操作失败', err?.message ?? '');
                          }
                        }}
                      >
                        {sessionView === 'active' ? <Archive size={13} color={colors.muted} /> : <ArchiveRestore size={13} color={colors.muted} />}
                      </Pressable>
                      <Pressable testID={`m-session-rename-${session.id}`} hitSlop={8} style={{ paddingHorizontal: 6 }} onPress={() => setRenameTarget({ id: session.id, title: session.title })}>
                        <Pencil size={13} color={colors.muted} />
                      </Pressable>
                      <Pressable testID={`m-session-delete-${session.id}`} hitSlop={8} onPress={() => void deleteSession(session.id)}>
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

      {renameTarget ? (
        <Modal visible transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.sheet}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>重命名会话</Text>
                <Pressable style={styles.iconButton} onPress={() => setRenameTarget(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={{ padding: 14, gap: 10 }}>
                <TextInput
                  testID="m-rename-input"
                  style={styles.input}
                  value={renameTarget.title}
                  onChangeText={(title) => setRenameTarget({ ...renameTarget, title })}
                  placeholder="会话名称"
                  placeholderTextColor={colors.muted}
                  autoFocus
                />
                <Pressable
                  testID="m-rename-save"
                  style={styles.primaryButton}
                  onPress={async () => {
                    const title = renameTarget.title.trim();
                    if (!title) return;
                    try {
                      const result = await client.renameSession(renameTarget.id, title);
                      setSessions((prev) => prev.map((item) => (item.id === result.session.id ? result.session : item)));
                      setArchivedSessions((prev) => prev.map((item) => (item.id === result.session.id ? result.session : item)));
                      if (sessionId === renameTarget.id) setSessionMeta(result.session);
                      setRenameTarget(null);
                    } catch (err: any) {
                      notify('重命名失败', err?.message ?? '');
                    }
                  }}
                >
                  <Text style={styles.primaryButtonText}>保存</Text>
                </Pressable>
              </View>
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

function PermissionSelect({ mode, onChange, testID = 'm-mode-select' }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void; testID?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable testID={testID} style={styles.modeSelect} onPress={() => setOpen(true)}>
        {mode === 'readonly' ? <Lock size={10} color={colors.accent} /> : <ShieldAlert size={10} color={colors.muted} />}
        <Text style={styles.modeSelectText}>{modeLabels[mode]}</Text>
        <ChevronDown size={10} color={colors.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>权限模式</Text>
              <Pressable style={styles.iconButton} onPress={() => setOpen(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            {MODES.map((value) => (
              <Pressable
                key={value}
                testID={`m-mode-${value}`}
                style={[styles.sessionRow, mode === value && { backgroundColor: colors.accentSoft }]}
                onPress={() => {
                  onChange(value);
                  setOpen(false);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.listTitle}>{modeLabels[value]}</Text>
                  <Text style={styles.listMeta}>{modeDescriptions[value]}</Text>
                </View>
                {mode === value ? <Check size={14} color={colors.success} /> : null}
              </Pressable>
            ))}
            <Text style={[styles.hint, { paddingHorizontal: 14, paddingBottom: 16 }]}>全自动仍会按审批策略拦截破坏性操作。</Text>
          </View>
        </View>
      </Modal>
    </>
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
  agentSettings,
  onSaveAgent,
  databases,
  database,
  onOpenDatabases,
  pendingImages,
  uploadingImage,
  onPickImage,
  onRemoveImage,
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
  agentSettings?: AgentSettings;
  onSaveAgent: (patch: Record<string, unknown>) => void;
  databases: string[];
  database?: string;
  onOpenDatabases: () => void;
  pendingImages: Array<{ id: string; mime: string }>;
  uploadingImage: boolean;
  onPickImage: () => void;
  onRemoveImage: (id: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [modelSheet, setModelSheet] = useState(false);
  const modelOptions = useMemo(() => {
    const configs = agentSettings?.modelConfigs ?? [];
    const base = configs.flatMap((config) =>
      config.models.map((entry) => ({
        configId: config.id,
        model: entry.id,
        label: entry.name || entry.id,
        provider: config.name || config.baseUrl || config.id,
      })),
    );
    if (!base.length && agentSettings?.model) {
      base.push({ configId: agentSettings.activeModelId ?? 'default', model: agentSettings.model, label: agentSettings.model, provider: agentSettings.provider });
    }
    const counts = new Map<string, number>();
    for (const item of base) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
    return base.map((item) => (counts.get(item.label)! > 1 ? { ...item, label: `${item.label} · ${item.provider}` } : item));
  }, [agentSettings]);
  const activeModelIndex = modelOptions.findIndex(
    (item) => item.configId === (agentSettings?.activeModelId ?? agentSettings?.modelConfigs?.[0]?.id) && item.model === agentSettings?.model,
  );
  const profile = agentSettings?.model ? agentSettings.modelProfiles?.[agentSettings.model] : undefined;
  const tierLevels = profile?.reasoning
    ? [...new Set((profile.reasoningTiers ?? []).filter((tier) => tier.value?.trim()).map((tier) => tier.level))]
    : [];
  const modelLabel = modelOptions[activeModelIndex]?.label ?? agentSettings?.model ?? '未配置模型';
  const tierLabel = agentSettings?.reasoningTier ?? 'Default';
  const switchModel = (item: { configId: string; model: string }) => {
    if (!agentSettings) return;
    const tiers = agentSettings.modelProfiles?.[item.model]?.reasoningTiers ?? [];
    const keep = agentSettings.reasoningTier && tiers.some((tier) => tier.level === agentSettings.reasoningTier);
    onSaveAgent({ activeModelId: item.configId, model: item.model, ...(keep ? {} : { reasoningTier: null }) });
    setModelSheet(false);
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.chatHead}>
        <View style={{ flex: 1 }}>
          <Text style={styles.chatTitle} numberOfLines={1}>{sessionMeta?.title ?? 'AI 助手'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 1 }}>
            <Pressable testID="m-connection" style={styles.connInline} onPress={onOpenConnections}>
              <Database size={11} color={colors.muted} />
              <Text style={styles.listMeta} numberOfLines={1}>{connection?.name ?? '未选择连接'}</Text>
              <ChevronDown size={11} color={colors.muted} />
            </Pressable>
            {databases.length > 1 ? (
              <Pressable testID="m-database" style={styles.connInline} onPress={onOpenDatabases}>
                <Database size={10} color={colors.accent} />
                <Text style={styles.listMeta} numberOfLines={1}>{database ?? '选择库'}</Text>
                <ChevronDown size={10} color={colors.muted} />
              </Pressable>
            ) : null}
          </View>
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
        <View style={styles.composerTop}>
          <Pressable testID="m-model-select" style={styles.modelPill} onPress={() => setModelSheet(true)}>
            <Sparkles size={10} color={colors.agent} />
            <Text style={styles.modelPillText} numberOfLines={1}>{modelLabel} · {tierLabel}</Text>
            <ChevronDown size={10} color={colors.muted} />
          </Pressable>
          <PermissionSelect mode={mode} onChange={setMode} />
          <View style={styles.modeHint}>
            <Text style={styles.listMeta}>{connected ? 'Bridge 在线' : '重连中…'}</Text>
          </View>
        </View>
        {pendingImages.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingBottom: 6 }}>
            {pendingImages.map((image) => (
              <Pressable key={image.id} style={styles.modeChip} onPress={() => onRemoveImage(image.id)}>
                <ImagePlus size={11} color={colors.accent} />
                <Text style={styles.modeChipText}>图片 · 移除</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <View style={styles.inputBox}>
          <Pressable style={styles.iconButton} onPress={onOpenCommands} testID="m-commands">
            <TerminalSquare size={15} color={colors.accent} />
          </Pressable>
          <Pressable style={styles.iconButton} onPress={onOpenTables}>
            <AtSign size={15} color={colors.muted} />
          </Pressable>
          <Pressable style={styles.iconButton} onPress={onPickImage} disabled={uploadingImage || pendingImages.length >= 4} testID="m-image">
            {uploadingImage ? <ActivityIndicator size="small" color={colors.accent} /> : <ImagePlus size={15} color={colors.muted} />}
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
        <Text style={styles.composerHint}>{modeLabels[mode]}模式 · Enter 发送 · @ 引用表</Text>
      </View>
      <Modal visible={modelSheet} transparent animationType="slide" onRequestClose={() => setModelSheet(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '80%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>模型与思考程度</Text>
              <Pressable style={styles.iconButton} onPress={() => setModelSheet(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView>
              <Text style={styles.sectionLabel}>模型</Text>
              {modelOptions.map((item) => {
                const active = activeModelIndex >= 0 && modelOptions[activeModelIndex]?.configId === item.configId && modelOptions[activeModelIndex]?.model === item.model;
                return (
                  <Pressable key={`${item.configId}:${item.model}`} style={[styles.sessionRow, active && { backgroundColor: colors.accentSoft }]} onPress={() => switchModel(item)}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle} numberOfLines={1}>{item.label}</Text>
                      <Text style={styles.listMeta}>{item.provider}</Text>
                    </View>
                    {active ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                );
              })}
              {!modelOptions.length ? <Text style={[styles.hint, { padding: 14 }]}>桌面端「设置 → 模型」中添加模型后可在此切换。</Text> : null}
              {tierLevels.length ? (
                <>
                  <Text style={styles.sectionLabel}>思考程度</Text>
                  <Pressable
                    style={[styles.sessionRow, !agentSettings?.reasoningTier && { backgroundColor: colors.accentSoft }]}
                    onPress={() => {
                      onSaveAgent({ reasoningTier: null });
                      setModelSheet(false);
                    }}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>Default</Text>
                      <Text style={styles.listMeta}>不下发推理参数，使用服务商默认档位</Text>
                    </View>
                    {!agentSettings?.reasoningTier ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                  {tierLevels.map((level) => (
                    <Pressable
                      key={level}
                      style={[styles.sessionRow, agentSettings?.reasoningTier === level && { backgroundColor: colors.accentSoft }]}
                      onPress={() => {
                        onSaveAgent({ reasoningTier: level });
                        setModelSheet(false);
                      }}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listTitle}>{level}</Text>
                        <Text style={styles.listMeta}>推理档位：{level}</Text>
                      </View>
                      {agentSettings?.reasoningTier === level ? <Check size={14} color={colors.success} /> : null}
                    </Pressable>
                  ))}
                </>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function TableDataScreen({
  client,
  table,
  page,
  loading,
  connection,
  database,
  onBack,
  onRefresh,
  onPage,
  onDesign,
  onChanged,
}: {
  client: BridgeClient;
  table: TableInfo;
  page: DataPage | null;
  loading: boolean;
  connection?: ConnectionConfig;
  database?: string;
  onBack: () => void;
  onRefresh: () => void;
  onPage: (offset: number) => void;
  onDesign: () => void;
  onChanged: () => void;
}) {
  const result = page?.batch.sets[0];
  const limit = page?.limit ?? 50;
  const offset = page?.offset ?? 0;
  const current = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil((page?.total ?? 0) / limit));
  const pkColumns = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
  const canWrite = Boolean(connection && !connection.readonly && pkColumns.length);
  const editableColumns = (table.columns ?? []).filter((column) => !column.autoIncrement && !column.generated);
  const [draft, setDraft] = useState<{ mode: 'insert' | 'edit'; original?: Record<string, unknown>; values: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState(false);

  const valueOf = (row: unknown[], name: string): unknown => {
    const index = (result?.columns ?? []).findIndex((column) => column.name === name);
    return index >= 0 ? row[index] : null;
  };

  const startEdit = (row: unknown[]) => {
    const values: Record<string, string> = {};
    for (const column of table.columns ?? []) {
      const value = valueOf(row, column.name);
      values[column.name] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    const original: Record<string, unknown> = {};
    for (const pk of pkColumns) original[pk] = valueOf(row, pk);
    setDraft({ mode: 'edit', values, original });
  };

  const save = async () => {
    if (!draft || !connection) return;
    setSaving(true);
    try {
      const values: Record<string, unknown> = {};
      for (const column of table.columns ?? []) {
        if (column.autoIncrement || column.generated) continue;
        if (draft.mode === 'edit' && pkColumns.includes(column.name)) continue;
        const raw = draft.values[column.name] ?? '';
        values[column.name] = raw === '' && column.nullable ? null : raw;
      }
      if (draft.mode === 'insert') {
        await client.rows(connection.id, table.name, 'insert', { values }, database);
      } else {
        await client.rows(connection.id, table.name, 'update', { values, key: draft.original ?? {} }, database);
      }
      setDraft(null);
      notify('已保存', draft.mode === 'insert' ? '新行已写入' : '修改已保存');
      onChanged();
    } catch (err: any) {
      notify('保存失败', err?.message ?? '');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: unknown[]) => {
    if (!connection) return;
    const key: Record<string, unknown> = {};
    for (const pk of pkColumns) key[pk] = valueOf(row, pk);
    if (!(await confirmAction('删除行', `按主键 ${pkColumns.join(', ')} 删除这一行？`, '删除'))) return;
    try {
      await client.rows(connection.id, table.name, 'delete', { key }, database);
      notify('已删除', '行已删除');
      onChanged();
    } catch (err: any) {
      notify('删除失败', err?.message ?? '');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable style={styles.iconButton} onPress={onBack}>
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{table.name}</Text>
          <Text style={styles.listMeta}>{connection?.readonly ? '只读 · ' : ''}{page?.total ?? '?'} 行{canWrite ? ' · 可编辑' : ''}</Text>
        </View>
        <Pressable style={styles.iconButton} onPress={onDesign} testID="m-table-design">
          <Wrench size={15} color={colors.text} />
        </Pressable>
        <Pressable style={styles.iconButton} onPress={onRefresh}>
          <RefreshCw size={15} color={colors.text} />
        </Pressable>
        {canWrite ? (
          <Pressable
            style={styles.iconButton}
            testID="m-row-insert"
            onPress={() => setDraft({ mode: 'insert', values: Object.fromEntries(editableColumns.map((column) => [column.name, ''])) })}
          >
            <Plus size={16} color={colors.accent} />
          </Pressable>
        ) : null}
      </View>
      {loading ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}
      {!canWrite && !connection?.readonly ? <Text style={[styles.hint, { paddingHorizontal: 14, paddingTop: 8 }]}>该表没有主键，无法按行编辑；可用 SQL 查询修改。</Text> : null}
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 24 }}>
        {(result?.rows ?? []).map((row, rowIndex) => (
          <View key={rowIndex} style={styles.rowCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.rowIndex, { flex: 1 }]}>#{offset + rowIndex + 1}</Text>
              {canWrite ? (
                <>
                  <Pressable testID={`m-row-edit-${rowIndex}`} hitSlop={8} style={{ paddingHorizontal: 8 }} onPress={() => startEdit(row)}>
                    <Pencil size={13} color={colors.muted} />
                  </Pressable>
                  <Pressable testID={`m-row-delete-${rowIndex}`} hitSlop={8} onPress={() => void remove(row)}>
                    <Trash2 size={13} color={colors.muted} />
                  </Pressable>
                </>
              ) : null}
            </View>
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
      {draft ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{draft.mode === 'insert' ? '新增行' : '编辑行'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setDraft(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {(table.columns ?? []).map((column) => {
                  const readOnly = column.generated || (draft.mode === 'edit' && pkColumns.includes(column.name)) || (draft.mode === 'insert' && column.autoIncrement);
                  if (!readOnly && draft.mode === 'insert' && !(column.name in draft.values)) return null;
                  return (
                    <View key={column.name}>
                      <Text style={styles.fieldName}>{column.name}{column.primaryKey ? ' · PK' : ''} · {column.type}</Text>
                      <TextInput
                        testID={`m-row-field-${column.name}`}
                        style={[styles.input, readOnly && { opacity: 0.55 }]}
                        value={draft.values[column.name] ?? ''}
                        onChangeText={(value) => setDraft({ ...draft, values: { ...draft.values, [column.name]: value } })}
                        editable={!readOnly}
                        placeholder={column.nullable ? 'NULL' : ''}
                        placeholderTextColor={colors.muted}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                  );
                })}
                <Pressable testID="m-row-save" style={[styles.primaryButton, saving && { opacity: 0.5 }]} disabled={saving} onPress={() => void save()}>
                  <Text style={styles.primaryButtonText}>{saving ? '保存中…' : '保存'}</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function SettingsScreen({
  client,
  boot,
  config,
  mode,
  connected,
  onDisconnect,
  onMode,
  themeMode,
  resolvedTheme,
  onThemeMode,
  locale,
  onLocale,
}: {
  client: BridgeClient;
  boot: BootstrapData | null;
  config: BridgeConfig;
  mode: PermissionMode;
  connected: boolean;
  onDisconnect: () => void;
  onMode: (mode: PermissionMode) => void;
  themeMode: 'dark' | 'light' | 'system';
  resolvedTheme: ThemeResolved;
  onThemeMode: (mode: 'dark' | 'light' | 'system') => void;
  locale: Locale;
  onLocale: (locale: Locale) => void;
}) {
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; enabled: boolean; builtin?: boolean }>>([]);
  const [mcps, setMcps] = useState<Array<{ id: string; name: string; command: string; enabled: boolean; builtin?: boolean }>>([]);
  const [devices, setDevices] = useState<Array<{ id: string; name: string; platform: string; pairedAt: string; revoked: boolean }>>([]);
  useEffect(() => {
    void (async () => {
      try {
        const [skillResult, mcpResult, deviceResult] = await Promise.all([client.skills(true), client.mcpServers(), client.devices()]);
        setSkills(skillResult.skills);
        setMcps(mcpResult.servers);
        setDevices(deviceResult.devices.filter((device) => !device.revoked));
      } catch {
        /* 扩展列表失败不影响其余设置 */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>已配对设备</Text>
          {devices.map((device) => (
            <View key={device.id} style={[styles.rowBetween, { paddingVertical: 6 }]}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={styles.listTitle}>{device.name}{device.id === config.deviceId ? '（当前设备）' : ''}</Text>
                <Text style={styles.listMeta}>{device.platform} · 配对于 {new Date(device.pairedAt).toLocaleString()}</Text>
              </View>
              {device.id === config.deviceId ? (
                <Text style={styles.listMeta}>本机</Text>
              ) : (
                <Pressable
                  style={styles.modeChip}
                  onPress={async () => {
                    if (!(await confirmAction('吊销设备', `${device.name} 需要重新配对才能访问 Bridge`, '吊销'))) return;
                    try {
                      await client.revokeDevice(device.id);
                      setDevices((prev) => prev.filter((item) => item.id !== device.id));
                    } catch (err: any) {
                      notify('吊销失败', err?.message ?? '');
                    }
                  }}
                >
                  <Text style={[styles.modeChipText, { color: colors.danger }]}>吊销</Text>
                </Pressable>
              )}
            </View>
          ))}
          {!devices.length ? <Text style={styles.hint}>没有已配对设备。</Text> : null}
        </View>

        <View style={styles.card}>
          <Text style={[styles.sectionLabel, { marginTop: 12 }]}>默认权限</Text>
          <View style={{ flexDirection: 'row', marginTop: 6 }}>
            <PermissionSelect mode={mode} onChange={onMode} testID="m-settings-mode" />
          </View>
          <Text style={[styles.hint, { marginTop: 8 }]}>移动端新会话默认只读；破坏性操作即使在全自动模式下也需要审批。</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>外观</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
            {([
              { value: 'dark', label: '深色' },
              { value: 'light', label: '浅色' },
              { value: 'system', label: '跟随系统' },
            ] as const).map((option) => (
              <Pressable
                key={option.value}
                testID={`m-theme-${option.value}`}
                style={[styles.modeChip, themeMode === option.value && styles.modeChipActive]}
                onPress={() => onThemeMode(option.value)}
              >
                <Text style={[styles.modeChipText, themeMode === option.value && { color: colors.accent }]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.hint, { marginTop: 8 }]}>当前：{resolvedTheme === 'light' ? '浅色' : '深色'}；主题只保存在本机。</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>语言 / Language</Text>
          <View style={{ flexDirection: 'row', gap: 6, marginTop: 6 }}>
            {([
              { value: 'zh', label: '中文' },
              { value: 'en', label: 'English' },
            ] as const).map((option) => (
              <Pressable
                key={option.value}
                testID={`m-locale-${option.value}`}
                style={[styles.modeChip, locale === option.value && styles.modeChipActive]}
                onPress={() => onLocale(option.value)}
              >
                <Text style={[styles.modeChipText, locale === option.value && { color: colors.accent }]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={[styles.hint, { marginTop: 8 }]}>界面文案即时切换，只保存在本机。</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>扩展</Text>
          <Text style={[styles.listMeta, { marginTop: 6 }]}>Skills</Text>
          {skills.map((skill) => (
            <View key={skill.id} style={[styles.rowBetween, { paddingVertical: 6 }]}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={styles.listTitle}>{skill.name}</Text>
                <Text style={styles.listMeta} numberOfLines={1}>{skill.description}</Text>
              </View>
              <Switch
                value={skill.enabled}
                onValueChange={async (value) => {
                  try {
                    await client.toggleSkill(skill.id, value);
                    setSkills((prev) => prev.map((item) => (item.id === skill.id ? { ...item, enabled: value } : item)));
                  } catch (err: any) {
                    notify('操作失败', err?.message ?? '');
                  }
                }}
              />
            </View>
          ))}
          {!skills.length ? <Text style={styles.hint}>没有可用 Skill。</Text> : null}
          <Text style={[styles.listMeta, { marginTop: 10 }]}>MCP Servers</Text>
          {mcps.map((server) => (
            <View key={server.id} style={[styles.rowBetween, { paddingVertical: 6 }]}>
              <View style={{ flex: 1, paddingRight: 10 }}>
                <Text style={styles.listTitle}>{server.name}</Text>
                <Text style={styles.listMeta} numberOfLines={1}>{server.builtin ? '内置 · ' : ''}{server.command}</Text>
              </View>
              <Switch
                value={server.enabled}
                onValueChange={async (value) => {
                  try {
                    await client.toggleMcp(server.id, value);
                    setMcps((prev) => prev.map((item) => (item.id === server.id ? { ...item, enabled: value } : item)));
                  } catch (err: any) {
                    notify('操作失败', err?.message ?? '');
                  }
                }}
              />
            </View>
          ))}
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>数据</Text>
          <Text style={styles.listMeta}>{boot?.connections.length ?? 0} 个连接 · {boot?.settings.agent.autoMemory ? '自动记忆开启' : '自动记忆关闭'} · {boot?.settings.agent.snapshotBeforeWrite ? '写前备份开启' : '写前备份关闭'}</Text>
        </View>

        <Pressable
          style={styles.secondaryButton}
          testID="m-unpair"
          onPress={async () => {
            if (await confirmAction('解除配对', '将清除设备上的 Bridge 地址与令牌。', '解除')) await onDisconnect();
          }}
        >
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

type SqlSet = QueryBatchResult['sets'][number];

function QueryScreen({
  client,
  connection,
  database,
  initialSql,
  onBack,
}: {
  client: BridgeClient;
  connection?: ConnectionConfig;
  database?: string;
  initialSql?: string;
  onBack: () => void;
}) {
  const [sql, setSql] = useState(initialSql ?? 'SELECT * FROM ');
  useEffect(() => {
    if (initialSql) setSql(initialSql);
  }, [initialSql]);
  const [sets, setSets] = useState<SqlSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowMulti, setAllowMulti] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveType, setSaveType] = useState('bar');

  const run = async () => {
    if (!connection || !sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.query(connection.id, sql, database, allowMulti);
      setSets(result.batch.sets);
    } catch (err: any) {
      setError(err?.message ?? '执行失败');
      setSets([]);
    } finally {
      setBusy(false);
    }
  };

  const exportResult = async (format: 'csv' | 'json' | 'xml' | 'sql' | 'xlsx') => {
    if (!connection || !sql.trim()) return;
    try {
      const result = await client.exportInline({ connectionId: connection.id, database, sql, format, limit: 5000 });
      await shareBase64(result.content, format);
      notify('导出完成', `已生成 ${result.file.rows} 行 ${format.toUpperCase()}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    }
  };

  const saveCard = async () => {
    if (!connection || !saveTitle.trim()) return;
    try {
      await client.createDashboardCard({ connectionId: connection.id, database, title: saveTitle.trim(), sql, chartType: saveType });
      setSaveOpen(false);
      setSaveTitle('');
      notify('已保存', '已加入仪表板');
    } catch (err: any) {
      notify('保存失败', err?.message ?? '需要只读查询');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable style={styles.iconButton} onPress={onBack} testID="m-query-back">
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>SQL 查询</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable testID="m-query-run" style={[styles.primarySmall, busy && { opacity: 0.5 }]} disabled={busy || !connection} onPress={() => void run()}>
          <Text style={styles.primarySmallText}>{busy ? '执行中…' : '执行'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
        <TextInput
          testID="m-query-input"
          style={styles.queryInput}
          value={sql}
          onChangeText={setSql}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="SELECT * FROM table LIMIT 100"
          placeholderTextColor={colors.muted}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <View style={styles.modeChip}>
            <Text style={styles.modeChipText}>多语句</Text>
            <Switch value={allowMulti} onValueChange={setAllowMulti} style={{ transform: [{ scale: 0.65 }] }} />
          </View>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('csv')}>
            <Text style={styles.modeChipText}>导出 CSV</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('json')}>
            <Text style={styles.modeChipText}>导出 JSON</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('xml')}>
            <Text style={styles.modeChipText}>XML</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('sql')}>
            <Text style={styles.modeChipText}>SQL</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('xlsx')}>
            <Text style={styles.modeChipText}>XLSX</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => setSaveOpen(true)}>
            <Text style={styles.modeChipText}>存为仪表板</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {sets.map((set, setIndex) => (
          <View key={setIndex} style={styles.resultCard}>
            <Text style={styles.listMeta}>
              {set.columns.length ? `${set.rowCount} 行 · ${set.durationMs}ms${set.truncated ? ' · 已截断' : ''}` : `影响 ${set.affected ?? 0} 行 · ${set.durationMs}ms`}
            </Text>
            {set.columns.length ? (
              <ScrollView horizontal>
                <View>
                  <View style={styles.resultRow}>
                    {set.columns.map((column) => (
                      <Text key={column.name} style={[styles.resultCell, styles.resultHead]} numberOfLines={1}>{column.name}</Text>
                    ))}
                  </View>
                  {set.rows.slice(0, 100).map((row, rowIndex) => (
                    <View key={rowIndex} style={styles.resultRow}>
                      {row.map((value, colIndex) => (
                        <Text key={colIndex} style={styles.resultCell} numberOfLines={2}>
                          {value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}
          </View>
        ))}
        {!sets.length && !error ? <Text style={styles.hint}>写一条只读 SQL，或直接执行 UPDATE / CREATE 等语句（只读连接会被拒绝）。</Text> : null}
      </ScrollView>
      <Modal visible={saveOpen} transparent animationType="fade" onRequestClose={() => setSaveOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>保存到仪表板</Text>
              <Pressable style={styles.iconButton} onPress={() => setSaveOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <View style={{ padding: 14, gap: 10 }}>
              <TextInput testID="m-card-title" style={styles.input} value={saveTitle} onChangeText={setSaveTitle} placeholder="卡片标题" placeholderTextColor={colors.muted} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(['bar', 'line', 'pie'] as const).map((type) => (
                  <Pressable key={type} style={[styles.modeChip, saveType === type && styles.modeChipActive]} onPress={() => setSaveType(type)}>
                    <Text style={[styles.modeChipText, saveType === type && { color: colors.accent }]}>{type}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable testID="m-card-save" style={styles.primaryButton} onPress={() => void saveCard()}><Text style={styles.primaryButtonText}>保存</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function BackupScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; path: string; bytes: number; label?: string; createdAt: string }>>([]);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!connection) return;
    try {
      setItems((await client.backups(connection.id)).backups);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  const create = async () => {
    if (!connection) return;
    setBusy(true);
    try {
      const result = await client.createBackup(connection.id, `移动端备份 ${new Date().toLocaleString()}`);
      notify('备份完成', `${result.backup.tables} 张表 / ${result.backup.rows} 行`);
      await load();
    } catch (err: any) {
      notify('备份失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-backup-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>备份</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}</Text>
        </View>
        <Pressable testID="m-backup-create" style={[styles.primarySmall, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void create()}>
          <Text style={styles.primarySmallText}>{busy ? '备份中…' : '立即备份'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {items.map((item) => (
          <View key={item.id} style={styles.rowCard}>
            <Text style={styles.listTitle}>{item.label ?? item.path.split(/[\\/]/).pop()}</Text>
            <Text style={styles.listMeta}>{new Date(item.createdAt).toLocaleString()} · {humanBytes(item.bytes)}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                style={styles.modeChip}
                onPress={async () => {
                  if (!(await confirmAction('恢复备份', '将覆盖当前库中的同名对象，确定继续？', '恢复'))) return;
                  try {
                    await client.restoreBackup(item.id);
                    notify('恢复完成', '备份已恢复');
                  } catch (err: any) {
                    notify('恢复失败', err?.message ?? '');
                  }
                }}
              >
                <Text style={styles.modeChipText}>恢复</Text>
              </Pressable>
            </View>
          </View>
        ))}
        {!items.length ? <Text style={styles.hint}>还没有备份。点击右上角「立即备份」生成 SQL 备份。</Text> : null}
      </ScrollView>
    </View>
  );
}

function DashboardScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
  const [cards, setCards] = useState<Array<{ id: string; title: string; sql: string; chartType: string }>>([]);
  const [results, setResults] = useState<Record<string, { status: string; columns: Array<{ name: string }>; rows: unknown[][]; error?: string }>>({});
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!connection) return;
    try {
      setCards((await client.dashboardCards(connection.id, database)).cards);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, database]);
  const refresh = async () => {
    if (!connection) return;
    setBusy(true);
    try {
      const result = await client.refreshDashboards(connection.id, database);
      setResults(Object.fromEntries(result.results.map((item) => [item.cardId, item])));
    } catch (err: any) {
      notify('刷新失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-dash-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>仪表板</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable style={[styles.primarySmall, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void refresh()}>
          <Text style={styles.primarySmallText}>{busy ? '刷新中…' : '刷新'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        {cards.map((card) => {
          const result = results[card.id];
          const numeric = result?.columns.findIndex((_, index) => result.rows.some((row) => typeof row[index] === 'number'));
          const max = result ? Math.max(1, ...result.rows.map((row) => Number(row[numeric ?? 1]) || 0)) : 1;
          return (
            <View key={card.id} style={styles.rowCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.listTitle, { flex: 1 }]}>{card.title}</Text>
                <Pressable
                  testID={`m-card-delete-${card.id}`}
                  style={styles.iconButton}
                  onPress={async () => {
                    if (!(await confirmAction('删除卡片', card.title, '删除'))) return;
                    try {
                      await client.deleteDashboardCard(card.id);
                      await load();
                    } catch (err: any) {
                      notify('删除失败', err?.message ?? '');
                    }
                  }}
                >
                  <Trash2 size={14} color={colors.muted} />
                </Pressable>
              </View>
              <Text style={styles.listMeta} numberOfLines={1}>{card.chartType} · {card.sql}</Text>
              {result?.status === 'error' ? <Text style={styles.error}>{result.error}</Text> : null}
              {result?.status === 'ok' && result.rows.length ? (
                card.chartType === 'bar' || card.chartType === 'line' || card.chartType === 'pie' ? (
                  <View style={{ gap: 4, marginTop: 8 }}>
                    {result.rows.slice(0, 8).map((row, index) => (
                      <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={[styles.listMeta, { width: 86 }]} numberOfLines={1}>{String(row[0] ?? '')}</Text>
                        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border }}>
                          <View style={{ width: `${Math.max(3, (Number(row[numeric === -1 ? 1 : numeric]) / max) * 100)}%`, height: 6, borderRadius: 3, backgroundColor: colors.agent }} />
                        </View>
                        <Text style={styles.listMeta}>{String(row[numeric === -1 ? 1 : numeric] ?? '')}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.listMeta}>{result.rows.length} 行数据</Text>
                )
              ) : null}
            </View>
          );
        })}
        {!cards.length ? <Text style={styles.hint}>还没有卡片。在 SQL 查询里执行一条只读 SQL，点「存为仪表板」。</Text> : null}
      </ScrollView>
    </View>
  );
}

function ImportExportScreen({ client, connection, database, tables, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; tables: TableInfo[]; onBack: () => void }) {
  const [table, setTable] = useState('');
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (!table && tables.length) setTable(tables[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.length]);
  const pickCsv = async () => {
    if (!connection || !table) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      const csv = Platform.OS === 'web' && asset.file ? await asset.file.text() : await FileSystem.readAsStringAsync(asset.uri);
      setImporting(true);
      const result = await client.importCsv(connection.id, table, csv, database);
      setLast(`导入 ${result.result.inserted} 行，跳过 ${result.result.skipped} 行${result.result.errors.length ? `；${result.result.errors[0]}` : ''}`);
      notify('导入完成', `已写入 ${result.result.inserted} 行`);
    } catch (err: any) {
      notify('导入失败', err?.message ?? '');
    } finally {
      setImporting(false);
    }
  };
  const exportTable = async (format: 'csv' | 'json' | 'xml' | 'sql' | 'xlsx') => {
    if (!connection || !table) return;
    setExporting(true);
    try {
      const result = await client.exportInline({ connectionId: connection.id, database, table, format, limit: 10000 });
      await shareBase64(result.content, format);
      setLast(`导出 ${result.file.rows} 行 ${format.toUpperCase()}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    } finally {
      setExporting(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-io-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>导入 / 导出</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <Text style={styles.sectionLabel}>目标表</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tables.map((item) => (
            <Pressable key={item.name} style={[styles.modeChip, table === item.name && styles.modeChipActive]} onPress={() => setTable(item.name)}>
              <Text style={[styles.modeChipText, table === item.name && { color: colors.accent }]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>导入 CSV</Text>
          <Text style={styles.hint}>CSV 首行作为列名，按列名写入当前表；只读连接会被拒绝。</Text>
          <Pressable testID="m-import-csv" style={[styles.primaryButton, (importing || !table) && { opacity: 0.5 }]} disabled={importing || !table} onPress={() => void pickCsv()}>
            <Text style={styles.primaryButtonText}>{importing ? '导入中…' : '选择 CSV 文件'}</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>导出当前表</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable testID="m-export-csv" style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('csv')}>
              <Text style={styles.modeChipText}>CSV</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('json')}>
              <Text style={styles.modeChipText}>JSON</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('xml')}>
              <Text style={styles.modeChipText}>XML</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('sql')}>
              <Text style={styles.modeChipText}>SQL</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('xlsx')}>
              <Text style={styles.modeChipText}>XLSX</Text>
            </Pressable>
          </View>
        </View>
        {last ? <Text style={styles.hint}>{last}</Text> : null}
      </ScrollView>
    </View>
  );
}

function TableDesignScreen({
  client,
  connection,
  database,
  tables,
  initialTable,
  onBack,
}: {
  client: BridgeClient;
  connection?: ConnectionConfig;
  database?: string;
  tables: TableInfo[];
  initialTable?: string;
  onBack: () => void;
}) {
  const [tableName, setTableName] = useState(initialTable ?? tables[0]?.name ?? '');
  const [detail, setDetail] = useState<TableInfo | null>(null);
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('TEXT');
  const [indexName, setIndexName] = useState('');
  const [indexColumns, setIndexColumns] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [tableList, setTableList] = useState<TableInfo[]>(tables);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTable, setNewTable] = useState<{ name: string; columns: Array<{ name: string; type: string; pk: boolean }> }>({ name: '', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: '', type: 'TEXT', pk: false }] });
  const load = async () => {
    if (!connection || !tableName) return;
    try {
      const result = await client.schema(connection.id, database);
      const all = result.schemas.flatMap((schema) => schema.tables);
      setTableList(all.length ? all : tables);
      const found = all.find((item) => item.name === tableName);
      setDetail(found ?? null);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, connection?.id, database]);
  const exec = async (sql: string, successText: string) => {
    if (!connection) return;
    setBusy(true);
    try {
      await client.execDdl(connection.id, sql, database);
      notify('完成', successText);
      setColumnName('');
      setIndexName('');
      setIndexColumns('');
      await load();
    } catch (err: any) {
      notify('执行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  const tableOp = async (op: string, extra: Record<string, unknown> = {}) => {
    if (!connection) return;
    try {
      await client.tableOp(connection.id, tableName, op, extra, database);
      notify('完成', op === 'rename' ? '已重命名' : op === 'truncate' ? '已清空' : '操作完成');
      if (op === 'drop') onBack();
      else await load();
    } catch (err: any) {
      notify('操作失败', err?.message ?? '');
    }
  };
  const engine = connection?.engine ?? 'sqlite';
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-table-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>表结构</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable testID="m-table-create" style={styles.primarySmall} onPress={() => setCreateOpen(true)}>
          <Text style={styles.primarySmallText}>新建表</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tableList.map((item) => (
            <Pressable key={item.name} style={[styles.modeChip, tableName === item.name && styles.modeChipActive]} onPress={() => setTableName(item.name)}>
              <Text style={[styles.modeChipText, tableName === item.name && { color: colors.accent }]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {detail ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>列（{detail.columns?.length ?? 0}）</Text>
              {(detail.columns ?? []).map((column) => (
                <View key={column.name} style={styles.fieldRow}>
                  <Text style={styles.fieldName}>{column.name}</Text>
                  <Text style={styles.fieldValue}>{column.type}{column.primaryKey ? ' · PK' : ''}{column.nullable ? '' : ' · NOT NULL'}</Text>
                </View>
              ))}
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>索引（{detail.indexes?.length ?? 0}）</Text>
              {(detail.indexes ?? []).map((index) => (
                <View key={index.name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text style={[styles.listMeta, { flex: 1 }]}>{index.name} · {index.columns.join(', ')}{index.unique ? ' · UNIQUE' : ''}</Text>
                  <Pressable
                    style={styles.modeChip}
                    onPress={async () => {
                      if (!(await confirmAction('删除索引', index.name, '删除'))) return;
                      await exec(`DROP INDEX ${quoteIdent(index.name, engine)}`, '索引已删除');
                    }}
                  >
                    <Text style={styles.modeChipText}>删除</Text>
                  </Pressable>
                </View>
              ))}
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>加列</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput testID="m-new-column" style={[styles.input, { flex: 1 }]} value={columnName} onChangeText={setColumnName} placeholder="列名" placeholderTextColor={colors.muted} />
                <TextInput testID="m-new-column-type" style={[styles.input, { width: 100 }]} value={columnType} onChangeText={setColumnType} placeholder="TEXT" autoCapitalize="characters" placeholderTextColor={colors.muted} />
              </View>
              <Pressable
                testID="m-add-column"
                style={[styles.primaryButton, (busy || !columnName.trim()) && { opacity: 0.5 }]}
                disabled={busy || !columnName.trim()}
                onPress={() => void exec(`ALTER TABLE ${quoteIdent(tableName, engine)} ADD COLUMN ${quoteIdent(columnName.trim(), engine)} ${columnType.trim() || 'TEXT'}`, '列已添加')}
              >
                <Text style={styles.primaryButtonText}>添加列</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>加索引</Text>
              <TextInput testID="m-new-index" style={styles.input} value={indexName} onChangeText={setIndexName} placeholder="索引名，如 ix_orders_status" autoCapitalize="none" placeholderTextColor={colors.muted} />
              <TextInput testID="m-new-index-cols" style={[styles.input, { marginTop: 8 }]} value={indexColumns} onChangeText={setIndexColumns} placeholder="列名，英文逗号分隔" autoCapitalize="none" placeholderTextColor={colors.muted} />
              <Pressable
                testID="m-add-index"
                style={[styles.primaryButton, (busy || !indexName.trim() || !indexColumns.trim()) && { opacity: 0.5 }]}
                disabled={busy || !indexName.trim() || !indexColumns.trim()}
                onPress={() => void exec(`CREATE INDEX ${quoteIdent(indexName.trim(), engine)} ON ${quoteIdent(tableName, engine)} (${indexColumns.split(',').map((item) => quoteIdent(item.trim(), engine)).join(', ')})`, '索引已创建')}
              >
                <Text style={styles.primaryButtonText}>创建索引</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>表操作</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Pressable
                  testID="m-table-rename"
                  style={styles.modeChip}
                  onPress={() => {
                    setRenameValue(tableName);
                    setRenameOpen(true);
                  }}
                >
                  <Text style={styles.modeChipText}>重命名</Text>
                </Pressable>
                <Pressable style={styles.modeChip} onPress={async () => { if (await confirmAction('清空表', `${tableName} 的数据会被全部删除`, '清空')) await tableOp('truncate'); }}>
                  <Text style={styles.modeChipText}>清空数据</Text>
                </Pressable>
                <Pressable style={styles.modeChip} onPress={async () => { if (await confirmAction('删除表', `${tableName} 将被永久删除`, '删除')) await tableOp('drop'); }}>
                  <Text style={[styles.modeChipText, { color: colors.danger }]}>删除表</Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : <Text style={styles.hint}>选择一张表查看结构。</Text>}
      </ScrollView>
      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { maxHeight: '86%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>新建表</Text>
              <Pressable style={styles.iconButton} onPress={() => setCreateOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
              <TextInput testID="m-new-table-name" style={styles.input} value={newTable.name} onChangeText={(name) => setNewTable({ ...newTable, name })} placeholder="表名" autoCapitalize="none" placeholderTextColor={colors.muted} />
              {newTable.columns.map((column, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={column.name}
                    onChangeText={(name) => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, name } : item)) })}
                    placeholder="列名"
                    autoCapitalize="none"
                    placeholderTextColor={colors.muted}
                  />
                  <TextInput
                    style={[styles.input, { width: 88 }]}
                    value={column.type}
                    onChangeText={(type) => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, type } : item)) })}
                    placeholder="TEXT"
                    autoCapitalize="characters"
                    placeholderTextColor={colors.muted}
                  />
                  <Pressable
                    style={[styles.modeChip, column.pk && styles.modeChipActive]}
                    onPress={() => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, pk: !item.pk } : item)) })}
                  >
                    <Text style={[styles.modeChipText, column.pk && { color: colors.accent }]}>PK</Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => setNewTable({ ...newTable, columns: newTable.columns.filter((_, i) => i !== index) })}>
                    <X size={14} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.modeChip} onPress={() => setNewTable({ ...newTable, columns: [...newTable.columns, { name: '', type: 'TEXT', pk: false }] })}>
                <Text style={styles.modeChipText}>+ 添加列</Text>
              </Pressable>
              <Pressable
                testID="m-create-table-save"
                style={[styles.primaryButton, (!newTable.name.trim() || !newTable.columns.some((column) => column.name.trim())) && { opacity: 0.5 }]}
                disabled={!newTable.name.trim() || !newTable.columns.some((column) => column.name.trim())}
                onPress={async () => {
                  if (!connection) return;
                  const name = newTable.name.trim();
                  const columns = newTable.columns.filter((column) => column.name.trim());
                  const pk = columns.filter((column) => column.pk);
                  const defs = columns.map((column) => `${quoteIdent(column.name.trim(), engine)} ${column.type.trim() || 'TEXT'}`.trim());
                  if (pk.length) defs.push(`PRIMARY KEY (${pk.map((column) => quoteIdent(column.name.trim(), engine)).join(', ')})`);
                  setBusy(true);
                  try {
                    await client.execDdl(connection.id, `CREATE TABLE ${quoteIdent(name, engine)} (${defs.join(', ')})`, database);
                    notify('已创建', `表 ${name} 已创建`);
                    setCreateOpen(false);
                    setTableName(name);
                    setNewTable({ name: '', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: '', type: 'TEXT', pk: false }] });
                    await load();
                  } catch (err: any) {
                    notify('创建失败', err?.message ?? '');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Text style={styles.primaryButtonText}>{busy ? '创建中…' : '创建表'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>重命名表</Text>
              <Pressable style={styles.iconButton} onPress={() => setRenameOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <View style={{ padding: 14, gap: 10 }}>
              <TextInput testID="m-rename-table-input" style={styles.input} value={renameValue} onChangeText={setRenameValue} autoCapitalize="none" />
              <Pressable
                testID="m-rename-table-save"
                style={styles.primaryButton}
                onPress={async () => {
                  const next = renameValue.trim();
                  if (!next || next === tableName) return;
                  setRenameOpen(false);
                  await tableOp('rename', { newName: next });
                  setTableName(next);
                }}
              >
                <Text style={styles.primaryButtonText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function DictionaryScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
  const [markdown, setMarkdown] = useState('');
  const [info, setInfo] = useState<{ tableCount: number; columnCount: number } | null>(null);
  useEffect(() => {
    if (!connection) return;
    void (async () => {
      try {
        const result = await client.dictionary(connection.id, database);
        setMarkdown(result.dictionary.markdown);
        setInfo({ tableCount: result.dictionary.tableCount, columnCount: result.dictionary.columnCount });
      } catch (err: any) {
        notify('加载失败', err?.message ?? '');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, database]);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-dict-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>数据字典</Text>
          <Text style={styles.listMeta}>{info ? `${info.tableCount} 张表 · ${info.columnCount} 列` : connection?.name ?? ''}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14 }}>
        <Text selectable style={styles.dictionaryText}>{markdown || '生成中…'}</Text>
      </ScrollView>
    </View>
  );
}

function MonitorScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
  const [monitor, setMonitor] = useState<{ engine: string; version?: string; sections: Array<{ title: string; items: Array<{ label: string; value: string }>; error?: string }> } | null>(null);
  useEffect(() => {
    if (!connection) return;
    void (async () => {
      try {
        setMonitor((await client.monitor(connection.id)).monitor);
      } catch (err: any) {
        notify('监控不可用', err?.message ?? '');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-monitor-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>服务器监控</Text>
          <Text style={styles.listMeta}>{connection?.name ?? ''}{monitor?.version ? ` · ${monitor.version}` : ''}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        {(monitor?.sections ?? []).map((section) => (
          <View key={section.title} style={styles.card}>
            <Text style={styles.sectionLabel}>{section.title}</Text>
            {section.error ? <Text style={styles.error}>{section.error}</Text> : null}
            {section.items.map((item) => (
              <View key={item.label} style={styles.fieldRow}>
                <Text style={styles.fieldName}>{item.label}</Text>
                <Text style={styles.fieldValue}>{item.value}</Text>
              </View>
            ))}
          </View>
        ))}
        {!monitor ? <Text style={styles.hint}>加载中…</Text> : null}
      </ScrollView>
    </View>
  );
}

function SearchScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'objects' | 'data' | 'all'>('all');
  const [result, setResult] = useState<{ objects: Array<{ kind: string; table: string; column?: string; detail?: string }>; data: Array<{ table: string; columns: string[]; rows: unknown[][] }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (!connection || !query.trim()) return;
    setBusy(true);
    try {
      setResult(await client.search(connection.id, query.trim(), scope, database));
    } catch (err: any) {
      notify('搜索失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-search-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>数据库搜索</Text>
          <Text style={styles.listMeta}>{connection?.name ?? ''}{database ? ` · ${database}` : ''}</Text>
        </View>
      </View>
      <View style={styles.searchRow}>
        <Search size={14} color={colors.muted} />
        <TextInput testID="m-search-input" style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="表名、列名或数据…" placeholderTextColor={colors.muted} returnKeyType="search" onSubmitEditing={() => void run()} />
        <Pressable testID="m-search-run" style={styles.iconButton} disabled={busy} onPress={() => void run()}>
          <Search size={14} color={colors.text} />
        </Pressable>
      </View>
      <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 8 }}>
        {(['objects', 'data', 'all'] as const).map((value) => (
          <Pressable key={value} style={[styles.modeChip, scope === value && styles.modeChipActive]} onPress={() => setScope(value)}>
            <Text style={[styles.modeChipText, scope === value && { color: colors.accent }]}>{value === 'objects' ? '对象' : value === 'data' ? '数据' : '全部'}</Text>
          </Pressable>
        ))}
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {result?.objects?.length ? <Text style={styles.sectionLabel}>对象</Text> : null}
        {(result?.objects ?? []).map((item, index) => (
          <View key={`${item.table}-${item.column ?? ''}-${index}`} style={styles.listRow}>
            <Database size={14} color={colors.accent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{item.table}{item.column ? `.${item.column}` : ''}</Text>
              <Text style={styles.listMeta} numberOfLines={2}>{item.kind}{item.detail ? ` · ${item.detail}` : ''}</Text>
            </View>
          </View>
        ))}
        {result?.data?.length ? <Text style={styles.sectionLabel}>数据命中</Text> : null}
        {(result?.data ?? []).map((group) => (
          <View key={group.table} style={styles.rowCard}>
            <Text style={styles.listTitle}>{group.table}</Text>
            <Text style={styles.listMeta}>{group.rows.length} 行 · {group.columns.join(', ')}</Text>
            {group.rows.slice(0, 3).map((row, index) => (
              <Text key={index} style={[styles.listMeta, { marginTop: 4 }]} numberOfLines={2}>{row.map((value) => (value === null ? 'NULL' : String(value))).join(' | ')}</Text>
            ))}
          </View>
        ))}
        {result && !result.objects.length && !result.data.length ? <Text style={styles.hint}>没有匹配结果。</Text> : null}
      </ScrollView>
    </View>
  );
}

function HistoryScreen({ client, connection, onBack, onPick }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void; onPick: (sql: string) => void }) {
  const [items, setItems] = useState<Array<{ id: string; sql: string; status: 'ok' | 'error'; durationMs?: number; rowCount?: number; favorite?: boolean; createdAt: string }>>([]);
  const [query, setQuery] = useState('');
  const load = async (search = '') => {
    try {
      setItems((await client.history(connection?.id, search || undefined, 150)).items);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-history-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>查询历史</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '全部连接'}</Text>
        </View>
      </View>
      <View style={styles.searchRow}>
        <Search size={14} color={colors.muted} />
        <TextInput style={styles.searchInput} value={query} onChangeText={setQuery} placeholder="搜索 SQL…" placeholderTextColor={colors.muted} returnKeyType="search" onSubmitEditing={() => void load(query)} />
        <Pressable style={styles.iconButton} onPress={() => void load(query)}><Search size={14} color={colors.text} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {items.map((item) => (
          <Pressable key={item.id} testID={`m-history-${item.id}`} style={styles.rowCard} onPress={() => onPick(item.sql)}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={[styles.listMeta, { flex: 1 }]}>{new Date(item.createdAt).toLocaleString()} · {item.status}{item.durationMs ? ` · ${item.durationMs}ms` : ''}{item.rowCount ? ` · ${item.rowCount} 行` : ''}</Text>
              <Pressable
                hitSlop={8}
                onPress={async (event) => {
                  event.stopPropagation();
                  try {
                    await client.favoriteHistory(item.id, !item.favorite);
                    setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, favorite: !row.favorite } : row)));
                  } catch (err: any) {
                    notify('操作失败', err?.message ?? '');
                  }
                }}
              >
                <Text style={{ color: item.favorite ? colors.warning : colors.muted }}>{item.favorite ? '★' : '☆'}</Text>
              </Pressable>
            </View>
            <Text style={styles.sqlSnippet} numberOfLines={3}>{item.sql}</Text>
          </Pressable>
        ))}
        {!items.length ? <Text style={styles.hint}>没有历史记录。</Text> : null}
      </ScrollView>
    </View>
  );
}

function AuditScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
  const [entries, setEntries] = useState<Array<{ id: string; actor: string; tool?: string; sql?: string; status: string; createdAt: string }>>([]);
  useEffect(() => {
    void (async () => {
      try {
        setEntries((await client.audit(connection?.id, 200)).entries);
      } catch (err: any) {
        notify('加载失败', err?.message ?? '');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-audit-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>审计日志</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '全部连接'} · {entries.length} 条</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {entries.map((entry) => (
          <View key={entry.id} style={styles.rowCard}>
            <Text style={styles.listMeta}>{new Date(entry.createdAt).toLocaleString()} · {entry.actor} · {entry.tool ?? '—'} · {entry.status}</Text>
            {entry.sql ? <Text style={styles.sqlSnippet} numberOfLines={2}>{entry.sql}</Text> : null}
          </View>
        ))}
        {!entries.length ? <Text style={styles.hint}>没有审计记录。</Text> : null}
      </ScrollView>
    </View>
  );
}

function ArtifactsScreen({ client, onBack }: { client: BridgeClient; onBack: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; type: string; title: string; status: string; updatedAt: string }>>([]);
  const [detail, setDetail] = useState<{ artifact: { id: string; type: string; title: string; status: string; spec: unknown }; run?: { status: string; result?: unknown; error?: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setItems((await client.artifacts(100)).artifacts);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (id: string) => {
    try {
      const artifact = (await client.artifactDetail(id)).artifact;
      const runs = (await client.artifactRuns(id, 1)).runs;
      setDetail({ artifact, run: runs[0] });
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  const exportArtifact = async (format: 'xlsx' | 'pptx') => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await client.exportArtifact(detail.artifact.id, format);
      if (!result.content) throw new Error('导出内容为空');
      await shareBase64(result.content, format);
      notify('导出完成', `${format.toUpperCase()} ${humanBytes(result.bytes)}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-artifacts-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>报告与产物</Text>
          <Text style={styles.listMeta}>{items.length} 个产物</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {items.map((item) => (
          <Pressable key={item.id} testID={`m-artifact-${item.id}`} style={styles.rowCard} onPress={() => void open(item.id)}>
            <Text style={styles.listTitle}>{item.title}</Text>
            <Text style={styles.listMeta}>{item.type} · {item.status} · {new Date(item.updatedAt).toLocaleString()}</Text>
          </Pressable>
        ))}
        {!items.length ? <Text style={styles.hint}>还没有报告或对比产物。可在对话中使用 /report、/diff、/recon。</Text> : null}
      </ScrollView>
      {detail ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDetail(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{detail.artifact.title}</Text>
                <Pressable testID="m-artifact-close" style={styles.iconButton} onPress={() => setDetail(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
                <Text style={styles.listMeta}>{detail.artifact.type} · {detail.artifact.status}{detail.run ? ` · 运行 ${detail.run.status}` : ''}</Text>
                {detail.run?.error ? <Text style={styles.error}>{detail.run.error}</Text> : null}
                <Text style={styles.sectionLabel}>运行结果</Text>
                <Text selectable style={styles.sqlSnippet}>{detail.run?.result ? JSON.stringify(detail.run.result, null, 2) : '没有运行结果'}</Text>
                <Text style={styles.sectionLabel}>规格</Text>
                <Text selectable style={styles.sqlSnippet}>{JSON.stringify(detail.artifact.spec, null, 2)}</Text>
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Pressable style={[styles.modeChip, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void exportArtifact('xlsx')}><Text style={styles.modeChipText}>导出 XLSX</Text></Pressable>
                  <Pressable style={[styles.modeChip, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void exportArtifact('pptx')}><Text style={styles.modeChipText}>导出 PPTX</Text></Pressable>
                  <Pressable
                    style={styles.modeChip}
                    onPress={async () => {
                      if (!(await confirmAction('删除产物', detail.artifact.title, '删除'))) return;
                      try {
                        await client.deleteArtifact(detail.artifact.id);
                        setDetail(null);
                        await load();
                      } catch (err: any) {
                        notify('删除失败', err?.message ?? '');
                      }
                    }}
                  >
                    <Text style={[styles.modeChipText, { color: colors.danger }]}>删除</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function UsersScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
  const [state, setState] = useState<{ supported: boolean; users: Array<{ name: string; host?: string; attributes: string[]; superuser?: boolean; disabled?: boolean }>; note?: string }>({ supported: false, users: [] });
  const [draft, setDraft] = useState<{ action: 'create' | 'grant' | 'drop'; name: string; host: string; password: string; privileges: string; scope: string; role: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!connection) return;
    try {
      setState(await client.users(connection.id));
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  const run = async () => {
    if (!connection || !draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: draft.name.trim(), host: draft.host.trim() || '%' };
      if (draft.action === 'create') payload.password = draft.password;
      if (draft.action === 'grant') {
        payload.privileges = draft.privileges.trim() || 'SELECT';
        payload.scope = draft.scope.trim() || '*.*';
        payload.role = draft.role.trim() || payload.privileges;
      }
      const result = await client.userAction(connection.id, draft.action, payload);
      notify('执行成功', (result.result.sql ?? []).join('\n'));
      setDraft(null);
      await load();
    } catch (err: any) {
      notify('执行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-users-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>用户与权限</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'} · {state.supported ? `${state.users.length} 个账户` : '该引擎无服务器账户'}</Text>
        </View>
        {state.supported ? (
          <Pressable testID="m-user-create" style={styles.primarySmall} onPress={() => setDraft({ action: 'create', name: '', host: '%', password: '', privileges: 'SELECT', scope: '*.*', role: '' })}>
            <Text style={styles.primarySmallText}>创建账户</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {!state.supported ? <Text style={styles.hint}>{state.note ?? '当前引擎不支持账户管理。'}</Text> : null}
        {state.users.map((user) => (
          <View key={`${user.name}@${user.host ?? ''}`} style={styles.rowCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.listTitle, { flex: 1 }]}>{user.name}{user.host ? `@${user.host}` : ''}</Text>
              {user.disabled ? <Text style={[styles.listMeta, { color: colors.warning }]}>已禁用</Text> : null}
            </View>
            <Text style={styles.listMeta}>{user.attributes.filter(Boolean).join(' · ') || '—'}{user.superuser ? ' · SUPERUSER' : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                style={styles.modeChip}
                onPress={() => setDraft({ action: 'grant', name: user.name, host: user.host ?? '%', password: '', privileges: 'SELECT', scope: '*.*', role: '' })}
              >
                <Text style={styles.modeChipText}>授权</Text>
              </Pressable>
              <Pressable
                style={styles.modeChip}
                onPress={async () => {
                  if (!connection) return;
                  if (!(await confirmAction('删除账户', `${user.name}${user.host ? '@' + user.host : ''}`, '删除'))) return;
                  try {
                    await client.userAction(connection.id, 'drop', { name: user.name, host: user.host ?? '%' });
                    notify('已删除', '账户已删除');
                    await load();
                  } catch (err: any) {
                    notify('删除失败', err?.message ?? '');
                  }
                }}
              >
                <Text style={[styles.modeChipText, { color: colors.danger }]}>删除</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      {draft ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{draft.action === 'create' ? '创建账户' : draft.action === 'grant' ? '授权' : '删除账户'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setDraft(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                <TextInput style={styles.input} value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} placeholder="账户名" autoCapitalize="none" placeholderTextColor={colors.muted} />
                {connection?.engine === 'mysql' || connection?.engine === 'mariadb' ? (
                  <TextInput style={styles.input} value={draft.host} onChangeText={(host) => setDraft({ ...draft, host })} placeholder="主机，默认 %" autoCapitalize="none" placeholderTextColor={colors.muted} />
                ) : null}
                {draft.action === 'create' ? (
                  <TextInput style={styles.input} value={draft.password} onChangeText={(password) => setDraft({ ...draft, password })} placeholder="密码（至少 4 位）" secureTextEntry placeholderTextColor={colors.muted} />
                ) : null}
                {draft.action === 'grant' ? (
                  <>
                    <TextInput style={styles.input} value={draft.privileges} onChangeText={(privileges) => setDraft({ ...draft, privileges })} placeholder="权限，如 SELECT / ALL PRIVILEGES" autoCapitalize="characters" placeholderTextColor={colors.muted} />
                    <TextInput style={styles.input} value={draft.scope} onChangeText={(scope) => setDraft({ ...draft, scope })} placeholder="范围，如 db.* 或 *.*" autoCapitalize="none" placeholderTextColor={colors.muted} />
                    <TextInput style={styles.input} value={draft.role} onChangeText={(role) => setDraft({ ...draft, role })} placeholder="角色（PostgreSQL/SQL Server 用），可选" autoCapitalize="none" placeholderTextColor={colors.muted} />
                  </>
                ) : null}
                <Pressable style={[styles.primaryButton, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void run()}>
                  <Text style={styles.primaryButtonText}>{busy ? '执行中…' : '执行'}</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

function CommandScreen({ client, connections, activeConnection, onBack }: { client: BridgeClient; connections: ConnectionConfig[]; activeConnection?: ConnectionConfig; onBack: () => void }) {
  const [commandId, setCommandId] = useState(COMMANDS[0]?.id ?? 'report');
  const command = COMMANDS.find((item) => item.id === commandId) ?? COMMANDS[0];
  const minSources = Math.max(1, Number((command as any)?.sources?.min ?? 1));
  const maxSources = Math.max(minSources, Number((command as any)?.sources?.max ?? minSources));
  const slots = ((command as any)?.slots ?? []) as Array<{ key: string; kind: string; label: { zh: string }; required?: boolean; default?: unknown; options?: Array<{ value: string; label: { zh: string } }> }>;
  const [sources, setSources] = useState<string[]>(() => Array.from({ length: minSources }, (_, index) => (index === 0 ? activeConnection?.id : connections[index]?.id) ?? '').filter(Boolean));
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<{ id: string; status: string; error?: { message?: string } | string; artifactId?: string } | null>(null);

  useEffect(() => {
    setSources(Array.from({ length: minSources }, (_, index) => (index === 0 ? activeConnection?.id : connections[index]?.id) ?? '').filter(Boolean));
    setValues({});
    setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandId]);

  const start = async () => {
    const chosen = sources.filter(Boolean);
    if (chosen.length < minSources) {
      notify('无法运行', `需要选择 ${minSources} 个数据源`);
      return;
    }
    const input: Record<string, unknown> = {
      sources: chosen.map((connectionId) => {
        const conn = connections.find((item) => item.id === connectionId);
        return { connectionId, database: conn?.database, label: conn?.name };
      }),
    };
    for (const slot of slots) {
      if (slot.kind === 'sources') continue;
      const raw = values[slot.key];
      if (raw === undefined || raw === '') continue;
      if (slot.kind === 'tables') input[slot.key] = String(raw).split(',').map((item) => item.trim()).filter(Boolean);
      else if (slot.kind === 'mapping') {
        try {
          input[slot.key] = JSON.parse(String(raw));
        } catch {
          notify('映射格式错误', '请输入合法 JSON');
          return;
        }
      } else input[slot.key] = raw;
    }
    setBusy(true);
    try {
      const started = await client.startCommand(command.id, input as any, { title: `${command.title.zh} · 移动端` });
      setRun({ id: started.run.id, status: started.run.status });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const detail = await client.commandRun(started.run.id);
        setRun({ id: detail.run.id, status: detail.run.status, error: detail.run.error, artifactId: (detail.run as any).artifactId });
        if (['succeeded', 'failed', 'cancelled'].includes(detail.run.status)) break;
      }
    } catch (err: any) {
      notify('运行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-command-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>命令工作流</Text>
          <Text style={styles.listMeta}>{command.title.zh}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {COMMANDS.map((item) => (
            <Pressable key={item.id} testID={`m-command-${item.id}`} style={[styles.modeChip, commandId === item.id && styles.modeChipActive]} onPress={() => setCommandId(item.id)}>
              <Text style={[styles.modeChipText, commandId === item.id && { color: colors.accent }]}>{item.title.zh}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>数据源（{minSources}–{maxSources}）</Text>
          {sources.map((sourceId, index) => (
            <View key={index} style={{ marginTop: 6 }}>
              <Text style={styles.listMeta}>源 {index + 1}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 4 }}>
                {connections.map((conn) => (
                  <Pressable
                    key={conn.id}
                    testID={`m-cmd-source-${index}-${conn.id}`}
                    style={[styles.modeChip, sourceId === conn.id && styles.modeChipActive]}
                    onPress={() => setSources((prev) => prev.map((item, i) => (i === index ? conn.id : item)))}
                  >
                    <Text style={[styles.modeChipText, sourceId === conn.id && { color: colors.accent }]}>{conn.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ))}
          {sources.length < maxSources ? (
            <Pressable style={[styles.modeChip, { marginTop: 6 }]} onPress={() => setSources((prev) => [...prev, connections[0]?.id ?? ''])}>
              <Text style={styles.modeChipText}>+ 添加数据源</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>参数</Text>
          {slots.filter((slot) => slot.kind !== 'sources').map((slot) => (
            <View key={slot.key} style={{ marginTop: 8 }}>
              <Text style={styles.listMeta}>{slot.label.zh}{slot.required ? ' *' : ''}</Text>
              {slot.kind === 'boolean' ? (
                <Switch
                  value={Boolean(values[slot.key] ?? slot.default ?? false)}
                  onValueChange={(value) => setValues((prev) => ({ ...prev, [slot.key]: value }))}
                />
              ) : slot.kind === 'enum' ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 4 }}>
                  {(slot.options ?? []).map((option) => (
                    <Pressable
                      key={option.value}
                      style={[styles.modeChip, values[slot.key] === option.value && styles.modeChipActive]}
                      onPress={() => setValues((prev) => ({ ...prev, [slot.key]: option.value }))}
                    >
                      <Text style={[styles.modeChipText, values[slot.key] === option.value && { color: colors.accent }]}>{option.label.zh}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <TextInput
                  style={[styles.input, slot.kind === 'mapping' && { minHeight: 90, textAlignVertical: 'top' }]}
                  value={String(values[slot.key] ?? slot.default ?? '')}
                  onChangeText={(value) => setValues((prev) => ({ ...prev, [slot.key]: value }))}
                  placeholder={slot.kind === 'tables' ? '表名，英文逗号分隔' : slot.kind === 'mapping' ? 'JSON 映射' : slot.label.zh}
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline={slot.kind === 'mapping'}
                />
              )}
            </View>
          ))}
        </View>
        <Pressable testID="m-command-run" style={[styles.primaryButton, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void start()}>
          <Text style={styles.primaryButtonText}>{busy ? '运行中…' : `运行 /${command.id}`}</Text>
        </Pressable>
        {run ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>运行状态</Text>
            <Text testID="m-command-status" style={styles.listTitle}>{run.status}</Text>
            {run.error ? <Text style={styles.error}>{typeof run.error === 'string' ? run.error : run.error.message}</Text> : null}
            {run.artifactId ? <Text style={styles.listMeta}>产物：{run.artifactId}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const QUICK_PROMPTS = [
  '给当前数据库做一次完整体检，并列出可修复项',
  '生成当前库的数据字典摘要',
  '备份当前数据库',
  '统计每张表的行数并画柱状图',
  '找出最近失败或很慢的查询',
  '对比当前库与另一个库的结构差异',
];

function ToolsScreen({
  connection,
  database,
  connections,
  tables,
  sessions,
  memories,
  onRunPrompt,
  onRunCommand,
  onOpen,
}: {
  connection?: ConnectionConfig;
  database?: string;
  connections: ConnectionConfig[];
  tables: TableInfo[];
  sessions: AgentSessionMeta[];
  memories: Memory[];
  onRunPrompt: (text: string) => void;
  onRunCommand: (id: string) => void;
  onOpen: (page: 'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | 'commands') => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeading icon={<Wrench size={16} color={colors.accent} />} title="工具箱" subtitle="命令与快捷巡检" />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>当前上下文</Text>
          <Text style={[styles.settingValue, { marginTop: 4 }]}>
            {connection?.name ?? '未选择连接'}
            {database && connections.length ? ` / ${database}` : ''}
          </Text>
          <Text style={styles.listMeta}>
            {connection?.engine ?? '未连接'} · {tables.length} 个对象 · {sessions.length} 个会话 · {memories.length} 条记忆
          </Text>
        </View>
        <Text style={styles.sectionLabel}>数据工具</Text>
        {[
          { page: 'query' as const, label: 'SQL 查询', desc: '执行 SQL、导出、保存到仪表板', icon: <TerminalSquare size={15} color={colors.accent} /> },
          { page: 'table' as const, label: '表结构', desc: '列 / 索引 / 加列 / 重命名 / 清空', icon: <Table2 size={15} color={colors.accent} /> },
          { page: 'io' as const, label: '导入 / 导出', desc: 'CSV 导入；CSV / JSON / XML / SQL / XLSX 导出', icon: <Database size={15} color={colors.accent} /> },
          { page: 'backups' as const, label: '备份', desc: '创建与恢复 SQL 备份', icon: <History size={15} color={colors.accent} /> },
          { page: 'dashboards' as const, label: '仪表板', desc: '刷新卡片、查看趋势、删除卡片', icon: <BarChart3 size={15} color={colors.accent} /> },
          { page: 'search' as const, label: '数据库搜索', desc: '按对象与数据全文查找', icon: <Search size={15} color={colors.accent} /> },
          { page: 'dictionary' as const, label: '数据字典', desc: 'Markdown 结构说明', icon: <Database size={15} color={colors.accent} /> },
          { page: 'monitor' as const, label: '服务器监控', desc: '指标与会话概览', icon: <Gauge size={15} color={colors.accent} /> },
          { page: 'history' as const, label: '查询历史', desc: '搜索、收藏、回填 SQL', icon: <History size={15} color={colors.accent} /> },
          { page: 'audit' as const, label: '审计日志', desc: '谁在什么时候改了什么', icon: <ShieldAlert size={15} color={colors.accent} /> },
          { page: 'artifacts' as const, label: '报告与产物', desc: '报告/对比结果与导出', icon: <FileCode2 size={15} color={colors.accent} /> },
          { page: 'users' as const, label: '用户与权限', desc: '账户列表、创建、授权与删除', icon: <Users size={15} color={colors.accent} /> },
          { page: 'commands' as const, label: '命令工作流', desc: '报告/对比/对账/体检的表单化运行', icon: <TerminalSquare size={15} color={colors.accent} /> },
        ].map((entry) => (
          <Pressable key={entry.page} testID={`m-tool-${entry.page}`} style={styles.listRow} onPress={() => onOpen(entry.page)}>
            {entry.icon}
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{entry.label}</Text>
              <Text style={styles.listMeta} numberOfLines={1}>{entry.desc}</Text>
            </View>
            <ChevronRight size={14} color={colors.muted} />
          </Pressable>
        ))}
        <Text style={styles.sectionLabel}>Agent 命令</Text>
        {COMMANDS.map((command) => (
          <Pressable key={command.id} testID={`m-tool-command-${command.id}`} style={styles.listRow} onPress={() => onRunCommand(command.id)}>
            <TerminalSquare size={15} color={colors.agent} />
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{command.title.zh}</Text>
              <Text style={styles.listMeta} numberOfLines={1}>{command.description.zh}</Text>
            </View>
            <ChevronRight size={14} color={colors.muted} />
          </Pressable>
        ))}
        <Text style={styles.sectionLabel}>常用任务</Text>
        {QUICK_PROMPTS.map((prompt) => (
          <Pressable key={prompt} style={styles.listRow} onPress={() => onRunPrompt(prompt)}>
            <Sparkles size={15} color={colors.agent} />
            <Text style={[styles.listTitle, { flex: 1 }]}>{prompt}</Text>
            <ChevronRight size={14} color={colors.muted} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function BottomTabs({ tab, setTab, busy, bottom }: { tab: TabKey; setTab: (tab: TabKey) => void; busy: boolean; bottom: number }) {
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: 'chat', label: '对话', icon: <Sparkles size={17} color={tab === 'chat' ? colors.agent : colors.muted} /> },
    { key: 'data', label: '数据', icon: <Table2 size={17} color={tab === 'data' ? colors.accent : colors.muted} /> },
    { key: 'tools', label: '工具', icon: <Wrench size={17} color={tab === 'tools' ? colors.accent : colors.muted} /> },
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

interface ChartShape {
  type?: string;
  title?: string;
  xLabel?: string;
  yLabel?: string;
  series?: Array<{ label: string; value: number }>;
  points?: Array<{ x: number; y: number }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][] };
}

const CHART_COLORS = () => [colors.accent, colors.agent, colors.warning, colors.success, colors.danger, colors.cyan, colors.secondary];

function MobileChart({ chart }: { chart: ChartShape }) {
  const series = (chart.series ?? []).slice(0, 12);
  const palette = CHART_COLORS();
  const W = 320;
  const H = 150;
  const type = chart.type ?? 'bar';
  const max = Math.max(1, ...series.map((point) => Number(point.value) || 0));
  const min = Math.min(0, ...series.map((point) => Number(point.value) || 0));
  const scale = (value: number) => H - 18 - ((value - min) / Math.max(1, max - min)) * (H - 30);

  let body: React.ReactNode = null;
  let legend: Array<{ label: string; value: number; color: string }> = [];
  if (type === 'line' && series.length > 1) {
    const step = (W - 20) / (series.length - 1);
    const points = series.map((point, index) => `${10 + index * step},${scale(Number(point.value) || 0)}`).join(' ');
    body = (
      <>
        {[0, 0.5, 1].map((ratio) => (
          <Line key={ratio} x1={10} y1={15 + (H - 30) * ratio} x2={W - 10} y2={15 + (H - 30) * ratio} stroke={colors.border} strokeWidth={1} />
        ))}
        <Polyline points={points} fill="none" stroke={colors.accent} strokeWidth={2} />
        {series.map((point, index) => (
          <Circle key={point.label} cx={10 + index * step} cy={scale(Number(point.value) || 0)} r={3} fill={colors.agent} />
        ))}
        <SvgText x={10} y={H - 3} fill={colors.muted} fontSize={8}>{String(series[0]?.label ?? '').slice(0, 10)}</SvgText>
        <SvgText x={W - 10} y={H - 3} fill={colors.muted} fontSize={8} textAnchor="end">{String(series[series.length - 1]?.label ?? '').slice(0, 10)}</SvgText>
      </>
    );
    legend = series.slice(0, 3).map((point, index) => ({ label: point.label, value: point.value, color: palette[index] }));
  } else if (type === 'pie' && series.length) {
    const total = series.reduce((sum, point) => sum + Math.max(0, Number(point.value) || 0), 0) || 1;
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 12;
    let angle = -Math.PI / 2;
    body = series.map((point, index) => {
      const slice = (Math.max(0, Number(point.value) || 0) / total) * Math.PI * 2;
      const end = angle + slice;
      const large = slice > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(angle);
      const y1 = cy + r * Math.sin(angle);
      const x2 = cx + r * Math.cos(end);
      const y2 = cy + r * Math.sin(end);
      const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
      const fill = palette[index % palette.length];
      angle = end;
      return <Path key={point.label} d={path} fill={fill} stroke={colors.panel} strokeWidth={1} />;
    });
    legend = series.slice(0, 8).map((point, index) => ({ label: point.label, value: point.value, color: palette[index % palette.length] }));
  } else if (type === 'scatter' && chart.points?.length) {
    const xs = chart.points.map((point) => Number(point.x) || 0);
    const ys = chart.points.map((point) => Number(point.y) || 0);
    const xMax = Math.max(1, ...xs);
    const yMax = Math.max(1, ...ys);
    body = (
      <>
        <Line x1={12} y1={H - 15} x2={W - 10} y2={H - 15} stroke={colors.border} strokeWidth={1} />
        <Line x1={12} y1={15} x2={12} y2={H - 15} stroke={colors.border} strokeWidth={1} />
        {chart.points.slice(0, 120).map((point, index) => (
          <Circle key={index} cx={12 + ((Number(point.x) || 0) / xMax) * (W - 24)} cy={H - 15 - ((Number(point.y) || 0) / yMax) * (H - 30)} r={2.5} fill={colors.accent} fillOpacity={0.75} />
        ))}
      </>
    );
  } else if (type === 'heatmap' && chart.heatmap) {
    const { xLabels, yLabels, values } = chart.heatmap;
    const flat = values.flat().map((value) => Number(value) || 0);
    const heatMax = Math.max(1, ...flat);
    const cellW = (W - 20) / Math.max(1, xLabels.length);
    const cellH = (H - 22) / Math.max(1, yLabels.length);
    body = values.slice(0, yLabels.length).map((row, y) =>
      row.slice(0, xLabels.length).map((value, x) => (
        <Rect
          key={`${x}-${y}`}
          x={10 + x * cellW}
          y={4 + y * cellH}
          width={Math.max(1, cellW - 2)}
          height={Math.max(1, cellH - 2)}
          rx={2}
          fill={colors.accent}
          fillOpacity={0.12 + 0.78 * ((Number(value) || 0) / heatMax)}
        />
      )),
    );
    legend = [
      { label: `${xLabels[0] ?? ''} …`, value: 0, color: colors.accent },
      { label: `${yLabels[0] ?? ''} …`, value: 0, color: colors.muted },
    ];
  } else if (type === 'radar' && series.length >= 3) {
    const cx = W / 2;
    const cy = H / 2;
    const r = Math.min(W, H) / 2 - 18;
    const points = series.map((point, index) => {
      const angle = -Math.PI / 2 + (index / series.length) * Math.PI * 2;
      const radius = (Math.max(0, Number(point.value) || 0) / max) * r;
      return `${cx + radius * Math.cos(angle)},${cy + radius * Math.sin(angle)}`;
    }).join(' ');
    body = (
      <>
        {[0.33, 0.66, 1].map((ratio) => (
          <Circle key={ratio} cx={cx} cy={cy} r={r * ratio} fill="none" stroke={colors.border} strokeWidth={1} />
        ))}
        <Polyline points={points} fill={colors.accent} fillOpacity={0.18} stroke={colors.accent} strokeWidth={2} />
      </>
    );
    legend = series.slice(0, 4).map((point, index) => ({ label: point.label, value: point.value, color: palette[index] }));
  } else {
    // bar（默认）
    const barW = (W - 20) / Math.max(1, series.length);
    body = series.map((point, index) => {
      const height = Math.max(2, ((Number(point.value) || 0) / max) * (H - 30));
      return <Rect key={point.label} x={10 + index * barW + 2} y={H - 15 - height} width={Math.max(3, barW - 4)} height={height} rx={2} fill={palette[index % palette.length]} />;
    });
    legend = series.slice(0, 4).map((point, index) => ({ label: point.label, value: point.value, color: palette[index % palette.length] }));
  }

  return (
    <View style={{ marginTop: 7, gap: 5 }}>
      <Text style={[styles.listMeta, { color: colors.text }]}>{chart.title ?? '图表'}{chart.xLabel || chart.yLabel ? ` · ${chart.xLabel ?? ''}${chart.yLabel ? ' × ' + chart.yLabel : ''}` : ''}</Text>
      <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.panel, padding: 4 }}>
        <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>{body}</Svg>
      </View>
      {legend.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {legend.map((item, index) => (
            <View key={`${item.label}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: item.color }} />
              <Text style={styles.listMeta} numberOfLines={1}>{item.label}{item.value ? ` · ${item.value.toLocaleString()}` : ''}</Text>
            </View>
          ))}
        </View>
      ) : null}
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
  const chart = data?.chart as ChartShape | undefined;
  return (
    <Pressable testID="m-tool-card" style={[styles.toolCard, status === 'error' && { borderLeftColor: colors.danger }, status === 'awaiting' && { borderLeftColor: colors.warning }]} onPress={() => setOpen(!open)}>
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
              {chart ? <MobileChart chart={chart as ChartShape} /> : null}
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

const makeStyles = () => StyleSheet.create({
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
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 6 },
  scanLink: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 2 },
  scanLinkText: { color: colors.accent, fontSize: 11 },
  scanWrap: { flex: 1, backgroundColor: '#000' },
  scanHead: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 18, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 3 },
  scanTitle: { color: '#fff', fontSize: 14, fontWeight: '600' },
  scanFrame: { position: 'absolute', left: '12%', right: '12%', top: '26%', aspectRatio: 1, borderWidth: 2, borderColor: colors.accent, borderRadius: 16 },
  scanFoot: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, paddingTop: 14, gap: 8, alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.55)', zIndex: 3 },
  scanHint: { color: '#fff', fontSize: 12, textAlign: 'center' },
  scanError: { color: '#fca5a5', fontSize: 12, textAlign: 'center' },
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
  composerTop: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 7 },
  sqlSnippet: { color: colors.secondary, fontSize: 10.5, lineHeight: 16, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginTop: 4 },
  dictionaryText: { color: colors.text, fontSize: 11.5, lineHeight: 18, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  queryInput: { minHeight: 130, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.elevated, padding: 10, color: colors.text, fontSize: 12, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', textAlignVertical: 'top' },
  resultCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.panel, padding: 8, overflow: 'hidden' },
  resultRow: { flexDirection: 'row' },
  resultCell: { minWidth: 90, maxWidth: 220, paddingHorizontal: 6, paddingVertical: 5, color: colors.text, fontSize: 10.5, borderBottomWidth: 1, borderColor: colors.border },
  resultHead: { color: colors.secondary, fontWeight: '600', backgroundColor: colors.elevated },
  modelPill: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 23, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.elevated, maxWidth: '58%' },
  modelPillText: { color: colors.secondary, fontSize: 9.5 },
  modeSelect: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 23, paddingHorizontal: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.elevated },
  modeSelectText: { color: colors.secondary, fontSize: 9.5 },
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

let styles = makeStyles();
let currentTheme: ThemeResolved | undefined;

function applyTheme(mode: ThemeResolved): void {
  if (currentTheme === mode) return;
  currentTheme = mode;
  setPalette(mode);
  styles = makeStyles();
}

