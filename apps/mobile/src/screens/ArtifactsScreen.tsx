import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, X } from 'lucide-react-native';
import type { ReportSpec } from '@aidb/core';
import { isReportSpec } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, shareBase64, humanBytes, confirmAction } from '../lib/utils';
import { Text } from '../components/base';
import { ReportView } from '../components/ReportView';

function reportSpecOf(type: string, result: unknown): ReportSpec | undefined {
  return (type === 'report' || type === 'compare') && isReportSpec(result) ? result : undefined;
}

export function ArtifactsScreen({ client, onBack }: { client: BridgeClient; onBack: () => void }) {
  const [items, setItems] = useState<Array<{ id: string; type: string; title: string; status: string; updatedAt: string }>>([]);
  const [detail, setDetail] = useState<{ artifact: { id: string; type: string; title: string; status: string; spec: unknown }; run?: { status: string; result?: unknown; error?: string } } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    try {
      setItems((await client.artifacts(100)).artifacts);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (id: string) => {
    try {
      const artifact = (await client.artifactDetail(id)).artifact;
      const runs = (await client.artifactRuns(id, 1)).runs;
      setDetail({ artifact, run: runs[0] });
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  const exportArtifact = async (format: 'xlsx' | 'pptx') => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await client.exportArtifact(detail.artifact.id, format);
      if (!result.content) throw new Error('导出内容为空');
      await shareBase64(result.content, format);
      notify('导出完成', `${format.toUpperCase()} ${humanBytes(result.bytes)}`);
    } catch (err: any) {
      notify('导出失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  const reportSpec = detail ? reportSpecOf(detail.artifact.type, detail.run?.result) : undefined;
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-artifacts-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>报告与产物</Text>
          <Text style={styles.listMeta}>{items.length} 个产物</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {items.map((item) => (
          <Pressable key={item.id} testID={`m-artifact-${item.id}`} style={styles.rowCard} onPress={() => void open(item.id)}>
            <Text style={styles.listTitle}>{item.title}</Text>
            <Text style={styles.listMeta}>{item.type} · {item.status} · {new Date(item.updatedAt).toLocaleString()}</Text>
          </Pressable>
        ))}
        {!items.length ? <Text style={styles.hint}>还没有报告或对比产物。可在对话中使用 /report、/diff、/recon。</Text> : null}
      </ScrollView>
      {detail ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDetail(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{detail.artifact.title}</Text>
                <Pressable testID="m-artifact-close" style={styles.iconButton} onPress={() => setDetail(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
                <Text style={styles.listMeta}>{detail.artifact.type} · {detail.artifact.status}{detail.run ? ` · 运行 ${detail.run.status}` : ''}</Text>
                {detail.run?.error ? <Text style={styles.error}>{detail.run.error}</Text> : null}
                {reportSpec ? (
                  <ReportView spec={reportSpec} error={detail.run?.error} />
                ) : (
                  <>
                    <Text style={styles.sectionLabel}>运行结果</Text>
                    <Text selectable style={styles.sqlSnippet}>{detail.run?.result ? JSON.stringify(detail.run.result, null, 2) : '没有运行结果'}</Text>
                    <Text style={styles.sectionLabel}>规格</Text>
                    <Text selectable style={styles.sqlSnippet}>{JSON.stringify(detail.artifact.spec, null, 2)}</Text>
                  </>
                )}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Pressable style={[styles.modeChip, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void exportArtifact('xlsx')}><Text style={styles.modeChipText}>导出 XLSX</Text></Pressable>
                  <Pressable style={[styles.modeChip, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void exportArtifact('pptx')}><Text style={styles.modeChipText}>导出 PPTX</Text></Pressable>
                  <Pressable
                    style={styles.modeChip}
                    onPress={async () => {
                      if (!(await confirmAction('删除产物', detail.artifact.title, '删除'))) return;
                      try {
                        await client.deleteArtifact(detail.artifact.id);
                        setDetail(null);
                        await load();
                      } catch (err: any) {
                        notify('删除失败', err?.message ?? '');
                      }
                    }}
                  >
                    <Text style={[styles.modeChipText, { color: colors.danger }]}>删除</Text>
                  </Pressable>
                </View>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

