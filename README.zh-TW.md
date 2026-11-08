<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>資料庫工作台，也是資料庫 Agent。</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <strong>繁體中文</strong> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.it.md">Italiano</a> ·
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <a href="./README.id.md">Bahasa Indonesia</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio 把 Agent 當作主要入口：連線、結構、SQL、資料、儀表板、報表與稽核共用同一個可執行上下文。內建 41 種資料庫引擎、14 個生產力模組與 53 個 Agent 工具，Agent 的每個動作都看得見、控制得住、留得下紀錄。

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## 安裝檔

| 系統 | 架構 | 檔案 |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Windows on ARM 也能靠系統模擬執行 x64 安裝檔；Linux 的 deb / rpm 走套件管理器，AppImage 需要 FUSE 2，沒有就加 `--appimage-extract-and-run`。

## 文件

- [English](./README.md) — 完整文件
- [简体中文](./README.zh-CN.md) — 完整文件
- [docs/](./docs) — 架構、功能規格、UI/UX、Agent 設計
- [Releases](https://github.com/keiskeies/ai-db/releases) — 安裝檔

> 本頁是簡短概覽；完整文件為英文與簡體中文版本。

## 授權

[MIT](./LICENSE)
