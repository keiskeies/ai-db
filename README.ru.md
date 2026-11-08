<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Рабочее место для баз данных. И одновременно агент по базам данных.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.es.md">Español</a> ·
  <a href="./README.pt-BR.md">Português (BR)</a> ·
  <a href="./README.it.md">Italiano</a> ·
  <strong>Русский</strong> ·
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

В AiDB Studio агент — основной вход: подключения, схема, SQL, данные, дашборды, отчёты и аудит используют один исполняемый контекст. Внутри 41 СУБД, 14 модулей продуктивности и 53 инструмента агента; каждое действие агента видно, управляемо и проверяемо.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Установщики

| Система | Архитектура | Файлы |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

В Windows on ARM установщик x64 работает через системную эмуляцию. В Linux deb / rpm ставятся менеджером пакетов, а AppImage требует FUSE 2 (или `--appimage-extract-and-run`).

## Документация

- [English](./README.md) — полная документация
- [简体中文](./README.zh-CN.md) — полная документация
- [docs/](./docs) — архитектура, спецификация функций, UI/UX, проектирование агента
- [Releases](https://github.com/keiskeies/ai-db/releases) — Установщики

> Это краткий обзор. Полная документация — на английском и упрощённом китайском.

## Лицензия

[MIT](./LICENSE)
