<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>データベース・ワークベンチ、そしてデータベース・エージェント。</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <strong>日本語</strong> ·
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

AiDB Studio は Agent を主要な入口として扱います。接続、スキーマ、SQL、データ、ダッシュボード、レポート、監査が同じ実行コンテキストを共有します。41 のデータベースエンジン、14 の生産性モジュール、53 の Agent ツールを備え、Agent の操作はすべて可視化・制御・監査できます。

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## インストーラー

| システム | アーキテクチャ | ファイル |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Windows on ARM では x64 インストーラーもシステムのエミュレーションで動作します。Linux の deb / rpm はパッケージマネージャーで導入し、AppImage は FUSE 2 が必要です（`--appimage-extract-and-run` でも可）。

## ドキュメント

- [English](./README.md) — 完全なドキュメント
- [简体中文](./README.zh-CN.md) — 完全なドキュメント
- [docs/](./docs) — アーキテクチャ、機能仕様、UI/UX、Agent 設計
- [Releases](https://github.com/keiskeies/ai-db/releases) — インストーラー

> このページは概要です。完全なドキュメントは英語と簡体字中国語で提供しています。

## ライセンス

MIT
