import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Check, Database, X } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { colors } from '../../theme';
import { styles } from '../../styles';
import type { PickerKind, EdgeInsets } from '../../types';
import { Text } from '../../components/base';

export function DatabasesSheet({ setPicker, insets, activeConnection, databases, activeDatabase, setActiveDatabase, disabled }: { setPicker: Dispatch<SetStateAction<PickerKind>>; insets: EdgeInsets; activeConnection: ConnectionConfig | undefined; databases: string[]; activeDatabase: string | undefined; setActiveDatabase: Dispatch<SetStateAction<string | undefined>>; disabled: boolean; }) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '70%' }]}>
              <View style={styles.sheetHead}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.sheetTitle}>选择数据库</Text>
                  <Text style={styles.listMeta}>{activeConnection?.name ?? ''}{databases.length ? ` · ${databases.length} 个库` : ''}</Text>
                </View>
                <Pressable testID="m-databases-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView>
                {databases.map((name) => (
                  <Pressable
                    key={name}
                    testID={`m-database-${name}`}
                    style={[styles.sessionRow, activeDatabase === name && { backgroundColor: colors.accentSoft }]}
                    disabled={disabled}
                    onPress={() => {
                      setActiveDatabase(name);
                      setPicker(null);
                    }}
                  >
                    <Database size={14} color={colors.accent} />
                    <Text style={[styles.listTitle, { flex: 1 }]} numberOfLines={1}>{name}</Text>
                    {activeDatabase === name ? <Check size={14} color={colors.success} /> : null}
                  </Pressable>
                ))}
                {!databases.length ? <Text style={[styles.hint, { padding: 14 }]}>当前连接没有可切换的数据库。</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
  );
}
