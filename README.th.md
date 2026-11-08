<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>เวิร์กเบนช์ฐานข้อมูล และเป็นเอเจนต์ฐานข้อมูลด้วย</strong></p>

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
  <strong>ไทย</strong> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio ถือว่าเอเจนต์คือทางเข้าหลัก: การเชื่อมต่อ สคีมา SQL ข้อมูล แดชบอร์ด รายงาน และการตรวจสอบใช้บริบทการทำงานเดียวกัน มี 41 เอนจินฐานข้อมูล 14 โมดูลเพิ่มประสิทธิภาพ และ 53 เครื่องมือสำหรับเอเจนต์ ทุกการกระทำของเอเจนต์มองเห็น ควบคุม และตรวจสอบได้

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## ตัวติดตั้ง

| ระบบ | สถาปัตยกรรม | ไฟล์ |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

บน Windows on ARM ตัวติดตั้ง x64 ทำงานผ่านการจำลองของระบบ ส่วน Linux ติดตั้ง deb / rpm ผ่านตัวจัดการแพ็กเกจ และ AppImage ต้องใช้ FUSE 2 (หรือ `--appimage-extract-and-run`)

## เอกสาร

- [English](./README.md) — เอกสารฉบับเต็ม
- [简体中文](./README.zh-CN.md) — เอกสารฉบับเต็ม
- [docs/](./docs) — สถาปัตยกรรม ข้อกำหนดฟีเจอร์ UI/UX การออกแบบเอเจนต์
- [Releases](https://github.com/keiskeies/ai-db/releases) — ตัวติดตั้ง

> หน้านี้เป็นภาพรวมโดยย่อ เอกสารฉบับเต็มมีเป็นภาษาอังกฤษและจีนตัวย่อ

## สัญญาอนุญาต

MIT
