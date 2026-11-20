import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, Switch, View } from 'react-native';
import { ChevronLeft, X } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, shareBase64 } from '../lib/utils';
import type { SqlSet } from '../types';
import { Text, TextInput } from '../components/base';

export function QueryScreen({
  client,
  connection,
  database,
  initialSql,
  onBack,
}: {
  client: BridgeClient;
  connection?: ConnectionConfig;
  database?: string;
  initialSql?: string;
  onBack: () => void;
}) {
  const [sql, setSql] = useState(initialSql ?? 'SELECT * FROM ');
  useEffect(() => {
    if (initialSql) setSql(initialSql);
  }, [initialSql]);
  const [sets, setSets] = useState<SqlSet[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [allowMulti, setAllowMulti] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveTitle, setSaveTitle] = useState('');
  const [saveType, setSaveType] = useState('bar');

  const run = async () => {
    if (!connection || !sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await client.query(connection.id, sql, database, allowMulti);
      setSets(result.batch.sets);
    } catch (err: any) {
      setError(err?.message ?? '执行失败');
      setSets([]);
    } finally {
      setBusy(false);
    }
  };

  const exportResult = async (format: 'csv' | 'json' | 'xml' | 'sql' | 'xlsx') => {
    if (!connection || !sql.trim()) return;
    try {
      const result = await client.exportInline({ connectionId: connection.id, database, sql, format, limit: 5000 });
      await shareBase64(result.content, format);
      notify('导出完成', `已生成 ${result.file.rows} 行 ${format.toUpperCase()}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    }
  };

  const saveCard = async () => {
    if (!connection || !saveTitle.trim()) return;
    try {
      await client.createDashboardCard({ connectionId: connection.id, database, title: saveTitle.trim(), sql, chartType: saveType });
      setSaveOpen(false);
      setSaveTitle('');
      notify('已保存', '已加入仪表板');
    } catch (err: any) {
      notify('保存失败', err?.message ?? '需要只读查询');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable style={styles.iconButton} onPress={onBack} testID="m-query-back">
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>SQL 查询</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable testID="m-query-run" style={[styles.primarySmall, busy && { opacity: 0.5 }]} disabled={busy || !connection} onPress={() => void run()}>
          <Text style={styles.primarySmallText}>{busy ? '执行中…' : '执行'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 12, gap: 10, paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
        <TextInput
          testID="m-query-input"
          style={styles.queryInput}
          value={sql}
          onChangeText={setSql}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="SELECT * FROM table LIMIT 100"
          placeholderTextColor={colors.muted}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <View style={styles.modeChip}>
            <Text style={styles.modeChipText}>多语句</Text>
            <Switch value={allowMulti} onValueChange={setAllowMulti} style={{ transform: [{ scale: 0.65 }] }} />
          </View>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('csv')}>
            <Text style={styles.modeChipText}>导出 CSV</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('json')}>
            <Text style={styles.modeChipText}>导出 JSON</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('xml')}>
            <Text style={styles.modeChipText}>XML</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('sql')}>
            <Text style={styles.modeChipText}>SQL</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => void exportResult('xlsx')}>
            <Text style={styles.modeChipText}>XLSX</Text>
          </Pressable>
          <Pressable style={styles.modeChip} onPress={() => setSaveOpen(true)}>
            <Text style={styles.modeChipText}>存为仪表板</Text>
          </Pressable>
        </View>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {sets.map((set, setIndex) => (
          <View key={setIndex} style={styles.resultCard}>
            <Text style={styles.listMeta}>
              {set.columns.length ? `${set.rowCount} 行 · ${set.durationMs}ms${set.truncated ? ' · 已截断' : ''}` : `影响 ${set.affected ?? 0} 行 · ${set.durationMs}ms`}
            </Text>
            {set.columns.length ? (
              <ScrollView horizontal>
                <View>
                  <View style={styles.resultRow}>
                    {set.columns.map((column) => (
                      <Text key={column.name} style={[styles.resultCell, styles.resultHead]} numberOfLines={1}>{column.name}</Text>
                    ))}
                  </View>
                  {set.rows.slice(0, 100).map((row, rowIndex) => (
                    <View key={rowIndex} style={styles.resultRow}>
                      {row.map((value, colIndex) => (
                        <Text key={colIndex} style={styles.resultCell} numberOfLines={2}>
                          {value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            ) : null}
          </View>
        ))}
        {!sets.length && !error ? <Text style={styles.hint}>写一条只读 SQL，或直接执行 UPDATE / CREATE 等语句（只读连接会被拒绝）。</Text> : null}
      </ScrollView>
      <Modal visible={saveOpen} transparent animationType="fade" onRequestClose={() => setSaveOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>保存到仪表板</Text>
              <Pressable style={styles.iconButton} onPress={() => setSaveOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <View style={{ padding: 14, gap: 10 }}>
              <TextInput testID="m-card-title" style={styles.input} value={saveTitle} onChangeText={setSaveTitle} placeholder="卡片标题" placeholderTextColor={colors.muted} />
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {(['bar', 'line', 'pie'] as const).map((type) => (
                  <Pressable key={type} style={[styles.modeChip, saveType === type && styles.modeChipActive]} onPress={() => setSaveType(type)}>
                    <Text style={[styles.modeChipText, saveType === type && { color: colors.accent }]}>{type}</Text>
                  </Pressable>
                ))}
              </View>
              <Pressable testID="m-card-save" style={styles.primaryButton} onPress={() => void saveCard()}><Text style={styles.primaryButtonText}>保存</Text></Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

