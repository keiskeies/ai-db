// 与桌面端 tokens.css 同一套：铸铁底 + 铜强调，冷色只留给 Agent
export const colors = {
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
