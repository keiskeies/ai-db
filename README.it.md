<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Una workbench per database. E anche un agente per database.</strong></p>

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
  <strong>Italiano</strong> ·
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

AiDB Studio considera l'agente il punto di ingresso principale: connessioni, schema, SQL, dati, dashboard, report e audit condividono lo stesso contesto eseguibile. Include 41 motori di database, 14 moduli di produttività e 53 strumenti per l'agente; ogni azione dell'agente è visibile, controllabile e verificabile.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Installer

| Sistema | Architettura | File |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Su Windows on ARM anche l'installer x64 funziona tramite emulazione di sistema. Su Linux deb / rpm si installano con il gestore di pacchetti; l'AppImage richiede FUSE 2 (oppure `--appimage-extract-and-run`).

## Documentazione

- [English](./README.md) — documentazione completa
- [简体中文](./README.zh-CN.md) — documentazione completa
- [docs/](./docs) — architettura, specifiche funzionali, UI/UX, progettazione dell'agente
- [Releases](https://github.com/keiskeies/ai-db/releases) — Installer

> Questa pagina è una panoramica. La documentazione completa è in inglese e cinese semplificato.

## Licenza

[MIT](./LICENSE)
