import React from 'react';
import { Pressable, View } from 'react-native';
import { Sparkles, Table2, User, Wrench } from 'lucide-react-native';
import { colors } from '../theme';
import { styles } from '../styles';
import type { TabKey } from '../types';
import { Text } from './base';

export function BottomTabs({ tab, setTab, busy, bottom }: { tab: TabKey; setTab: (tab: TabKey) => void; busy: boolean; bottom: number }) {
  const tabs: Array<{ key: TabKey; label: string; icon: React.ReactNode }> = [
    { key: 'chat', label: '对话', icon: <Sparkles size={17} color={tab === 'chat' ? colors.agent : colors.muted} /> },
    { key: 'data', label: '数据', icon: <Table2 size={17} color={tab === 'data' ? colors.accent : colors.muted} /> },
    { key: 'tools', label: '工具', icon: <Wrench size={17} color={tab === 'tools' ? colors.accent : colors.muted} /> },
    { key: 'me', label: '我的', icon: <User size={17} color={tab === 'me' ? colors.accent : colors.muted} /> },
  ];
  return (
    <View style={[styles.bottomTabs, { paddingBottom: Math.max(bottom, 6) }]}>
      {tabs.map((item) => (
        <Pressable key={item.key} testID={`m-tab-${item.key}`} style={styles.bottomTab} onPress={() => setTab(item.key)}>
          <View>
            {item.icon}
            {item.key === 'chat' && busy ? <View style={styles.busyDot} /> : null}
          </View>
          <Text style={[styles.bottomLabel, tab === item.key && { color: item.key === 'chat' ? colors.agent : colors.accent }]}>{item.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}
