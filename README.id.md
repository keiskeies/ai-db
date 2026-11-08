<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Workbench basis data, sekaligus agen basis data.</strong></p>

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
  <strong>Bahasa Indonesia</strong> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio menjadikan agen sebagai pintu masuk utama: koneksi, skema, SQL, data, dasbor, laporan, dan audit berbagi satu konteks eksekusi. Tersedia 41 mesin basis data, 14 modul produktivitas, dan 53 alat agen; setiap tindakan agen terlihat, dapat dikendalikan, dan dapat diaudit.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Pemasang

| Sistem | Arsitektur | Berkas |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Di Windows on ARM, pemasang x64 berjalan lewat emulasi sistem. Di Linux, deb / rpm dipasang lewat manajer paket, dan AppImage memerlukan FUSE 2 (atau `--appimage-extract-and-run`).

## Dokumentasi

- [English](./README.md) — dokumentasi lengkap
- [简体中文](./README.zh-CN.md) — dokumentasi lengkap
- [docs/](./docs) — arsitektur, spesifikasi fitur, UI/UX, desain agen
- [Releases](https://github.com/keiskeies/ai-db/releases) — Pemasang

> Halaman ini ringkasan singkat. Dokumentasi lengkap tersedia dalam bahasa Inggris dan Tionghoa Sederhana.

## Lisensi

[MIT](./LICENSE)
