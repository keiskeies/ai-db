<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>데이터베이스 워크벤치이자 데이터베이스 에이전트.</strong></p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.zh-CN.md">简体中文</a> ·
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <strong>한국어</strong> ·
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

AiDB Studio는 에이전트를 기본 진입점으로 삼습니다. 연결, 스키마, SQL, 데이터, 대시보드, 리포트, 감사가 하나의 실행 컨텍스트를 공유합니다. 41개 데이터베이스 엔진, 14개 생산성 모듈, 53개 에이전트 도구를 제공하며, 에이전트의 모든 동작은 확인·제어·감사할 수 있습니다.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## 설치 파일

| 시스템 | 아키텍처 | 파일 |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Windows on ARM에서는 x64 설치 파일도 시스템 에뮬레이션으로 실행됩니다. Linux의 deb / rpm은 패키지 관리자로 설치하고, AppImage는 FUSE 2가 필요합니다(`--appimage-extract-and-run` 사용 가능).

## 문서

- [English](./README.md) — 전체 문서
- [简体中文](./README.zh-CN.md) — 전체 문서
- [docs/](./docs) — 아키텍처, 기능 명세, UI/UX, 에이전트 설계
- [Releases](https://github.com/keiskeies/ai-db/releases) — 설치 파일

> 이 페이지는 간단한 개요입니다. 전체 문서는 영어와 중국어(간체)로 제공됩니다.

## 라이선스

[MIT](./LICENSE)
