'use strict';

/**
 * 更新能力的纯逻辑：不 require electron，因此可以在 node --test 里直接断言。
 *
 * 这里只回答两个问题——
 *   1. 当前这个安装形态能不能「自己下载并替换」（resolveMode）；
 *   2. 手动下载时该挑哪个发布资产（pickAsset）。
 * 真正的网络请求与安装动作在 updater.cjs。
 */

/** auto：能下载并静默安装；manual：只能提示用户去发布页手动装。 */
const MODE = Object.freeze({ AUTO: 'auto', MANUAL: 'manual' });

/** 为什么退化成手动：dev(开发态) / unsigned(未签名) / package(deb、rpm) / platform(其他)。 */
const REASON = Object.freeze({
  DEV: 'dev',
  UNSIGNED: 'unsigned',
  PACKAGE: 'package',
  PLATFORM: 'platform',
});

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * 解析 semver（够用即可，不引第三方包）：返回 { major, minor, patch, pre }。
 * 解析不出来时返回 null，调用方按「不比当前版本新」处理，避免误报。
 */
function parseVersion(input) {
  const match = String(input ?? '').trim().match(VERSION_RE);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre: match[4] ?? '' };
}

/** 返回 -1 / 0 / 1。预发布版低于同号正式版（1.0.0-beta < 1.0.0）。 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre > right.pre ? 1 : -1;
}

/**
 * 决定更新通道。
 *
 * - 开发态没有 app-update.yml，electron-updater 会直接抛错；
 * - macOS 的自动更新走 Squirrel.Mac，要求应用已签名（CI 里 CSC 是关掉的），
 *   未签名时能下载但装不上，不如明确告诉用户去下载 dmg；
 * - Linux 只有 AppImage 能自我替换（运行时会设置 APPIMAGE 环境变量），
 *   deb / rpm 由包管理器接管，应用无权覆盖 /opt；
 * - Windows 的 NSIS 安装器支持静默安装，是唯一开箱即用的自动更新通道。
 */
function resolveMode({ isPackaged, platform, appImagePath }) {
  if (!isPackaged) return { mode: MODE.MANUAL, reason: REASON.DEV };
  if (platform === 'darwin') return { mode: MODE.MANUAL, reason: REASON.UNSIGNED };
  if (platform === 'linux') {
    return appImagePath ? { mode: MODE.AUTO, reason: null } : { mode: MODE.MANUAL, reason: REASON.PACKAGE };
  }
  if (platform === 'win32') return { mode: MODE.AUTO, reason: null };
  return { mode: MODE.MANUAL, reason: REASON.PLATFORM };
}

/** 各平台手动下载时认的资产名后缀：与 electron-builder 的 artifactName 对应。 */
function assetSuffix(platform, arch) {
  if (platform === 'win32') return `-${arch}-setup.exe`;
  if (platform === 'darwin') return `-${arch}.dmg`;
  if (platform === 'linux') return arch === 'arm64' ? '-arm64.AppImage' : '-x86_64.AppImage';
  return null;
}

/**
 * 从 GitHub release 的 assets 里挑出当前平台/架构的那一个。
 * 名字比 electron-builder 实际产物（AiDB.Studio-0.0.4-x64-setup.exe），
 * 所以用后缀匹配而不是全名相等。blockmap 是同名加后缀，天然不会命中。
 */
function pickAsset(assets, { platform, arch }) {
  const suffix = assetSuffix(platform, arch);
  if (!suffix) return null;
  const list = Array.isArray(assets) ? assets : [];
  const hit = list.find((asset) => typeof asset?.name === 'string' && asset.name.endsWith(suffix));
  if (!hit) return null;
  return {
    name: hit.name,
    url: hit.browser_download_url ?? hit.url ?? null,
    size: typeof hit.size === 'number' ? hit.size : null,
  };
}

/** releaseNotes 可能是字符串，也可能是 [{ note }]，统一成纯文本。 */
function flattenNotes(notes) {
  if (!notes) return '';
  if (typeof notes === 'string') return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((item) => (typeof item === 'string' ? item : item?.note ?? ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

/** GitHub 的 tag 形如 v0.0.4；没有 tag 时退到 name。 */
function versionFromRelease(release) {
  return String(release?.tag_name ?? release?.name ?? '').trim().replace(/^v/i, '');
}

module.exports = {
  MODE,
  REASON,
  parseVersion,
  compareVersions,
  resolveMode,
  assetSuffix,
  pickAsset,
  flattenNotes,
  versionFromRelease,
};
