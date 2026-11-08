<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Uma bancada de trabalho para bancos de dados. E também um agente de banco de dados.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.de.md">Deutsch</a> ·
  <a href="./README.fr.md">Français</a> ·
  <a href="./README.es.md">Español</a> ·
  <strong>Português (BR)</strong> ·
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

O AiDB Studio trata o agente como ponto de entrada principal: conexões, esquema, SQL, dados, painéis, relatórios e auditoria compartilham o mesmo contexto executável. São 41 motores de banco de dados, 14 módulos de produtividade e 53 ferramentas de agente, e toda ação do agente é visível, controlável e auditável.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Instaladores

| Sistema | Arquitetura | Arquivos |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

No Windows on ARM, o instalador x64 roda pela emulação do sistema. No Linux, deb / rpm são instalados pelo gerenciador de pacotes; o AppImage precisa do FUSE 2 (ou `--appimage-extract-and-run`).

## Documentação

- [English](./README.md) — documentação completa
- [简体中文](./README.zh-CN.md) — documentação completa
- [docs/](./docs) — arquitetura, especificação funcional, UI/UX, design do agente
- [Releases](https://github.com/keiskeies/ai-db/releases) — Instaladores

> Esta página é um resumo. A documentação completa está em inglês e chinês simplificado.

## Licença

MIT
