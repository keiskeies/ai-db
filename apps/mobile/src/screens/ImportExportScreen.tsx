import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import { ChevronLeft } from 'lucide-react-native';
import { type ConnectionConfig, type TableInfo } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, shareBase64 } from '../lib/utils';
import { Text } from '../components/base';

export function ImportExportScreen({ client, connection, database, tables, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; tables: TableInfo[]; onBack: () => void }) {
  const [table, setTable] = useState('');
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  useEffect(() => {
    if (!table && tables.length) setTable(tables[0].name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.length]);
  const pickCsv = async () => {
    if (!connection || !table) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/plain', 'application/vnd.ms-excel'], copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.length) return;
      const asset = picked.assets[0];
      const csv = Platform.OS === 'web' && asset.file ? await asset.file.text() : await FileSystem.readAsStringAsync(asset.uri);
      setImporting(true);
      const result = await client.importCsv(connection.id, table, csv, database);
      setLast(`导入 ${result.result.inserted} 行，跳过 ${result.result.skipped} 行${result.result.errors.length ? `；${result.result.errors[0]}` : ''}`);
      notify('导入完成', `已写入 ${result.result.inserted} 行`);
    } catch (err: any) {
      notify('导入失败', err?.message ?? '');
    } finally {
      setImporting(false);
    }
  };
  const exportTable = async (format: 'csv' | 'json' | 'xml' | 'sql' | 'xlsx') => {
    if (!connection || !table) return;
    setExporting(true);
    try {
      const result = await client.exportInline({ connectionId: connection.id, database, table, format, limit: 10000 });
      await shareBase64(result.content, format);
      setLast(`导出 ${result.file.rows} 行 ${format.toUpperCase()}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    } finally {
      setExporting(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-io-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>导入 / 导出</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <Text style={styles.sectionLabel}>目标表</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tables.map((item) => (
            <Pressable key={item.name} style={[styles.modeChip, table === item.name && styles.modeChipActive]} onPress={() => setTable(item.name)}>
              <Text style={[styles.modeChipText, table === item.name && { color: colors.accent }]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>导入 CSV</Text>
          <Text style={styles.hint}>CSV 首行作为列名，按列名写入当前表；只读连接会被拒绝。</Text>
          <Pressable testID="m-import-csv" style={[styles.primaryButton, (importing || !table) && { opacity: 0.5 }]} disabled={importing || !table} onPress={() => void pickCsv()}>
            <Text style={styles.primaryButtonText}>{importing ? '导入中…' : '选择 CSV 文件'}</Text>
          </Pressable>
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>导出当前表</Text>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Pressable testID="m-export-csv" style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('csv')}>
              <Text style={styles.modeChipText}>CSV</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('json')}>
              <Text style={styles.modeChipText}>JSON</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('xml')}>
              <Text style={styles.modeChipText}>XML</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('sql')}>
              <Text style={styles.modeChipText}>SQL</Text>
            </Pressable>
            <Pressable style={[styles.modeChip, exporting && { opacity: 0.5 }]} disabled={exporting || !table} onPress={() => void exportTable('xlsx')}>
              <Text style={styles.modeChipText}>XLSX</Text>
            </Pressable>
          </View>
        </View>
        {last ? <Text style={styles.hint}>{last}</Text> : null}
      </ScrollView>
    </View>
  );
}

