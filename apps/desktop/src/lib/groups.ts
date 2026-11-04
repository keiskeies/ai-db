import { t as tr } from '../i18n';

/** 内置分组名会写进连接配置，只能以中文原文作数据键，显示时再翻译。 */
export const SYSTEM_GROUPS = ['默认', '示例']; // i18n-ignore

export function groupLabel(stored: string): string {
  return SYSTEM_GROUPS.includes(stored) ? tr(stored) : stored;
}

export function groupFromLabel(label: string): string {
  const hit = SYSTEM_GROUPS.find((group) => tr(group) === label);
  return hit ?? label;
}

/** 连接上的分组归属：空值与内置名都归到「默认」。 */
export function groupOfConnection(groupName?: string): string {
  return groupName && groupName !== '默认' ? groupName : '默认'; // i18n-ignore
}
