import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Linking from 'expo-linking';
import type ZeroconfClass from 'react-native-zeroconf';
import type { Service } from 'react-native-zeroconf';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Lock, ScanLine, Search, Sparkles, X } from 'lucide-react-native';
import { parsePairingPayload } from '@aidb/core';
import { BridgeClient, claimPairing, normalizeBaseUrl, saveBridgeConfig, type BridgeConfig } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { Text, TextInput, BrandMark } from '../components/base';

export function PairScreen({ onConnected }: { onConnected: (config: BridgeConfig) => void }) {
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
      let zeroconf: ZeroconfClass | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          zeroconf?.stop();
        } catch {
          /* ignore */
        }
        try {
          zeroconf?.removeDeviceListeners();
          zeroconf?.removeAllListeners();
        } catch {
          /* ignore */
        }
        resolve(found);
      };
      const timer = setTimeout(finish, 4000);
      try {
        const NativeZeroconf = require('react-native-zeroconf').default as typeof ZeroconfClass;
        zeroconf = new NativeZeroconf();
        zeroconf.on('resolved', (service: Service) => {
          const host = service.ipv4[0] ?? service.host;
          if (!host) return;
          const entry = { url: `http://${host}:${service.port}`, version: service.txt?.version };
          if (!found.some((item) => item.url === entry.url)) found.push(entry);
        });
        zeroconf.on('error', () => finish());
        zeroconf.scan({ type: 'aidb', protocol: 'tcp', domain: 'local.' });
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

