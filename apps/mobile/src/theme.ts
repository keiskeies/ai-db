export const colors = {
  bg: '#05070d',
  panel: '#0a0f18',
  elevated: '#0e1522',
  hover: '#131c2d',
  border: '#152033',
  borderStrong: '#233250',
  text: '#e8f0ff',
  secondary: '#90a4c2',
  muted: '#5a6d8a',
  accent: '#4d7cff',
  accentSoft: 'rgba(77,124,255,0.14)',
  cyan: '#22d3ee',
  agent: '#9a7bff',
  agentSoft: 'rgba(154,123,255,0.13)',
  success: '#2dd4a7',
  successSoft: 'rgba(45,212,167,0.14)',
  warning: '#f5c451',
  warningSoft: 'rgba(245,196,81,0.14)',
  danger: '#ff6b81',
  dangerSoft: 'rgba(255,107,129,0.14)',
  code: '#04070c',
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
