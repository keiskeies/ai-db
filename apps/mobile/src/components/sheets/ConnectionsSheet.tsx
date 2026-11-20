import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Check, X } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { colors } from '../../theme';
import { styles } from '../../styles';
import type { PickerKind, EdgeInsets } from '../../types';
import { Text, EngineLogo } from '../../components/base';

export function ConnectionsSheet({ setPicker, insets, connections, activeConnectionId, pendingDatabasePickerRef, setActiveConnectionId, activeDatabase }: { setPicker: Dispatch<SetStateAction<PickerKind>>; insets: EdgeInsets; connections: ConnectionConfig[]; activeConnectionId: string | undefined; pendingDatabasePickerRef: { current: boolean }; setActiveConnectionId: Dispatch<SetStateAction<string | undefined>>; activeDatabase: string | undefined; }) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14 }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>选择连接</Text>
                <Pressable testID="m-connections-close" style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              {connections.map((conn) => (
                <Pressable
                  key={conn.id}
                  testID={`m-connection-${conn.id}`}
                  style={[styles.sessionRow, conn.id === activeConnectionId && { backgroundColor: colors.accentSoft }]}
                  onPress={() => {
                    if (conn.id !== activeConnectionId) pendingDatabasePickerRef.current = true;
                    setActiveConnectionId(conn.id);
                    setPicker(null);
                  }}
                >
                  <EngineLogo engine={conn.engine} size={16} />
                  <View style={{ flex: 1 }}>
                    <Text style={styles.listTitle}>{conn.name}</Text>
                    <Text style={styles.listMeta}>
                      {conn.engine} · {conn.environment}
                      {conn.id === activeConnectionId && activeDatabase ? ` · ${activeDatabase}` : ''}
                    </Text>
                  </View>
                  {conn.id === activeConnectionId ? <Check size={14} color={colors.success} /> : null}
                </Pressable>
              ))}
            </View>
          </View>
        </Modal>
  );
}
