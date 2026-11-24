import type { Dispatch, SetStateAction } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronDown, ChevronRight, Database, RefreshCw, Table2 } from 'lucide-react-native';
import { type ConnectionConfig, type TableInfo } from '@aidb/core';
import { colors } from '../theme';
import { styles } from '../styles';
import type { PickerKind } from '../types';
import { Text, EngineLogo, ScreenHeading } from '../components/base';

export function DataScreen({ databases, activeDatabase, tables, activeConnection, activeConnectionId, setPicker, loadSchema, openTable, scopeLocked }: { databases: string[]; activeDatabase: string | undefined; tables: TableInfo[]; activeConnection: ConnectionConfig | undefined; activeConnectionId: string | undefined; setPicker: Dispatch<SetStateAction<PickerKind>>; loadSchema: (connectionId?: string, database?: string) => Promise<void>; openTable: (table: TableInfo, offset?: number) => Promise<void>; scopeLocked: boolean; }) {
  return (
            <View style={{ flex: 1 }}>
              <ScreenHeading icon={<Table2 size={16} color={colors.accent} />} title="数据" subtitle={`${databases.length > 1 && activeDatabase ? activeDatabase + ' · ' : ''}${tables.length} 个对象`} />
              <View style={styles.dataToolbar}>
                <Pressable testID="m-data-connection" style={[styles.dataChip, { flex: 1 }]} onPress={() => setPicker('connections')} disabled={scopeLocked}>
                  <EngineLogo engine={activeConnection?.engine} size={14} />
                  <Text style={styles.dataChipText} numberOfLines={1}>{activeConnection?.name ?? '选择连接'}</Text>
                  <ChevronDown size={12} color={colors.muted} />
                </Pressable>
                {databases.length > 1 ? (
                  <Pressable testID="m-data-database" style={[styles.dataChip, { flex: 1 }]} onPress={() => setPicker('databases')} disabled={scopeLocked}>
                    <Database size={12} color={colors.accent} />
                    <Text style={styles.dataChipText} numberOfLines={1}>{activeDatabase ?? '选择库'}</Text>
                    <ChevronDown size={12} color={colors.muted} />
                  </Pressable>
                ) : null}
                {/* 刷新必须带上当前库：不带库的请求对没有默认库的 MySQL 连接直接 400 */}
                <Pressable testID="m-data-refresh" style={styles.iconButton} onPress={() => activeConnectionId && void loadSchema(activeConnectionId, activeDatabase)}>
                  <RefreshCw size={15} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                {tables.map((table) => (
                  <Pressable key={table.name} testID={`m-table-${table.name}`} style={styles.listRow} onPress={() => void openTable(table)}>
                    <Table2 size={15} color={colors.accent} />
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{table.name}</Text>
                      <Text style={styles.listMeta}>
                        {table.type === 'view' ? '视图' : `${table.columns?.length ?? 0} 列`}
                        {table.rowEstimate !== undefined ? ` · ~${table.rowEstimate} 行` : ''}
                      </Text>
                    </View>
                    <ChevronRight size={14} color={colors.muted} />
                  </Pressable>
                ))}
                {!tables.length ? <Text style={styles.hint}>当前连接没有表，或尚未加载结构。</Text> : null}
                <Text style={styles.hint}>点击表可浏览与编辑数据；结构变更、导入导出在「工具」页。</Text>
              </ScrollView>
            </View>
  );
}
