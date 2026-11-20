import { Pressable, ScrollView, View } from 'react-native';
import { BarChart3, ChevronRight, Database, FileCode2, Gauge, History, Search, ShieldAlert, Table2, TerminalSquare, Users, Workflow, Wrench } from 'lucide-react-native';
import { type ConnectionConfig, type TableInfo } from '@aidb/core';
import { colors } from '../theme';
import { styles } from '../styles';
import { Text, ScreenHeading } from '../components/base';
import { Markdown } from '../components/markdown';

export function ToolsScreen({
  connection,
  database,
  tables,
  onOpen,
}: {
  connection?: ConnectionConfig;
  database?: string;
  tables: TableInfo[];
  onOpen: (page: 'query' | 'table' | 'io' | 'backups' | 'dashboards' | 'pipelines' | 'dictionary' | 'monitor' | 'search' | 'history' | 'audit' | 'artifacts' | 'users') => void;
}) {
  return (
    <View style={{ flex: 1 }}>
      <ScreenHeading icon={<Wrench size={16} color={colors.accent} />} title="工具箱" subtitle="当前库的数据库工具" />
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>当前上下文</Text>
          <Text style={[styles.settingValue, { marginTop: 4 }]}>
            {connection?.name ?? '未选择连接'}
            {database ? ` / ${database}` : ''}
          </Text>
          <Text style={styles.listMeta}>
            {connection?.engine ?? '未连接'} · {tables.length} 个对象
          </Text>
        </View>
        <Text style={styles.sectionLabel}>数据工具</Text>
        {[
          { page: 'query' as const, label: 'SQL 查询', desc: '执行 SQL、导出、保存到仪表板', icon: <TerminalSquare size={15} color={colors.accent} /> },
          { page: 'table' as const, label: '表结构', desc: '列 / 索引 / 加列 / 重命名 / 清空', icon: <Table2 size={15} color={colors.accent} /> },
          { page: 'io' as const, label: '导入 / 导出', desc: 'CSV 导入；CSV / JSON / XML / SQL / XLSX 导出', icon: <Database size={15} color={colors.accent} /> },
          { page: 'backups' as const, label: '备份', desc: '创建与恢复 SQL 备份', icon: <History size={15} color={colors.accent} /> },
          { page: 'dashboards' as const, label: '仪表板', desc: '刷新卡片、查看趋势、删除卡片', icon: <BarChart3 size={15} color={colors.accent} /> },
          { page: 'pipelines' as const, label: '数据流处理', desc: '查看步骤、立即运行、看运行历史', icon: <Workflow size={15} color={colors.accent} /> },
          { page: 'search' as const, label: '数据库搜索', desc: '按对象与数据全文查找', icon: <Search size={15} color={colors.accent} /> },
          { page: 'dictionary' as const, label: '数据字典', desc: 'Markdown 结构说明', icon: <Database size={15} color={colors.accent} /> },
          { page: 'monitor' as const, label: '服务器监控', desc: '指标与会话概览', icon: <Gauge size={15} color={colors.accent} /> },
          { page: 'history' as const, label: '查询历史', desc: '搜索、收藏、回填 SQL', icon: <History size={15} color={colors.accent} /> },
          { page: 'audit' as const, label: '审计日志', desc: '谁在什么时候改了什么', icon: <ShieldAlert size={15} color={colors.accent} /> },
          { page: 'artifacts' as const, label: '报告与产物', desc: '报告/对比结果与导出', icon: <FileCode2 size={15} color={colors.accent} /> },
          { page: 'users' as const, label: '用户与权限', desc: '账户列表、创建、授权与删除', icon: <Users size={15} color={colors.accent} /> },
        ].map((entry) => (
          <Pressable key={entry.page} testID={`m-tool-${entry.page}`} style={styles.listRow} onPress={() => onOpen(entry.page)}>
            {entry.icon}
            <View style={{ flex: 1 }}>
              <Text style={styles.listTitle}>{entry.label}</Text>
              <Text style={styles.listMeta} numberOfLines={1}>{entry.desc}</Text>
            </View>
            <ChevronRight size={14} color={colors.muted} />
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

