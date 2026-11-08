<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>Bir veritabanı çalışma tezgâhı. Aynı zamanda bir veritabanı ajanı.</strong></p>

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
  <strong>Türkçe</strong> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio, ajanı ana giriş noktası olarak ele alır: bağlantılar, şema, SQL, veri, panolar, raporlar ve denetim aynı yürütme bağlamını paylaşır. 41 veritabanı motoru, 14 üretkenlik modülü ve 53 ajan aracı içerir; ajanın her eylemi görünür, denetlenebilir ve izlenebilirdir.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## Kurulum dosyaları

| Sistem | Mimari | Dosyalar |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Windows on ARM'de x64 kurulum dosyası sistem öykünmesiyle çalışır. Linux'ta deb / rpm paket yöneticisiyle kurulur; AppImage için FUSE 2 (veya `--appimage-extract-and-run`) gerekir.

## Belgeler

- [English](./README.md) — tam belge
- [简体中文](./README.zh-CN.md) — tam belge
- [docs/](./docs) — mimari, özellik belgesi, UI/UX, ajan tasarımı
- [Releases](https://github.com/keiskeies/ai-db/releases) — Kurulum dosyaları

> Bu sayfa kısa bir özettir. Tam belge İngilizce ve Basitleştirilmiş Çince olarak mevcuttur.

## Lisans

MIT
