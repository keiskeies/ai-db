import { Pressable, ScrollView, View } from 'react-native';
import { Brain, ChevronRight, Database, ShieldAlert, User, Settings as SettingsIcon } from 'lucide-react-native';
import { localeInfo, type ConnectionConfig, type Memory } from '@aidb/core';
import { type BootstrapData, type BridgeConfig } from '../bridge';
import { colors } from '../theme';
import { translate, type Locale } from '../i18n';
import { styles } from '../styles';
import { Text, ScreenHeading } from '../components/base';

export function MeScreen({
  boot,
  config,
  connections,
  activeConnection,
  memories,
  connected,
  themeMode,
  locale,
  canManageHost,
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
  canManageHost: boolean;
  onOpen: (page: 'memory' | 'connections' | 'settings') => void;
}) {
  const entries = [
    { page: 'memory' as const, icon: <Brain size={17} color={colors.agent} />, title: '记忆', desc: translate('{0} 条 · 跨会话召回', [memories.length]) },
    { page: 'connections' as const, icon: <Database size={17} color={colors.accent} />, title: '连接', desc: translate('{0} 个 · 当前 {1}', [connections.length, activeConnection?.name ?? translate('未选择')]) },
    { page: 'settings' as const, icon: <SettingsIcon size={17} color={colors.accent} />, title: '设置', desc: canManageHost ? translate('Bridge、设备、扩展、主题与语言') : translate('Bridge、主题与语言') },
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
            <Text style={styles.listMeta}>{connected ? 'WebSocket 已连接' : '正在重连'} · v{boot?.version ?? '0.0.11'}</Text>
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

