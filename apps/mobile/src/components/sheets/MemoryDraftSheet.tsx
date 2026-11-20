import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { X } from 'lucide-react-native';
import type { BridgeClient } from '../../bridge';
import { colors } from '../../theme';
import { styles } from '../../styles';
import { notify } from '../../lib/utils';
import type { MemoryDraft, EdgeInsets } from '../../types';
import { Text, TextInput } from '../../components/base';

export function MemoryDraftSheet({ memoryDraft, setMemoryDraft, insets, client, loadMemories }: { memoryDraft: MemoryDraft; setMemoryDraft: Dispatch<SetStateAction<MemoryDraft | null>>; insets: EdgeInsets; client: BridgeClient; loadMemories: (q?: string) => Promise<void>; }) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => setMemoryDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{memoryDraft.id ? '编辑记忆' : '新建记忆'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setMemoryDraft(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={{ padding: 14, gap: 10 }}>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {(['fact', 'preference', 'schema', 'procedural'] as const).map((kind) => (
                    <Pressable
                      key={kind}
                      style={[styles.modeChip, memoryDraft.kind === kind && styles.modeChipActive]}
                      onPress={() => setMemoryDraft({ ...memoryDraft, kind })}
                    >
                      <Text style={[styles.modeChipText, memoryDraft.kind === kind && { color: colors.accent }]}>{kind}</Text>
                    </Pressable>
                  ))}
                </View>
                <TextInput
                  testID="m-memory-title"
                  style={styles.input}
                  value={memoryDraft.title}
                  onChangeText={(title) => setMemoryDraft({ ...memoryDraft, title })}
                  placeholder="标题，例如「GMV 口径」"
                  placeholderTextColor={colors.muted}
                />
                <TextInput
                  testID="m-memory-content"
                  style={[styles.input, { height: 110, textAlignVertical: 'top', paddingTop: 10 }]}
                  value={memoryDraft.content}
                  onChangeText={(content) => setMemoryDraft({ ...memoryDraft, content })}
                  placeholder="内容：事实、口径或流程"
                  placeholderTextColor={colors.muted}
                  multiline
                />
                <Pressable
                  testID="m-memory-save"
                  style={styles.primaryButton}
                  onPress={async () => {
                    const title = memoryDraft.title.trim();
                    const content = memoryDraft.content.trim();
                    if (!title || !content) {
                      notify('无法保存', '标题和内容都不能为空');
                      return;
                    }
                    try {
                      if (memoryDraft.id) await client.updateMemory(memoryDraft.id, { kind: memoryDraft.kind, title, content });
                      else await client.createMemory({ kind: memoryDraft.kind, title, content });
                      setMemoryDraft(null);
                      void loadMemories();
                    } catch (err: any) {
                      notify('保存失败', err?.message ?? '');
                    }
                  }}
                >
                  <Text style={styles.primaryButtonText}>保存</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
  );
}
