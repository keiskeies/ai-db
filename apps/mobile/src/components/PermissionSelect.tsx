import { useState } from 'react';
import { Modal, Pressable, View } from 'react-native';
import { Check, ChevronDown, Lock, ShieldAlert, X } from 'lucide-react-native';
import type { PermissionMode } from '@aidb/core';
import { colors, modeLabels } from '../theme';
import { styles } from '../styles';
import { Text } from './base';

const MODES: PermissionMode[] = ['readonly', 'ask', 'auto', 'full'];
const modeDescriptions: Record<PermissionMode, string> = {
  readonly: '只查询，不允许任何写入或结构变更',
  ask: '每次写入、DDL 或破坏性操作都先询问',
  auto: '非破坏性操作自动执行，破坏性操作仍询问',
  full: '在审批策略允许的范围内全部自动执行',
};

export function PermissionSelect({ mode, onChange, testID = 'm-mode-select' }: { mode: PermissionMode; onChange: (mode: PermissionMode) => void; testID?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable testID={testID} style={styles.modeSelect} onPress={() => setOpen(true)}>
        {mode === 'readonly' ? <Lock size={10} color={colors.accent} /> : <ShieldAlert size={10} color={colors.muted} />}
        <Text style={styles.modeSelectText}>{modeLabels[mode]}</Text>
        <ChevronDown size={10} color={colors.muted} />
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={styles.modalBackdrop}>
          <View style={styles.sheet}>
            <View style={styles.sheetHead}>
              <Text style={styles.sheetTitle}>权限模式</Text>
              <Pressable style={styles.iconButton} onPress={() => setOpen(false)}>
                <X size={16} color={colors.text} />
              </Pressable>
            </View>
            {MODES.map((value) => (
              <Pressable
                key={value}
                testID={`m-mode-${value}`}
                style={[styles.sessionRow, mode === value && { backgroundColor: colors.accentSoft }]}
                onPress={() => {
                  onChange(value);
                  setOpen(false);
                }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.listTitle}>{modeLabels[value]}</Text>
                  <Text style={styles.listMeta}>{modeDescriptions[value]}</Text>
                </View>
                {mode === value ? <Check size={14} color={colors.success} /> : null}
              </Pressable>
            ))}
            <Text style={[styles.hint, { paddingHorizontal: 14, paddingBottom: 16 }]}>全自动仍会按审批策略拦截破坏性操作。</Text>
          </View>
        </View>
      </Modal>
    </>
  );
}
