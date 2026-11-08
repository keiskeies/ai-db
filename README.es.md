<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Un banco de trabajo para bases de datos. También un agente de bases de datos.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <strong>Español</strong> ·
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

AiDB Studio convierte al agente en el punto de entrada principal: conexiones, esquema, SQL, datos, paneles, informes y auditoría comparten un mismo contexto ejecutable. Incluye 41 motores de bases de datos, 14 módulos de productividad y 53 herramientas de agente, y cada acción del agente es visible, controlable y auditable.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Instaladores

| Sistema | Arquitectura | Archivos |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

En Windows on ARM, el instalador x64 funciona con la emulación del sistema. En Linux, deb / rpm se instalan con el gestor de paquetes; el AppImage necesita FUSE 2 (o `--appimage-extract-and-run`).

## Documentación

- [English](./README.md) — documentación completa
- [简体中文](./README.zh-CN.md) — documentación completa
- [docs/](./docs) — arquitectura, especificación funcional, UI/UX, diseño del agente
- [Releases](https://github.com/keiskeies/ai-db/releases) — Instaladores

> Esta página es un resumen. La documentación completa está en inglés y chino simplificado.

## Licencia

MIT
