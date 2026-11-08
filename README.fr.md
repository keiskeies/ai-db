<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Un poste de travail pour bases de données. Aussi un agent de base de données.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <strong>Français</strong> ·
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

AiDB Studio fait de l'agent le point d'entrée principal : connexions, schéma, SQL, données, tableaux de bord, rapports et audit partagent un même contexte exécutable. 41 moteurs de bases de données, 14 modules de productivité et 53 outils d'agent sont inclus, et chaque action de l'agent reste visible, contrôlable et auditable.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Installateurs

| Système | Architecture | Fichiers |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Sous Windows on ARM, l'installateur x64 fonctionne via l'émulation système. Sous Linux, deb / rpm passent par le gestionnaire de paquets ; l'AppImage nécessite FUSE 2 (ou `--appimage-extract-and-run`).

## Documentation

- [English](./README.md) — documentation complète
- [简体中文](./README.zh-CN.md) — documentation complète
- [docs/](./docs) — architecture, spécifications fonctionnelles, UI/UX, conception de l'agent
- [Releases](https://github.com/keiskeies/ai-db/releases) — Installateurs

> Cette page est un aperçu. La documentation complète est en anglais et en chinois simplifié.

## Licence

[MIT](./LICENSE)
