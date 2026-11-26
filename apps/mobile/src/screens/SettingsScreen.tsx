import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { type PermissionMode } from '@aidb/core';
import { BridgeClient, type BootstrapData, type BridgeConfig } from '../bridge';
import { colors, type ThemeResolved } from '../theme';
import { LOCALES, translate, type Locale } from '../i18n';
import { styles } from '../styles';
import { notify, confirmAction } from '../lib/utils';
import { Text } from '../components/base';
import { PermissionSelect } from '../components/PermissionSelect';

export function SettingsScreen({
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
  canManageHost,
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
  canManageHost: boolean;
}) {
  const [skills, setSkills] = useState<Array<{ id: string; name: string; description: string; enabled: boolean; builtin?: boolean }>>([]);
  const [mcps, setMcps] = useState<Array<{ id: string; name: string; command: string; enabled: boolean; builtin?: boolean }>>([]);
  const [devices, setDevices] = useState<Array<{ id: string; name: string; platform: string; pairedAt: string; revoked: boolean }>>([]);
  useEffect(() => {
    if (!canManageHost) return;
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
  }, [canManageHost]);
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
            <Text style={styles.listMeta}>v{boot?.version ?? '0.0.10'}</Text>
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionLabel}>AGENT</Text>
          <Text style={styles.settingValue}>{boot?.settings.agent.provider === 'local' ? 'Local（离线）' : boot?.settings.agent.model}</Text>
          <Text style={styles.listMeta}>{boot?.tools.length ?? 18} 个工具 · 四层记忆 · {boot?.sessions.length ?? 0} 个会话</Text>
        </View>

        {canManageHost ? (
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
        ) : null}

        <View style={styles.card}>
          <Text style={[styles.sectionLabel, { marginTop: 12 }]}>默认权限</Text>
          <View style={{ flexDirection: 'row', marginTop: 6 }}>
            <PermissionSelect mode={mode} onChange={onMode} testID="m-settings-mode" modes={canManageHost ? undefined : ['readonly', 'ask']} />
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

        {canManageHost ? (
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
        ) : null}

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

        <Text style={[styles.hint, { textAlign: 'center', marginTop: 6 }]}>AiDB Studio v{boot?.version ?? '0.0.10'} · Android / iOS / Web</Text>
      </ScrollView>
    </View>
  );
}

