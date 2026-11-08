<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Eine Datenbank-Workbench. Und ein Datenbank-Agent.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <strong>Deutsch</strong> ·
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

AiDB Studio macht den Agenten zum primären Einstiegspunkt: Verbindungen, Schema, SQL, Daten, Dashboards, Berichte und Audit teilen einen ausführbaren Kontext. Enthalten sind 41 Datenbank-Engines, 14 Produktivitätsmodule und 53 Agent-Werkzeuge — jede Aktion des Agenten ist sichtbar, steuerbar und prüfbar.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Installationspakete

| System | Architektur | Dateien |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Unter Windows on ARM läuft auch der x64-Installer über die Systememulation. Unter Linux installieren deb / rpm über den Paketmanager; das AppImage braucht FUSE 2 (oder `--appimage-extract-and-run`).

## Dokumentation

- [English](./README.md) — vollständige Dokumentation
- [简体中文](./README.zh-CN.md) — vollständige Dokumentation
- [docs/](./docs) — Architektur, Funktionsumfang, UI/UX, Agent-Design
- [Releases](https://github.com/keiskeies/ai-db/releases) — Installationspakete

> Diese Seite ist eine kurze Übersicht. Die vollständige Dokumentation gibt es auf Englisch und vereinfachtem Chinesisch.

## Lizenz

MIT
