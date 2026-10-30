import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ChevronLeft, Play, X } from 'lucide-react-native';
import { COMMANDS, type CommandDefinition, type CommandRunInfo, type CommandRunInput, type ConnectionConfig } from '@aidb/core';
import type { BridgeClient } from './bridge';
import { colors, radius } from './theme';

interface Props {
  visible: boolean;
  onClose: () => void;
  bridge: BridgeClient;
  connections: ConnectionConfig[];
  activeConnectionId?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultsFor(command: CommandDefinition): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const slot of command.slots) {
    if (slot.kind === 'sources' || slot.kind === 'mapping') continue;
    if (slot.default !== undefined) values[slot.key] = slot.default;
    else if (slot.kind === 'boolean') values[slot.key] = false;
    else if (slot.kind === 'number') values[slot.key] = undefined;
    else values[slot.key] = '';
  }
  return values;
}

function initialSources(command: CommandDefinition, connections: ConnectionConfig[], activeId?: string): string[] {
  const first = connections.find((connection) => connection.id === activeId) ?? connections[0];
  if (!first) return [];
  const result = [first.id];
  for (const connection of connections) {
    if (result.length >= command.sources.min) break;
    if (!result.includes(connection.id)) result.push(connection.id);
  }
  return result;
}

export function CommandSheet({ visible, onClose, bridge, connections, activeConnectionId }: Props) {
  const [command, setCommand] = useState<CommandDefinition | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [run, setRun] = useState<CommandRunInfo | null>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!visible) {
      cancelled.current = true;
      setCommand(null);
      setRun(null);
      setResult(null);
      setError(null);
      setBusy(false);
      return;
    }
    cancelled.current = false;
  }, [visible]);

  const select = (next: CommandDefinition) => {
    setCommand(next);
    setSourceIds(initialSources(next, connections, activeConnectionId));
    setValues({ ...defaultsFor(next), leftTable: '', leftKeys: 'id', rightTable: '', rightKeys: 'id' });
    setRun(null);
    setResult(null);
    setError(null);
  };

  const toggleSource = (id: string) => {
    if (!command) return;
    setSourceIds((current) => {
      if (current.includes(id)) {
        if (current.length <= command.sources.min) return current;
        return current.filter((item) => item !== id);
      }
      if (current.length >= command.sources.max) return current;
      return [...current, id];
    });
  };

  const setValue = (key: string, value: unknown) => setValues((current) => ({ ...current, [key]: value }));

  const runCommand = async () => {
    if (!command || busy) return;
    setBusy(true);
    setError(null);
    setRun(null);
    setResult(null);
    try {
      const sources = sourceIds
        .map((id) => connections.find((connection) => connection.id === id))
        .filter((connection): connection is ConnectionConfig => Boolean(connection))
        .map((connection) => ({ connectionId: connection.id, database: connection.database, label: connection.name }));
      const input: CommandRunInput = { sources, ...values };
      if (command.id === 'recon') {
        const left = connections.find((connection) => connection.id === sourceIds[0]);
        const right = connections.find((connection) => connection.id === sourceIds[1]);
        if (!left || !right) throw new Error('对账需要两个连接');
        if (left.engine === 'redis' || right.engine === 'redis') {
          throw new Error('移动端暂不支持 Redis 异构对账，请使用桌面端');
        }
        input.mapping = {
          mode: 'table-table',
          left: {
            kind: 'table',
            connectionId: left.id,
            database: left.database,
            table: String(values.leftTable ?? ''),
            keyColumns: String(values.leftKeys ?? 'id').split(',').map((value) => value.trim()).filter(Boolean),
          },
          right: {
            kind: 'table',
            connectionId: right.id,
            database: right.database,
            table: String(values.rightTable ?? ''),
            keyColumns: String(values.rightKeys ?? 'id').split(',').map((value) => value.trim()).filter(Boolean),
          },
          baseSide: 'left',
        };
      }
      const started = await bridge.startCommand(command.id, input, {
        title: `${command.title.zh}${sources.length ? ` · ${sources.map((source) => source.label).join(' ↔ ')}` : ''}`,
      });
      let current = started.run;
      setRun(current);
      for (let attempt = 0; attempt < 240 && !cancelled.current; attempt++) {
        if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'canceled') break;
        await sleep(500);
        current = (await bridge.commandRun(current.id)).run;
        setRun({ ...current });
      }
      if (current.artifactId) {
        const runs = await bridge.artifactRuns(current.artifactId, 1);
        setResult(runs.runs[0]?.result ?? null);
      }
      if (current.status !== 'succeeded') setError(current.error?.message ?? (current.status === 'canceled' ? '已取消' : '命令未完成'));
    } catch (err: any) {
      setError(err?.message ?? String(err));
    } finally {
      setBusy(false);
    }
  };

  const available = useMemo(() => COMMANDS.filter((item) => item.id !== 'ask'), []);
  const selectedConnections = sourceIds
    .map((id) => connections.find((connection) => connection.id === id))
    .filter((connection): connection is ConnectionConfig => Boolean(connection));

  const renderFormValue = (slot: CommandDefinition['slots'][number]) => {
    const value = values[slot.key];
    if (slot.kind === 'text') {
      return (
        <View key={slot.key} style={styles.field}>
          <Text style={styles.label}>{slot.label.zh}</Text>
          <TextInput
            style={styles.input}
            value={String(value ?? '')}
            onChangeText={(text) => setValue(slot.key, text)}
            placeholder={slot.placeholder}
            placeholderTextColor={colors.muted}
          />
        </View>
      );
    }
    if (slot.kind === 'enum') {
      return (
        <View key={slot.key} style={styles.field}>
          <Text style={styles.label}>{slot.label.zh}</Text>
          <View style={styles.chips}>
            {(slot.options ?? []).map((option) => (
              <Pressable
                key={option.value}
                style={[styles.chip, String(value) === option.value && styles.chipActive]}
                onPress={() => setValue(slot.key, option.value)}
              >
                <Text style={[styles.chipText, String(value) === option.value && styles.chipTextActive]}>{option.label.zh}</Text>
              </Pressable>
            ))}
          </View>
        </View>
      );
    }
    if (slot.kind === 'boolean') {
      return (
        <Pressable key={slot.key} style={styles.field} onPress={() => setValue(slot.key, !value)}>
          <View style={styles.toggleRow}>
            <Text style={styles.label}>{slot.label.zh}</Text>
            <Text style={{ color: value ? colors.accent : colors.muted, fontSize: 12 }}>{value ? '开' : '关'}</Text>
          </View>
        </Pressable>
      );
    }
    if (slot.kind === 'number') {
      return (
        <View key={slot.key} style={styles.field}>
          <Text style={styles.label}>{slot.label.zh}</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            value={value === undefined ? '' : String(value)}
            onChangeText={(text) => setValue(slot.key, text ? Number(text) : undefined)}
          />
        </View>
      );
    }
    if (slot.kind === 'tables') {
      return (
        <View key={slot.key} style={styles.field}>
          <Text style={styles.label}>{slot.label.zh}</Text>
          <Text style={styles.hint}>移动端暂不提供表多选，留空表示对比默认范围。</Text>
        </View>
      );
    }
    if (slot.kind === 'period') {
      return (
        <View key={slot.key} style={styles.field}>
          <Text style={styles.label}>{slot.label.zh}</Text>
          <TextInput
            style={styles.input}
            value={String(value ?? '')}
            onChangeText={(text) => setValue(slot.key, text)}
            placeholder="最近 7 天 / 2026-10-01..2026-10-31"
            placeholderTextColor={colors.muted}
          />
        </View>
      );
    }
    return null;
  };

  const renderResult = () => {
    if (!result) return null;
    if (result.sections) {
      return (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>{result.title}</Text>
          <Text style={styles.hint}>{result.layout} · {result.sources?.length ?? 0} 个源</Text>
          {result.sections.map((section: any) => (
            <View key={section.id} style={styles.resultSection}>
              <Text style={styles.resultSectionTitle}>{section.title}</Text>
              {section.blocks.map((block: any, index: number) => {
                if (block.kind === 'narrative') return <Text key={index} style={styles.resultText}>{block.text}</Text>;
                if (block.kind === 'metric') {
                  return (
                    <Text key={index} style={styles.resultText}>
                      {(block.metrics ?? []).map((metric: any) => `${metric.label}: ${metric.value}${metric.unit ?? ''}`).join('  ·  ')}
                    </Text>
                  );
                }
                if (block.kind === 'comparison') {
                  return (
                    <Text key={index} style={styles.resultText}>
                      {block.left?.label}: {block.left?.value}  /  {block.right?.label}: {block.right?.value}
                      {block.delta ? `  (差值 ${block.delta.absolute})` : ''}
                    </Text>
                  );
                }
                if (block.kind === 'table') {
                  return (
                    <Text key={index} style={styles.hint}>
                      {(block.rows ?? []).slice(0, 8).map((row: any[]) => row.join(' | ')).join('\n')}
                    </Text>
                  );
                }
                if (block.kind === 'callout') return <Text key={index} style={styles.hint}>{block.text}</Text>;
                return null;
              })}
            </View>
          ))}
        </View>
      );
    }
    if (result.summary?.comparedKeys !== undefined) {
      return (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>对账结果</Text>
          <Text style={styles.resultText}>
            缺失 {result.summary.missingInRight} · 多余 {result.summary.extraInRight} · 改值 {result.summary.valueChanged}
          </Text>
          {result.notes?.map((note: string) => <Text key={note} style={styles.hint}>{note}</Text>)}
        </View>
      );
    }
    if (result.summary?.statements !== undefined) {
      return (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>结构差异</Text>
          <Text style={styles.resultText}>新增 {result.summary.added} · 删除 {result.summary.removed} · 变更 {result.summary.changed}</Text>
        </View>
      );
    }
    if (result.findings) {
      return (
        <View style={styles.result}>
          <Text style={styles.resultTitle}>体检结果</Text>
          <Text style={styles.resultText}>{result.findings.length} 项发现 · {result.plan?.length ?? 0} 条修复计划</Text>
          {result.note ? <Text style={styles.hint}>{result.note}</Text> : null}
        </View>
      );
    }
    return null;
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.sheet}>
        <View style={styles.head}>
          {command ? (
            <Pressable style={styles.iconButton} onPress={() => setCommand(null)}>
              <ChevronLeft size={18} color={colors.text} />
            </Pressable>
          ) : <View style={{ width: 30 }} />}
          <Text style={styles.headTitle}>{command ? command.title.zh : '命令'}</Text>
          <Pressable testID="m-command-close" style={styles.iconButton} onPress={onClose}>
            <X size={18} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          {!command ? (
            <View style={{ gap: 8 }}>
              {available.map((item) => (
                <Pressable key={item.id} testID={`m-command-${item.id}`} style={styles.commandRow} onPress={() => select(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.commandTitle}>/{item.id} · {item.title.zh}</Text>
                    <Text style={styles.hint}>{item.description.zh}</Text>
                  </View>
                  <Text style={styles.hint}>{item.sources.min === item.sources.max ? `${item.sources.min} 源` : `${item.sources.min}–${item.sources.max} 源`}</Text>
                </Pressable>
              ))}
            </View>
          ) : (
            <>
              <Text style={styles.hint}>{command.description.zh}</Text>
              <View style={styles.field}>
                <Text style={styles.label}>数据源（{sourceIds.length}/{command.sources.max}）</Text>
                <View style={styles.chips}>
                  {connections.map((connection) => (
                    <Pressable
                      key={connection.id}
                      style={[styles.chip, sourceIds.includes(connection.id) && styles.chipActive]}
                      onPress={() => toggleSource(connection.id)}
                    >
                      <Text style={[styles.chipText, sourceIds.includes(connection.id) && styles.chipTextActive]}>{connection.name}</Text>
                    </Pressable>
                  ))}
                </View>
              </View>
              {command.id === 'recon' ? (
                <View style={{ gap: 10 }}>
                  <Text style={styles.hint}>移动端仅支持表对表；Redis 异构对账请使用桌面端。</Text>
                  <View style={styles.field}>
                    <Text style={styles.label}>{selectedConnections[0]?.name ?? '左'} · 表名</Text>
                    <TextInput style={styles.input} value={String(values.leftTable ?? '')} onChangeText={(text) => setValue('leftTable', text)} placeholder="users" placeholderTextColor={colors.muted} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>左键列</Text>
                    <TextInput style={styles.input} value={String(values.leftKeys ?? '')} onChangeText={(text) => setValue('leftKeys', text)} placeholder="id" placeholderTextColor={colors.muted} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>{selectedConnections[1]?.name ?? '右'} · 表名</Text>
                    <TextInput style={styles.input} value={String(values.rightTable ?? '')} onChangeText={(text) => setValue('rightTable', text)} placeholder="users" placeholderTextColor={colors.muted} />
                  </View>
                  <View style={styles.field}>
                    <Text style={styles.label}>右键列</Text>
                    <TextInput style={styles.input} value={String(values.rightKeys ?? '')} onChangeText={(text) => setValue('rightKeys', text)} placeholder="id" placeholderTextColor={colors.muted} />
                  </View>
                </View>
              ) : null}
              {command.slots.filter((slot) => slot.kind !== 'sources' && slot.kind !== 'mapping').map(renderFormValue)}
              {run ? (
                <View style={styles.result}>
                  <Text style={styles.resultTitle}>执行</Text>
                  {run.steps.map((step) => (
                    <Text key={step.id} style={styles.resultText}>{step.status} · {step.label}{step.summary ? ` · ${step.summary}` : ''}</Text>
                  ))}
                </View>
              ) : null}
              {error ? <Text style={styles.error}>{error}</Text> : null}
              {renderResult()}
            </>
          )}
        </ScrollView>
        {command ? (
          <View style={styles.foot}>
            <Pressable testID="m-command-run" style={[styles.runButton, busy && { opacity: 0.5 }]} onPress={() => void runCommand()} disabled={busy}>
              {busy ? <ActivityIndicator size="small" color="#0b0d0d" /> : <Play size={14} color="#0b0d0d" />}
              <Text style={styles.runText}>{busy ? '运行中…' : '运行'}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: colors.bg },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 8 },
  headTitle: { flex: 1, color: colors.text, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  iconButton: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  body: { padding: 14, gap: 12, paddingBottom: 30 },
  commandRow: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 12 },
  commandTitle: { color: colors.text, fontSize: 13, fontWeight: '600' },
  field: { gap: 6 },
  label: { color: colors.secondary, fontSize: 11 },
  hint: { color: colors.muted, fontSize: 10, lineHeight: 15 },
  input: { backgroundColor: colors.code, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 8, color: colors.text, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  chipText: { color: colors.muted, fontSize: 11 },
  chipTextActive: { color: colors.accent },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6 },
  result: { gap: 6, marginTop: 8, padding: 10, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md },
  resultTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  resultSection: { gap: 4, marginTop: 4 },
  resultSectionTitle: { color: colors.secondary, fontSize: 12, fontWeight: '600' },
  resultText: { color: colors.text, fontSize: 12, lineHeight: 18 },
  error: { color: colors.danger, fontSize: 12 },
  foot: { padding: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  runButton: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: colors.accent, borderRadius: radius.md, paddingVertical: 11 },
  runText: { color: '#0b0d0d', fontSize: 13, fontWeight: '600' },
});
