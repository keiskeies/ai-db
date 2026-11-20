import { useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, Database, Search } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function SearchScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
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

