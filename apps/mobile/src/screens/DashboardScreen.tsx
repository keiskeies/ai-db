import { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, Trash2 } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, confirmAction } from '../lib/utils';
import { Text } from '../components/base';

export function DashboardScreen({ client, connection, database, onBack }: { client: BridgeClient; connection?: ConnectionConfig; database?: string; onBack: () => void }) {
  const [cards, setCards] = useState<Array<{ id: string; title: string; sql: string; chartType: string }>>([]);
  const [results, setResults] = useState<Record<string, { status: string; columns: Array<{ name: string }>; rows: unknown[][]; error?: string }>>({});
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!connection) return;
    try {
      setCards((await client.dashboardCards(connection.id, database)).cards);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id, database]);
  const refresh = async () => {
    if (!connection) return;
    setBusy(true);
    try {
      const result = await client.refreshDashboards(connection.id, database);
      setResults(Object.fromEntries(result.results.map((item) => [item.cardId, item])));
    } catch (err: any) {
      notify('刷新失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-dash-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>仪表板</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'}{database ? ` · ${database}` : ''}</Text>
        </View>
        <Pressable style={[styles.primarySmall, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void refresh()}>
          <Text style={styles.primarySmallText}>{busy ? '刷新中…' : '刷新'}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        {cards.map((card) => {
          const result = results[card.id];
          const numeric = result?.columns.findIndex((_, index) => result.rows.some((row) => typeof row[index] === 'number'));
          const max = result ? Math.max(1, ...result.rows.map((row) => Number(row[numeric ?? 1]) || 0)) : 1;
          return (
            <View key={card.id} style={styles.rowCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Text style={[styles.listTitle, { flex: 1 }]}>{card.title}</Text>
                <Pressable
                  testID={`m-card-delete-${card.id}`}
                  style={styles.iconButton}
                  onPress={async () => {
                    if (!(await confirmAction('删除卡片', card.title, '删除'))) return;
                    try {
                      await client.deleteDashboardCard(card.id);
                      await load();
                    } catch (err: any) {
                      notify('删除失败', err?.message ?? '');
                    }
                  }}
                >
                  <Trash2 size={14} color={colors.muted} />
                </Pressable>
              </View>
              <Text style={styles.listMeta} numberOfLines={1}>{card.chartType} · {card.sql}</Text>
              {result?.status === 'error' ? <Text style={styles.error}>{result.error}</Text> : null}
              {result?.status === 'ok' && result.rows.length ? (
                card.chartType === 'bar' || card.chartType === 'line' || card.chartType === 'pie' ? (
                  <View style={{ gap: 4, marginTop: 8 }}>
                    {result.rows.slice(0, 8).map((row, index) => (
                      <View key={index} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text style={[styles.listMeta, { width: 86 }]} numberOfLines={1}>{String(row[0] ?? '')}</Text>
                        <View style={{ flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.border }}>
                          <View style={{ width: `${Math.max(3, (Number(row[numeric === -1 ? 1 : numeric]) / max) * 100)}%`, height: 6, borderRadius: 3, backgroundColor: colors.agent }} />
                        </View>
                        <Text style={styles.listMeta}>{String(row[numeric === -1 ? 1 : numeric] ?? '')}</Text>
                      </View>
                    ))}
                  </View>
                ) : (
                  <Text style={styles.listMeta}>{result.rows.length} 行数据</Text>
                )
              ) : null}
            </View>
          );
        })}
        {!cards.length ? <Text style={styles.hint}>还没有卡片。在 SQL 查询里执行一条只读 SQL，点「存为仪表板」。</Text> : null}
      </ScrollView>
    </View>
  );
}

