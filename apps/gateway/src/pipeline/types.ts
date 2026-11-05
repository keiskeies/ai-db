import type { AppSettings } from '@aidb/core';
import type { GatewayConfig } from '../config';
import type { ConnectionManager } from '../manager';
import type { Store } from '../store';

/** 一条 HTTP 凭证在内存里的样子；密文只在这一层出现，不进 spec、不进日志。 */
export interface PipelineCredentialSecret {
  kind: 'bearer' | 'basic' | 'apikey' | 'header';
  token?: string;
  username?: string;
  password?: string;
  header?: string;
  value?: string;
  prefix?: string;
}

export interface StepOutput {
  rows: Record<string, unknown>[];
  columns: string[];
  /** 原始响应/结果集，map 步骤的 select 可以在它上面重新选取。 */
  raw?: unknown;
  meta?: Record<string, unknown>;
  /** 步骤希望回写到流水线 state 的内容（增量断点）。 */
  state?: Record<string, unknown>;
  /** 目标步骤渲染出的 SQL / 请求体，试运行与运行历史都要展示。 */
  preview?: string;
}

export interface RunFrame {
  id: string;
  batchAt: string;
  startedAt: string;
  trigger: 'manual' | 'scheduled' | 'trial';
  attempt: number;
}

export interface StepContext {
  store: Store;
  manager: ConnectionManager;
  settings: AppSettings;
  config: GatewayConfig;
  /** 本次运行的工作目录，脚本与 DuckDB 的临时数据都落在这里。 */
  workDir: string;
  run: RunFrame;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  /** `{{ }}` 绑定作用域：{ params, state, run, steps }。 */
  scope: Record<string, unknown>;
  credential(id: string): PipelineCredentialSecret | null;
  /** 整个运行共享一个内存 DuckDB，步骤里按需注册 input 视图。 */
  duckdb(): Promise<import('./duckdb').DuckdbSession>;
  shouldAbort(): boolean;
  /** 试运行：目标写入与外发请求只渲染不执行。 */
  previewOnly: boolean;
}

export class PipelineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export class PipelineAbortedError extends PipelineError {
  constructor() {
    super('数据流已取消', 'PIPELINE_ABORTED');
    this.name = 'PipelineAbortedError';
  }
}

export function emptyOutput(): StepOutput {
  return { rows: [], columns: [] };
}

export function toInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.trunc(Number(value));
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function asStringMap(value: unknown): Record<string, string> {
  const source = asRecord(value);
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (item === null || item === undefined) continue;
    out[key] = String(item);
  }
  return out;
}

export function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}
