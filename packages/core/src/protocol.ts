import type { AgentEvent } from './agent/types';

/** Encode an agent event as an SSE frame (used by the Bridge and tests). */
export function encodeSse(event: AgentEvent | { type: 'ping' }): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function sseHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  };
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}
