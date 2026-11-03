import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BASE = process.env.QA_BASE ?? 'http://127.0.0.1:8787';
export const TOKEN = process.env.QA_TOKEN ?? 'dev-token';

export const results = [];
let currentSection = 'general';

export function section(name) {
  currentSection = name;
  console.log(`\n=== ${name} ===`);
}

export function record(name, ok, detail, sectionName = currentSection) {
  results.push({ section: sectionName, name, ok, detail: detail ?? null });
  const mark = ok ? 'PASS' : 'FAIL';
  if (!ok) {
    const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
    console.log(`[${mark}] ${sectionName} :: ${name} — ${String(text ?? '').slice(0, 500)}`);
  }
  return ok;
}

export function check(name, cond, detail) {
  return record(name, Boolean(cond), cond ? undefined : detail);
}

export function checkEqual(name, actual, expected, extra) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  return record(name, ok, ok ? undefined : { expected, actual, ...(extra ?? {}) });
}

export function fail(name, detail) {
  return record(name, false, detail);
}

export function pass(name, detail) {
  return record(name, true, detail);
}

export async function api(method, path, body, opts = {}) {
  const started = Date.now();
  const headers = { authorization: `Bearer ${TOKEN}`, ...(opts.headers ?? {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, ms: Date.now() - started };
}

export async function expectOk(name, method, path, body, validate) {
  let res;
  try {
    res = await api(method, path, body);
  } catch (err) {
    return fail(name, `request threw: ${err.message}`);
  }
  if (res.status < 200 || res.status >= 300) {
    return fail(name, { status: res.status, error: res.json?.error ?? res.text.slice(0, 400) });
  }
  if (!validate) return pass(name);
  try {
    const out = await validate(res.json, res);
    return out === false ? fail(name, { status: res.status, body: truncate(res.json) }) : pass(name, typeof out === 'string' ? out : undefined);
  } catch (err) {
    return fail(name, `validation threw: ${err.message} :: ${truncate(res.json)}`);
  }
}

export async function expectError(name, method, path, body, status, code) {
  const res = await api(method, path, body);
  const okStatus = Array.isArray(status) ? status.includes(res.status) : res.status === status;
  const okCode = code ? res.json?.error?.code === code : true;
  return record(name, okStatus && okCode, { status: res.status, expected: status, code: res.json?.error?.code, expectedCode: code, error: res.json?.error });
}

export function truncate(value) {
  return String(typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 400);
}

/**
 * Minimal SSE client: resolves with all events once the stream ends or `until(event)` returns true.
 */
export async function sse(path, body, { onEvent, timeoutMs = 240000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];
  try {
    const res = await fetch(BASE + '/api' + path, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body ?? {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      return { status: res.status, events, text };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let stop = false;
    while (!stop) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const dataLines = raw
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim());
        if (!dataLines.length) continue;
        let event;
        try {
          event = JSON.parse(dataLines.join('\n'));
        } catch {
          continue;
        }
        event.__raw = raw;
        events.push(event);
        if (onEvent) {
          const action = await onEvent(event, events);
          if (action === 'stop') stop = true;
        }
        if (event.type === 'done' || event.type === 'error' || (raw.includes('event: done') && !event.type)) stop = true;
      }
      if (stop) {
        controller.abort();
        break;
      }
    }
    return { status: res.status, events };
  } catch (err) {
    return { status: 0, events, text: err.name === 'AbortError' ? 'timeout/aborted' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

export function saveReport(file, meta = {}) {
  mkdirSync(dirname(file), { recursive: true });
  const summary = {
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    bySection: {},
  };
  for (const result of results) {
    summary.bySection[result.section] ??= { total: 0, failed: 0 };
    summary.bySection[result.section].total += 1;
    if (!result.ok) summary.bySection[result.section].failed += 1;
  }
  writeFileSync(file, JSON.stringify({ meta: { ...meta, at: new Date().toISOString() }, summary, results }, null, 2));
  console.log(`\nSUMMARY ${summary.passed}/${summary.total} passed, ${summary.failed} failed → ${file}`);
  for (const [name, value] of Object.entries(summary.bySection)) {
    if (value.failed) console.log(`  ${name}: ${value.failed}/${value.total} failed`);
  }
  if (summary.failed) {
    console.log('\nFAILURES:');
    for (const result of results.filter((r) => !r.ok)) {
      const detail = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail);
      console.log(`- [${result.section}] ${result.name}: ${String(detail).slice(0, 800)}`);
    }
  }
  return summary;
}
