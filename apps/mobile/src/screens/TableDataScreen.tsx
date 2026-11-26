import { useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, View, type ScrollViewInstance } from 'react-native';
import { ChevronLeft, ChevronRight, Pencil, Plus, RefreshCw, Trash2, Wrench, X } from 'lucide-react-native';
import { type ConnectionConfig, type TableInfo } from '@aidb/core';
import { BridgeClient, type DataPage } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, confirmAction } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function TableDataScreen({
  client,
  table,
  page,
  loading,
  connection,
  database,
  onBack,
  onRefresh,
  onPage,
  onDesign,
  onChanged,
}: {
  client: BridgeClient;
  table: TableInfo;
  page: DataPage | null;
  loading: boolean;
  connection?: ConnectionConfig;
  database?: string;
  onBack: () => void;
  onRefresh: () => void;
  onPage: (offset: number) => void;
  onDesign: () => void;
  onChanged: () => void;
}) {
  const result = page?.batch.sets[0];
  const limit = page?.limit ?? 50;
  const offset = page?.offset ?? 0;
  const current = Math.floor(offset / limit) + 1;
  const totalPages = Math.max(1, Math.ceil((page?.total ?? 0) / limit));
  const pkColumns = (table.columns ?? []).filter((column) => column.primaryKey).map((column) => column.name);
  const canWrite = Boolean(connection && !connection.readonly && pkColumns.length);
  const editableColumns = (table.columns ?? []).filter((column) => !column.autoIncrement && !column.generated);
  const [draft, setDraft] = useState<{ mode: 'insert' | 'edit'; original?: Record<string, unknown>; values: Record<string, string> } | null>(null);
  const [saving, setSaving] = useState(false);
  const [viewMode, setViewMode] = useState<'grid' | 'cards'>('grid');
  const [inspect, setInspect] = useState<{ row: unknown[]; index: number } | null>(null);
  const gridHeaderRef = useRef<ScrollViewInstance | null>(null);
  const gridBodyRef = useRef<ScrollViewInstance | null>(null);
  const lastGridXRef = useRef(0);

  const syncGridScroll = (x: number) => {
    if (Math.abs(x - lastGridXRef.current) < 1) return;
    lastGridXRef.current = x;
    gridHeaderRef.current?.scrollTo({ x, animated: false });
    gridBodyRef.current?.scrollTo({ x, animated: false });
  };

  const widthForColumn = (column: { name: string; type?: string; kind?: string }) => {
    const type = (column.type ?? table.columns?.find((item) => item.name === column.name)?.type ?? '').toLowerCase();
    if (column.kind === 'json' || column.kind === 'vector' || column.kind === 'geometry') return 200;
    if (/(text|json|blob|clob|xml|enum|set)/.test(type)) return 190;
    if (/(char|string)/.test(type)) return 160;
    if (/(date|time|timestamp)/.test(type)) return 150;
    if (/(bool|bit|int|double|float|decimal|numeric|number|real)/.test(type)) return 110;
    return 140;
  };

  const gridWidth = 40 + (canWrite ? 58 : 0) + (result?.columns ?? []).reduce((sum, column) => sum + widthForColumn(column), 0);

  const valueOf = (row: unknown[], name: string): unknown => {
    const index = (result?.columns ?? []).findIndex((column) => column.name === name);
    return index >= 0 ? row[index] : null;
  };

  const startEdit = (row: unknown[]) => {
    const values: Record<string, string> = {};
    for (const column of table.columns ?? []) {
      const value = valueOf(row, column.name);
      values[column.name] = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    const original: Record<string, unknown> = {};
    for (const pk of pkColumns) original[pk] = valueOf(row, pk);
    setDraft({ mode: 'edit', values, original });
  };

  const save = async () => {
    if (!draft || !connection) return;
    setSaving(true);
    try {
      const values: Record<string, unknown> = {};
      for (const column of table.columns ?? []) {
        if (column.autoIncrement || column.generated) continue;
        if (draft.mode === 'edit' && pkColumns.includes(column.name)) continue;
        const raw = draft.values[column.name] ?? '';
        values[column.name] = raw === '' && column.nullable ? null : raw;
      }
      if (draft.mode === 'insert') {
        await client.rows(connection.id, table.name, 'insert', { values }, database);
      } else {
        await client.rows(connection.id, table.name, 'update', { values, key: draft.original ?? {} }, database);
      }
      setDraft(null);
      notify('已保存', draft.mode === 'insert' ? '新行已写入' : '修改已保存');
      onChanged();
    } catch (err: any) {
      notify('保存失败', err?.message ?? '');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: unknown[]) => {
    if (!connection) return;
    const key: Record<string, unknown> = {};
    for (const pk of pkColumns) key[pk] = valueOf(row, pk);
    if (!(await confirmAction('删除行', `按主键 ${pkColumns.join(', ')} 删除这一行？`, '删除'))) return;
    try {
      await client.rows(connection.id, table.name, 'delete', { key }, database);
      notify('已删除', '行已删除');
      onChanged();
    } catch (err: any) {
      notify('删除失败', err?.message ?? '');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable style={styles.iconButton} onPress={onBack}>
          <ChevronLeft size={18} color={colors.text} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>{table.name}</Text>
          <Text style={styles.listMeta}>{connection?.readonly ? '只读 · ' : ''}{page?.total ?? '?'} 行{canWrite ? ' · 可编辑' : ''}</Text>
        </View>
        <Pressable style={styles.iconButton} onPress={onDesign} testID="m-table-design">
          <Wrench size={15} color={colors.text} />
        </Pressable>
        <Pressable style={styles.iconButton} onPress={onRefresh}>
          <RefreshCw size={15} color={colors.text} />
        </Pressable>
        {canWrite ? (
          <Pressable
            style={styles.iconButton}
            testID="m-row-insert"
            onPress={() => setDraft({ mode: 'insert', values: Object.fromEntries(editableColumns.map((column) => [column.name, ''])) })}
          >
            <Plus size={16} color={colors.accent} />
          </Pressable>
        ) : null}
      </View>
      {loading ? <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} /> : null}
      {!canWrite && !connection?.readonly ? <Text style={[styles.hint, { paddingHorizontal: 14, paddingTop: 8 }]}>该表没有主键，无法按行编辑；可用 SQL 查询修改。</Text> : null}
      <View style={styles.dataViewBar}>
        <View style={styles.viewSwitch}>
          <Pressable testID="m-data-view-grid" style={[styles.viewSwitchItem, viewMode === 'grid' && styles.viewSwitchActive]} onPress={() => setViewMode('grid')}>
            <Text style={[styles.viewSwitchText, viewMode === 'grid' && styles.viewSwitchTextActive]}>表格</Text>
          </Pressable>
          <Pressable testID="m-data-view-cards" style={[styles.viewSwitchItem, viewMode === 'cards' && styles.viewSwitchActive]} onPress={() => setViewMode('cards')}>
            <Text style={[styles.viewSwitchText, viewMode === 'cards' && styles.viewSwitchTextActive]}>卡片</Text>
          </Pressable>
        </View>
        {viewMode === 'grid' ? <Text style={styles.listMeta}>左右滑动查看全部列 · 点行看详情</Text> : null}
      </View>
      {viewMode === 'grid' ? (
        <View style={{ flex: 1 }}>
          <ScrollView
            horizontal
            ref={gridHeaderRef}
            onScroll={(event) => syncGridScroll(event.nativeEvent.contentOffset.x)}
            scrollEventThrottle={16}
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, flexShrink: 0, height: 32 }}
          >
            <View style={[styles.gridHeaderRow, { width: gridWidth }]}>
              <Text style={[styles.gridHeadCell, { width: 40 }]}>#</Text>
              {canWrite ? <Text style={[styles.gridHeadCell, { width: 58 }]}>操作</Text> : null}
              {(result?.columns ?? []).map((column) => (
                <Text key={column.name} style={[styles.gridHeadCell, { width: widthForColumn(column) }]} numberOfLines={1}>{column.name}</Text>
              ))}
            </View>
          </ScrollView>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 8 }}>
            <ScrollView
              horizontal
              ref={gridBodyRef}
              onScroll={(event) => syncGridScroll(event.nativeEvent.contentOffset.x)}
              scrollEventThrottle={16}
            >
              <View>
                {(result?.rows ?? []).map((row, rowIndex) => (
                  <Pressable
                    key={rowIndex}
                    testID={`m-row-${rowIndex}`}
                    style={[styles.gridRow, { width: gridWidth }, rowIndex % 2 === 1 && { backgroundColor: colors.elevated }]}
                    onPress={() => setInspect({ row, index: rowIndex })}
                  >
                    <Text style={[styles.gridIndexCell, { width: 40 }]}>{offset + rowIndex + 1}</Text>
                    {canWrite ? (
                      <View style={[styles.gridActionCell, { width: 58 }]}>
                        <Pressable testID={`m-row-edit-${rowIndex}`} hitSlop={8} style={styles.gridActionButton} onPress={() => startEdit(row)}>
                          <Pencil size={12} color={colors.muted} />
                        </Pressable>
                        <Pressable testID={`m-row-delete-${rowIndex}`} hitSlop={8} style={styles.gridActionButton} onPress={() => void remove(row)}>
                          <Trash2 size={12} color={colors.muted} />
                        </Pressable>
                      </View>
                    ) : null}
                    {(result?.columns ?? []).map((column, colIndex) => {
                      const value = row[colIndex];
                      const isNull = value === null || value === undefined;
                      return (
                        <Text
                          key={column.name}
                          style={[styles.gridCell, { width: widthForColumn(column) }, isNull && { color: colors.muted, fontStyle: 'italic' }]}
                          numberOfLines={1}
                        >
                          {isNull ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        </Text>
                      );
                    })}
                  </Pressable>
                ))}
              </View>
            </ScrollView>
            {!loading && !(result?.rows ?? []).length ? <Text style={styles.hint}>没有数据</Text> : null}
          </ScrollView>
        </View>
      ) : (
      <ScrollView contentContainerStyle={{ padding: 12, gap: 8, paddingBottom: 24 }}>
        {(result?.rows ?? []).map((row, rowIndex) => (
          <View key={rowIndex} style={styles.rowCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.rowIndex, { flex: 1 }]}>#{offset + rowIndex + 1}</Text>
              {canWrite ? (
                <>
                  <Pressable testID={`m-row-edit-${rowIndex}`} hitSlop={8} style={{ paddingHorizontal: 8 }} onPress={() => startEdit(row)}>
                    <Pencil size={13} color={colors.muted} />
                  </Pressable>
                  <Pressable testID={`m-row-delete-${rowIndex}`} hitSlop={8} onPress={() => void remove(row)}>
                    <Trash2 size={13} color={colors.muted} />
                  </Pressable>
                </>
              ) : null}
            </View>
            {(result?.columns ?? []).map((column, colIndex) => (
              <View key={column.name} style={styles.fieldRow}>
                <Text style={styles.fieldName}>{column.name}</Text>
                <Text style={styles.fieldValue} numberOfLines={4}>
                  {row[colIndex] === null || row[colIndex] === undefined
                    ? 'NULL'
                    : typeof row[colIndex] === 'object'
                      ? JSON.stringify(row[colIndex])
                      : String(row[colIndex])}
                </Text>
              </View>
            ))}
          </View>
        ))}
        {!loading && !(result?.rows ?? []).length ? <Text style={styles.hint}>没有数据</Text> : null}
      </ScrollView>
      )}
      <View style={styles.pager}>
        <Pressable style={[styles.pagerButton, offset <= 0 && { opacity: 0.4 }]} disabled={offset <= 0} onPress={() => onPage(Math.max(0, offset - limit))}>
          <ChevronLeft size={14} color={colors.text} />
        </Pressable>
        <Text style={styles.listMeta}>{current} / {totalPages}</Text>
        <Pressable style={[styles.pagerButton, current >= totalPages && { opacity: 0.4 }]} disabled={current >= totalPages} onPress={() => onPage(offset + limit)}>
          <ChevronRight size={14} color={colors.text} />
        </Pressable>
      </View>
      {draft ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{draft.mode === 'insert' ? '新增行' : '编辑行'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setDraft(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {(table.columns ?? []).map((column) => {
                  const readOnly = column.generated || (draft.mode === 'edit' && pkColumns.includes(column.name)) || (draft.mode === 'insert' && column.autoIncrement);
                  if (!readOnly && draft.mode === 'insert' && !(column.name in draft.values)) return null;
                  return (
                    <View key={column.name}>
                      <Text style={styles.fieldName}>{column.name}{column.primaryKey ? ' · PK' : ''} · {column.type}</Text>
                      <TextInput
                        testID={`m-row-field-${column.name}`}
                        style={[styles.input, readOnly && { opacity: 0.55 }]}
                        value={draft.values[column.name] ?? ''}
                        onChangeText={(value) => setDraft({ ...draft, values: { ...draft.values, [column.name]: value } })}
                        editable={!readOnly}
                        placeholder={column.nullable ? 'NULL' : ''}
                        placeholderTextColor={colors.muted}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    </View>
                  );
                })}
                <Pressable testID="m-row-save" style={[styles.primaryButton, saving && { opacity: 0.5 }]} disabled={saving} onPress={() => void save()}>
                  <Text style={styles.primaryButtonText}>{saving ? '保存中…' : '保存'}</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
      {inspect ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setInspect(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>行详情</Text>
                  <Text style={styles.listMeta}>{table.name} · #{offset + inspect.index + 1}</Text>
                </View>
                <Pressable testID="m-row-inspect-close" style={styles.iconButton} onPress={() => setInspect(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {(result?.columns ?? []).map((column, colIndex) => {
                  const value = inspect.row[colIndex];
                  return (
                    <View key={column.name} style={styles.fieldRow}>
                      <Text style={styles.fieldName}>{column.name}</Text>
                      <Text style={styles.fieldValue}>
                        {value === null || value === undefined ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </Text>
                    </View>
                  );
                })}
                {canWrite ? (
                  <View style={{ flexDirection: 'row', gap: 8, marginTop: 6 }}>
                    <Pressable
                      testID="m-row-inspect-edit"
                      style={[styles.secondaryButton, { flex: 1 }]}
                      onPress={() => {
                        const row = inspect.row;
                        setInspect(null);
                        startEdit(row);
                      }}
                    >
                      <Text style={styles.secondaryButtonText}>编辑</Text>
                    </Pressable>
                    <Pressable
                      testID="m-row-inspect-delete"
                      style={[styles.secondaryButton, { flex: 1, borderColor: colors.danger }]}
                      onPress={() => {
                        const row = inspect.row;
                        setInspect(null);
                        void remove(row);
                      }}
                    >
                      <Text style={[styles.secondaryButtonText, { color: colors.danger }]}>删除</Text>
                    </Pressable>
                  </View>
                ) : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

