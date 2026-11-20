import { Alert, Platform } from 'react-native';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { translate } from '../i18n';

/** RN Web 没有实现带按钮的 Alert：统一用浏览器原生确认/提示，避免按钮点了没反应。 */
export function notify(title: string, message: string): void {
  const heading = translate(title);
  const body = translate(message);
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') window.alert(`${heading}

${body}`);
    return;
  }
  Alert.alert(heading, body);
}

export async function shareBase64(base64: string, format: string): Promise<void> {
  if (Platform.OS === 'web') {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const mime = format === 'csv' ? 'text/csv' : format === 'json' ? 'application/json' : 'application/octet-stream';
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `export-${Date.now()}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const path = `${FileSystem.cacheDirectory}export-${Date.now()}.${format}`;
  await FileSystem.writeAsStringAsync(path, base64, { encoding: FileSystem.EncodingType.Base64 });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
}

export function humanBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function quoteIdent(name: string, engine: string): string {
  if (engine === 'mysql' || engine === 'mariadb') return `\`${name.replace(/`/g, '``')}\``;
  if (engine === 'sqlserver') return `[${name.replace(/]/g, ']]')}]`;
  return `"${name.replace(/"/g, '""')}"`;
}

export function confirmAction(title: string, message: string, confirmLabel = '确定'): Promise<boolean> {
  if (Platform.OS === 'web') {
    return Promise.resolve(typeof window !== 'undefined' ? window.confirm(`${title}

${message}`) : false);
  }
  return new Promise((resolve) => {
    Alert.alert(
      translate(title),
      translate(message),
      [
        { text: '取消', style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

export function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return translate('刚刚');
  if (diff < 3_600_000) return translate('{0} 分钟前', [Math.round(diff / 60_000)]);
  if (diff < 86_400_000) return translate('{0} 小时前', [Math.round(diff / 3_600_000)]);
  return `${Math.round(diff / 86_400_000)} 天前`;
}
