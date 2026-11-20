import { View } from 'react-native';
import { colors } from '../theme';
import { styles } from '../styles';
import { Text, BrandMark } from './base';

export function TopBar({ provider, connected, connName }: { provider: string | undefined; connected: boolean; connName: string }) {
  return (
      <View style={styles.topbar}>
        <View style={styles.brandRow}>
          <BrandMark size={30} />
          <View>
            <Text style={styles.brand}>AiDB Studio</Text>
            <Text style={styles.brandSub}>{provider} · {connected ? 'Bridge 在线' : '重连中…'}</Text>
          </View>
        </View>
        <View style={[styles.connChip, !connected && { opacity: 0.5 }]}>
          <View style={[styles.statusDot, { backgroundColor: connected ? colors.success : colors.warning }]} />
          <Text style={styles.connChipText} numberOfLines={1}>{connName}</Text>
        </View>
      </View>
  );
}
