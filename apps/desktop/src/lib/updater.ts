import { useEffect, useSyncExternalStore } from 'react';
import { desktopBridge, type UpdateEvent, type UpdateFallbackReason } from './desktop';

/**
 * 更新状态放在模块级的小 store 里，而不是组件的 useState：
 * 「关于」面板关掉再打开、或者在下载中途切走，进度不应该丢。
 * 组件通过 useSyncExternalStore 订阅，主进程事件直接写进这个 store。
 */

export type UpdatePhase = 'unsupported' | 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'ready' | 'error';

export interface UpdaterState {
  phase: UpdatePhase;
  /** auto 能自己下载安装；manual 只能跳下载页。 */
  mode: 'auto' | 'manual';
  /** 为什么是 manual（开发态 / 未签名 / 包管理器安装）。 */
  reason: UpdateFallbackReason;
  currentVersion: string;
  latestVersion: string | null;
  notes: string;
  percent: number;
  downloadUrl: string | null;
  error: { code: string; detail?: string } | null;
}

const INITIAL: UpdaterState = {
  phase: 'idle',
  mode: 'auto',
  reason: null,
  currentVersion: '',
  latestVersion: null,
  notes: '',
  percent: 0,
  downloadUrl: null,
  error: null,
};

let state: UpdaterState = INITIAL;
const listeners = new Set<() => void>();
let started = false;

function set(patch: Partial<UpdaterState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

/** 主进程推来的事件 → 状态机。文案留在界面层，这里只搬事实。 */
function applyEvent(event: UpdateEvent) {
  switch (event.type) {
    case 'checking':
      set({ phase: 'checking', error: null, percent: 0, mode: event.mode ?? state.mode, reason: event.reason ?? state.reason });
      break;
    case 'available':
      set({
        phase: 'available',
        mode: event.mode ?? state.mode,
        reason: event.reason ?? state.reason,
        latestVersion: event.latestVersion ?? null,
        notes: event.notes ?? '',
        percent: 0,
        error: null,
      });
      break;
    case 'latest':
      set({
        phase: 'latest',
        mode: event.mode ?? state.mode,
        reason: event.reason ?? state.reason,
        latestVersion: event.latestVersion ?? state.currentVersion ?? null,
        percent: 0,
        error: null,
      });
      break;
    case 'progress':
      set({ phase: 'downloading', percent: Math.round(event.percent ?? 0) });
      break;
    case 'downloaded':
      set({ phase: 'ready', percent: 100, latestVersion: event.latestVersion ?? state.latestVersion });
      break;
    case 'error':
      set({ phase: 'error', error: { code: event.code ?? 'unknown', detail: event.detail } });
      break;
    default:
      break;
  }
}

function ensureStarted() {
  if (started) return;
  started = true;
  const bridge = desktopBridge?.updater;
  if (!bridge) {
    set({ phase: 'unsupported' });
    return;
  }
  bridge.onEvent(applyEvent);
  void bridge
    .status()
    .then((info) => set({ mode: info.mode, reason: info.reason, currentVersion: info.currentVersion }))
    .catch(() => set({ phase: 'error', error: { code: 'status' } }));
}

export function useUpdater(): UpdaterState {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  useEffect(() => {
    ensureStarted();
  }, []);
  return snapshot;
}

export async function checkForUpdates(): Promise<void> {
  const bridge = desktopBridge?.updater;
  if (!bridge) return;
  set({ phase: 'checking', error: null, percent: 0 });
  try {
    const result = await bridge.check();
    if (result.status === 'error') {
      set({ phase: 'error', error: { code: result.code ?? 'network', detail: result.detail } });
      return;
    }
    // 事件通常会先到；这里兜底一次，避免窗口重建导致事件丢失后停在「检查中」。
    set({
      phase: result.status,
      mode: result.mode,
      reason: result.reason,
      latestVersion: result.latestVersion ?? null,
      notes: result.notes ?? '',
      downloadUrl: result.downloadUrl ?? null,
      error: null,
    });
  } catch (err: any) {
    set({ phase: 'error', error: { code: 'network', detail: String(err?.message ?? err) } });
  }
}

export async function downloadUpdate(): Promise<void> {
  const bridge = desktopBridge?.updater;
  if (!bridge) return;
  set({ phase: 'downloading', percent: 0, error: null });
  try {
    const result = await bridge.download();
    if (!result.ok) set({ phase: 'error', error: { code: result.code ?? 'download' } });
  } catch (err: any) {
    set({ phase: 'error', error: { code: 'download', detail: String(err?.message ?? err) } });
  }
}

export async function installUpdate(): Promise<void> {
  await desktopBridge?.updater?.install();
}

export function openDownloadPage(): void {
  void desktopBridge?.updater?.openDownload(state.downloadUrl);
}
