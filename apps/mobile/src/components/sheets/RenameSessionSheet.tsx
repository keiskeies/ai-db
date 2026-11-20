import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { X } from 'lucide-react-native';
import { type AgentSessionMeta } from '@aidb/core';
import type { BridgeClient } from '../../bridge';
import { colors } from '../../theme';
import { styles } from '../../styles';
import { notify } from '../../lib/utils';
import type { RenameTarget } from '../../types';
import { Text, TextInput } from '../../components/base';

export function RenameSessionSheet({ renameTarget, setRenameTarget, client, setSessions, setArchivedSessions, sessionId, setSessionMeta }: { renameTarget: RenameTarget; setRenameTarget: Dispatch<SetStateAction<RenameTarget | null>>; client: BridgeClient; setSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>; setArchivedSessions: Dispatch<SetStateAction<AgentSessionMeta[]>>; sessionId: string | undefined; setSessionMeta: Dispatch<SetStateAction<AgentSessionMeta | undefined>>; }) {
  return (
        <Modal visible transparent animationType="fade" onRequestClose={() => setRenameTarget(null)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.sheet}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>重命名会话</Text>
                <Pressable style={styles.iconButton} onPress={() => setRenameTarget(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <View style={{ padding: 14, gap: 10 }}>
                <TextInput
                  testID="m-rename-input"
                  style={styles.input}
                  value={renameTarget.title}
                  onChangeText={(title) => setRenameTarget({ ...renameTarget, title })}
                  placeholder="会话名称"
                  placeholderTextColor={colors.muted}
                  autoFocus
                />
                <Pressable
                  testID="m-rename-save"
                  style={styles.primaryButton}
                  onPress={async () => {
                    const title = renameTarget.title.trim();
                    if (!title) return;
                    try {
                      const result = await client.renameSession(renameTarget.id, title);
                      setSessions((prev) => prev.map((item) => (item.id === result.session.id ? result.session : item)));
                      setArchivedSessions((prev) => prev.map((item) => (item.id === result.session.id ? result.session : item)));
                      if (sessionId === renameTarget.id) setSessionMeta(result.session);
                      setRenameTarget(null);
                    } catch (err: any) {
                      notify('重命名失败', err?.message ?? '');
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
