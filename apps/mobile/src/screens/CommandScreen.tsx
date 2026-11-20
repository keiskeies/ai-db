import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Switch, View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import { COMMANDS, type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { translate } from '../i18n';
import { styles } from '../styles';
import { notify } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function CommandScreen({ client, connections, activeConnection, onBack }: { client: BridgeClient; connections: ConnectionConfig[]; activeConnection?: ConnectionConfig; onBack: () => void }) {
  const [commandId, setCommandId] = useState(COMMANDS[0]?.id ?? 'report');
  const command = COMMANDS.find((item) => item.id === commandId) ?? COMMANDS[0];
  const minSources = Math.max(1, Number((command as any)?.sources?.min ?? 1));
  const maxSources = Math.max(minSources, Number((command as any)?.sources?.max ?? minSources));
  const slots = ((command as any)?.slots ?? []) as Array<{ key: string; kind: string; label: { zh: string }; required?: boolean; default?: unknown; options?: Array<{ value: string; label: { zh: string } }> }>;
  const [sources, setSources] = useState<string[]>(() => Array.from({ length: minSources }, (_, index) => (index === 0 ? activeConnection?.id : connections[index]?.id) ?? '').filter(Boolean));
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<{ id: string; status: string; error?: { message?: string } | string; artifactId?: string } | null>(null);

  useEffect(() => {
    setSources(Array.from({ length: minSources }, (_, index) => (index === 0 ? activeConnection?.id : connections[index]?.id) ?? '').filter(Boolean));
    setValues({});
    setRun(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commandId]);

  const start = async () => {
    const chosen = sources.filter(Boolean);
    if (chosen.length < minSources) {
      notify('无法运行', `需要选择 ${minSources} 个数据源`);
      return;
    }
    const input: Record<string, unknown> = {
      sources: chosen.map((connectionId) => {
        const conn = connections.find((item) => item.id === connectionId);
        return { connectionId, database: conn?.database, label: conn?.name };
      }),
    };
    for (const slot of slots) {
      if (slot.kind === 'sources') continue;
      const raw = values[slot.key];
      if (raw === undefined || raw === '') continue;
      if (slot.kind === 'tables') input[slot.key] = String(raw).split(',').map((item) => item.trim()).filter(Boolean);
      else if (slot.kind === 'mapping') {
        try {
          input[slot.key] = JSON.parse(String(raw));
        } catch {
          notify('映射格式错误', '请输入合法 JSON');
          return;
        }
      } else input[slot.key] = raw;
    }
    setBusy(true);
    try {
      const started = await client.startCommand(command.id, input as any, { title: `${translate(command.title.zh)} · ${translate('移动端')}` });
      setRun({ id: started.run.id, status: started.run.status });
      for (let attempt = 0; attempt < 90; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const detail = await client.commandRun(started.run.id);
        setRun({ id: detail.run.id, status: detail.run.status, error: detail.run.error, artifactId: (detail.run as any).artifactId });
        if (['succeeded', 'failed', 'cancelled'].includes(detail.run.status)) break;
      }
    } catch (err: any) {
      notify('运行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-command-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>命令工作流</Text>
          <Text style={styles.listMeta}>{command.title.zh}</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 10 }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6 }}>
          {COMMANDS.map((item) => (
            <Pressable key={item.id} testID={`m-command-${item.id}`} style={[styles.modeChip, commandId === item.id && styles.modeChipActive]} onPress={() => setCommandId(item.id)}>
              <Text style={[styles.modeChipText, commandId === item.id && { color: colors.accent }]}>{item.title.zh}</Text>
            </Pressable>
          ))}
        </ScrollView>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>数据源（{minSources}–{maxSources}）</Text>
          {sources.map((sourceId, index) => (
            <View key={index} style={{ marginTop: 6 }}>
              <Text style={styles.listMeta}>源 {index + 1}</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 4 }}>
                {connections.map((conn) => (
                  <Pressable
                    key={conn.id}
                    testID={`m-cmd-source-${index}-${conn.id}`}
                    style={[styles.modeChip, sourceId === conn.id && styles.modeChipActive]}
                    onPress={() => setSources((prev) => prev.map((item, i) => (i === index ? conn.id : item)))}
                  >
                    <Text style={[styles.modeChipText, sourceId === conn.id && { color: colors.accent }]}>{conn.name}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ))}
          {sources.length < maxSources ? (
            <Pressable style={[styles.modeChip, { marginTop: 6 }]} onPress={() => setSources((prev) => [...prev, connections[0]?.id ?? ''])}>
              <Text style={styles.modeChipText}>+ 添加数据源</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.card}>
          <Text style={styles.sectionLabel}>参数</Text>
          {slots.filter((slot) => slot.kind !== 'sources').map((slot) => (
            <View key={slot.key} style={{ marginTop: 8 }}>
              <Text style={styles.listMeta}>{slot.label.zh}{slot.required ? ' *' : ''}</Text>
              {slot.kind === 'boolean' ? (
                <Switch
                  value={Boolean(values[slot.key] ?? slot.default ?? false)}
                  onValueChange={(value) => setValues((prev) => ({ ...prev, [slot.key]: value }))}
                />
              ) : slot.kind === 'enum' ? (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, marginTop: 4 }}>
                  {(slot.options ?? []).map((option) => (
                    <Pressable
                      key={option.value}
                      style={[styles.modeChip, values[slot.key] === option.value && styles.modeChipActive]}
                      onPress={() => setValues((prev) => ({ ...prev, [slot.key]: option.value }))}
                    >
                      <Text style={[styles.modeChipText, values[slot.key] === option.value && { color: colors.accent }]}>{option.label.zh}</Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : (
                <TextInput
                  style={[styles.input, slot.kind === 'mapping' && { minHeight: 90, textAlignVertical: 'top' }]}
                  value={String(values[slot.key] ?? slot.default ?? '')}
                  onChangeText={(value) => setValues((prev) => ({ ...prev, [slot.key]: value }))}
                  placeholder={slot.kind === 'tables' ? '表名，英文逗号分隔' : slot.kind === 'mapping' ? 'JSON 映射' : slot.label.zh}
                  placeholderTextColor={colors.muted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  multiline={slot.kind === 'mapping'}
                />
              )}
            </View>
          ))}
        </View>
        <Pressable testID="m-command-run" style={[styles.primaryButton, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void start()}>
          <Text style={styles.primaryButtonText}>{busy ? '运行中…' : `运行 /${command.id}`}</Text>
        </Pressable>
        {run ? (
          <View style={styles.card}>
            <Text style={styles.sectionLabel}>运行状态</Text>
            <Text testID="m-command-status" style={styles.listTitle}>{run.status}</Text>
            {run.error ? <Text style={styles.error}>{typeof run.error === 'string' ? run.error : run.error.message}</Text> : null}
            {run.artifactId ? <Text style={styles.listMeta}>产物：{run.artifactId}</Text> : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

