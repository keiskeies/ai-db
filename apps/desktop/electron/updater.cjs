'use strict';

/**
 * 更新器：把「检查 / 下载 / 安装」三件事收敛到一处，渲染层只发命令、收事件。
 *
 * 两条通道（判定逻辑见 updateLogic.cjs 的 resolveMode）：
 * - auto   —— electron-updater 走 latest.yml（Windows NSIS、Linux AppImage），
 *             支持增量下载：只传差异部分，Windows 上通常几十 KB 而非整包 136 MB；
 * - manual —— 直接查 GitHub Releases API，只做「有新版本 + 打开下载页」，
 *             macOS（未签名）、deb/rpm、开发态都走这条。
 *
 * 事件统一用 { type, ... } 形状推给渲染层，文案与状态机放在前端，
 * 主进程不持有界面语言。
 */

const { app, shell } = require('electron');
const https = require('node:https');
const { MODE, resolveMode, pickAsset, compareVersions, flattenNotes, versionFromRelease } = require('./updateLogic.cjs');

const REPO = { owner: 'keiskeies', repo: 'ai-db' };
const RELEASES_API = `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO.owner}/${REPO.repo}/releases/latest`;
const USER_AGENT = 'AiDB-Studio-Updater';

const subscribers = new Set();
let autoUpdater = null;
let wired = false;
/** 最近一次检查结果：auto 通道下载时需要靠它确认「确实有新版」。 */
let lastCheck = null;

function emit(event) {
  for (const fn of subscribers) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[updater] subscriber failed', err);
    }
  }
}

function onEvent(listener) {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

function currentMode() {
  return resolveMode({ isPackaged: app.isPackaged, platform: process.platform, appImagePath: process.env.APPIMAGE });
}

function status() {
  const { mode, reason } = currentMode();
  return { mode, reason, currentVersion: app.getVersion(), platform: process.platform, arch: process.arch };
}

function ensureUpdater() {
  if (autoUpdater) return autoUpdater;
  const updater = require('electron-updater').autoUpdater;
  // 下载由用户点击触发：不自动下、不自动装，避免占带宽和打断工作。
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  // Windows 的元数据文件名不带架构后缀，x64 / arm64 会覆盖同一份 latest.yml，
  // 所以 arm64 走独立通道 latest-arm64.yml（CI 用 -c.publish.channel 生成同名文件）。
  // Linux 不必这样：electron-updater 自己会给 arm64 加上 -linux-arm64 前缀。
  if (process.platform === 'win32' && process.arch === 'arm64') updater.channel = 'latest-arm64';
  autoUpdater = updater;
  if (!wired) {
    wired = true;
    updater.on('download-progress', (progress) => {
      emit({
        type: 'progress',
        percent: Math.max(0, Math.min(100, Number(progress?.percent ?? 0))),
        transferred: progress?.transferred ?? 0,
        total: progress?.total ?? 0,
        bytesPerSecond: progress?.bytesPerSecond ?? 0,
      });
    });
    updater.on('update-downloaded', (info) => {
      emit({ type: 'downloaded', latestVersion: info?.version ?? lastCheck?.latestVersion ?? null });
    });
    updater.on('error', (err) => {
      emit({ type: 'error', code: 'installer', detail: String(err?.message ?? err) });
    });
  }
  return updater;
}

/** GET JSON，跟随重定向（GitHub 的资产下载会 302 到 objects.githubusercontent.com）。 */
function fetchJson(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' }, timeout: 15000 },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
          res.resume();
          fetchJson(res.headers.location, redirects + 1).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          res.resume();
          reject(Object.assign(new Error(`HTTP ${status}`), { httpStatus: status }));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Releases API 的响应带完整说明，正常几十 KB，超过 2 MB 视为异常。
          if (body.length > 2 * 1024 * 1024) req.destroy(new Error('response too large'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'timeout' })));
    req.on('error', reject);
  });
}

/** 手动通道：只查 Releases API，给出「有没有新版」和下载地址。 */
async function checkViaApi(currentVersion) {
  const release = await fetchJson(RELEASES_API);
  const latestVersion = versionFromRelease(release);
  if (!latestVersion) throw Object.assign(new Error('release has no tag'), { code: 'bad-release' });
  const asset = pickAsset(release.assets, { platform: process.platform, arch: process.arch });
  return {
    latestVersion,
    notes: flattenNotes(release.body),
    publishedAt: release.published_at ?? null,
    downloadUrl: asset?.url ?? release.html_url ?? RELEASES_PAGE,
    assetName: asset?.name ?? null,
    assetSize: asset?.size ?? null,
    pageUrl: release.html_url ?? RELEASES_PAGE,
  };
}

/**
 * 检查更新。
 * auto 通道优先问 electron-updater（它读 latest.yml，能拿到差分下载所需的元数据）；
 * 失败时退回 API，至少能告诉用户「有新版本，去下载页」。
 */
async function check() {
  const currentVersion = app.getVersion();
  const { mode, reason } = currentMode();
  emit({ type: 'checking', mode, reason, currentVersion });

  if (mode === MODE.AUTO) {
    try {
      const result = await ensureUpdater().checkForUpdates();
      const latestVersion = String(result?.updateInfo?.version ?? currentVersion);
      const hasNewer = compareVersions(latestVersion, currentVersion) > 0;
      const info = {
        mode,
        reason,
        currentVersion,
        latestVersion,
        notes: flattenNotes(result?.updateInfo?.releaseNotes),
        publishedAt: result?.updateInfo?.releaseDate ?? null,
        downloadUrl: RELEASES_PAGE,
        assetName: null,
        assetSize: result?.updateInfo?.files?.[0]?.size ?? null,
      };
      lastCheck = info;
      emit({ type: hasNewer ? 'available' : 'latest', ...info });
      return { status: hasNewer ? 'available' : 'latest', ...info };
    } catch (err) {
      console.warn('[updater] auto check failed, falling back to API', err?.message ?? err);
      // 落下去走 API；下面的结果会带 mode: manual，界面据此把按钮换成「打开下载页」。
    }
  }

  try {
    const api = await checkViaApi(currentVersion);
    const hasNewer = compareVersions(api.latestVersion, currentVersion) > 0;
    const info = {
      mode: MODE.MANUAL,
      reason: mode === MODE.MANUAL ? reason : 'fallback',
      currentVersion,
      ...api,
    };
    lastCheck = info;
    emit({ type: hasNewer ? 'available' : 'latest', ...info });
    return { status: hasNewer ? 'available' : 'latest', ...info };
  } catch (err) {
    const payload = {
      type: 'error',
      code: err?.code === 'timeout' ? 'timeout' : err?.httpStatus === 403 ? 'rate-limit' : 'network',
      detail: String(err?.message ?? err),
    };
    emit(payload);
    return { status: 'error', ...payload, currentVersion, mode, reason };
  }
}

/** 只有 auto 通道能下载；下载进度与完成由 electron-updater 的事件推送。 */
async function download() {
  const { mode, reason } = currentMode();
  if (mode !== MODE.AUTO) {
    emit({ type: 'error', code: 'unsupported', detail: reason ?? 'manual' });
    return { ok: false, code: 'unsupported' };
  }
  if (!lastCheck || lastCheck.mode !== MODE.AUTO) {
    // 没先检查就下载：先补一次检查，避免 electron-updater 内部状态是空的。
    const checked = await check();
    if (checked.status !== 'available') return { ok: false, code: checked.status };
  }
  try {
    await ensureUpdater().downloadUpdate();
    return { ok: true };
  } catch (err) {
    emit({ type: 'error', code: 'download', detail: String(err?.message ?? err) });
    return { ok: false, code: 'download' };
  }
}

/** 退出并安装：先让 before-quit 关掉内嵌网关，再由 electron-updater 拉起安装器。 */
function install() {
  const { mode } = currentMode();
  if (mode !== MODE.AUTO) return { ok: false, code: 'unsupported' };
  try {
    setImmediate(() => ensureUpdater().quitAndInstall(false, true));
    return { ok: true };
  } catch (err) {
    emit({ type: 'error', code: 'install', detail: String(err?.message ?? err) });
    return { ok: false, code: 'install' };
  }
}

function openDownload(url) {
  const target = typeof url === 'string' && /^https:\/\//.test(url) ? url : lastCheck?.downloadUrl ?? RELEASES_PAGE;
  shell.openExternal(target).catch((err) => console.warn('[updater] open download page failed', err));
  return { ok: true, url: target };
}

module.exports = { status, check, download, install, openDownload, onEvent };
