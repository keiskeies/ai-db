<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Робоче місце для баз даних. І водночас агент для роботи з базами даних.</strong></p>

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
  <a href="./README.ru.md">Русский</a> ·
  <a href="./README.ar.md">العربية</a> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <a href="./README.id.md">Bahasa Indonesia</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <strong>Українська</strong>
</p>

AiDB Studio робить агента основним входом: з'єднання, схема, SQL, дані, дашборди, звіти й аудит використовують один виконуваний контекст. Усередині 41 СУБД, 14 модулів продуктивності та 53 інструменти агента; кожна дія агента видима, керована й підлягає аудиту.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Інсталятори

| Система | Архітектура | Файли |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

У Windows on ARM інсталятор x64 працює через системну емуляцію. У Linux deb / rpm ставляться менеджером пакетів, а AppImage потребує FUSE 2 (або `--appimage-extract-and-run`).

## Документація

- [English](./README.md) — повна документація
- [简体中文](./README.zh-CN.md) — повна документація
- [docs/](./docs) — архітектура, специфікація функцій, UI/UX, проєктування агента
- [Releases](https://github.com/keiskeies/ai-db/releases) — Інсталятори

> Це короткий огляд. Повна документація — англійською та спрощеною китайською.

## Ліцензія

[MIT](./LICENSE)
