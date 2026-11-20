import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text } from '../components/base';

export function MonitorScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
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

