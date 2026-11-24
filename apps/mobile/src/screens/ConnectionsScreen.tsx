import type { Dispatch, SetStateAction } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { Check, ChevronLeft, ShieldAlert } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { colors } from '../theme';
import { styles } from '../styles';
import type { TabKey } from '../types';
import { Text, EngineLogo } from '../components/base';

export function ConnectionsScreen({ setMePage, refreshing, refreshAll, connections, activeConnectionId, setActiveConnectionId, setTab, activeDatabase, databases, scopeLocked }: { setMePage: Dispatch<SetStateAction<'memory' | 'connections' | 'settings' | null>>; refreshing: boolean; refreshAll: () => Promise<void>; connections: ConnectionConfig[]; activeConnectionId: string | undefined; setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>; setTab: Dispatch<SetStateAction<TabKey>>; activeDatabase: string | undefined; databases: string[]; scopeLocked: boolean; }) {
  return (
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
                  disabled={scopeLocked}
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
  );
}
