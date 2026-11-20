import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, Search } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function HistoryScreen({ client, connection, onBack, onPick }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void; onPick: (sql: string) => void }) {
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

