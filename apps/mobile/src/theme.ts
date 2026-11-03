// 与桌面端 tokens.css 同一套：石墨底盘 + 品牌青，金色只做第二数据色
const darkColors = {
  bg: '#0a0c0c',
  chrome: '#0b0e0e',
  panel: '#1d2322',
  elevated: '#272e2c',
  hover: '#262c2b',
  active: '#2d3331',
  border: 'rgba(255,255,255,0.09)',
  borderStrong: 'rgba(255,255,255,0.17)',
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
  overlay: 'rgba(6,8,8,0.78)',
  onSolid: '#0b0d0d',
  brandA: '#45c8c3',
  brandB: '#e0af63',
  onBrand: '#0b0d0d',
};

const lightColors: typeof darkColors = {
  bg: '#e4e7e5',
  chrome: '#e7eae8',
  panel: '#ffffff',
  elevated: '#f4f6f5',
  hover: '#e7eae9',
  active: '#dee2e0',
  border: 'rgba(0,0,0,0.10)',
  borderStrong: 'rgba(0,0,0,0.20)',
  text: '#131716',
  secondary: '#4c5350',
  muted: '#6a726e',
  accent: '#0a7370',
  accentSoft: 'rgba(10,115,112,0.10)',
  cyan: '#96681b',
  agent: '#0a7370',
  agentSoft: 'rgba(10,115,112,0.08)',
  success: '#15784f',
  successSoft: 'rgba(21,120,79,0.10)',
  warning: '#8a5f0d',
  warningSoft: 'rgba(138,95,13,0.09)',
  danger: '#bd3546',
  dangerSoft: 'rgba(189,53,70,0.09)',
  code: '#fbfcfb',
  overlay: 'rgba(16,20,20,0.40)',
  onSolid: '#ffffff',
  brandA: '#45c8c3',
  brandB: '#e0af63',
  onBrand: '#0b0d0d',
};

/** 全局可变的颜色对象：主题切换时就地改写，配合样式重建即可整树重绘。 */
export const colors = { ...darkColors };

export type ThemeResolved = 'dark' | 'light';

let resolved: ThemeResolved = 'dark';

export function setPalette(mode: ThemeResolved): void {
  resolved = mode;
  Object.assign(colors, mode === 'light' ? lightColors : darkColors);
}

export function getThemeMode(): ThemeResolved {
  return resolved;
}

/** 与桌面端 ChartView 的 COLORS 完全一致；两套主题共用，避免图表换色。 */
export const chartPalette = ['#45c8c3', '#e0af63', '#a9c97e', '#8fa8f0', '#e58cb0', '#c48fc8', '#6e9fbf', '#d98e6e'];

const heatPalette = {
  dark: { low: [20, 38, 35], mid: [45, 152, 141], high: [232, 183, 92] },
  light: { low: [226, 241, 237], mid: [137, 211, 202], high: [9, 108, 102] },
};

export function heatTone(ratio: number): string {
  const palette = heatPalette[resolved];
  const t = Math.max(0, Math.min(1, ratio));
  const [from, to, mix] = t <= 0.55 ? [palette.low, palette.mid, t / 0.55] : [palette.mid, palette.high, (t - 0.55) / 0.45];
  const rgb = from.map((value, index) => Math.round(value + (to[index] - value) * mix));
  return `rgb(${rgb.join(',')})`;
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
