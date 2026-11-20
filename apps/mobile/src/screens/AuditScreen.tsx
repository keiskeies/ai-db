import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text } from '../components/base';

export function AuditScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
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

