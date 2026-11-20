import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, humanBytes, confirmAction } from '../lib/utils';
import { Text } from '../components/base';

export function BackupScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
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

