import type { Dispatch, SetStateAction } from 'react';
import { ActivityIndicator, Pressable, ScrollView, View } from 'react-native';
import { Check, ChevronLeft, Pencil, Plus, Search, Trash2 } from 'lucide-react-native';
import { type Memory } from '@aidb/core';
import type { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { translate } from '../i18n';
import { styles } from '../styles';
import { notify, confirmAction, timeAgo } from '../lib/utils';
import type { MemoryDraft } from '../types';
import { Text, TextInput } from '../components/base';

export function MemoryScreen({ setMePage, memories, setMemoryDraft, memoryQuery, setMemoryQuery, loadMemories, memoryLoading, client }: { setMePage: Dispatch<SetStateAction<'memory' | 'connections' | 'settings' | null>>; memories: Memory[]; setMemoryDraft: Dispatch<SetStateAction<MemoryDraft | null>>; memoryQuery: string; setMemoryQuery: Dispatch<SetStateAction<string>>; loadMemories: (q?: string) => Promise<void>; memoryLoading: boolean; client: BridgeClient; }) {
  return (
          <View style={{ flex: 1 }}>
            <View style={styles.tableHead}>
              <Pressable testID="m-memory-back" style={styles.iconButton} onPress={() => setMePage(null)}>
                <ChevronLeft size={18} color={colors.text} />
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={styles.listTitle}>记忆</Text>
                <Text style={styles.listMeta}>{translate('{0} 条 · 跨会话召回', [memories.length])}</Text>
              </View>
              <Pressable testID="m-memory-new" style={styles.iconButton} onPress={() => setMemoryDraft({ kind: 'fact', title: '', content: '' })}>
                <Plus size={16} color={colors.text} />
              </Pressable>
            </View>
            <View style={styles.searchRow}>
              <Search size={14} color={colors.muted} />
              <TextInput
                style={styles.searchInput}
                value={memoryQuery}
                onChangeText={setMemoryQuery}
                placeholder="搜索记忆…"
                placeholderTextColor={colors.muted}
                returnKeyType="search"
                onSubmitEditing={() => void loadMemories()}
              />
              <Pressable style={styles.iconButton} onPress={() => void loadMemories()}>
                <Search size={14} color={colors.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
              {memoryLoading ? <ActivityIndicator color={colors.accent} /> : null}
              {memories.map((memory) => (
                <View key={memory.id} style={styles.memoryCard}>
                  <View style={styles.rowBetween}>
                    <Text style={styles.memoryKind}>{memory.kind}</Text>
                    <Text style={styles.listMeta}>{memory.scopeType} · {timeAgo(memory.updatedAt)}</Text>
                  </View>
                  <Text style={styles.memoryTitle}>{memory.title}</Text>
                  <Text style={styles.memoryContent}>{memory.content}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Pressable
                      style={styles.pinRow}
                      onPress={async () => {
                        try {
                          await client.updateMemory(memory.id, { pinned: !memory.pinned });
                          void loadMemories();
                        } catch {
                          /* ignore */
                        }
                      }}
                    >
                      <Check size={11} color={memory.pinned ? colors.warning : colors.muted} />
                      <Text style={[styles.listMeta, memory.pinned && { color: colors.warning }]}>{memory.pinned ? '已置顶' : '置顶'}</Text>
                    </Pressable>
                    <Pressable style={styles.pinRow} onPress={() => setMemoryDraft({ id: memory.id, kind: memory.kind, title: memory.title, content: memory.content })}>
                      <Pencil size={11} color={colors.muted} />
                      <Text style={styles.listMeta}>编辑</Text>
                    </Pressable>
                    <Pressable
                      style={styles.pinRow}
                      onPress={async () => {
                        if (!(await confirmAction('删除记忆', memory.title, '删除'))) return;
                        try {
                          await client.deleteMemory(memory.id);
                          void loadMemories();
                        } catch (err: any) {
                          notify('删除失败', err?.message ?? '');
                        }
                      }}
                    >
                      <Trash2 size={11} color={colors.muted} />
                      <Text style={styles.listMeta}>删除</Text>
                    </Pressable>
                  </View>
                </View>
              ))}
              {!memories.length && !memoryLoading ? <Text style={styles.hint}>还没有记忆。与 AI 对话时它会自动沉淀事实、偏好与结论。</Text> : null}
            </ScrollView>
          </View>
  );
}
