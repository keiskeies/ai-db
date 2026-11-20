import type { Dispatch, SetStateAction } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { Table2, X } from 'lucide-react-native';
import { type TableInfo } from '@aidb/core';
import { colors } from '../../theme';
import { styles } from '../../styles';
import type { PickerKind, EdgeInsets } from '../../types';
import { Text } from '../../components/base';

export function TablesSheet({ setPicker, insets, tables, setInput }: { setPicker: Dispatch<SetStateAction<PickerKind>>; insets: EdgeInsets; tables: TableInfo[]; setInput: Dispatch<SetStateAction<string>>; }) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPicker(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 14, maxHeight: '70%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>引用表</Text>
                <Pressable style={styles.iconButton} onPress={() => setPicker(null)}>
                  <X size={16} color={colors.text} />
                </Pressable>
              </View>
              <ScrollView>
                {tables.map((table) => (
                  <Pressable
                    key={table.name}
                    style={styles.sessionRow}
                    onPress={() => {
                      setInput((prev) => `${prev}${prev && !prev.endsWith(' ') ? ' ' : ''}@${table.name} `);
                      setPicker(null);
                    }}
                  >
                    <Table2 size={14} color={colors.accent} />
                    <Text style={styles.listTitle}>{table.name}</Text>
                    <Text style={styles.listMeta}>{table.columns?.length ?? 0} 列</Text>
                  </Pressable>
                ))}
                {!tables.length ? <Text style={[styles.hint, { padding: 14 }]}>当前连接没有可引用表</Text> : null}
              </ScrollView>
            </View>
          </View>
        </Modal>
  );
}
