import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text } from '../components/base';

export function DictionaryScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
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

