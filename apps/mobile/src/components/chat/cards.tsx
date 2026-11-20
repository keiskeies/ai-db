import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { Check, Loader2, X } from 'lucide-react-native';
import type { AgentPlanItem, Risk, ToolResult } from '@aidb/core';
import type { LiveTool } from '../../types';
import { colors, riskColor, riskLabels } from '../../theme';
import { styles } from '../../styles';
import { Text } from '../base';
import type { ChartShape } from '../chart/model';
import { MobileChart } from '../chart/MobileChart';

export function UserBubble({ text }: { text: string }) {
  return (
    <View style={styles.userRow}>
      <Text style={styles.promptMark}>❯</Text>
      <View style={styles.userBubble}>
        <Text style={styles.userText}>{text}</Text>
      </View>
    </View>
  );
}

export function ThinkingBlock({ text }: { text: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <Pressable style={styles.thinking} onPress={() => setOpen(!open)}>
      <Text style={styles.listMeta}>{open ? '▾' : '▸'} 思考过程</Text>
      {open ? <Text style={[styles.listMeta, { marginTop: 5, lineHeight: 17 }]}>{text}</Text> : null}
    </Pressable>
  );
}

export function ExecutionSection({ count, running, children }: { count: number; running?: boolean; children: React.ReactNode }) {
  const [manual, setManual] = React.useState<boolean | null>(null);
  const open = manual ?? Boolean(running);
  return (
    <View style={styles.execution}>
      <Pressable testID="m-execution-section" style={styles.executionHead} onPress={() => setManual(!open)}>
        <Text style={styles.executionTitle}>{open ? '▾' : '▸'} 执行过程</Text>
        <Text style={styles.executionCount}>{count} 次工具调用</Text>
      </Pressable>
      {open ? <View style={styles.executionBody}>{children}</View> : null}
    </View>
  );
}

export function MobileToolCard({
  tool,
  args,
  risk,
  status,
  result,
  summary,
  showChart = true,
}: {
  tool: string;
  args: unknown;
  risk?: Risk;
  status: LiveTool['status'];
  result?: ToolResult;
  summary?: string;
  showChart?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const sql = args && typeof args === 'object' ? (args as Record<string, unknown>).sql : undefined;
  const data = result?.data as Record<string, any> | undefined;
  const chart = data?.chart as ChartShape | undefined;
  return (
    <Pressable testID="m-tool-card" style={[styles.toolCard, status === 'error' && { borderLeftColor: colors.danger }, status === 'awaiting' && { borderLeftColor: colors.warning }]} onPress={() => setOpen(!open)}>
      <View style={styles.toolHead}>
        {status === 'running' ? <Loader2 size={11} color={colors.agent} /> : status === 'ok' ? <Check size={11} color={colors.success} /> : <X size={11} color={colors.danger} />}
        <Text style={styles.toolName}>{tool}</Text>
        <Text style={styles.toolSummary} numberOfLines={1}>{summary ?? (typeof sql === 'string' ? sql.replace(/\s+/g, ' ') : '')}</Text>
        <Text style={[styles.riskBadgeText, { color: riskColor(risk) }]}>{riskLabels[risk ?? ''] ?? ''}</Text>
      </View>
      {open ? (
        <View style={styles.toolBody}>
          <Text style={styles.toolLabel}>参数</Text>
          <Text style={styles.codeText}>{typeof sql === 'string' ? String(sql) : JSON.stringify(args, null, 2).slice(0, 1600)}</Text>
          {result ? (
            <>
              <Text style={styles.toolLabel}>结果</Text>
              <Text style={[styles.listMeta, { color: result.ok ? colors.success : colors.danger }]}>{result.summary}</Text>
              {result.error ? <Text style={[styles.hint, { color: colors.danger, marginTop: 4 }]}>{result.error.message}</Text> : null}
              {chart && showChart ? <MobileChart chart={chart as ChartShape} /> : null}
              {Array.isArray(data?.findings) && data.findings.length ? (
                <View style={{ marginTop: 6, gap: 5 }}>
                  {data.findings.slice(0, 5).map((finding: any, index: number) => (
                    <View key={index} style={{ borderLeftWidth: 2, borderLeftColor: finding.severity === 'high' ? colors.danger : finding.severity === 'medium' ? colors.warning : colors.muted, paddingLeft: 6 }}>
                      <Text style={[styles.listMeta, { color: colors.text }]}>{String(finding.severity).toUpperCase()} · {finding.title}</Text>
                      <Text style={styles.listMeta} numberOfLines={3}>{finding.detail}</Text>
                    </View>
                  ))}
                </View>
              ) : null}
              {!chart && data?.columns && data?.rows ? (
                <ScrollView horizontal style={{ marginTop: 6 }}>
                  <View>
                    {(data.rows as unknown[][]).slice(0, 5).map((row, i) => (
                      <Text key={i} style={[styles.codeText, { marginTop: 3 }]}>
                        {row.map((value) => (value === null ? 'NULL' : typeof value === 'object' ? JSON.stringify(value) : String(value))).join(' · ').slice(0, 160)}
                      </Text>
                    ))}
                  </View>
                </ScrollView>
              ) : null}
              {data?.path ? <Text style={[styles.codeText, { marginTop: 4 }]}>{String(data.path)}</Text> : null}
            </>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

export function PlanCard({ items }: { items: AgentPlanItem[] }) {
  if (!items.length) return null;
  return (
    <View style={styles.planCard}>
      <Text style={styles.sectionLabel}>计划 · {items.filter((i) => i.status === 'done').length}/{items.length}</Text>
      {items.map((item) => (
        <View key={item.id} style={styles.planRow}>
          <Text style={[styles.planIcon, item.status === 'done' && { color: colors.success }, item.status === 'doing' && { color: colors.agent }]}>
            {item.status === 'done' ? '✓' : item.status === 'doing' ? '◐' : '○'}
          </Text>
          <Text style={[styles.planText, item.status === 'done' && { color: colors.muted, textDecorationLine: 'line-through' }]}>{item.text}</Text>
        </View>
      ))}
    </View>
  );
}
