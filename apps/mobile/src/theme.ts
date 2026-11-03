// 与桌面端 tokens.css 同一套：铸铁底 + 铜强调，冷色只留给 Agent
const darkColors = {
  bg: '#0b0d0d',
  panel: '#111414',
  elevated: '#171b1b',
  hover: '#1e2323',
  border: 'rgba(255,255,255,0.07)',
  borderStrong: 'rgba(255,255,255,0.14)',
  text: '#f1f3f1',
  secondary: '#b8beba',
  muted: '#858d88',
  accent: '#45c8c3',
  accentSoft: 'rgba(69,200,195,0.12)',
  cyan: '#e0af63',
  agent: '#45c8c3',
  agentSoft: 'rgba(69,200,195,0.10)',
  success: '#6fd39a',
  successSoft: 'rgba(111,211,154,0.12)',
  warning: '#e8b75c',
  warningSoft: 'rgba(232,183,92,0.12)',
  danger: '#f07c86',
  dangerSoft: 'rgba(240,124,134,0.12)',
  code: '#0a0c0c',
};

const lightColors: typeof darkColors = {
  bg: '#f4f6f5',
  panel: '#ffffff',
  elevated: '#eef1f0',
  hover: '#e4e9e7',
  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.18)',
  text: '#141817',
  secondary: '#4c5652',
  muted: '#6b7671',
  accent: '#0a7370',
  accentSoft: 'rgba(10,115,112,0.10)',
  cyan: '#a66a12',
  agent: '#0a7370',
  agentSoft: 'rgba(10,115,112,0.08)',
  success: '#1f7a4d',
  successSoft: 'rgba(31,122,77,0.12)',
  warning: '#8a5a00',
  warningSoft: 'rgba(138,90,0,0.12)',
  danger: '#b3261e',
  dangerSoft: 'rgba(179,38,30,0.10)',
  code: '#f7f9f8',
};

/** 全局可变的颜色对象：主题切换时就地改写，配合样式重建即可整树重绘。 */
export const colors = { ...darkColors };

export type ThemeResolved = 'dark' | 'light';

export function setPalette(mode: ThemeResolved): void {
  Object.assign(colors, mode === 'light' ? lightColors : darkColors);
}

export const radius = { sm: 5, md: 9, lg: 13 };

export const modeLabels: Record<string, string> = {
  readonly: '只读',
  ask: '询问',
  auto: '自动',
  full: '全自动',
};

export const riskLabels: Record<string, string> = {
  read: 'READ',
  write: 'WRITE',
  ddl: 'DDL',
  destructive: 'DANGER',
  dynamic: 'SQL',
};

export function riskColor(risk?: string): string {
  if (risk === 'read') return colors.success;
  if (risk === 'write') return colors.warning;
  if (risk === 'ddl') return colors.accent;
  if (risk === 'destructive') return colors.danger;
  return colors.muted;
}
