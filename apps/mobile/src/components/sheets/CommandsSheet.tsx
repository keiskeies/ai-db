import type { Dispatch, SetStateAction } from 'react';
import { Modal, Platform, Pressable, ScrollView, View } from 'react-native';
import { TerminalSquare, X } from 'lucide-react-native';
import { COMMANDS } from '@aidb/core';
import { colors } from '../../theme';
import { styles } from '../../styles';
import type { EdgeInsets } from '../../types';
import { Text } from '../../components/base';

export function CommandsSheet({ commandOpen, setCommandOpen, insets, setInput, setChatPage }: { commandOpen: boolean; setCommandOpen: Dispatch<SetStateAction<boolean>>; insets: EdgeInsets; setInput: Dispatch<SetStateAction<string>>; setChatPage: Dispatch<SetStateAction<'commands' | null>>; }) {
  return (
      <Modal visible={commandOpen} transparent animationType="slide" onRequestClose={() => setCommandOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '80%' }]}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>命令</Text>
              <Pressable style={styles.iconButton} testID="m-command-close" onPress={() => setCommandOpen(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            <Text style={styles.hint}>选一个目的即可，Agent 会自己理解并执行，不需要填参数。</Text>
            <ScrollView>
              {COMMANDS.filter((command) => command.id !== 'ask').map((command) => (
                <Pressable
                  key={command.id}
                  style={styles.sessionRow}
                  testID={`m-command-${command.id}`}
                  onPress={() => {
                    setCommandOpen(false);
                    setInput(`/${command.id} `);
                  }}
                >
                  <TerminalSquare size={14} color={colors.agent} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listTitle}>{command.title.zh}</Text>
                    <Text style={styles.listMeta} numberOfLines={2}>{command.description.zh}</Text>
                  </View>
                  <Text style={{ color: colors.muted, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 10 }}>/{command.id}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable testID="m-command-workflows" style={[styles.secondaryButton, { marginTop: 10 }]} onPress={() => { setCommandOpen(false); setChatPage('commands'); }}>
              <Text style={styles.secondaryButtonText}>需要数据源或参数？打开命令工作流</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
  );
}
