<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Warsztat pracy z bazami danych. A także agent bazodanowy.</strong></p>

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
  <strong>Polski</strong> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio traktuje agenta jako główny punkt wejścia: połączenia, schemat, SQL, dane, pulpity, raporty i audyt korzystają z jednego kontekstu wykonawczego. W środku 41 silników baz danych, 14 modułów produktywności i 53 narzędzia agenta; każda akcja agenta jest widoczna, kontrolowalna i audytowalna.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Instalatory

| System | Architektura | Pliki |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

W Windows on ARM instalator x64 działa przez emulację systemową. W Linuxie deb / rpm instaluje menedżer pakietów, a AppImage wymaga FUSE 2 (lub `--appimage-extract-and-run`).

## Dokumentacja

- [English](./README.md) — pełna dokumentacja
- [简体中文](./README.zh-CN.md) — pełna dokumentacja
- [docs/](./docs) — architektura, specyfikacja funkcji, UI/UX, projekt agenta
- [Releases](https://github.com/keiskeies/ai-db/releases) — Instalatory

> Ta strona to krótki przegląd. Pełna dokumentacja jest po angielsku i w uproszczonym chińskim.

## Licencja

MIT
