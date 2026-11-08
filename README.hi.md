<p align="center">
  <img src="docs/brand/logo-mark-256.png" width="92" alt="AiDB Studio" />
</p>

<h1 align="center">AiDB Studio</h1>

<p align="center"><strong>डेटाबेस वर्कबेंच, और एक डेटाबेस एजेंट भी।</strong></p>

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
  <strong>हिन्दी</strong> ·
  <a href="./README.id.md">Bahasa Indonesia</a> ·
  <a href="./README.vi.md">Tiếng Việt</a> ·
  <a href="./README.th.md">ไทย</a> ·
  <a href="./README.tr.md">Türkçe</a> ·
  <a href="./README.nl.md">Nederlands</a> ·
  <a href="./README.pl.md">Polski</a> ·
  <a href="./README.uk.md">Українська</a>
</p>

AiDB Studio एजेंट को मुख्य प्रवेश बिंदु मानता है: कनेक्शन, स्कीमा, SQL, डेटा, डैशबोर्ड, रिपोर्ट और ऑडिट एक ही निष्पादन योग्य संदर्भ साझा करते हैं। इसमें 41 डेटाबेस इंजन, 14 उत्पादकता मॉड्यूल और 53 एजेंट टूल हैं, और एजेंट की हर क्रिया दृश्य, नियंत्रणीय और ऑडिट योग्य है।

<p align="center">
  <img src="docs/screenshots/showcase/agent-workflow.gif" width="420" alt="AiDB Studio Agent" />
</p>

## इंस्टॉलर

| सिस्टम | आर्किटेक्चर | फ़ाइलें |
|---|---|---|
| Windows | x64 | `AiDB-Studio-<version>-x64-setup.exe` (NSIS) |
| Windows | arm64 | `AiDB-Studio-<version>-arm64-setup.exe` (NSIS) |
| macOS | Apple Silicon | `AiDB-Studio-<version>-arm64.dmg` |
| macOS | Intel | `AiDB-Studio-<version>-x64.dmg` |
| Linux | x64 | `AiDB-Studio-<version>-x86_64.AppImage` / `-amd64.deb` / `-x86_64.rpm` |
| Linux | arm64 | `AiDB-Studio-<version>-arm64.AppImage` / `-arm64.deb` / `-aarch64.rpm` |

Windows on ARM पर x64 इंस्टॉलर सिस्टम एमुलेशन से चलता है। Linux में deb / rpm पैकेज मैनेजर से इंस्टॉल होते हैं, और AppImage के लिए FUSE 2 (या `--appimage-extract-and-run`) चाहिए।

## दस्तावेज़

- [English](./README.md) — पूरा दस्तावेज़
- [简体中文](./README.zh-CN.md) — पूरा दस्तावेज़
- [docs/](./docs) — आर्किटेक्चर, फ़ीचर स्पेक, UI/UX, एजेंट डिज़ाइन
- [Releases](https://github.com/keiskeies/ai-db/releases) — इंस्टॉलर

> यह पृष्ठ संक्षिप्त परिचय है। पूरा दस्तावेज़ अंग्रेज़ी और सरलीकृत चीनी में है।

## लाइसेंस

MIT
