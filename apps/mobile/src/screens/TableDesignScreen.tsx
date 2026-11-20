import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, X } from 'lucide-react-native';
import { type ConnectionConfig, type TableInfo } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, quoteIdent, confirmAction } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function TableDesignScreen({
  client,
  connection,
  database,
  tables,
  initialTable,
  onBack,
}: {
  client: BridgeClient;
  connection?: ConnectionConfig;
  database?: string;
  tables: TableInfo[];
  initialTable?: string;
  onBack: () => void;
}) {
  const [tableName, setTableName] = useState(initialTable ?? tables[0]?.name ?? '');
  const [detail, setDetail] = useState<TableInfo | null>(null);
  const [columnName, setColumnName] = useState('');
  const [columnType, setColumnType] = useState('TEXT');
  const [indexName, setIndexName] = useState('');
  const [indexColumns, setIndexColumns] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [tableList, setTableList] = useState<TableInfo[]>(tables);
  const [createOpen, setCreateOpen] = useState(false);
  const [newTable, setNewTable] = useState<{ name: string; columns: Array<{ name: string; type: string; pk: boolean }> }>({ name: '', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: '', type: 'TEXT', pk: false }] });
  const load = async () => {
    if (!connection || !tableName) return;
    try {
      const result = await client.schema(connection.id, database);
      const all = result.schemas.flatMap((schema) => schema.tables);
      setTableList(all.length ? all : tables);
      const found = all.find((item) => item.name === tableName);
      setDetail(found ?? null);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableName, connection?.id, database]);
  const exec = async (sql: string, successText: string) => {
    if (!connection) return;
    setBusy(true);
    try {
      await client.execDdl(connection.id, sql, database);
      notify('完成', successText);
      setColumnName('');
      setIndexName('');
      setIndexColumns('');
      await load();
    } catch (err: any) {
      notify('执行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  const tableOp = async (op: string, extra: Record<string, unknown> = {}) => {
    if (!connection) return;
    try {
      await client.tableOp(connection.id, tableName, op, extra, database);
      notify('完成', op === 'rename' ? '已重命名' : op === 'truncate' ? '已清空' : '操作完成');
      if (op === 'drop') onBack();
      else await load();
    } catch (err: any) {
      notify('操作失败', err?.message ?? '');
    }
  };
  const engine = connection?.engine ?? 'sqlite';
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-table-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>表结构</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable testID="m-table-create" style={styles.primarySmall} onPress={() => setCreateOpen(true)}>
          <Text style={styles.primarySmallText}>新建表</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {tableList.map((item) => (
            <Pressable key={item.name} style={[styles.modeChip, tableName === item.name && styles.modeChipActive]} onPress={() => setTableName(item.name)}>
              <Text style={[styles.modeChipText, tableName === item.name && { color: colors.accent }]}>{item.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {detail ? (
          <>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>列（{detail.columns?.length ?? 0}）</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View>
                  <View style={styles.schemaHeaderRow}>
                    <Text style={[styles.schemaHeadCell, { width: 112 }]}>列名</Text>
                    <Text style={[styles.schemaHeadCell, { width: 124 }]}>类型</Text>
                    <Text style={[styles.schemaHeadCell, { width: 34 }]}>键</Text>
                    <Text style={[styles.schemaHeadCell, { width: 44 }]}>可空</Text>
                    <Text style={[styles.schemaHeadCell, { width: 120 }]}>默认值</Text>
                  </View>
                  {(detail.columns ?? []).map((column) => (
                    <View key={column.name} style={styles.schemaRow}>
                      <Text style={[styles.schemaCell, { width: 112, color: colors.text }]} numberOfLines={1}>{column.name}</Text>
                      <Text style={[styles.schemaCell, { width: 124 }]} numberOfLines={1}>{column.type}</Text>
                      <Text style={[styles.schemaCell, { width: 34 }, column.primaryKey && { color: colors.accent, fontWeight: '600' }]}>{column.primaryKey ? 'PK' : '—'}</Text>
                      <Text style={[styles.schemaCell, { width: 44 }]}>{column.nullable ? 'YES' : 'NO'}</Text>
                      <Text style={[styles.schemaCell, { width: 120 }]} numberOfLines={1}>{column.defaultValue === null || column.defaultValue === undefined ? '—' : String(column.defaultValue)}</Text>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>索引（{detail.indexes?.length ?? 0}）</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator>
                <View>
                  <View style={styles.schemaHeaderRow}>
                    <Text style={[styles.schemaHeadCell, { width: 140 }]}>名称</Text>
                    <Text style={[styles.schemaHeadCell, { width: 110 }]}>列</Text>
                    <Text style={[styles.schemaHeadCell, { width: 40 }]}>唯一</Text>
                    <Text style={[styles.schemaHeadCell, { width: 50 }]}>操作</Text>
                  </View>
                  {(detail.indexes ?? []).map((index) => (
                    <View key={index.name} style={styles.schemaRow}>
                      <Text style={[styles.schemaCell, { width: 140, color: colors.text }]} numberOfLines={1}>{index.name}</Text>
                      <Text style={[styles.schemaCell, { width: 110 }]} numberOfLines={1}>{index.columns.join(', ')}</Text>
                      <Text style={[styles.schemaCell, { width: 40 }]}>{index.unique ? 'YES' : '—'}</Text>
                      <View style={[styles.schemaActionCell, { width: 50 }]}>
                        <Pressable
                          style={styles.modeChip}
                          onPress={async () => {
                            if (!(await confirmAction('删除索引', index.name, '删除'))) return;
                            await exec(`DROP INDEX ${quoteIdent(index.name, engine)}`, '索引已删除');
                          }}
                        >
                          <Text style={styles.modeChipText}>删除</Text>
                        </Pressable>
                      </View>
                    </View>
                  ))}
                </View>
              </ScrollView>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>加列</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <TextInput testID="m-new-column" style={[styles.input, { flex: 1 }]} value={columnName} onChangeText={setColumnName} placeholder="列名" placeholderTextColor={colors.muted} />
                <TextInput testID="m-new-column-type" style={[styles.input, { width: 100 }]} value={columnType} onChangeText={setColumnType} placeholder="TEXT" autoCapitalize="characters" placeholderTextColor={colors.muted} />
              </View>
              <Pressable
                testID="m-add-column"
                style={[styles.primaryButton, (busy || !columnName.trim()) && { opacity: 0.5 }]}
                disabled={busy || !columnName.trim()}
                onPress={() => void exec(`ALTER TABLE ${quoteIdent(tableName, engine)} ADD COLUMN ${quoteIdent(columnName.trim(), engine)} ${columnType.trim() || 'TEXT'}`, '列已添加')}
              >
                <Text style={styles.primaryButtonText}>添加列</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>加索引</Text>
              <TextInput testID="m-new-index" style={styles.input} value={indexName} onChangeText={setIndexName} placeholder="索引名，如 ix_orders_status" autoCapitalize="none" placeholderTextColor={colors.muted} />
              <TextInput testID="m-new-index-cols" style={[styles.input, { marginTop: 8 }]} value={indexColumns} onChangeText={setIndexColumns} placeholder="列名，英文逗号分隔" autoCapitalize="none" placeholderTextColor={colors.muted} />
              <Pressable
                testID="m-add-index"
                style={[styles.primaryButton, (busy || !indexName.trim() || !indexColumns.trim()) && { opacity: 0.5 }]}
                disabled={busy || !indexName.trim() || !indexColumns.trim()}
                onPress={() => void exec(`CREATE INDEX ${quoteIdent(indexName.trim(), engine)} ON ${quoteIdent(tableName, engine)} (${indexColumns.split(',').map((item) => quoteIdent(item.trim(), engine)).join(', ')})`, '索引已创建')}
              >
                <Text style={styles.primaryButtonText}>创建索引</Text>
              </Pressable>
            </View>
            <View style={styles.card}>
              <Text style={styles.sectionLabel}>表操作</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                <Pressable
                  testID="m-table-rename"
                  style={styles.modeChip}
                  onPress={() => {
                    setRenameValue(tableName);
                    setRenameOpen(true);
                  }}
                >
                  <Text style={styles.modeChipText}>重命名</Text>
                </Pressable>
                <Pressable style={styles.modeChip} onPress={async () => { if (await confirmAction('清空表', `${tableName} 的数据会被全部删除`, '清空')) await tableOp('truncate'); }}>
                  <Text style={styles.modeChipText}>清空数据</Text>
                </Pressable>
                <Pressable style={styles.modeChip} onPress={async () => { if (await confirmAction('删除表', `${tableName} 将被永久删除`, '删除')) await tableOp('drop'); }}>
                  <Text style={[styles.modeChipText, { color: colors.danger }]}>删除表</Text>
                </Pressable>
              </View>
            </View>
          </>
        ) : <Text style={styles.hint}>选择一张表查看结构。</Text>}
      </ScrollView>
      <Modal visible={createOpen} transparent animationType="slide" onRequestClose={() => setCreateOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { maxHeight: '86%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>新建表</Text>
              <Pressable style={styles.iconButton} onPress={() => setCreateOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
              <TextInput testID="m-new-table-name" style={styles.input} value={newTable.name} onChangeText={(name) => setNewTable({ ...newTable, name })} placeholder="表名" autoCapitalize="none" placeholderTextColor={colors.muted} />
              {newTable.columns.map((column, index) => (
                <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    value={column.name}
                    onChangeText={(name) => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, name } : item)) })}
                    placeholder="列名"
                    autoCapitalize="none"
                    placeholderTextColor={colors.muted}
                  />
                  <TextInput
                    style={[styles.input, { width: 88 }]}
                    value={column.type}
                    onChangeText={(type) => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, type } : item)) })}
                    placeholder="TEXT"
                    autoCapitalize="characters"
                    placeholderTextColor={colors.muted}
                  />
                  <Pressable
                    style={[styles.modeChip, column.pk && styles.modeChipActive]}
                    onPress={() => setNewTable({ ...newTable, columns: newTable.columns.map((item, i) => (i === index ? { ...item, pk: !item.pk } : item)) })}
                  >
                    <Text style={[styles.modeChipText, column.pk && { color: colors.accent }]}>PK</Text>
                  </Pressable>
                  <Pressable hitSlop={8} onPress={() => setNewTable({ ...newTable, columns: newTable.columns.filter((_, i) => i !== index) })}>
                    <X size={14} color={colors.muted} />
                  </Pressable>
                </View>
              ))}
              <Pressable style={styles.modeChip} onPress={() => setNewTable({ ...newTable, columns: [...newTable.columns, { name: '', type: 'TEXT', pk: false }] })}>
                <Text style={styles.modeChipText}>+ 添加列</Text>
              </Pressable>
              <Pressable
                testID="m-create-table-save"
                style={[styles.primaryButton, (!newTable.name.trim() || !newTable.columns.some((column) => column.name.trim())) && { opacity: 0.5 }]}
                disabled={!newTable.name.trim() || !newTable.columns.some((column) => column.name.trim())}
                onPress={async () => {
                  if (!connection) return;
                  const name = newTable.name.trim();
                  const columns = newTable.columns.filter((column) => column.name.trim());
                  const pk = columns.filter((column) => column.pk);
                  const defs = columns.map((column) => `${quoteIdent(column.name.trim(), engine)} ${column.type.trim() || 'TEXT'}`.trim());
                  if (pk.length) defs.push(`PRIMARY KEY (${pk.map((column) => quoteIdent(column.name.trim(), engine)).join(', ')})`);
                  setBusy(true);
                  try {
                    await client.execDdl(connection.id, `CREATE TABLE ${quoteIdent(name, engine)} (${defs.join(', ')})`, database);
                    notify('已创建', `表 ${name} 已创建`);
                    setCreateOpen(false);
                    setTableName(name);
                    setNewTable({ name: '', columns: [{ name: 'id', type: 'INTEGER', pk: true }, { name: '', type: 'TEXT', pk: false }] });
                    await load();
                  } catch (err: any) {
                    notify('创建失败', err?.message ?? '');
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Text style={styles.primaryButtonText}>{busy ? '创建中…' : '创建表'}</Text>
              </Pressable>
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal visible={renameOpen} transparent animationType="fade" onRequestClose={() => setRenameOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>重命名表</Text>
              <Pressable style={styles.iconButton} onPress={() => setRenameOpen(false)}><X size={16} color={colors.text} /></Pressable>
            </View>
            <View style={{ padding: 14, gap: 10 }}>
              <TextInput testID="m-rename-table-input" style={styles.input} value={renameValue} onChangeText={setRenameValue} autoCapitalize="none" />
              <Pressable
                testID="m-rename-table-save"
                style={styles.primaryButton}
                onPress={async () => {
                  const next = renameValue.trim();
                  if (!next || next === tableName) return;
                  setRenameOpen(false);
                  await tableOp('rename', { newName: next });
                  setTableName(next);
                }}
              >
                <Text style={styles.primaryButtonText}>保存</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

