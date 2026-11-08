import { AlertTriangle, CheckCircle2, Download, Loader2, RefreshCw } from 'lucide-react';
import { t as tr } from '../i18n';
import { checkForUpdates, downloadUpdate, installUpdate, openDownloadPage, useUpdater, type UpdaterState } from '../lib/updater';
import type { UpdateFallbackReason } from '../lib/desktop';

/** 为什么这条安装不能自动装：说清楚原因，别让用户以为是坏了。 */
function reasonHint(reason: UpdateFallbackReason): string {
  switch (reason) {
    case 'dev':
      return tr('开发模式：只检查发布页，不做自动更新。');
    case 'unsigned':
      return tr('macOS 版未签名，系统不允许静默替换，请下载 dmg 覆盖安装。');
    case 'package':
      return tr('通过 deb / rpm 安装的版本由包管理器升级，请下载新包手动安装。');
    case 'platform':
      return tr('当前平台不支持自动更新，请前往发布页下载。');
    case 'fallback':
      return tr('自动更新通道暂不可用，已改为检查发布页。');
    default:
      return '';
  }
}

/** 错误码 → 可执行的说明；detail 只在没有对应文案时拼进去。 */
function errorText(state: UpdaterState): string {
  const detail = state.error?.detail;
  switch (state.error?.code) {
    case 'timeout':
      return tr('请求超时，请检查网络后重试。');
    case 'rate-limit':
      return tr('GitHub API 请求过于频繁，请稍后再试。');
    case 'network':
      return tr('无法连接 GitHub，请检查网络或代理后重试。');
    case 'unsupported':
      return tr('当前安装方式不支持自动更新。');
    case 'status':
      return tr('读取版本信息失败。');
    default:
      return detail ? tr('更新失败：{message}', { message: detail }) : tr('更新失败，请稍后重试。');
  }
}

function statusTitle(state: UpdaterState): string {
  switch (state.phase) {
    case 'unsupported':
      return tr('网页版不含桌面更新能力，请在桌面应用内检查。');
    case 'idle':
      return tr('尚未检查更新');
    case 'checking':
      return tr('正在检查…');
    case 'latest':
      return tr('已是最新版本 {version}', { version: state.currentVersion });
    case 'available':
      return tr('发现新版本 {latest}（当前 {current}）', {
        latest: state.latestVersion ?? '',
        current: state.currentVersion,
      });
    case 'downloading':
      return tr('正在下载更新… {percent}%', { percent: String(state.percent) });
    case 'ready':
      return tr('更新已下载，重启后自动安装');
    case 'error':
      return errorText(state);
    default:
      return '';
  }
}

export function UpdateCard() {
  const state = useUpdater();
  const busy = state.phase === 'checking' || state.phase === 'downloading';

  if (state.phase === 'unsupported') {
    return <p className="hint" data-testid="update-unsupported">{statusTitle(state)}</p>;
  }

  const hint = state.phase === 'error' ? '' : reasonHint(state.reason);
  const isManual = state.mode === 'manual';
  // 「已是最新」时不需要下载入口，避免和「重新检查」并排出现两个都像主操作的按钮。
  const canOpenPage = state.phase === 'available' || state.phase === 'error' || state.phase === 'ready';

  return (
    <div className="update-card" data-testid="update-card">
      <div className="update-card-head">
        <div className="update-card-text">
          <div className="update-card-title">{tr('版本更新')}</div>
          <div className={`update-card-status${state.phase === 'error' ? ' error' : ''}`} data-testid="update-status">
            {state.phase === 'available' ? <Download size={12} /> : null}
            {state.phase === 'latest' ? <CheckCircle2 size={12} /> : null}
            {state.phase === 'error' ? <AlertTriangle size={12} /> : null}
            <span>{statusTitle(state)}</span>
          </div>
        </div>
        <div className="update-card-actions">
          {canOpenPage ? (
            <button className="btn small ghost" onClick={openDownloadPage} data-testid="update-open-page">
              {tr('打开下载页')}
            </button>
          ) : null}
          {state.phase === 'available' && !isManual ? (
            <button className="btn small primary" onClick={() => void downloadUpdate()} data-testid="update-download">
              {tr('下载更新')}
            </button>
          ) : null}
          {state.phase === 'available' && isManual ? (
            <button className="btn small primary" onClick={openDownloadPage} data-testid="update-manual-download">
              {tr('前往下载')}
            </button>
          ) : null}
          {state.phase === 'ready' ? (
            <button className="btn small primary" onClick={() => void installUpdate()} data-testid="update-install">
              {tr('立即重启安装')}
            </button>
          ) : null}
          {state.phase === 'downloading' ? (
            <button className="btn small" disabled>
              <Loader2 size={12} className="spin" />
              {tr('下载中…')}
            </button>
          ) : null}
          {state.phase === 'idle' || state.phase === 'latest' || state.phase === 'error' ? (
            <button className="btn small" onClick={() => void checkForUpdates()} disabled={busy} data-testid="update-check">
              {state.phase === 'idle' ? <RefreshCw size={12} /> : null}
              {state.phase === 'idle' ? tr('检查更新') : tr('重新检查')}
            </button>
          ) : null}
          {state.phase === 'checking' ? (
            <button className="btn small" disabled>
              <Loader2 size={12} className="spin" />
              {tr('检查中…')}
            </button>
          ) : null}
        </div>
      </div>
      {state.phase === 'downloading' || state.phase === 'ready' ? (
        <div
          className="update-progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={state.percent}
        >
          <div className="update-progress-fill" style={{ width: `${state.percent}%` }} />
        </div>
      ) : null}
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}
