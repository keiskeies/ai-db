import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
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
import Svg, { Circle, G, Line, Path, Polyline, Rect, SvgXml, Text as SvgText } from 'react-native-svg';
import { CameraView, useCameraPermissions } from 'expo-camera';
import brandMark from './assets/brand-mark.png';
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
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
  Grid3x3,
  History,
  ImagePlus,
  Layers,
  LineChart,
  Loader2,
  Lock,
  MessageSquarePlus,
  Pencil,
  PieChart,
  Plus,
  Radar,
  RefreshCw,
  ScanLine,
  ScatterChart,
  Search,
  Send,
  Settings as SettingsIcon,
  ShieldAlert,
  Sparkles,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  User,
  Users,
  Workflow,
  Wrench,
  X,
} from 'lucide-react-native';
import { COMMANDS, chartSuitability, localeInfo, normalizeLocale, parsePairingPayload, pipelineStepKind } from '@aidb/core';
import type {
  AgentEvent,
  AgentSettings,
  AgentMessage,
  AgentMessageBlock,
  AgentPlanItem,
  AgentSessionMeta,
  ChartKind,
  QueryBatchResult,
  ConnectionConfig,
  Engine,
  Memory,
  PermissionMode,
  PipelineInfo,
  PipelineRunInfo,
  PipelineStep,
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
import { colors, chartPalette, getThemeMode, heatTone, modeLabels, radius, riskColor, riskLabels, setPalette, type ThemeResolved } from './src/theme';
import { ENGINE_LOGO_PNG, ENGINE_LOGO_SVG, LETTER_BADGES, MONO_ENGINE_LOGOS, BRIGHT_ENGINE_LOGOS } from './src/engineLogos';
import { currentLocale, LOCALES, setLocale, translate, type Locale } from './src/i18n';

type TabKey = 'chat' | 'data' | 'tools' | 'me';

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

/** 与桌面端 .brand-mark 同一份品牌资源，不随主题变化。 */
function BrandMark({ size }: { size: number }) {
  return <Image source={brandMark} style={{ width: size, height: size }} resizeMode="contain" accessibilityIgnoresInvertColors />;
}

/** 引擎官方 logo：与桌面 EngineIcon 同一套资源；暗色下反转接近黑色的 logo。 */
function EngineLogo({ engine, size = 16 }: { engine?: string; size?: number }) {
  const key = (engine ?? '') as Engine;
  const svg = ENGINE_LOGO_SVG[key];
  if (svg) {
    const xml = getThemeMode() === 'dark' && MONO_ENGINE_LOGOS.has(key) ? svg.replace(/(fill|stroke)="(#003B57|#003545|#005571|black)"/g, `$1="${colors.text}"`) : svg;
    return <SvgXml xml={xml} width={size} height={size} />;
  }
  const png = ENGINE_LOGO_PNG[key];
  if (png) {
    return (
      <Image
        source={png}
        style={{ width: size, height: size, opacity: getThemeMode() === 'light' && BRIGHT_ENGINE_LOGOS.has(key) ? 0.88 : 1 }}
        resizeMode="contain"
      />
    );
  }
  const badge = LETTER_BADGES[key];
  return (
    <View style={{ width: size, height: size, borderRadius: 3, backgroundColor: `${badge?.color ?? colors.muted}33`, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: badge?.color ?? colors.muted, fontSize: Math.max(7, size * 0.55), fontWeight: '700' }}>{badge?.letter ?? '?'}</Text>
    </View>
  );
}

function TextInput(props: React.ComponentProps<typeof RNTextInput>) {
  const webStyle = Platform.OS === 'web' ? ({ outlineStyle: 'none' } as any) : undefined;
  return <RNTextInput {...props} style={[props.style, webStyle]} placeholder={props.placeholder ? translate(props.placeholder) : props.placeholder} />;
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
  if (diff < 60_000) return translate('刚刚');
  if (diff < 3_600_000) return translate('{0} 分钟前', [Math.round(diff / 60_000)]);
  if (diff < 86_400_000) return translate('{0} 小时前', [Math.round(diff / 3_600_000)]);
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
      const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('aidb.mobile.locale') : null;
      return normalizeLocale(stored ?? 'en');
    } catch {
      return 'en';
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
        <BrandMark size={48} />
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
        <BrandMark size={64} />
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
            {busy ? <ActivityIndicator color={colors.onSolid} size="small" /> : <Sparkles size={15} color={colors.onSolid} />}
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
  const [databaseReadyFor, setDatabaseReadyFor] = useState<string | undefined>();
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
  const [toolPage, setToolPage] = useState<'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users' | null>(null);
  const [chatPage, setChatPage] = useState<'commands' | null>(null);
  const [mePage, setMePage] = useState<'memory' | 'connections' | 'settings' | null>(null);
  const [toolTable, setToolTable] = useState<string | undefined>(undefined);
  const [toolSql, setToolSql] = useState<string | undefined>(undefined);

  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | undefined>(undefined);
  const activeConnectionIdRef = useRef<string | undefined>(undefined);
  const schemaInFlightRef = useRef(false);
  const preferredDatabaseRef = useRef<string | undefined>(undefined);
  const pendingDatabasePickerRef = useRef(false);
  const schemaPendingRef = useRef(false);
  const handlerRef = useRef<(event: any) => void>(() => undefined);
  const scrollRef = useRef<ScrollView>(null);
  /** 是否跟随最新输出；用户手动上滑后置为 false，滑回底部再恢复。 */
  const stickRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  /** 首次加载/流式输出期间，内容尺寸变化才跟随贴底；静态展开折叠不触发。 */
  const initialScrollRef = useRef(true);
  const busyRef = useRef(false);
  const lastTurnStartRef = useRef(0);
  const [showJump, setShowJump] = useState(false);

  const activeConnection = connections.find((c) => c.id === activeConnectionId);
  const busy = live?.status === 'streaming' || live?.status === 'awaiting';

  useEffect(() => {
    busyRef.current = Boolean(busy);
  }, [busy]);

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
    if (!stickRef.current) return;
    const timer = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(timer);
  }, [live?.text, live?.tools.length, live?.status, live?.plan, messages.length]);

  // 新一轮开始：无论此前停在哪里都回到最新输出。
  useEffect(() => {
    if (!live || live.startedAt === lastTurnStartRef.current) return;
    lastTurnStartRef.current = live.startedAt;
    stickRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollToEnd({ animated: false });
  }, [live?.startedAt]);

  // 切换/新建会话：重置为跟随底部，等首屏布局完成再贴底一次。
  useEffect(() => {
    stickRef.current = true;
    setShowJump(false);
    initialScrollRef.current = true;
    const timer = setTimeout(() => {
      initialScrollRef.current = false;
      scrollRef.current?.scrollToEnd({ animated: false });
    }, 160);
    return () => clearTimeout(timer);
  }, [sessionId]);

  const onChatScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const top = contentOffset.y;
    const distance = contentSize.height - top - layoutMeasurement.height;
    const scrolledUp = top < lastScrollTopRef.current - 2;
    lastScrollTopRef.current = top;
    if (scrolledUp) stickRef.current = false;
    else if (distance <= 48) stickRef.current = true;
    setShowJump((prev) => (distance <= 48 ? false : scrolledUp || distance > 120 ? true : prev));
  };

  // 只有首次加载或流式输出期间，尺寸变化才跟随贴底；静态展开折叠不触发。
  const onChatContentSizeChange = () => {
    if (!stickRef.current) return;
    if (!busyRef.current && !initialScrollRef.current) return;
    scrollRef.current?.scrollToEnd({ animated: false });
  };

  const jumpToLatest = () => {
    stickRef.current = true;
    setShowJump(false);
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  useEffect(() => {
    if (tab === 'me' && mePage === 'memory') void loadMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mePage]);

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
          <RefreshCw size={14} color={colors.onSolid} />
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
            <Pressable testID="m-command-workflows" style={[styles.secondaryButton, { marginTop: 10 }]} onPress={() => { setCommandOpen(false); setChatPage('commands'); }}>
              <Text style={styles.secondaryButtonText}>需要数据源或参数？打开命令工作流</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <View style={[styles.topSafe, { paddingTop: insets.top }]} />
      <View style={styles.topbar}>
        <View style={styles.brandRow}>
          <BrandMark size={30} />
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
          chatPage === 'commands' ? (
            <CommandScreen client={client} connections={connections} activeConnection={activeConnection} onBack={() => setChatPage(null)} />
          ) : (
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
            onScroll={onChatScroll}
            onContentSizeChange={onChatContentSizeChange}
            showJump={showJump}
            onJumpToLatest={jumpToLatest}
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
          )
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
              <ScreenHeading icon={<Table2 size={16} color={colors.accent} />} title="数据" subtitle={`${databases.length > 1 && activeDatabase ? activeDatabase + ' · ' : ''}${tables.length} 个对象`} />
              <View style={styles.dataToolbar}>
                <Pressable testID="m-data-connection" style={[styles.dataChip, { flex: 1 }]} onPress={() => setPicker('connections')}>
                  <EngineLogo engine={activeConnection?.engine} size={14} />
                  <Text style={styles.dataChipText} numberOfLines={1}>{activeConnection?.name ?? '选择连接'}</Text>
                  <ChevronDown size={12} color={colors.muted} />
                </Pressable>
                {databases.length > 1 ? (
                  <Pressable testID="m-data-database" style={[styles.dataChip, { flex: 1 }]} onPress={() => setPicker('databases')}>
                    <Database size={12} color={colors.accent} />
                    <Text style={styles.dataChipText} numberOfLines={1}>{activeDatabase ?? '选择库'}</Text>
                    <ChevronDown size={12} color={colors.muted} />
                  </Pressable>
                ) : null}
                <Pressable testID="m-data-refresh" style={styles.iconButton} onPress={() => activeConnectionId && void loadSchema(activeConnectionId)}>
                  <RefreshCw size={15} color={colors.text} />
                </Pressable>
              </View>
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
                <Text style={styles.hint}>点击表可浏览与编辑数据；结构变更、导入导出在「工具」页。</Text>
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
          ) : toolPage === 'pipelines' ? (
            <PipelinesScreen client={client} onBack={() => setToolPage(null)} />
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
          ) : (
            <ToolsScreen
              connection={activeConnection}
              database={activeDatabase}
              tables={tables}
              onOpen={(page) => {
                if (page === 'query') setToolSql(undefined);
                setToolPage(page);
              }}
            />
          )
        ) : null}

        {tab === 'me' && mePage === 'connections' ? (
          <View style={{ flex: 1 }}>
            <View style={styles.tableHead}>
              <Pressable testID="m-connections-back" style={styles.iconButton} onPress={() => setMePage(null)}>
                <ChevronLeft size={18} color={colors.text} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={styles.listTitle}>连接</Text>
                <Text style={styles.listMeta}>由 Bridge 统一管理</Text>
              </View>
            </View>
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
                    setMePage(null);
                    setTab('data');
                  }}
                >
                  <View style={styles.connCardHead}>
                    <EngineLogo engine={conn.engine} size={16} />
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

        {tab === 'me' && mePage === 'memory' ? (
          <View style={{ flex: 1 }}>
            <View style={styles.tableHead}>
              <Pressable testID="m-memory-back" style={styles.iconButton} onPress={() => setMePage(null)}>
                <ChevronLeft size={18} color={colors.text} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={styles.listTitle}>记忆</Text>
                <Text style={styles.listMeta}>{translate('{0} 条 · 跨会话召回', [memories.length])}</Text>
              </View>
              <Pressable testID="m-memory-new" style={styles.iconButton} onPress={() => setMemoryDraft({ kind: 'fact', title: '', content: '' })}>
                <Plus size={16} color={colors.text} />
              </Pressable>
            </View>
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

        {tab === 'me' && mePage === 'settings' ? (
          <SettingsScreen client={client} boot={boot} config={config} mode={mode} connected={connected} onDisconnect={onDisconnect} onMode={setMode} themeMode={themeMode} resolvedTheme={resolvedTheme} onThemeMode={onThemeMode} locale={locale} onLocale={onLocale} onBack={() => setMePage(null)} />
        ) : null}

        {tab === 'me' && !mePage ? (
          <MeScreen
            boot={boot}
            config={config}
            connections={connections}
            activeConnection={activeConnection}
            memories={memories}
            connected={connected}
            themeMode={themeMode}
            locale={locale}
            onOpen={(page) => setMePage(page)}
          />
        ) : null}
      </View>

      <BottomTabs
        tab={tab}
        setTab={(next) => {
          if (next === 'me') setMePage(null);
          if (next === 'chat') setChatPage(null);
          setTab(next);
        }}
        busy={busy}
        bottom={insets.bottom}
      />

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
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>选择数据库</Text>
                  <Text style={styles.listMeta}>{activeConnection?.name ?? ''}{databases.length ? ` · ${databases.length} 个库` : ''}</Text>
                </View>
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
                  <Plus size={13} color={colors.onSolid} />
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
                <Pressable testID="m-connections-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              {connections.map((conn) => (
                <Pressable
                  key={conn.id}
                  testID={`m-connection-${conn.id}`}
                  style={[styles.sessionRow, conn.id === activeConnectionId && { backgroundColor: colors.accentSoft }]}
                  onPress={() => {
                    if (conn.id !== activeConnectionId) pendingDatabasePickerRef.current = true;
                    setActiveConnectionId(conn.id);
                    setPicker(null);
                  }}
                >
                  <EngineLogo engine={conn.engine} size={16} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listTitle}>{conn.name}</Text>
                    <Text style={styles.listMeta}>
                      {conn.engine} · {conn.environment}
                      {conn.id === activeConnectionId && activeDatabase ? ` · ${activeDatabase}` : ''}
                    </Text>
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
  onScroll,
  onContentSizeChange,
  showJump,
  onJumpToLatest,
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
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onContentSizeChange: () => void;
  showJump: boolean;
  onJumpToLatest: () => void;
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
              <EngineLogo engine={connection?.engine} size={14} />
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

      <View style={{ flex: 1 }}>
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: 24, gap: 14 }}
          keyboardShouldPersistTaps="handled"
          onScroll={onScroll}
          scrollEventThrottle={16}
          onContentSizeChange={onContentSizeChange}
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
              {live.thinking || live.tools.length || live.plan.length ? (
                <ExecutionSection count={live.tools.length} running={busy}>
                  {live.thinking ? <ThinkingBlock text={live.thinking} /> : null}
                  {live.tools.map((tool) => (
                    <MobileToolCard key={tool.callId} tool={tool.tool} args={tool.args} risk={tool.risk} status={tool.status} result={tool.result} summary={tool.summary} showChart={!chartOf(tool.result)} />
                  ))}
                  {live.plan.length ? <PlanCard items={live.plan} /> : null}
                </ExecutionSection>
              ) : null}
              {live.text ? <Markdown text={live.text} /> : busy ? (
                <View style={styles.loadingRow}>
                  <Loader2 size={12} color={colors.agent} />
                  <Text style={styles.listMeta}>{live.status === 'awaiting' ? '等待授权…' : '正在处理…'}</Text>
                </View>
              ) : null}
              {live.tools.filter((tool) => chartOf(tool.result)).map((tool) => (
                <MobileChart key={`chart_${tool.callId}`} chart={chartOf(tool.result)!} />
              ))}
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
        {showJump ? (
          <View pointerEvents="box-none" style={styles.jumpWrap}>
            <Pressable testID="m-scroll-bottom" style={styles.jumpButton} onPress={onJumpToLatest}>
              <ArrowDown size={12} color={colors.secondary} />
              <Text style={styles.jumpText}>回到底部</Text>
            </Pressable>
          </View>
        ) : null}
      </View>

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
          <View style={styles.inputToolbar}>
            <Pressable style={styles.inputTool} onPress={onOpenCommands} testID="m-commands">
              <TerminalSquare size={15} color={colors.accent} />
            </Pressable>
            <Pressable style={styles.inputTool} onPress={onOpenTables}>
              <AtSign size={15} color={colors.muted} />
            </Pressable>
            <Pressable style={styles.inputTool} onPress={onPickImage} disabled={uploadingImage || pendingImages.length >= 4} testID="m-image">
              {uploadingImage ? <ActivityIndicator size="small" color={colors.accent} /> : <ImagePlus size={15} color={colors.muted} />}
            </Pressable>
            <View style={{ flex: 1 }} />
            {busy ? (
              <Pressable style={[styles.sendButton, { backgroundColor: colors.danger }]} onPress={onStop}>
                <Square size={13} color={colors.onSolid} />
              </Pressable>
            ) : (
              <Pressable testID="m-send" style={[styles.sendButton, (!input.trim() || !connected) && { opacity: 0.4 }]} onPress={onSend} disabled={!input.trim() || !connected}>
                <Send size={14} color={colors.onSolid} />
              </Pressable>
            )}
          </View>
        </View>
        <Text style={styles.composerHint}>{translate(modeLabels[mode])}{translate('模式 · @ 引用表 · 图片随消息发送')}</Text>
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
  const [viewMode, setViewMode] = useState<'grid' | 'cards'>('grid');
  const [inspect, setInspect] = useState<{ row: unknown[]; index: number } | null>(null);
  const gridHeaderRef = useRef<ScrollView>(null);
  const gridBodyRef = useRef<ScrollView>(null);
  const lastGridXRef = useRef(0);

  const syncGridScroll = (x: number) => {
    if (Math.abs(x - lastGridXRef.current) < 1) return;
    lastGridXRef.current = x;
    gridHeaderRef.current?.scrollTo({ x, animated: false });
    gridBodyRef.current?.scrollTo({ x, animated: false });
  };

  const widthForColumn = (column: { name: string; type?: string; kind?: string }) => {
    const type = (column.type ?? table.columns?.find((item) => item.name === column.name)?.type ?? '').toLowerCase();
    if (column.kind === 'json' || column.kind === 'vector' || column.kind === 'geometry') return 200;
    if (/(text|json|blob|clob|xml|enum|set)/.test(type)) return 190;
    if (/(char|string)/.test(type)) return 160;
    if (/(date|time|timestamp)/.test(type)) return 150;
    if (/(bool|bit|int|double|float|decimal|numeric|number|real)/.test(type)) return 110;
    return 140;
  };

  const gridWidth = 40 + (canWrite ? 58 : 0) + (result?.columns ?? []).reduce((sum, column) => sum + widthForColumn(column), 0);

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
      <View style={styles.dataViewBar}>
        <View style={styles.viewSwitch}>
          <Pressable testID="m-data-view-grid" style={[styles.viewSwitchItem, viewMode === 'grid' && styles.viewSwitchActive]} onPress={() => setViewMode('grid')}>
            <Text style={[styles.viewSwitchText, viewMode === 'grid' && styles.viewSwitchTextActive]}>表格</Text>
          </Pressable>
          <Pressable testID="m-data-view-cards" style={[styles.viewSwitchItem, viewMode === 'cards' && styles.viewSwitchActive]} onPress={() => setViewMode('cards')}>
            <Text style={[styles.viewSwitchText, viewMode === 'cards' && styles.viewSwitchTextActive]}>卡片</Text>
          </Pressable>
        </View>
        {viewMode === 'grid' ? <Text style={styles.listMeta}>左右滑动查看全部列 · 点行看详情</Text> : null}
      </View>
      {viewMode === 'grid' ? (
        <View style={{ flex: 1 }}>
          <ScrollView
            horizontal
            ref={gridHeaderRef}
            onScroll={(event) => syncGridScroll(event.nativeEvent.contentOffset.x)}
            scrollEventThrottle={16}
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, flexShrink: 0, height: 32 }}
          >
            <View style={[styles.gridHeaderRow, { width: gridWidth }]}>
              <Text style={[styles.gridHeadCell, { width: 40 }]}>#</Text>
              {canWrite ? <Text style={[styles.gridHeadCell, { width: 58 }]}>操作</Text> : null}
              {(result?.columns ?? []).map((column) => (
                <Text key={column.name} style={[styles.gridHeadCell, { width: widthForColumn(column) }]} numberOfLines={1}>{column.name}</Text>
              ))}
            </View>
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
            <ScrollView
              horizontal
              ref={gridBodyRef}
              onScroll={(event) => syncGridScroll(event.nativeEvent.contentOffset.x)}
              scrollEventThrottle={16}
            >
              <View>
                {(result?.rows ?? []).map((row, rowIndex) => (
                  <Pressable
                    key={rowIndex}
                    testID={`m-row-${rowIndex}`}
                    style={[styles.gridRow, { width: gridWidth }, rowIndex % 2 === 1 && { backgroundColor: colors.elevated }]}
                    onPress={() => setInspect({ row, index: rowIndex })}
                  >
                    <Text style={[styles.gridIndexCell, { width: 40 }]}>{offset + rowIndex + 1}</Text>
                    {canWrite ? (
                      <View style={[styles.gridActionCell, { width: 58 }]}>
                        <Pressable testID={`m-row-edit-${rowIndex}`} hitSlop={8} style={styles.gridActionButton} onPress={() => startEdit(row)}>
                          <Pencil size={12} color={colors.muted} />
                        </Pressable>
                        <Pressable testID={`m-row-delete-${rowIndex}`} hitSlop={8} style={styles.gridActionButton} onPress={() => void remove(row)}>
                          <Trash2 size={12} color={colors.muted} />
                        </Pressable>
                      </View>
                    ) : null}
                    {(result?.columns ?? []).map((column, colIndex) => {
                      const value = row[colIndex];
                      const isNull = value === null || value === undefined;
                      return (
                        <Text
                          key={column.name}
                          style={[styles.gridCell, { width: widthForColumn(column) }, isNull && { color: colors.muted, fontStyle: 'italic' }]}
                          numberOfLines={1}
                        >
                          {isNull ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </Text>
                      );
                    })}
                  </Pressable>
                ))}
              </View>
            </ScrollView>
            {!loading && !(result?.rows ?? []).length ? <Text style={styles.hint}>没有数据</Text> : null}
          </ScrollView>
        </View>
      ) : (
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
      )}
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
      {inspect ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setInspect(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>行详情</Text>
                  <Text style={styles.listMeta}>{table.name} · #{offset + inspect.index + 1}</Text>
                </View>
                <Pressable testID="m-row-inspect-close" style={styles.iconButton} onPress={() => setInspect(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {(result?.columns ?? []).map((column, colIndex) => {
                  const value = inspect.row[colIndex];
                  return (
                    <View key={column.name} style={styles.fieldRow}>
                      <Text style={styles.fieldName}>{column.name}</Text>
                      <Text style={styles.fieldValue}>
                        {value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </Text>
                    </View>
                  );
                })}
                {canWrite ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    <Pressable
                      testID="m-row-inspect-edit"
                      style={[styles.secondaryButton, { flex: 1 }]}
                      onPress={() => {
                        const row = inspect.row;
                        setInspect(null);
                        startEdit(row);
                      }}
                    >
                      <Text style={styles.secondaryButtonText}>编辑</Text>
                    </Pressable>
                    <Pressable
                      testID="m-row-inspect-delete"
                      style={[styles.secondaryButton, { flex: 1, borderColor: colors.danger }]}
                      onPress={() => {
                        const row = inspect.row;
                        setInspect(null);
                        void remove(row);
                      }}
                    >
                      <Text style={[styles.secondaryButtonText, { color: colors.danger }]}>删除</Text>
                    </Pressable>
                  </View>
                ) : null}
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
  onBack,
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
  onBack: () => void;
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
      <View style={styles.tableHead}>
        <Pressable testID="m-settings-back" style={styles.iconButton} onPress={onBack}>
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>设置</Text>
          <Text style={styles.listMeta}>Bridge 与 Agent</Text>
        </View>
      </View>
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
            <Text style={styles.listMeta}>v{boot?.version ?? '0.0.4'}</Text>
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
          <Text style={[styles.hint, { marginTop: 8 }]}>{translate('当前：{0}；主题只保存在本机。', [resolvedTheme === 'light' ? translate('浅色') : translate('深色')])}</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>语言 / Language</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
            {LOCALES.map((option) => (
              <Pressable
                key={option.id}
                testID={`m-locale-${option.id}`}
                style={[styles.modeChip, locale === option.id && styles.modeChipActive]}
                onPress={() => onLocale(option.id)}
              >
                <Text style={[styles.modeChipText, locale === option.id && { color: colors.accent }]}>{option.native}</Text>
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

        <Text style={[styles.hint, { textAlign: 'center', marginTop: 6 }]}>AiDB Studio v0.0.4 · Android / iOS / Web</Text>
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
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View>
                  <View style={styles.schemaHeaderRow}>
                    <Text style={[styles.schemaHeadCell, { width: 112 }]}>列名</Text>
                    <Text style={[styles.schemaHeadCell, { width: 124 }]}>类型</Text>
                    <Text style={[styles.schemaHeadCell, { width: 34 }]}>键</Text>
                    <Text style={[styles.schemaHeadCell, { width: 44 }]}>可空</Text>
                    <Text style={[styles.schemaHeadCell, { width: 120 }]}>默认值</Text>
                  </View>
                  {(detail.columns ?? []).map((column) => (
                    <View key={column.name} style={styles.schemaRow}>
                      <Text style={[styles.schemaCell, { width: 112, color: colors.text }]} numberOfLines={1}>{column.name}</Text>
                      <Text style={[styles.schemaCell, { width: 124 }]} numberOfLines={1}>{column.type}</Text>
                      <Text style={[styles.schemaCell, { width: 34 }, column.primaryKey && { color: colors.accent, fontWeight: '600' }]}>{column.primaryKey ? 'PK' : '—'}</Text>
                      <Text style={[styles.schemaCell, { width: 44 }]}>{column.nullable ? 'YES' : 'NO'}</Text>
                      <Text style={[styles.schemaCell, { width: 120 }]} numberOfLines={1}>{column.defaultValue === null || column.defaultValue === undefined ? '—' : String(column.defaultValue)}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>索引（{detail.indexes?.length ?? 0}）</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View>
                  <View style={styles.schemaHeaderRow}>
                    <Text style={[styles.schemaHeadCell, { width: 140 }]}>名称</Text>
                    <Text style={[styles.schemaHeadCell, { width: 110 }]}>列</Text>
                    <Text style={[styles.schemaHeadCell, { width: 40 }]}>唯一</Text>
                    <Text style={[styles.schemaHeadCell, { width: 50 }]}>操作</Text>
                  </View>
                  {(detail.indexes ?? []).map((index) => (
                    <View key={index.name} style={styles.schemaRow}>
                      <Text style={[styles.schemaCell, { width: 140, color: colors.text }]} numberOfLines={1}>{index.name}</Text>
                      <Text style={[styles.schemaCell, { width: 110 }]} numberOfLines={1}>{index.columns.join(', ')}</Text>
                      <Text style={[styles.schemaCell, { width: 40 }]}>{index.unique ? 'YES' : '—'}</Text>
                      <View style={[styles.schemaActionCell, { width: 50 }]}>
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
                    </View>
                  ))}
                </View>
              </ScrollView>
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

function stepTypeLabel(type: string): string {
  const kind = pipelineStepKind(type);
  if (!kind) return type;
  // 目录里的双语标签是运行时数据，进不了整句查表，只能按当前语言二选一。
  return currentLocale() === 'zh-CN' ? kind.label.zh : kind.label.en;
}

function stepBrief(step: PipelineStep): string {
  const values = step.with ?? {};
  const table = String(values.table ?? '').trim();
  if (table) return table;
  const url = String(values.url ?? '').trim();
  if (url) return url.replace(/^https?:\/\//, '').slice(0, 44);
  const sql = String(values.sql ?? '').trim();
  if (sql) return sql.split('\n')[0].slice(0, 44);
  return '';
}

function flowChain(steps: PipelineStep[]): string {
  return steps.map((step) => step.label || stepTypeLabel(step.type)).join(' → ');
}

function runChain(run: PipelineRunInfo): string {
  return run.steps
    .map((step) => {
      const mark = step.status === 'ok' ? '✓' : step.status === 'error' ? '✗' : step.status === 'skipped' ? '–' : '·';
      const rows = step.outRows === undefined ? '' : ` ${step.inRows ?? 0}→${step.outRows}`;
      const name = step.label && step.label !== step.id ? step.label : stepTypeLabel(step.type);
      return `${mark} ${name}${rows}`;
    })
    .join(' → ');
}

function flowStatusText(status?: string): string {
  if (status === 'ok') return translate('成功');
  if (status === 'error') return translate('失败');
  if (status === 'running') return translate('运行中');
  return translate('尚未运行');
}

function PipelinesScreen({ client, onBack }: { client: BridgeClient; onBack: () => void }) {
  const [flows, setFlows] = useState<PipelineInfo[]>([]);
  const [detail, setDetail] = useState<{ flow: PipelineInfo; runs: PipelineRunInfo[] } | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    try {
      setFlows((await client.pipelines()).pipelines);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (flow: PipelineInfo) => {
    setDetail({ flow, runs: [] });
    try {
      setDetail({ flow, runs: (await client.pipelineRuns(flow.id, 10)).runs });
    } catch (err: any) {
      notify('历史加载失败', err?.message ?? '');
    }
  };

  const refresh = async (flowId: string) => {
    const list = (await client.pipelines()).pipelines;
    setFlows(list);
    const fresh = list.find((item) => item.id === flowId);
    if (fresh && detail?.flow.id === flowId) await open(fresh);
  };

  const runFlow = async (flow: PipelineInfo) => {
    // 手机端一按就是真实写入与外发请求，必须确认后再跑。
    if (!(await confirmAction('运行数据流', `立即运行「${flow.name}」？目标端会真实写入数据。`, '运行'))) return;
    setBusyId(flow.id);
    try {
      const { run: result } = await client.runPipeline(flow.id);
      notify(
        result.status === 'ok' ? '运行完成' : '运行失败',
        result.status === 'ok' ? translate('{0} 步 / {1} 行', [result.steps.length, result.rowsOut ?? 0]) : (result.error ?? ''),
      );
      await refresh(flow.id);
    } catch (err: any) {
      notify('运行失败', err?.message ?? '');
    } finally {
      setBusyId('');
    }
  };

  const resetBookmark = async (flow: PipelineInfo) => {
    if (!(await confirmAction('清空增量断点', '清空后下次运行会从头取数，可能重复拉取历史数据。', '清空'))) return;
    setBusyId(flow.id);
    try {
      await client.resetPipelineState(flow.id);
      notify('断点已清空', '下次运行从头取数');
      await refresh(flow.id);
    } catch (err: any) {
      notify('清空失败', err?.message ?? '');
    } finally {
      setBusyId('');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-pipelines-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>数据流处理</Text>
          <Text style={styles.listMeta}>{translate('{0} 条流水线', [flows.length])}</Text>
        </View>
        <Pressable testID="m-pipelines-refresh" style={styles.iconButton} onPress={() => void load()}><RefreshCw size={16} color={colors.text} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {flows.map((flow) => (
          <Pressable key={flow.id} testID={`m-pipeline-${flow.id}`} style={styles.rowCard} onPress={() => void open(flow)}>
            <Text style={styles.listTitle}>{flow.name}</Text>
            <Text style={styles.listMeta} numberOfLines={2}>{flowChain(flow.spec.steps)}</Text>
            <Text style={styles.listMeta}>
              {[
                flowStatusText(flow.lastStatus),
                flow.lastRunAt ? timeAgo(flow.lastRunAt) : '',
                Object.keys(flow.state ?? {}).length ? translate('已记住断点') : '',
              ].filter(Boolean).join(' · ')}
            </Text>
            {flow.lastError ? <Text style={styles.error} numberOfLines={2}>{flow.lastError}</Text> : null}
          </Pressable>
        ))}
        {!flows.length ? <Text style={styles.hint}>还没有数据流。请到桌面端 工具箱 → 数据流处理 创建，这里可以看步骤、立即运行和查历史。</Text> : null}
      </ScrollView>
      {detail ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDetail(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{detail.flow.name}</Text>
                <Pressable testID="m-pipeline-close" style={styles.iconButton} onPress={() => setDetail(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
                {detail.flow.description ? <Text style={styles.listMeta}>{detail.flow.description}</Text> : null}
                <Text style={styles.sectionLabel}>步骤</Text>
                {detail.flow.spec.steps.map((step, index) => (
                  <View key={step.id} style={styles.listRow}>
                    <Text style={[styles.modeChipText, { minWidth: 18, textAlign: 'center' }]}>{index + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{step.label || stepTypeLabel(step.type)}</Text>
                      {stepBrief(step) ? <Text style={styles.sqlSnippet} numberOfLines={1}>{stepBrief(step)}</Text> : null}
                    </View>
                  </View>
                ))}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Pressable
                    testID="m-pipeline-run"
                    style={[styles.modeChip, busyId === detail.flow.id && { opacity: 0.5 }]}
                    disabled={busyId === detail.flow.id}
                    onPress={() => void runFlow(detail.flow)}
                  >
                    <Text style={styles.modeChipText}>{busyId === detail.flow.id ? '运行中…' : '立即运行'}</Text>
                  </Pressable>
                  <Pressable style={styles.modeChip} disabled={busyId === detail.flow.id} onPress={() => void resetBookmark(detail.flow)}>
                    <Text style={styles.modeChipText}>清空断点</Text>
                  </Pressable>
                </View>
                <Text style={styles.sectionLabel}>运行历史</Text>
                {detail.runs.map((run) => (
                  <View key={run.id} style={styles.rowCard}>
                    <Text style={styles.listTitle}>
                      {`${flowStatusText(run.status)} · ${new Date(run.startedAt).toLocaleString()}`}
                    </Text>
                    <Text style={styles.listMeta} numberOfLines={3}>{runChain(run)}</Text>
                    {run.error ? <Text style={styles.error} numberOfLines={3}>{run.error}</Text> : null}
                  </View>
                ))}
                {!detail.runs.length ? <Text style={styles.hint}>还没有运行记录。</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
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
      const started = await client.startCommand(command.id, input as any, { title: `${translate(command.title.zh)} · ${translate('移动端')}` });
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

function ToolsScreen({
  connection,
  database,
  tables,
  onOpen,
}: {
  connection?: ConnectionConfig;
  database?: string;
  tables: TableInfo[];
  onOpen: (page: 'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users') => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeading icon={<Wrench size={16} color={colors.accent} />} title="工具箱" subtitle="当前库的数据库工具" />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>当前上下文</Text>
          <Text style={[styles.settingValue, { marginTop: 4 }]}>
            {connection?.name ?? '未选择连接'}
            {database ? ` / ${database}` : ''}
          </Text>
          <Text style={styles.listMeta}>
            {connection?.engine ?? '未连接'} · {tables.length} 个对象
          </Text>
        </View>
        <Text style={styles.sectionLabel}>数据工具</Text>
        {[
          { page: 'query' as const, label: 'SQL 查询', desc: '执行 SQL、导出、保存到仪表板', icon: <TerminalSquare size={15} color={colors.accent} /> },
          { page: 'table' as const, label: '表结构', desc: '列 / 索引 / 加列 / 重命名 / 清空', icon: <Table2 size={15} color={colors.accent} /> },
          { page: 'io' as const, label: '导入 / 导出', desc: 'CSV 导入；CSV / JSON / XML / SQL / XLSX 导出', icon: <Database size={15} color={colors.accent} /> },
          { page: 'backups' as const, label: '备份', desc: '创建与恢复 SQL 备份', icon: <History size={15} color={colors.accent} /> },
          { page: 'dashboards' as const, label: '仪表板', desc: '刷新卡片、查看趋势、删除卡片', icon: <BarChart3 size={15} color={colors.accent} /> },
          { page: 'pipelines' as const, label: '数据流处理', desc: '查看步骤、立即运行、看运行历史', icon: <Workflow size={15} color={colors.accent} /> },
          { page: 'search' as const, label: '数据库搜索', desc: '按对象与数据全文查找', icon: <Search size={15} color={colors.accent} /> },
          { page: 'dictionary' as const, label: '数据字典', desc: 'Markdown 结构说明', icon: <Database size={15} color={colors.accent} /> },
          { page: 'monitor' as const, label: '服务器监控', desc: '指标与会话概览', icon: <Gauge size={15} color={colors.accent} /> },
          { page: 'history' as const, label: '查询历史', desc: '搜索、收藏、回填 SQL', icon: <History size={15} color={colors.accent} /> },
          { page: 'audit' as const, label: '审计日志', desc: '谁在什么时候改了什么', icon: <ShieldAlert size={15} color={colors.accent} /> },
          { page: 'artifacts' as const, label: '报告与产物', desc: '报告/对比结果与导出', icon: <FileCode2 size={15} color={colors.accent} /> },
          { page: 'users' as const, label: '用户与权限', desc: '账户列表、创建、授权与删除', icon: <Users size={15} color={colors.accent} /> },
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
      </ScrollView>
    </View>
  );
}

function MeScreen({
  boot,
  config,
  connections,
  activeConnection,
  memories,
  connected,
  themeMode,
  locale,
  onOpen,
}: {
  boot: BootstrapData | null;
  config: BridgeConfig;
  connections: ConnectionConfig[];
  activeConnection?: ConnectionConfig;
  memories: Memory[];
  connected: boolean;
  themeMode: 'dark' | 'light' | 'system';
  locale: Locale;
  onOpen: (page: 'memory' | 'connections' | 'settings') => void;
}) {
  const entries = [
    { page: 'memory' as const, icon: <Brain size={17} color={colors.agent} />, title: '记忆', desc: translate('{0} 条 · 跨会话召回', [memories.length]) },
    { page: 'connections' as const, icon: <Database size={17} color={colors.accent} />, title: '连接', desc: translate('{0} 个 · 当前 {1}', [connections.length, activeConnection?.name ?? translate('未选择')]) },
    { page: 'settings' as const, icon: <SettingsIcon size={17} color={colors.accent} />, title: '设置', desc: 'Bridge、设备、扩展、主题与语言' },
  ];
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeading icon={<User size={16} color={colors.accent} />} title="我的" subtitle="记忆、连接与设置" />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>BRIDGE</Text>
          <Text style={[styles.settingValue, { marginTop: 4 }]}>{config.baseUrl}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <View style={[styles.statusDot, { backgroundColor: connected ? colors.success : colors.warning }]} />
            <Text style={styles.listMeta}>{connected ? 'WebSocket 已连接' : '正在重连'} · v{boot?.version ?? '0.0.4'}</Text>
          </View>
        </View>
        {entries.map((entry) => (
          <Pressable key={entry.page} testID={`m-me-${entry.page}`} style={styles.listRow} onPress={() => onOpen(entry.page)}>
            {entry.icon}
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{entry.title}</Text>
              <Text style={styles.listMeta} numberOfLines={1}>{entry.desc}</Text>
            </View>
            <ChevronRight size={14} color={colors.muted} />
          </Pressable>
        ))}
        <View style={styles.noteCard}>
          <ShieldAlert size={14} color={colors.muted} />
          <Text style={styles.hint}>{translate('主题：{0} · 语言：{1}', [themeMode === 'system' ? translate('跟随系统') : themeMode === 'light' ? translate('浅色') : translate('深色'), localeInfo(locale).native])}</Text>
        </View>
      </ScrollView>
    </View>
  );
}

function BottomTabs({ tab, setTab, busy, bottom }: { tab: TabKey; setTab: (tab: TabKey) => void; busy: boolean; bottom: number }) {
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: 'chat', label: '对话', icon: <Sparkles size={17} color={tab === 'chat' ? colors.agent : colors.muted} /> },
    { key: 'data', label: '数据', icon: <Table2 size={17} color={tab === 'data' ? colors.accent : colors.muted} /> },
    { key: 'tools', label: '工具', icon: <Wrench size={17} color={tab === 'tools' ? colors.accent : colors.muted} /> },
    { key: 'me', label: '我的', icon: <User size={17} color={tab === 'me' ? colors.accent : colors.muted} /> },
  ];
  return (
    <View style={[styles.bottomTabs, { paddingBottom: Math.max(bottom, 6) }]}>
      {tabs.map((item) => (
        <Pressable key={item.key} testID={`m-tab-${item.key}`} style={styles.bottomTab} onPress={() => setTab(item.key)}>
          <View>
            {item.icon}
            {item.key === 'chat' && busy ? <View style={styles.busyDot} /> : null}
          </View>
          <Text style={[styles.bottomLabel, tab === item.key && { color: item.key === 'chat' ? colors.agent : colors.accent }]}>{item.label}</Text>
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

function ExecutionSection({ count, running, children }: { count: number; running?: boolean; children: React.ReactNode }) {
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? Boolean(running);
  return (
    <View style={styles.execution}>
      <Pressable testID="m-execution-section" style={styles.executionHead} onPress={() => setManual(!open)}>
        <Text style={styles.executionTitle}>{open ? '▾' : '▸'} 执行过程</Text>
        <Text style={styles.executionCount}>{count} 次工具调用</Text>
      </Pressable>
      {open ? <View style={styles.executionBody}>{children}</View> : null}
    </View>
  );
}

function chartOf(result?: ToolResult): ChartShape | undefined {
  const data = result?.data as Record<string, any> | undefined;
  return (data?.chart as ChartShape | undefined) ?? undefined;
}

function AssistantMessage({ message }: { message: AgentMessage }) {
  const results = new Map<string, ToolResult>();
  for (const block of message.blocks) if (block.type === 'tool_result' && block.callId) results.set(block.callId, block.result as ToolResult);
  const thinking = message.blocks.find((b) => b.type === 'thinking')?.text;
  const tools = message.blocks.filter((b) => b.type === 'tool_call').length;
  // 模型每更新一次计划都会追加一个 plan block；只渲染最后一份，避免旧计划卡堆叠。
  const latestPlan = [...message.blocks].reverse().find((block) => block.type === 'plan');
  const hasExecution = Boolean(thinking) || tools > 0 || Boolean(latestPlan);
  const charts = message.blocks
    .filter((block) => block.type === 'tool_result')
    .map((block, index) => ({ key: block.callId ?? String(index), chart: chartOf(block.result as ToolResult | undefined) }))
    .filter((item): item is { key: string; chart: ChartShape } => Boolean(item.chart));
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', gap: 7, alignItems: 'center' }}>
        <View style={styles.agentAvatar}><Sparkles size={10} color={colors.agent} /></View>
        <Text style={styles.listMeta}>AiDB Agent</Text>
      </View>
      <View style={{ paddingLeft: 26, gap: 10 }}>
        {hasExecution ? (
          <ExecutionSection count={tools} running={false}>
            {thinking ? <ThinkingBlock text={thinking} /> : null}
            {message.blocks.map((block, index) => {
              if (block.type !== 'tool_call') return null;
              const result = block.callId ? results.get(block.callId) : undefined;
              return (
                <MobileToolCard
                  key={`${message.id}_${block.callId ?? index}`}
                  tool={block.tool ?? 'tool'}
                  args={block.args}
                  risk={block.risk}
                  status={result ? (result.ok ? 'ok' : 'error') : 'error'}
                  result={result}
                  showChart={!chartOf(result)}
                />
              );
            })}
            {latestPlan ? <PlanCard items={latestPlan.items ?? []} /> : null}
          </ExecutionSection>
        ) : null}
        {message.content ? <Markdown text={message.content} /> : null}
        {charts.map((item) => (
          <MobileChart key={`${message.id}_chart_${item.key}`} chart={item.chart} />
        ))}
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
  sql?: string;
  series?: Array<{ label: string; value: number }>;
  extraSeries?: Array<{ name: string; values: number[] }>;
  stacked?: boolean;
  dualAxis?: boolean;
  scatter?: Array<{ x: number; y: number; label?: string }>;
  heatmap?: { xLabels: string[]; yLabels: string[]; values: number[][]; valueLabel?: string };
  forecast?: Array<{ label: string; value: number; lower: number; upper: number }>;
  note?: string;
}

const CHART_COLORS = chartPalette;

const CHART_TYPES: Array<{ value: ChartKind; label: string; icon: typeof BarChart3 }> = [
  { value: 'bar', label: '柱状', icon: BarChart3 },
  { value: 'stacked', label: '堆叠', icon: Layers },
  { value: 'line', label: '折线', icon: LineChart },
  { value: 'pie', label: '饼图', icon: PieChart },
  { value: 'scatter', label: '散点', icon: ScatterChart },
  { value: 'heatmap', label: '热力', icon: Grid3x3 },
  { value: 'radar', label: '雷达', icon: Radar },
];

const normalizeChartType = (value?: string): ChartKind =>
  value && CHART_TYPES.some((item) => item.value === value) ? (value as ChartKind) : 'bar';

const chartCharWidth = (char: string, size: number): number =>
  /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(char) ? size : size * 0.56;

const chartLabelWidth = (text: string, size: number): number =>
  Array.from(text).reduce((sum, char) => sum + chartCharWidth(char, size), 0);

const CHART_DATE_LABEL = /^\d{4}[-/]\d{1,2}([-/]\d{1,2})?[日号]?$/;

/** 日期轴永不截断；其余标签按可用像素宽度裁切，避免旋转后互相压字。 */
const fitChartLabel = (label: string, maxWidth: number): string => {
  if (!Number.isFinite(maxWidth) || CHART_DATE_LABEL.test(label) || chartLabelWidth(label, 8) <= maxWidth) return label;
  let used = 0;
  let kept = '';
  for (const char of label) {
    const width = chartCharWidth(char, 8);
    if (used + width > maxWidth - 4) break;
    used += width;
    kept += char;
  }
  return kept ? `${kept}…` : label.slice(0, 1);
};

const compactNumber = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${+(value / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${+(value / 1e4).toFixed(1)}万`;
  if (abs >= 1e3) return `${+(value / 1e3).toFixed(1)}k`;
  if (Number.isInteger(value)) return String(value);
  return String(+value.toFixed(2));
};

interface ChartSelection {
  label: string;
  index?: number;
  entries: Array<{ name: string; value: string; color: string }>;
}

const formatMetric = (value: number): string =>
  Number.isFinite(value) && !Number.isInteger(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : Number(value).toLocaleString();

function MobileChart({ chart }: { chart: ChartShape }) {
  const [selection, setSelection] = React.useState<ChartSelection | null>(null);
  const [type, setType] = React.useState<ChartKind>(() => normalizeChartType(chart.type));
  const fit = React.useMemo(
    () => chartSuitability({ series: chart.series, extraSeries: chart.extraSeries, scatter: chart.scatter, heatmap: chart.heatmap, forecast: chart.forecast }),
    [chart],
  );
  const W = 320;
  const H = 168;
  const padLeft = 38;
  const padRight = 8;
  const padTop = 10;
  const innerW = W - padLeft - padRight;
  const palette = CHART_COLORS;
  const toggleSelection = (next: ChartSelection) => {
    setSelection((prev) => (prev && prev.label === next.label && prev.index === next.index ? null : next));
  };
  const history = (chart.series ?? []).slice(0, 24);
  const valuesOf = (list: Array<{ value: number }>) => list.map((point) => Number(point.value) || 0);
  const columns = [
    { name: chart.yLabel || '值', values: valuesOf(history), color: palette[0] },
    ...(chart.extraSeries ?? [])
      .filter((extra) => Array.isArray(extra.values) && extra.values.length >= history.length && history.length > 0)
      .slice(0, 4)
      .map((extra, index) => ({ name: extra.name, values: extra.values.slice(0, history.length).map((value) => Number(value) || 0), color: palette[(index + 1) % palette.length] })),
  ];
  const isBar = type === 'bar' || type === 'stacked';
  const stacked = isBar && columns.length > 1 && (type === 'stacked' || chart.stacked === true);
  const dual = isBar && chart.dualAxis === true && columns.length > 1 && !stacked;
  const forecast = type === 'line' ? (chart.forecast ?? []).slice(0, 12) : [];
  const labels = [...history.map((point) => String(point.label)), ...forecast.map((point) => String(point.label))];
  const primary = columns[0]?.values ?? [];

  // 横轴标签：放不下就统一倾斜；倾斜后仍会压字时才隔几个显示。
  const labelWidths = labels.map((label) => chartLabelWidth(label, 8));
  const bandEstimate = innerW / Math.max(1, labels.length);
  const rotateLabels = labels.length > 1 && Math.max(0, ...labelWidths) > bandEstimate - 6;
  const sinAngle = Math.sin((40 * Math.PI) / 180);
  const labelStep = rotateLabels ? Math.max(1, Math.ceil(8 / Math.max(1, bandEstimate * sinAngle))) : 1;
  const padBottom = rotateLabels ? Math.min(56, Math.max(32, Math.round(12 + Math.max(0, ...labelWidths) * sinAngle))) : 22;
  const innerH = H - padTop - padBottom;

  const bounds: number[] = [...primary, ...forecast.map((point) => Number(point.value) || 0)];
  if (stacked) {
    for (let index = 0; index < primary.length; index += 1) {
      let positive = 0;
      let negative = 0;
      for (const column of columns) {
        const value = column.values[index] ?? 0;
        if (value >= 0) positive += value;
        else negative += value;
      }
      bounds.push(positive, negative);
    }
  } else if (!dual) {
    for (const column of columns.slice(1)) bounds.push(...column.values);
  }
  for (const point of forecast) bounds.push(Number(point.lower) || 0, Number(point.upper) || 0);

  const hi = Math.max(1, ...bounds);
  const lo = Math.min(0, ...bounds);
  const span = hi - lo || 1;
  const y = (value: number) => padTop + innerH - ((value - lo) / span) * innerH;
  const secondary = dual ? columns[1].values : [];
  const hi2 = Math.max(1, ...secondary);
  const lo2 = Math.min(0, ...secondary);
  const y2 = (value: number) => padTop + innerH - ((value - lo2) / (hi2 - lo2 || 1)) * innerH;

  const count = Math.max(1, labels.length);
  const band = innerW / count;
  const x = (index: number) => padLeft + band * (index + 0.5);
  const selectedIndex = selection?.index ?? -1;
  const selectAt = (index: number, series: Array<{ name: string; values: number[]; color: string }>) => {
    toggleSelection({
      index,
      label: String(labels[index] ?? ''),
      entries: series.map((column) => ({ name: column.name, value: formatMetric(column.values[index] ?? 0), color: column.color })),
    });
  };
  const hitBands = (onPressAt: (index: number) => void) =>
    labels.map((_, index) => (
      <Rect
        key={`hit-${index}`}
        x={padLeft + index * band}
        y={padTop}
        width={band}
        height={innerH}
        fill={colors.text}
        fillOpacity={0.001}
        onPress={() => onPressAt(index)}
      />
    ));

  const grid = (
    <>
      {[0, 0.5, 1].map((ratio) => {
        const gy = padTop + innerH * ratio;
        return (
          <React.Fragment key={ratio}>
            <Line x1={padLeft} y1={gy} x2={W - padRight} y2={gy} stroke={colors.border} strokeWidth={1} />
            <SvgText x={padLeft - 4} y={gy + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(hi - span * ratio)}</SvgText>
          </React.Fragment>
        );
      })}
    </>
  );
  const axisLabels = labels.length ? (
    <>
      {labels.map((label, index) => {
        if (index % labelStep !== 0) return null;
        const labelX = x(index);
        const labelY = H - 4 - (rotateLabels ? Math.max(0, ...labelWidths) * sinAngle : 0);
        const room = rotateLabels ? (padBottom - 14) / sinAngle : band - 4;
        return (
          <SvgText
            key={`ax-${index}`}
            x={labelX}
            y={labelY}
            fill={colors.muted}
            fontSize={8}
            textAnchor={rotateLabels ? 'end' : 'middle'}
            transform={rotateLabels ? `rotate(-40 ${labelX} ${labelY})` : undefined}
          >
            {fitChartLabel(String(label), room)}
          </SvgText>
        );
      })}
    </>
  ) : null;

  let body: React.ReactNode = null;
  let legend: Array<{ label: string; value?: number; color: string }> = [];
  let caption = '';
  let empty = false;

  if (type === 'pie') {
    if (!history.length) {
      empty = true;
    } else {
      const total = history.reduce((sum, point) => sum + Math.max(0, Number(point.value) || 0), 0) || 1;
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2 - 12;
      let angle = -Math.PI / 2;
      body = history.map((point, index) => {
        const value = Math.max(0, Number(point.value) || 0);
        const slice = (value / total) * Math.PI * 2;
        const end = angle + slice;
        const large = slice > Math.PI ? 1 : 0;
        const x1 = cx + r * Math.cos(angle);
        const y1 = cy + r * Math.sin(angle);
        const x2 = cx + r * Math.cos(end);
        const y2 = cy + r * Math.sin(end);
        const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
        const fill = palette[index % palette.length];
        const active = selection?.index === index;
        angle = end;
        return (
          <Path
            key={`${point.label}-${index}`}
            d={path}
            fill={fill}
            fillOpacity={selection && !active ? 0.45 : 1}
            stroke={active ? colors.text : colors.panel}
            strokeWidth={active ? 1.6 : 1}
            onPress={() => toggleSelection({
              index,
              label: String(point.label),
              entries: [
                { name: '值', value: formatMetric(Number(point.value) || 0), color: fill },
                { name: '占比', value: `${((value / total) * 100).toFixed(1)}%`, color: fill },
              ],
            })}
          />
        );
      });
      legend = history.slice(0, 8).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
    }
  } else if (type === 'heatmap') {
    if (!chart.heatmap || !chart.heatmap.values.length) {
      empty = true;
    } else {
      const { xLabels, yLabels, values, valueLabel } = chart.heatmap;
      const flat = values.flat().map((value) => Number(value) || 0);
      const heatMax = Math.max(1, ...flat);
      const heatMin = Math.min(0, ...flat);
      const cellW = (innerW - 2) / Math.max(1, xLabels.length);
      const cellH = innerH / Math.max(1, yLabels.length);
      body = values.slice(0, yLabels.length).map((row, rowIndex) =>
        row.slice(0, xLabels.length).map((value, columnIndex) => {
          const numeric = Number(value) || 0;
          const fill = heatTone((numeric - heatMin) / (heatMax - heatMin || 1));
          const label = `${yLabels[rowIndex] ?? ''} · ${xLabels[columnIndex] ?? ''}`;
          const active = selection?.label === label;
          return (
            <Rect
              key={`${columnIndex}-${rowIndex}`}
              x={padLeft + columnIndex * cellW}
              y={padTop + rowIndex * cellH}
              width={Math.max(1, cellW - 2)}
              height={Math.max(1, cellH - 2)}
              rx={2}
              fill={fill}
              stroke={active ? colors.text : 'transparent'}
              strokeWidth={active ? 1.4 : 0}
              onPress={() => toggleSelection({ label, entries: [{ name: valueLabel || '值', value: formatMetric(numeric), color: fill }] })}
            />
          );
        }),
      );
      const xTicks = Array.from(new Set([0, Math.floor(xLabels.length / 2), xLabels.length - 1]));
      body = (
        <>
          {body}
          {yLabels.slice(0, 8).map((label, rowIndex) => (
            <SvgText key={`yl-${rowIndex}`} x={padLeft - 4} y={padTop + rowIndex * cellH + cellH / 2 + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">
              {String(label).slice(0, 4)}
            </SvgText>
          ))}
          {xTicks.map((columnIndex) => (
            <SvgText key={`xl-${columnIndex}`} x={padLeft + columnIndex * cellW + cellW / 2} y={H - 5} fill={colors.muted} fontSize={7.5} textAnchor="middle">
              {String(xLabels[columnIndex] ?? '').slice(0, 5)}
            </SvgText>
          ))}
        </>
      );
      caption = `${valueLabel || '值'}：${compactNumber(heatMin)} → ${compactNumber(heatMax)}`;
    }
  } else if (type === 'scatter') {
    const points = chart.scatter?.length
      ? chart.scatter
      : history.map((point, index) => {
          const numeric = Number(point.label);
          return { x: Number.isFinite(numeric) ? numeric : index + 1, y: Number(point.value) || 0, label: String(point.label) };
        });
    if (!points.length) {
      empty = true;
    } else {
      const xs = points.map((point) => Number(point.x) || 0);
      const ys = points.map((point) => Number(point.y) || 0);
      const xHi = Math.max(1, ...xs);
      const xLo = Math.min(0, ...xs);
      const yHi = Math.max(1, ...ys);
      const yLo = Math.min(0, ...ys);
      const px = (value: number) => padLeft + ((value - xLo) / (xHi - xLo || 1)) * innerW;
      const py = (value: number) => padTop + innerH - ((value - yLo) / (yHi - yLo || 1)) * innerH;
      const pointLabel = (point: { x: number; y: number; label?: string }) =>
        point.label && String(point.label).trim() ? String(point.label) : `(${Number(point.x) || 0}, ${Number(point.y) || 0})`;
      const selectPoint = (point: { x: number; y: number; label?: string }) =>
        toggleSelection({
          label: pointLabel(point),
          entries: [
            { name: chart.xLabel || 'x', value: formatMetric(Number(point.x) || 0), color: palette[0] },
            { name: chart.yLabel || 'y', value: formatMetric(Number(point.y) || 0), color: palette[0] },
          ],
        });
      body = (
        <>
          <Line x1={padLeft} y1={padTop + innerH} x2={W - padRight} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} />
          <Line x1={padLeft} y1={padTop} x2={padLeft} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} />
          {points.slice(0, 180).map((point, index) => {
            const active = selection?.label === pointLabel(point);
            return (
              <Circle
                key={`dot-${index}`}
                cx={px(Number(point.x) || 0)}
                cy={py(Number(point.y) || 0)}
                r={active ? 4.6 : 2.6}
                fill={palette[0]}
                fillOpacity={active ? 1 : 0.72}
                stroke={active ? colors.text : 'transparent'}
                strokeWidth={active ? 1.2 : 0}
              />
            );
          })}
          <SvgText x={padLeft - 4} y={padTop + 4} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(yHi)}</SvgText>
          <SvgText x={padLeft - 4} y={padTop + innerH + 3} fill={colors.muted} fontSize={7.5} textAnchor="end">{compactNumber(yLo)}</SvgText>
          <SvgText x={W - padRight} y={H - 5} fill={colors.muted} fontSize={8} textAnchor="end">{chart.xLabel ?? 'x'}</SvgText>
          {points.slice(0, 180).map((point, index) => (
            <Circle
              key={`hit-${index}`}
              cx={px(Number(point.x) || 0)}
              cy={py(Number(point.y) || 0)}
              r={9}
              fill={colors.text}
              fillOpacity={0.001}
              onPress={() => selectPoint(point)}
            />
          ))}
        </>
      );
    }
  } else if (type === 'radar') {
    if (history.length < 3) {
      empty = true;
    } else {
      const cx = W / 2;
      const cy = H / 2;
      const r = Math.min(W, H) / 2 - 22;
      const angleAt = (index: number) => -Math.PI / 2 + (index / history.length) * Math.PI * 2;
      const vertexAt = (index: number, value: number) => {
        const radius = (Math.max(0, value) / hi) * r;
        const angle = angleAt(index);
        return { cx: cx + radius * Math.cos(angle), cy: cy + radius * Math.sin(angle) };
      };
      const primaryVertices = history.map((point, index) => vertexAt(index, Number(point.value) || 0));
      body = (
        <>
          {[0.33, 0.66, 1].map((ratio) => (
            <Circle key={ratio} cx={cx} cy={cy} r={r * ratio} fill="none" stroke={colors.border} strokeWidth={1} />
          ))}
          {columns.map((column) => (
            <Polyline
              key={column.name}
              points={column.values.map((value, index) => { const vertex = vertexAt(index, value); return `${vertex.cx},${vertex.cy}`; }).join(' ')}
              fill={column.color}
              fillOpacity={0.12}
              stroke={column.color}
              strokeWidth={2}
            />
          ))}
          {history.map((point, index) => {
            const angle = angleAt(index);
            const labelX = cx + (r + 12) * Math.cos(angle);
            const labelY = cy + (r + 12) * Math.sin(angle) + 3;
            const anchor = Math.cos(angle) > 0.25 ? 'start' : Math.cos(angle) < -0.25 ? 'end' : 'middle';
            return (
              <SvgText key={`rl-${index}`} x={labelX} y={labelY} fill={colors.muted} fontSize={7.5} textAnchor={anchor}>
                {String(point.label).slice(0, 5)}
              </SvgText>
            );
          })}
          {primaryVertices.map((vertex, index) => (
            <Circle
              key={`hit-${index}`}
              cx={vertex.cx}
              cy={vertex.cy}
              r={9}
              fill={colors.text}
              fillOpacity={0.001}
              onPress={() => selectAt(index, columns)}
            />
          ))}
          {selectedIndex >= 0 ? columns.map((column) => {
            if (selectedIndex >= column.values.length) return null;
            const vertex = vertexAt(selectedIndex, column.values[selectedIndex]);
            return <Circle key={`sel-${column.name}`} cx={vertex.cx} cy={vertex.cy} r={3.4} fill={column.color} stroke={colors.text} strokeWidth={1} />;
          }) : null}
        </>
      );
      legend = columns.length > 1
        ? columns.map((column) => ({ label: column.name, color: column.color }))
        : history.slice(0, 5).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
    }
  } else if (!history.length) {
    empty = true;
  } else if (type === 'line') {
    const lineFor = (values: number[], scale: (value: number) => number, color: string) => (
      <>
        <Polyline points={values.map((value, index) => `${x(index)},${scale(value)}`).join(' ')} fill="none" stroke={color} strokeWidth={2} />
        {values.length <= 12 ? values.map((value, index) => <Circle key={index} cx={x(index)} cy={scale(value)} r={2.2} fill={color} />) : null}
      </>
    );
    const anchor = primary.length ? { x: x(primary.length - 1), y: y(primary[primary.length - 1]) } : null;
    const forecastPath = forecast.map((point, index) => `${index === 0 && anchor ? `M ${anchor.x} ${anchor.y} L` : index === 0 ? 'M' : 'L'} ${x(primary.length + index)} ${y(Number(point.value) || 0)}`).join(' ');
    const bandPath = forecast.length
      ? [
          ...forecast.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(primary.length + index)} ${y(Number(point.upper) || 0)}`),
          ...[...forecast].reverse().map((point, index) => `L ${x(primary.length + forecast.length - 1 - index)} ${y(Number(point.lower) || 0)}`),
          'Z',
        ].join(' ')
      : '';
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Line x1={x(selectedIndex)} y1={padTop} x2={x(selectedIndex)} y2={padTop + innerH} stroke={colors.borderStrong} strokeWidth={1} /> : null}
        {columns.map((column, index) => <React.Fragment key={column.name}>{lineFor(column.values, dual && index === 1 ? y2 : y, column.color)}</React.Fragment>)}
        {bandPath ? <Path d={bandPath} fill={palette[1]} fillOpacity={0.13} /> : null}
        {forecastPath ? <Path d={forecastPath} fill="none" stroke={palette[1]} strokeWidth={2} strokeDasharray="4 3" /> : null}
        {selectedIndex >= 0 ? columns.map((column, columnIndex) => (
          selectedIndex < column.values.length ? (
            <Circle
              key={`sel-${column.name}`}
              cx={x(selectedIndex)}
              cy={(dual && columnIndex === 1 ? y2 : y)(column.values[selectedIndex])}
              r={3.8}
              fill={column.color}
              stroke={colors.panel}
              strokeWidth={1.5}
            />
          ) : null
        )) : null}
        {axisLabels}
        {hitBands((index) => {
          if (index < history.length) {
            selectAt(index, columns);
            return;
          }
          const point = forecast[index - history.length];
          toggleSelection({
            index,
            label: String(labels[index] ?? ''),
            entries: [
              { name: '预测', value: formatMetric(Number(point?.value) || 0), color: palette[1] },
              { name: '区间', value: `${formatMetric(Number(point?.lower) || 0)} ~ ${formatMetric(Number(point?.upper) || 0)}`, color: palette[1] },
            ],
          });
        })}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
    if (forecast.length) legend = [...legend, { label: '预测', color: palette[1] }];
  } else if (dual) {
    const barW = Math.min(band * 0.5, 30);
    const path = secondary.map((value, index) => `${x(index)},${y2(value)}`).join(' ');
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {primary.map((value, index) => {
          const top = y(Math.max(value, 0));
          const bottom = y(Math.min(value, 0));
          return <Rect key={index} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={2.5} fill={palette[0]} fillOpacity={0.9} />;
        })}
        <Polyline points={path} fill="none" stroke={palette[1]} strokeWidth={2} />
        {secondary.map((value, index) => <Circle key={index} cx={x(index)} cy={y2(value)} r={2.2} fill={palette[1]} />)}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = [
      { label: columns[0].name, color: palette[0] },
      { label: `${columns[1].name}（右轴）`, color: palette[1] },
    ];
  } else if (stacked) {
    const barW = Math.min(band * 0.62, 34);
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => {
          let positive = 0;
          let negative = 0;
          return (
            <React.Fragment key={`${point.label}-${index}`}>
              {columns.map((column) => {
                const value = column.values[index] ?? 0;
                const base = value >= 0 ? positive : negative;
                const end = base + value;
                if (value >= 0) positive = end;
                else negative = end;
                const top = y(Math.max(base, end));
                const bottom = y(Math.min(base, end));
                return <Rect key={column.name} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={1.5} fill={column.color} fillOpacity={0.92} />;
              })}
            </React.Fragment>
          );
        })}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
  } else if (columns.length > 1) {
    const groupW = band * 0.78;
    const barW = groupW / columns.length;
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => (
          <React.Fragment key={`${point.label}-${index}`}>
            {columns.map((column, columnIndex) => {
              const value = column.values[index] ?? 0;
              const top = y(Math.max(value, 0));
              const bottom = y(Math.min(value, 0));
              return (
                <Rect
                  key={column.name}
                  x={x(index) - groupW / 2 + columnIndex * barW}
                  y={top}
                  width={Math.max(1, barW - 2)}
                  height={Math.max(1, bottom - top)}
                  rx={2}
                  fill={column.color}
                  fillOpacity={0.92}
                />
              );
            })}
          </React.Fragment>
        ))}
        {axisLabels}
        {hitBands((index) => selectAt(index, columns))}
      </>
    );
    legend = columns.map((column) => ({ label: column.name, color: column.color }));
  } else {
    const barW = Math.min(band * 0.62, 34);
    body = (
      <>
        {grid}
        {selectedIndex >= 0 ? <Rect x={padLeft + selectedIndex * band} y={padTop} width={band} height={innerH} fill={palette[0]} fillOpacity={0.07} /> : null}
        {history.map((point, index) => {
          const value = Number(point.value) || 0;
          const top = y(Math.max(value, 0));
          const bottom = y(Math.min(value, 0));
          return <Rect key={`${point.label}-${index}`} x={x(index) - barW / 2} y={top} width={barW} height={Math.max(1, bottom - top)} rx={2.5} fill={palette[index % palette.length]} fillOpacity={0.92} />;
        })}
        {axisLabels}
        {hitBands((index) => selectAt(index, [{ ...columns[0], color: palette[index % palette.length] }]))}
      </>
    );
    legend = history.slice(0, 6).map((point, index) => ({ label: String(point.label), value: Number(point.value) || 0, color: palette[index % palette.length] }));
  }

  const axisHint = [chart.xLabel, chart.yLabel].filter(Boolean).join(' × ');
  const hasData = history.length > 0 || Boolean(chart.heatmap?.values.length) || Boolean(chart.scatter?.length);
  return (
    <View style={{ marginTop: 7, gap: 5 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
        <Text style={styles.chartTitle} numberOfLines={2}>{chart.title ?? '图表'}</Text>
        {axisHint ? <Text style={styles.chartAxisHint} numberOfLines={1}>{axisHint}</Text> : null}
      </View>
      {hasData ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 3 }}>
          {CHART_TYPES.map((item) => {
            const active = item.value === type;
            const blocked = !active && fit[item.value]?.ok === false;
            return (
              <Pressable
                key={item.value}
                testID={`m-chart-type-${item.value}`}
                disabled={blocked}
                accessibilityLabel={item.label}
                accessibilityState={{ selected: active, disabled: blocked }}
                style={[styles.chartTypeChip, active && styles.chartTypeChipActive, blocked && styles.chartTypeChipBlocked]}
                onPress={() => {
                  setType(item.value);
                  setSelection(null);
                }}
              >
                <item.icon size={10} color={active ? colors.accent : blocked ? colors.muted : colors.secondary} />
                <Text style={[styles.chartTypeText, active && styles.chartTypeTextActive]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {empty ? (
        <View style={styles.chartEmpty}><Text style={styles.listMeta}>没有可绘制的数据点（结果集为空或全为 NULL）</Text></View>
      ) : (
        <View style={styles.chartCard}>
          <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
            <Rect x={0} y={0} width={W} height={H} fill={colors.text} fillOpacity={0.001} onPress={() => setSelection(null)} />
            {body}
          </Svg>
          {selection ? (
            <View
              testID="m-chart-tooltip"
              pointerEvents="none"
              style={[styles.chartTooltip, selection.index !== undefined && selection.index < labels.length / 2 ? { right: 6 } : { left: 6 }]}
            >
              <Text style={styles.chartTooltipLabel} numberOfLines={1}>{selection.label}</Text>
              {selection.entries.map((entry, index) => (
                <View key={`${entry.name}-${index}`} style={styles.chartTooltipRow}>
                  <View style={[styles.chartTooltipDot, { backgroundColor: entry.color }]} />
                  <Text style={styles.chartTooltipName} numberOfLines={1}>{entry.name}</Text>
                  <Text style={styles.chartTooltipValue} numberOfLines={1}>{entry.value}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      )}
      {caption ? <Text style={styles.chartNote}>{caption}</Text> : null}
      {legend.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {legend.map((item, index) => (
            <View key={`${item.label}-${index}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
              <View style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: item.color }} />
              <Text style={styles.listMeta} numberOfLines={1}>{item.label}{item.value !== undefined ? ` · ${item.value.toLocaleString()}` : ''}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {chart.note ? <Text style={styles.chartNote}>{chart.note}</Text> : null}
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
  showChart = true,
}: {
  tool: string;
  args: unknown;
  risk?: Risk;
  status: LiveTool['status'];
  result?: ToolResult;
  summary?: string;
  showChart?: boolean;
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
              {chart && showChart ? <MobileChart chart={chart as ChartShape} /> : null}
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

type MdAlign = 'left' | 'center' | 'right';

type MdBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; start: number; items: Array<{ depth: number; text: string }> }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; code: string }
  | { kind: 'hr' }
  | { kind: 'table'; header: string[]; align: MdAlign[]; rows: string[][] };

const MD_HEADING = /^(#{1,6})\s+(.*)$/;
const MD_HR = /^(?:-{3,}|\*{3,}|_{3,})$/;
const MD_LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

const mdTableRow = (line: string): string[] => {
  let content = line.trim();
  if (content.startsWith('|')) content = content.slice(1);
  if (content.endsWith('|')) content = content.slice(0, -1);
  return content.split('|').map((cell) => cell.trim());
};

const mdTableSeparator = (line: string): boolean => {
  if (!line.includes('|')) return false;
  const cells = mdTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s/g, '')));
};

const mdTableAlign = (line: string): MdAlign[] =>
  mdTableRow(line).map((cell) => {
    const token = cell.replace(/\s/g, '');
    if (token.startsWith(':') && token.endsWith(':')) return 'center';
    return token.endsWith(':') ? 'right' : 'left';
  });

const mdIsBlockStart = (lines: string[], index: number): boolean => {
  const trimmed = lines[index]?.trim() ?? '';
  if (!trimmed) return true;
  if (/^```/.test(trimmed) || MD_HEADING.test(trimmed) || MD_HR.test(trimmed)) return true;
  if (trimmed.startsWith('>') || MD_LIST.test(lines[index] ?? '')) return true;
  return trimmed.includes('|') && index + 1 < lines.length && mdTableSeparator(lines[index + 1]);
};

const mdJoinLines = (lines: string[]): string =>
  lines.reduce((acc, line) => {
    if (!acc) return line;
    const glued = /[\u2e80-\u9fff\u3000-\u303f]$/.test(acc) || /^[\u2e80-\u9fff\u3000-\u303f]/.test(line);
    return acc + (glued ? '' : ' ') + line;
  }, '');

function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) {
      index += 1;
      continue;
    }

    if (/^```/.test(trimmed)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'code', code: code.join('\n') });
      continue;
    }

    const heading = MD_HEADING.exec(trimmed);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }

    if (MD_HR.test(trimmed)) {
      blocks.push({ kind: 'hr' });
      index += 1;
      continue;
    }

    if (trimmed.includes('|') && index + 1 < lines.length && mdTableSeparator(lines[index + 1])) {
      const header = mdTableRow(trimmed);
      const align = mdTableAlign(lines[index + 1]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        rows.push(mdTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ kind: 'table', header, align, rows });
      continue;
    }

    if (trimmed.startsWith('>')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('>')) {
        quote.push(lines[index].trim().replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push({ kind: 'quote', text: mdJoinLines(quote) });
      continue;
    }

    if (MD_LIST.test(line)) {
      const ordered = /\d/.test(MD_LIST.exec(line)![2]);
      const start = ordered ? parseInt(MD_LIST.exec(line)![2], 10) || 1 : 1;
      const items: Array<{ depth: number; text: string }> = [];
      while (index < lines.length) {
        const match = MD_LIST.exec(lines[index]);
        if (!match) break;
        const indent = match[1].replace(/\t/g, '  ').length;
        items.push({ depth: Math.min(3, Math.floor(indent / 2)), text: match[3].trim() });
        index += 1;
        while (index < lines.length && lines[index].trim() && !MD_LIST.test(lines[index]) && !mdIsBlockStart(lines, index) && /^\s{2,}/.test(lines[index])) {
          items[items.length - 1].text += ' ' + lines[index].trim();
          index += 1;
        }
      }
      blocks.push({ kind: 'list', ordered, start, items });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && (paragraph.length === 0 || !mdIsBlockStart(lines, index))) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: mdJoinLines(paragraph) });
  }
  return blocks;
}

const MD_INLINE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`\n]+`|~~[^~\n]+~~|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g;

function Inline({ text, style }: { text: string; style?: any }) {
  const parts = text.split(MD_INLINE).filter(Boolean);
  return (
    <Text style={[styles.mdText, style]}>
      {parts.map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) return <Text key={index} style={styles.mdBold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('__') && part.endsWith('__')) return <Text key={index} style={styles.mdBold}>{part.slice(2, -2)}</Text>;
        if (part.startsWith('`') && part.endsWith('`')) return <Text key={index} style={styles.mdCode}>{part.slice(1, -1)}</Text>;
        if (part.startsWith('~~') && part.endsWith('~~')) return <Text key={index} style={styles.mdStrike}>{part.slice(2, -2)}</Text>;
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
        if (link) {
          return (
            <Text key={index} style={styles.mdLink} onPress={() => void Linking.openURL(link[2])}>
              {link[1]}
            </Text>
          );
        }
        if (part.startsWith('*') && part.endsWith('*') && part.length > 2) return <Text key={index} style={styles.mdItalic}>{part.slice(1, -1)}</Text>;
        return <Text key={index}>{part}</Text>;
      })}
    </Text>
  );
}

const mdTextWidth = (value: string): number =>
  Array.from(value).reduce((sum, char) => sum + (/[\u2e80-\u9fff\uf900-\ufaff\uff00-\uff60]/.test(char) ? 10.5 : 6), 0);

function MarkdownTable({ header, align, rows }: { header: string[]; align: MdAlign[]; rows: string[][] }) {
  const columns = Math.max(header.length, ...rows.map((row) => row.length), 1);
  const cellAt = (row: string[], column: number) => row[column] ?? '';
  const numeric = Array.from({ length: columns }, (_, column) =>
    rows.some((row) => cellAt(row, column).trim() !== '') &&
    rows.every((row) => cellAt(row, column).trim() === '' || /^(?:[—–-]|[-+¥$€]?[\d,]+(\.\d+)?%?)$/.test(cellAt(row, column).trim())),
  );
  const widths = Array.from({ length: columns }, (_, column) => {
    const widest = Math.max(...[header[column] ?? '', ...rows.map((row) => cellAt(row, column))].map(mdTextWidth), 2);
    return Math.max(62, Math.min(210, Math.round(widest + 16)));
  });
  const cellStyle = (column: number, lastRow = false) => [
    styles.mdTableCell,
    column === columns - 1 && styles.mdTableCellLast,
    lastRow && styles.mdTableCellLastRow,
    { width: widths[column], alignItems: numeric[column] || align[column] === 'right' ? 'flex-end' : align[column] === 'center' ? 'center' : 'flex-start' } as any,
  ];
  return (
    <View style={styles.mdTableWrap}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View>
          <View style={[styles.mdTableRow, styles.mdTableHeadRow]}>
            {Array.from({ length: columns }, (_, column) => (
              <View key={column} style={cellStyle(column)}>
                <Inline text={cellAt(header, column)} style={styles.mdTableHeadText} />
              </View>
            ))}
          </View>
          {rows.map((row, rowIndex) => (
            <View key={rowIndex} style={[styles.mdTableRow, rowIndex % 2 === 1 && { backgroundColor: colors.elevated }]}>
              {Array.from({ length: columns }, (_, column) => (
                <View key={column} style={cellStyle(column, rowIndex === rows.length - 1)}>
                  <Inline text={cellAt(row, column)} style={styles.mdTableCellText} />
                </View>
              ))}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View style={{ gap: 7 }}>
      {blocks.map((block, index) => {
        switch (block.kind) {
          case 'heading': {
            const style = block.level === 1 ? styles.mdH1 : block.level === 2 ? styles.mdH2 : block.level === 3 ? styles.mdH3 : styles.mdH4;
            return <Inline key={index} text={block.text} style={style} />;
          }
          case 'paragraph':
            return <Inline key={index} text={block.text} style={styles.mdParagraph} />;
          case 'list':
            return (
              <View key={index} style={{ gap: 3 }}>
                {block.items.map((item, itemIndex) => (
                  <View key={itemIndex} style={[styles.mdListRow, { paddingLeft: item.depth * 14 }]}>
                    <Text style={styles.mdListMarker}>{block.ordered ? `${block.start + itemIndex}.` : '•'}</Text>
                    <Inline text={item.text} style={styles.mdListText} />
                  </View>
                ))}
              </View>
            );
          case 'quote':
            return (
              <View key={index} style={styles.mdQuoteBlock}>
                <Inline text={block.text} style={styles.mdQuoteText} />
              </View>
            );
          case 'code':
            return (
              <View key={index} style={styles.codeBlock}>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.codeText}>{block.code.trim()}</Text>
                </ScrollView>
              </View>
            );
          case 'hr':
            return <View key={index} style={styles.mdHr} />;
          case 'table':
            return <MarkdownTable key={index} header={block.header} align={block.align} rows={block.rows} />;
          default:
            return null;
        }
      })}
    </View>
  );
}

/** AI 回答统一行高；React Native 的 lineHeight 只能给数值，这里按字号乘 1.6 计算。 */
const MD_LINE_HEIGHT = 1.6;
const mdLine = (fontSize: number) => fontSize * MD_LINE_HEIGHT;

const makeStyles = () => StyleSheet.create({
  splash: { flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' },
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
  primaryButtonText: { color: colors.onSolid, fontWeight: '700', fontSize: 13 },
  secondaryButton: { height: 40, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderStrong, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panel },
  secondaryButtonText: { color: colors.secondary, fontSize: 12.5 },
  paleButton: { height: 40, borderRadius: radius.md, backgroundColor: colors.elevated, alignItems: 'center', justifyContent: 'center' },
  paleButtonText: { color: colors.text, fontSize: 12.5 },
  primarySmall: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: colors.agent, paddingHorizontal: 9, height: 26, borderRadius: 7 },
  primarySmallText: { color: colors.onSolid, fontSize: 11, fontWeight: '600' },
  segment: { flexDirection: 'row', backgroundColor: colors.elevated, borderRadius: radius.md, padding: 3, marginTop: 10, marginBottom: 6 },
  segmentItem: { flex: 1, height: 30, alignItems: 'center', justifyContent: 'center', borderRadius: 7 },
  segmentActive: { backgroundColor: colors.bg },
  segmentText: { color: colors.muted, fontSize: 12 },
  segmentTextActive: { color: colors.text, fontWeight: '600' },
  pairNotes: { flexDirection: 'row', gap: 6, alignItems: 'flex-start', marginTop: 18, paddingHorizontal: 6 },
  pairNoteText: { flex: 1, color: colors.muted, fontSize: 10.5, lineHeight: 16 },

  app: { flex: 1, backgroundColor: colors.bg },
  topSafe: { backgroundColor: colors.chrome },
  topbar: { height: 52, backgroundColor: colors.chrome, borderBottomWidth: 1, borderBottomColor: colors.border, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 8 },
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

  mdText: { color: colors.secondary, fontSize: 12.5, lineHeight: mdLine(12.5) },
  mdParagraph: { color: colors.secondary, fontSize: 12.5, lineHeight: mdLine(12.5) },
  mdH1: { color: colors.text, fontSize: 16, lineHeight: mdLine(16), fontWeight: '700', marginTop: 2 },
  mdH2: { color: colors.text, fontSize: 14.5, lineHeight: mdLine(14.5), fontWeight: '700', marginTop: 2 },
  mdH3: { color: colors.text, fontSize: 13.5, lineHeight: mdLine(13.5), fontWeight: '600', marginTop: 1 },
  mdH4: { color: colors.text, fontSize: 12.5, lineHeight: mdLine(12.5), fontWeight: '600' },
  mdBold: { color: colors.text, fontWeight: '700' },
  mdItalic: { fontStyle: 'italic' },
  mdStrike: { textDecorationLine: 'line-through', color: colors.muted },
  mdLink: { color: colors.accent, textDecorationLine: 'underline' },
  mdCode: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', color: colors.text, fontSize: 11 },
  mdListRow: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  mdListMarker: { color: colors.muted, fontSize: 11, lineHeight: mdLine(12.5), minWidth: 13 },
  mdListText: { flex: 1, color: colors.secondary, fontSize: 12.5, lineHeight: mdLine(12.5) },
  mdQuoteBlock: { borderLeftWidth: 2, borderLeftColor: colors.agent, backgroundColor: colors.agentSoft, borderRadius: 6, paddingVertical: 6, paddingHorizontal: 9 },
  mdQuoteText: { color: colors.secondary, fontSize: 12, lineHeight: mdLine(12) },
  mdHr: { height: 1, backgroundColor: colors.border, marginVertical: 3 },
  mdTableWrap: { marginVertical: 2, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, overflow: 'hidden' },
  mdTableRow: { flexDirection: 'row', alignItems: 'stretch' },
  mdTableHeadRow: { backgroundColor: colors.elevated },
  mdTableCell: { paddingHorizontal: 7, paddingVertical: 5, borderBottomWidth: 1, borderRightWidth: 1, borderColor: colors.border },
  mdTableCellLast: { borderRightWidth: 0 },
  mdTableCellLastRow: { borderBottomWidth: 0 },
  mdTableHeadText: { color: colors.secondary, fontSize: 10, lineHeight: mdLine(10), fontWeight: '600' },
  mdTableCellText: { color: colors.text, fontSize: 10.5, lineHeight: mdLine(10.5) },
  codeBlock: { backgroundColor: colors.code, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 9 },
  codeText: { color: colors.secondary, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10.5, lineHeight: mdLine(10.5) },
  memoryPill: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, maxWidth: '70%' },
  memoryPillText: { color: colors.muted, fontSize: 9.5 },
  loadingRow: { flexDirection: 'row', gap: 6, alignItems: 'center' },
  turnEnd: { color: colors.muted, fontSize: 9.5, textAlign: 'center', marginTop: 4 },

  thinking: { borderWidth: 1, borderStyle: 'dashed', borderColor: colors.borderStrong, borderRadius: radius.sm, padding: 8, backgroundColor: colors.panel },
  jumpWrap: { position: 'absolute', left: 0, right: 0, bottom: 12, alignItems: 'center' },
  jumpButton: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 30, paddingHorizontal: 12, borderRadius: 999, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.elevated, shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 4 },
  jumpText: { color: colors.secondary, fontSize: 10.5 },
  execution: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, backgroundColor: colors.panel, overflow: 'hidden' },
  executionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 9, paddingVertical: 7 },
  executionTitle: { color: colors.muted, fontSize: 10.5, flex: 1 },
  executionCount: { color: colors.muted, fontSize: 9.5 },
  executionBody: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8, gap: 7 },
  toolCard: { borderWidth: 1, borderColor: colors.border, borderLeftWidth: 2, borderLeftColor: colors.agent, borderRadius: radius.sm, backgroundColor: colors.panel },
  toolHead: { flexDirection: 'row', alignItems: 'center', gap: 6, padding: 8 },
  toolName: { color: colors.text, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 11, fontWeight: '600' },
  toolSummary: { color: colors.muted, fontSize: 9.5, flex: 1 },
  riskBadgeText: { fontSize: 8, fontWeight: '700' },
  toolBody: { borderTopWidth: 1, borderTopColor: colors.border, padding: 8, gap: 3 },
  toolLabel: { color: colors.muted, fontSize: 8.5, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: 4 },
  chartTitle: { color: colors.text, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  chartAxisHint: { color: colors.muted, fontSize: 9, flexShrink: 1 },
  chartTypeChip: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 24, paddingHorizontal: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel },
  chartTypeChipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chartTypeChipBlocked: { opacity: 0.45 },
  chartTypeText: { color: colors.secondary, fontSize: 9.5 },
  chartTypeTextActive: { color: colors.accent, fontWeight: '600' },
  chartCard: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.panel, padding: 4 },
  chartTooltip: { position: 'absolute', top: 6, minWidth: 96, maxWidth: '72%', backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, paddingHorizontal: 7, paddingVertical: 5, gap: 3, shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 6, shadowOffset: { width: 0, height: 2 }, elevation: 4 },
  chartTooltipLabel: { color: colors.text, fontSize: 9.5, fontWeight: '600' },
  chartTooltipRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  chartTooltipDot: { width: 6, height: 6, borderRadius: 2 },
  chartTooltipName: { color: colors.muted, fontSize: 9, flexShrink: 1 },
  chartTooltipValue: { color: colors.text, fontSize: 9.5, fontWeight: '600', marginLeft: 'auto' },
  chartEmpty: { borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.panel, padding: 12 },
  chartNote: { color: colors.muted, fontSize: 9, lineHeight: 14 },
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
  inputBox: { gap: 3, backgroundColor: colors.elevated, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: radius.lg, paddingHorizontal: 6, paddingTop: 3, paddingBottom: 4 },
  chatInput: { width: '100%', minHeight: 38, maxHeight: 120, color: colors.text, fontSize: 13, lineHeight: 19, paddingTop: 7, paddingBottom: 4, paddingHorizontal: 5 },
  inputToolbar: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  inputTool: { width: 30, height: 30, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sendButton: { width: 32, height: 32, borderRadius: 9, backgroundColor: colors.agent, alignItems: 'center', justifyContent: 'center' },
  composerHint: { color: colors.muted, fontSize: 9, marginTop: 5, marginBottom: 6, textAlign: 'center' },

  screenHeading: { flexDirection: 'row', alignItems: 'center', gap: 9, paddingHorizontal: 14, height: 52, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  screenTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  dataToolbar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  dataChip: { flexDirection: 'row', alignItems: 'center', gap: 5, height: 32, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.elevated, paddingHorizontal: 9 },
  dataChipText: { flex: 1, color: colors.secondary, fontSize: 11.5 },
  dataViewBar: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 7, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.panel },
  viewSwitch: { flexDirection: 'row', backgroundColor: colors.elevated, borderRadius: radius.sm, padding: 2 },
  viewSwitchItem: { paddingHorizontal: 12, height: 26, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  viewSwitchActive: { backgroundColor: colors.panel },
  viewSwitchText: { color: colors.muted, fontSize: 11 },
  viewSwitchTextActive: { color: colors.text, fontWeight: '600' },
  gridHeaderRow: { flexDirection: 'row', alignItems: 'center', height: 32, backgroundColor: colors.elevated, borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  gridHeadCell: { color: colors.muted, fontSize: 9.5, fontWeight: '600', paddingHorizontal: 8 },
  gridRow: { flexDirection: 'row', alignItems: 'center', minHeight: 34, backgroundColor: colors.panel, borderBottomWidth: 1, borderBottomColor: colors.border },
  gridCell: { color: colors.secondary, fontSize: 11, paddingHorizontal: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  gridIndexCell: { color: colors.muted, fontSize: 9.5, paddingLeft: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  gridActionCell: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  gridActionButton: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  schemaHeaderRow: { flexDirection: 'row', alignItems: 'center', height: 30, backgroundColor: colors.elevated, borderBottomWidth: 1, borderBottomColor: colors.borderStrong },
  schemaRow: { flexDirection: 'row', alignItems: 'center', minHeight: 32, borderBottomWidth: 1, borderBottomColor: colors.border },
  schemaHeadCell: { color: colors.muted, fontSize: 9.5, fontWeight: '600', paddingHorizontal: 8 },
  schemaCell: { color: colors.secondary, fontSize: 10.5, paddingHorizontal: 8, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  schemaActionCell: { alignItems: 'flex-start', paddingLeft: 6 },
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

  bottomTabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.chrome, paddingTop: 6 },
  bottomTab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2, paddingBottom: 2 },
  bottomLabel: { color: colors.muted, fontSize: 9 },
  busyDot: { position: 'absolute', right: -3, top: -1, width: 5, height: 5, borderRadius: 3, backgroundColor: colors.agent },

  modalBackdrop: { flex: 1, backgroundColor: colors.overlay, justifyContent: 'flex-end' },
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

