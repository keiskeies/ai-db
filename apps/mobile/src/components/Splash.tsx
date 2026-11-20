import { ActivityIndicator, Pressable, View } from 'react-native';
import { RefreshCw, ShieldAlert } from 'lucide-react-native';
import { colors } from '../theme';
import { styles } from '../styles';
import { Text } from './base';

export function LoadingSplash() {
  return (
      <View style={styles.splash}>
        <ActivityIndicator color={colors.accent} />
        <Text style={[styles.hint, { marginTop: 10 }]}>正在连接 Bridge…</Text>
      </View>
  );
}

export function ErrorSplash({ error, bootstrap, onDisconnect }: { error: string; bootstrap: () => Promise<void>; onDisconnect: () => void }) {
  return (
      <View style={[styles.splash, { paddingHorizontal: 24 }]}>
        <ShieldAlert size={30} color={colors.danger} />
        <Text style={[styles.pairTitle, { fontSize: 18, marginTop: 12 }]}>连接失败</Text>
        <Text style={[styles.hint, { textAlign: 'center' }]}>{error}</Text>
        <Pressable style={styles.primaryButton} onPress={() => void bootstrap()}>
          <RefreshCw size={14} color={colors.onSolid} />
          <Text style={styles.primaryButtonText}>重试</Text>
        </Pressable>
        <Pressable onPress={() => void onDisconnect()} style={{ marginTop: 12 }}>
          <Text style={{ color: colors.muted, fontSize: 12 }}>重新配对</Text>
        </Pressable>
      </View>
  );
}
