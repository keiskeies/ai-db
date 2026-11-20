import { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { ChevronLeft, X } from 'lucide-react-native';
import { type ConnectionConfig } from '@aidb/core';
import { BridgeClient } from '../bridge';
import { colors } from '../theme';
import { styles } from '../styles';
import { notify, confirmAction } from '../lib/utils';
import { Text, TextInput } from '../components/base';

export function UsersScreen({ client, connection, onBack }: { client: BridgeClient; connection?: ConnectionConfig; onBack: () => void }) {
  const [state, setState] = useState<{ supported: boolean; users: Array<{ name: string; host?: string; attributes: string[]; superuser?: boolean; disabled?: boolean }>; note?: string }>({ supported: false, users: [] });
  const [draft, setDraft] = useState<{ action: 'create' | 'grant' | 'drop'; name: string; host: string; password: string; privileges: string; scope: string; role: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async () => {
    if (!connection) return;
    try {
      setState(await client.users(connection.id));
    } catch (err: any) {
      notify('加载失败', err?.message ?? '');
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection?.id]);
  const run = async () => {
    if (!connection || !draft || !draft.name.trim()) return;
    setBusy(true);
    try {
      const payload: Record<string, unknown> = { name: draft.name.trim(), host: draft.host.trim() || '%' };
      if (draft.action === 'create') payload.password = draft.password;
      if (draft.action === 'grant') {
        payload.privileges = draft.privileges.trim() || 'SELECT';
        payload.scope = draft.scope.trim() || '*.*';
        payload.role = draft.role.trim() || payload.privileges;
      }
      const result = await client.userAction(connection.id, draft.action, payload);
      notify('执行成功', (result.result.sql ?? []).join('\n'));
      setDraft(null);
      await load();
    } catch (err: any) {
      notify('执行失败', err?.message ?? '');
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ flex: 1 }}>
      <View style={styles.tableHead}>
        <Pressable testID="m-users-back" style={styles.iconButton} onPress={onBack}><ChevronLeft size={18} color={colors.text} /></Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.listTitle}>用户与权限</Text>
          <Text style={styles.listMeta}>{connection?.name ?? '未选择连接'} · {state.supported ? `${state.users.length} 个账户` : '该引擎无服务器账户'}</Text>
        </View>
        {state.supported ? (
          <Pressable testID="m-user-create" style={styles.primarySmall} onPress={() => setDraft({ action: 'create', name: '', host: '%', password: '', privileges: 'SELECT', scope: '*.*', role: '' })}>
            <Text style={styles.primarySmallText}>创建账户</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
        {!state.supported ? <Text style={styles.hint}>{state.note ?? '当前引擎不支持账户管理。'}</Text> : null}
        {state.users.map((user) => (
          <View key={`${user.name}@${user.host ?? ''}`} style={styles.rowCard}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Text style={[styles.listTitle, { flex: 1 }]}>{user.name}{user.host ? `@${user.host}` : ''}</Text>
              {user.disabled ? <Text style={[styles.listMeta, { color: colors.warning }]}>已禁用</Text> : null}
            </View>
            <Text style={styles.listMeta}>{user.attributes.filter(Boolean).join(' · ') || '—'}{user.superuser ? ' · SUPERUSER' : ''}</Text>
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
              <Pressable
                style={styles.modeChip}
                onPress={() => setDraft({ action: 'grant', name: user.name, host: user.host ?? '%', password: '', privileges: 'SELECT', scope: '*.*', role: '' })}
              >
                <Text style={styles.modeChipText}>授权</Text>
              </Pressable>
              <Pressable
                style={styles.modeChip}
                onPress={async () => {
                  if (!connection) return;
                  if (!(await confirmAction('删除账户', `${user.name}${user.host ? '@' + user.host : ''}`, '删除'))) return;
                  try {
                    await client.userAction(connection.id, 'drop', { name: user.name, host: user.host ?? '%' });
                    notify('已删除', '账户已删除');
                    await load();
                  } catch (err: any) {
                    notify('删除失败', err?.message ?? '');
                  }
                }}
              >
                <Text style={[styles.modeChipText, { color: colors.danger }]}>删除</Text>
              </Pressable>
            </View>
          </View>
        ))}
      </ScrollView>
      {draft ? (
        <Modal visible transparent animationType="slide" onRequestClose={() => setDraft(null)}>
          <View style={styles.modalBackdrop}>
            <View style={[styles.sheet, { maxHeight: '86%' }]}>
              <View style={styles.sheetHead}>
                <Text style={styles.sheetTitle}>{draft.action === 'create' ? '创建账户' : draft.action === 'grant' ? '授权' : '删除账户'}</Text>
                <Pressable style={styles.iconButton} onPress={() => setDraft(null)}><X size={16} color={colors.text} /></Pressable>
              </View>
              <ScrollView contentContainerStyle={{ padding: 14, gap: 8 }}>
                <TextInput style={styles.input} value={draft.name} onChangeText={(name) => setDraft({ ...draft, name })} placeholder="账户名" autoCapitalize="none" placeholderTextColor={colors.muted} />
                {connection?.engine === 'mysql' || connection?.engine === 'mariadb' ? (
                  <TextInput style={styles.input} value={draft.host} onChangeText={(host) => setDraft({ ...draft, host })} placeholder="主机，默认 %" autoCapitalize="none" placeholderTextColor={colors.muted} />
                ) : null}
                {draft.action === 'create' ? (
                  <TextInput style={styles.input} value={draft.password} onChangeText={(password) => setDraft({ ...draft, password })} placeholder="密码（至少 4 位）" secureTextEntry placeholderTextColor={colors.muted} />
                ) : null}
                {draft.action === 'grant' ? (
                  <>
                    <TextInput style={styles.input} value={draft.privileges} onChangeText={(privileges) => setDraft({ ...draft, privileges })} placeholder="权限，如 SELECT / ALL PRIVILEGES" autoCapitalize="characters" placeholderTextColor={colors.muted} />
                    <TextInput style={styles.input} value={draft.scope} onChangeText={(scope) => setDraft({ ...draft, scope })} placeholder="范围，如 db.* 或 *.*" autoCapitalize="none" placeholderTextColor={colors.muted} />
                    <TextInput style={styles.input} value={draft.role} onChangeText={(role) => setDraft({ ...draft, role })} placeholder="角色（PostgreSQL/SQL Server 用），可选" autoCapitalize="none" placeholderTextColor={colors.muted} />
                  </>
                ) : null}
                <Pressable style={[styles.primaryButton, busy && { opacity: 0.5 }]} disabled={busy} onPress={() => void run()}>
                  <Text style={styles.primaryButtonText}>{busy ? '执行中…' : '执行'}</Text>
                </Pressable>
              </ScrollView>
            </View>
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

