import { AsyncLocalStorage } from 'node:async_hooks';
import { safeFetch, type EgressOptions } from './egress';
import type { GatewayConfig } from './config';

export type LogLevel = 'info' | 'warn' | 'error';
export type GatewayLogger = (level: LogLevel, event: string, fields?: Record<string, unknown>) => void;

const correlationStorage = new AsyncLocalStorage<string>();
export const runWithCorrelation = <T>(correlationId: string, callback: () => T): T => correlationStorage.run(correlationId, callback);
export const currentCorrelationId = (): string | undefined => correlationStorage.getStore();

export function logGateway(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`;
  if (level === 'error') process.stderr.write(line);
  else process.stdout.write(line);
}

const DURATION_BUCKETS = [10, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 300_000, 1_800_000, 3_600_000];

interface Histogram {
  count: number;
  sum: number;
  buckets: number[];
}

export class GatewayMetrics {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, Histogram>();
  private readonly startedAt = Date.now();

  inc(name: string, labels: Record<string, string> = {}, value = 1): void {
    const key = metricKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    this.gauges.set(metricKey(name, labels), value);
  }

  observe(name: string, durationMs: number, labels: Record<string, string> = {}): void {
    const key = metricKey(name, labels);
    let histogram = this.histograms.get(key);
    if (!histogram) {
      histogram = { count: 0, sum: 0, buckets: DURATION_BUCKETS.map(() => 0) };
      this.histograms.set(key, histogram);
    }
    histogram.count += 1;
    histogram.sum += Math.max(0, durationMs);
    DURATION_BUCKETS.forEach((bucket, index) => {
      if (durationMs <= bucket) histogram!.buckets[index] += 1;
    });
  }

  snapshot(): Record<string, unknown> {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const histograms: Record<string, { count: number; sumMs: number; buckets: Record<string, number> }> = {};
    for (const [key, value] of this.counters) counters[key] = value;
    for (const [key, value] of this.gauges) gauges[key] = value;
    for (const [key, value] of this.histograms) {
      histograms[key] = {
        count: value.count,
        sumMs: value.sum,
        buckets: Object.fromEntries(DURATION_BUCKETS.map((bucket, index) => [String(bucket), value.buckets[index]])),
      };
    }
    return { uptimeMs: Date.now() - this.startedAt, counters, gauges, histograms };
  }
}

function metricKey(name: string, labels: Record<string, string>): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length ? `${name}{${entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(',')}}` : name;
}

export interface OperationalAlert {
  type: 'turn_deadline' | 'agent_terminal_failure' | 'interrupted_work_recovered';
  correlationId?: string;
  turnId?: string;
  sessionId?: string;
  runId?: string;
  code?: string;
  counts?: Record<string, number>;
}

export class AlertSender {
  constructor(private readonly config: GatewayConfig, private readonly egress: EgressOptions = {}) {}

  async send(alert: OperationalAlert): Promise<boolean> {
    if (!this.config.alertWebhookUrl) return false;
    try {
      const response = await safeFetch(this.config.alertWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...alert, instanceId: this.config.instanceId, timestamp: new Date().toISOString() }),
        redirect: 'error',
      }, { ...this.egress, allowPrivateOrigins: this.config.allowedPrivateOrigins, timeoutMs: 5000, maxBytes: 64 * 1024 });
      return response.ok;
    } catch {
      return false;
    }
  }

  notify(alert: OperationalAlert, logger: GatewayLogger = logGateway): void {
    if (!this.config.alertWebhookUrl) return;
    void this.send(alert).then((ok) => {
      if (!ok) logger('warn', 'alert_delivery_failed', { alertType: alert.type, correlationId: alert.correlationId, turnId: alert.turnId, runId: alert.runId });
    });
  }
}
