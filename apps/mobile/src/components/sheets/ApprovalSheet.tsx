import { Modal, Pressable, ScrollView, View } from 'react-native';
import { ShieldAlert } from 'lucide-react-native';
import { colors, riskColor, riskLabels } from '../../theme';
import { styles } from '../../styles';
import type { ApprovalState, EdgeInsets } from '../../types';
import { Text } from '../../components/base';

export function ApprovalSheet({ approval, resolveApproval, insets }: { approval: ApprovalState; resolveApproval: (decision: 'allow' | 'deny', scope: 'once' | 'session' | 'always') => Promise<void>; insets: EdgeInsets; }) {
  return (
        <Modal visible transparent animationType="slide" onRequestClose={() => void resolveApproval('deny', 'once')}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { paddingBottom: insets.bottom + 16 }]}>
              <View style={styles.sheetHead}>
                <ShieldAlert size={17} color={colors.warning} />
                <Text style={styles.sheetTitle}>需要授权</Text>
                <View style={[styles.riskBadge, { borderColor: riskColor(approval.risk) }]}>
                  <Text style={[styles.riskText, { color: riskColor(approval.risk) }]}>{riskLabels[approval.risk] ?? approval.risk}</Text>
                </View>
              </View>
              <Text style={styles.approvalTool}>{approval.tool}</Text>
              <Text style={styles.approvalSummary}>{approval.summary}</Text>
              {approval.sql ? (
                <ScrollView style={styles.approvalSql}>
                  <Text style={styles.codeText}>{approval.sql}</Text>
                </ScrollView>
              ) : null}
              {approval.risk === 'destructive' ? (
                <Text style={[styles.hint, { color: colors.danger, marginBottom: 8 }]}>破坏性操作：可能永久删除数据，Agent 会按设置先尝试备份。</Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 12 }}>
                <Pressable style={[styles.secondaryButton, { flex: 1 }]} onPress={() => void resolveApproval('deny', 'once')}>
                  <Text style={styles.secondaryButtonText}>拒绝</Text>
                </Pressable>
                <Pressable style={[styles.paleButton, { flex: 1 }]} onPress={() => void resolveApproval('allow', 'once')}>
                  <Text style={styles.paleButtonText}>仅此一次</Text>
                </Pressable>
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                <Pressable style={[styles.paleButton, { flex: 1 }]} onPress={() => void resolveApproval('allow', 'session')}>
                  <Text style={styles.paleButtonText}>本会话允许</Text>
                </Pressable>
                <Pressable style={[styles.primaryButton, { flex: 1, marginTop: 0 }]} onPress={() => void resolveApproval('allow', 'always')}>
                  <Text style={styles.primaryButtonText}>始终允许</Text>
                </Pressable>
              </View>
            </View>
          </View>
        </Modal>
  );
}
