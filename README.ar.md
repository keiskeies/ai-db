<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>مساحة عمل لقواعد البيانات، ووكيل لقواعد البيانات أيضًا.</strong></p>

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
  <strong>العربية</strong> ·
  <a href="./README.hi.md">हिन्दी</a> ·
  <a href="./README.id.md">Bahasa Indonesia</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

يعتبر AiDB Studio الوكيل نقطة الدخول الأساسية: الاتصالات والمخطط وSQL والبيانات ولوحات المعلومات والتقارير والتدقيق تتشارك سياقًا تنفيذيًا واحدًا. يضم 41 محرك قواعد بيانات و14 وحدة إنتاجية و53 أداة للوكيل، وكل إجراء يقوم به الوكيل مرئي وقابل للتحكم والتدقيق.

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## ملفات التثبيت

| النظام | المعمارية | الملفات |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

في Windows on ARM يعمل مثبّت x64 عبر محاكاة النظام. وفي Linux تُثبَّت حزم deb / rpm عبر مدير الحزم، ويحتاج AppImage إلى FUSE 2 أو الخيار `--appimage-extract-and-run`.

## التوثيق

- [English](./README.md) — التوثيق الكامل
- [简体中文](./README.zh-CN.md) — التوثيق الكامل
- [docs/](./docs) — المعمارية، مواصفات الميزات، UI/UX، تصميم الوكيل
- [Releases](https://github.com/keiskeies/ai-db/releases) — ملفات التثبيت

> هذه الصفحة نظرة مختصرة. التوثيق الكامل متوفر بالإنجليزية والصينية المبسطة.

## الترخيص

MIT
