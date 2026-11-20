import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, RefreshCw, X } from 'lucide-react-native';
import { pipelineStepKind, type PipelineInfo, type PipelineRunInfo, type PipelineStep } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { currentLocale, translate } from '../i18n';
import { styles } from '../styles';
import { notify, confirmAction, timeAgo } from '../lib/utils';
import { Text } from '../components/base';

function stepTypeLabel(type: string): string {
  const kind = pipelineStepKind(type);
  if (!kind) return type;
  // 目录里的双语标签是运行时数据，进不了整句查表，只能按当前语言二选一。
  return currentLocale() === 'zh-CN' ? kind.label.zh : kind.label.en;
}

function stepBrief(step: PipelineStep): string {
  const values = step.with ?? {};
  const table = String(values.table ?? '').trim();
  if (table) return table;
  const url = String(values.url ?? '').trim();
  if (url) return url.replace(/^https?:\/\//, '').slice(0, 44);
  const sql = String(values.sql ?? '').trim();
  if (sql) return sql.split('\n')[0].slice(0, 44);
  return '';
}

function flowChain(steps: PipelineStep[]): string {
  return steps.map((step) => step.label || stepTypeLabel(step.type)).join(' → ');
}

function runChain(run: PipelineRunInfo): string {
  return run.steps
    .map((step) => {
      const mark = step.status === 'ok' ? '✓' : step.status === 'error' ? '✗' : step.status === 'skipped' ? '–' : '·';
      const rows = step.outRows === undefined ? '' : ` ${step.inRows ?? 0}→${step.outRows}`;
      const name = step.label && step.label !== step.id ? step.label : stepTypeLabel(step.type);
      return `${mark} ${name}${rows}`;
    })
    .join(' → ');
}

function flowStatusText(status?: string): string {
  if (status === 'ok') return translate('成功');
  if (status === 'error') return translate('失败');
  if (status === 'running') return translate('运行中');
  return translate('尚未运行');
}

export function PipelinesScreen({ client, onBack }: { client: BridgeClient; onBack: () => void }) {
  const [flows, setFlows] = useState<PipelineInfo[]>([]);
  const [detail, setDetail] = useState<{ flow: PipelineInfo; runs: PipelineRunInfo[] } | null>(null);
  const [busyId, setBusyId] = useState('');

  const load = async () => {
    try {
      setFlows((await client.pipelines()).pipelines);
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = async (flow: PipelineInfo) => {
    setDetail({ flow, runs: [] });
    try {
      setDetail({ flow, runs: (await client.pipelineRuns(flow.id, 10)).runs });
    } catch (err: any) {
      notify('历史加载失败', err?.message ?? '');
    }
  };

  const refresh = async (flowId: string) => {
    const list = (await client.pipelines()).pipelines;
    setFlows(list);
    const fresh = list.find((item) => item.id === flowId);
    if (fresh && detail?.flow.id === flowId) await open(fresh);
  };

  const runFlow = async (flow: PipelineInfo) => {
    // 手机端一按就是真实写入与外发请求，必须确认后再跑。
    if (!(await confirmAction('运行数据流', `立即运行「${flow.name}」？目标端会真实写入数据。`, '运行'))) return;
    setBusyId(flow.id);
    try {
      const { run: result } = await client.runPipeline(flow.id);
      notify(
        result.status === 'ok' ? '运行完成' : '运行失败',
        result.status === 'ok' ? translate('{0} 步 / {1} 行', [result.steps.length, result.rowsOut ?? 0]) : (result.error ?? ''),
      );
      await refresh(flow.id);
    } catch (err: any) {
      notify('运行失败', err?.message ?? '');
    } finally {
      setBusyId('');
    }
  };

  const resetBookmark = async (flow: PipelineInfo) => {
    if (!(await confirmAction('清空增量断点', '清空后下次运行会从头取数，可能重复拉取历史数据。', '清空'))) return;
    setBusyId(flow.id);
    try {
      await client.resetPipelineState(flow.id);
      notify('断点已清空', '下次运行从头取数');
      await refresh(flow.id);
    } catch (err: any) {
      notify('清空失败', err?.message ?? '');
    } finally {
      setBusyId('');
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-pipelines-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>数据流处理</Text>
          <Text style={styles.listMeta}>{translate('{0} 条流水线', [flows.length])}</Text>
        </View>
        <Pressable testID="m-pipelines-refresh" style={styles.iconButton} onPress={() => void load()}><RefreshCw size={16} color={colors.text} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {flows.map((flow) => (
          <Pressable key={flow.id} testID={`m-pipeline-${flow.id}`} style={styles.rowCard} onPress={() => void open(flow)}>
            <Text style={styles.listTitle}>{flow.name}</Text>
            <Text style={styles.listMeta} numberOfLines={2}>{flowChain(flow.spec.steps)}</Text>
            <Text style={styles.listMeta}>
              {[
                flowStatusText(flow.lastStatus),
                flow.lastRunAt ? timeAgo(flow.lastRunAt) : '',
                Object.keys(flow.state ?? {}).length ? translate('已记住断点') : '',
              ].filter(Boolean).join(' · ')}
            </Text>
            {flow.lastError ? <Text style={styles.error} numberOfLines={2}>{flow.lastError}</Text> : null}
          </Pressable>
        ))}
        {!flows.length ? <Text style={styles.hint}>还没有数据流。请到桌面端 工具箱 → 数据流处理 创建，这里可以看步骤、立即运行和查历史。</Text> : null}
      </ScrollView>
      {detail ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDetail(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{detail.flow.name}</Text>
                <Pressable testID="m-pipeline-close" style={styles.iconButton} onPress={() => setDetail(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
                {detail.flow.description ? <Text style={styles.listMeta}>{detail.flow.description}</Text> : null}
                <Text style={styles.sectionLabel}>步骤</Text>
                {detail.flow.spec.steps.map((step, index) => (
                  <View key={step.id} style={styles.listRow}>
                    <Text style={[styles.modeChipText, { minWidth: 18, textAlign: 'center' }]}>{index + 1}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.listTitle}>{step.label || stepTypeLabel(step.type)}</Text>
                      {stepBrief(step) ? <Text style={styles.sqlSnippet} numberOfLines={1}>{stepBrief(step)}</Text> : null}
                    </View>
                  </View>
                ))}
                <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                  <Pressable
                    testID="m-pipeline-run"
                    style={[styles.modeChip, busyId === detail.flow.id && { opacity: 0.5 }]}
                    disabled={busyId === detail.flow.id}
                    onPress={() => void runFlow(detail.flow)}
                  >
                    <Text style={styles.modeChipText}>{busyId === detail.flow.id ? '运行中…' : '立即运行'}</Text>
                  </Pressable>
                  <Pressable style={styles.modeChip} disabled={busyId === detail.flow.id} onPress={() => void resetBookmark(detail.flow)}>
                    <Text style={styles.modeChipText}>清空断点</Text>
                  </Pressable>
                </View>
                <Text style={styles.sectionLabel}>运行历史</Text>
                {detail.runs.map((run) => (
                  <View key={run.id} style={styles.rowCard}>
                    <Text style={styles.listTitle}>
                      {`${flowStatusText(run.status)} · ${new Date(run.startedAt).toLocaleString()}`}
                    </Text>
                    <Text style={styles.listMeta} numberOfLines={3}>{runChain(run)}</Text>
                    {run.error ? <Text style={styles.error} numberOfLines={3}>{run.error}</Text> : null}
                  </View>
                ))}
                {!detail.runs.length ? <Text style={styles.hint}>还没有运行记录。</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

