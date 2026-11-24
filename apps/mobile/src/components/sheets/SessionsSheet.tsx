import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Archive, ArchiveRestore, Pencil, Plus, Search, TerminalSquare, Trash2, X } from 'lucide-react-native';
import type { AgentSessionMeta } from '@aidb/core';
import { colors, modeLabels } from '../../theme';
import { styles } from '../../styles';
import { timeAgo } from '../../lib/utils';
import type { PickerKind, RenameTarget, EdgeInsets } from '../../types';
import { Text, TextInput } from '../../components/base';

export function SessionsSheet({ setPicker, insets, newSession, sessionQuery, setSessionQuery, sessionView, setSessionView, sessions, archivedSessions, sessionId, openSession, setRenameTarget, deleteSession, archiveSession }: {
  setPicker: Dispatch<SetStateAction<PickerKind>>;
  insets: EdgeInsets;
  newSession: () => Promise<void>;
  sessionQuery: string;
  setSessionQuery: Dispatch<SetStateAction<string>>;
  sessionView: 'active' | 'archived';
  setSessionView: Dispatch<SetStateAction<'active' | 'archived'>>;
  sessions: AgentSessionMeta[];
  archivedSessions: AgentSessionMeta[];
  sessionId: string | undefined;
  openSession: (id: string) => Promise<void>;
  setRenameTarget: Dispatch<SetStateAction<RenameTarget | null>>;
  deleteSession: (id: string) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
}) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>会话</Text>
                <Pressable style={styles.primarySmall} onPress={() => void newSession()}>
                  <Plus size={13} color={colors.onSolid} />
                  <Text style={styles.primarySmallText}>新会话</Text>
                </Pressable>
                <Pressable testID="m-sessions-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={styles.searchRow}>
                <Search size={14} color={colors.muted} />
                <TextInput
                  style={styles.searchInput}
                  value={sessionQuery}
                  onChangeText={setSessionQuery}
                  placeholder="搜索会话…"
                  placeholderTextColor={colors.muted}
                  autoCorrect={false}
                />
              </View>
              <View style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 14, paddingBottom: 8 }}>
                {(['active', 'archived'] as const).map((view) => (
                  <Pressable key={view} style={[styles.modeChip, sessionView === view && styles.modeChipActive]} onPress={() => setSessionView(view)}>
                    <Text style={[styles.modeChipText, sessionView === view && { color: colors.accent }]}>{view === 'active' ? `活跃 ${sessions.length}` : `已归档 ${archivedSessions.length}`}</Text>
                  </Pressable>
                ))}
              </View>
              <ScrollView>
                {(sessionView === 'archived' ? archivedSessions : sessions)
                  .filter((session) => !sessionQuery.trim() || session.title.toLowerCase().includes(sessionQuery.trim().toLowerCase()))
                  .map((session) => (
                    <Pressable key={session.id} style={[styles.sessionRow, session.id === sessionId && { backgroundColor: colors.accentSoft }]} onPress={() => void openSession(session.id)}>
                      <TerminalSquare size={14} color={colors.agent} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.listTitle} numberOfLines={1}>{session.title}</Text>
                        <Text style={styles.listMeta}>{timeAgo(session.updatedAt)} · {modeLabels[session.permissionMode]}</Text>
                      </View>
                      <Pressable
                        testID={`m-session-archive-${session.id}`}
                        hitSlop={8}
                        style={{ paddingHorizontal: 6 }}
                        onPress={() => void archiveSession(session.id, sessionView === 'active')}
                      >
                        {sessionView === 'active' ? <Archive size={13} color={colors.muted} /> : <ArchiveRestore size={13} color={colors.muted} />}
                      </Pressable>
                      <Pressable testID={`m-session-rename-${session.id}`} hitSlop={8} style={{ paddingHorizontal: 6 }} onPress={() => setRenameTarget({ id: session.id, title: session.title })}>
                        <Pencil size={13} color={colors.muted} />
                      </Pressable>
                      <Pressable testID={`m-session-delete-${session.id}`} hitSlop={8} onPress={() => void deleteSession(session.id)}>
                        <Trash2 size={14} color={colors.muted} />
                      </Pressable>
                    </Pressable>
                  ))}
                {!sessions.length ? <Text style={[styles.hint, { padding: 14 }]}>还没有会话</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
  );
}
