import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const CJK = /[\u4e00-\u9fff]/;
const SQL_LIKE = /^\s*(select|insert|update|delete|create|drop|alter|show|describe|explain|with|grant|revoke|use|call|truncate|replace|merge)\b/i;

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.expo' || entry === 'i18n') continue;
      walk(p, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

function normalizeJsx(text) {
  return text.replace(/[ \t\r\n]+/g, ' ');
}

function collect(file, sources, jsxKeys) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /\.tsx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (CJK.test(text) && !SQL_LIKE.test(text)) sources.add(text);
    } else if (ts.isTemplateExpression(node)) {
      let pattern = node.head.text;
      node.templateSpans.forEach((span, index) => {
        pattern += `{${index}}` + span.literal.text;
      });
      if (CJK.test(pattern) && !SQL_LIKE.test(pattern)) sources.add(pattern);
    } else if (ts.isJsxText(node)) {
      const text = normalizeJsx(node.text);
      if (CJK.test(text)) {
        sources.add(text);
        jsxKeys.add(text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function collectLegacy() {
  const file = 'apps/desktop/src/i18n/legacy.ts';
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const maps = {};
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      const map = {};
      for (const prop of decl.initializer.properties) {
        if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && (ts.isStringLiteral(prop.initializer) || ts.isNoSubstitutionTemplateLiteral(prop.initializer))) {
          map[prop.name.text] = prop.initializer.text;
        }
      }
      maps[decl.name.text] = map;
    }
  }
  return { zh: maps.zh ?? {}, en: maps.en ?? {} };
}

const desktop = new Set();
const mobile = new Set();
const jsxKeys = new Set();
for (const file of walk('apps/desktop/src')) collect(file, desktop, jsxKeys);
for (const file of walk('apps/mobile')) collect(file, mobile, jsxKeys);
const coreStrings = new Set();
for (const file of walk('packages/core/src')) collect(file, coreStrings, jsxKeys);
for (const entry of fs.readdirSync('packages/core/src/capabilities')) {
  if (!entry.endsWith('.json')) continue;
  const raw = fs.readFileSync(path.join('packages/core/src/capabilities', entry), 'utf8');
  const visit = (value) => {
    if (typeof value === 'string') {
      if (CJK.test(value) && value.length < 400 && !SQL_LIKE.test(value)) coreStrings.add(value);
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(JSON.parse(raw));
}
for (const value of coreStrings) desktop.add(value);

const legacy = collectLegacy();
for (const value of Object.values(legacy.zh)) if (CJK.test(value)) desktop.add(value);
if (fs.existsSync('scripts/i18n/extra-strings.json')) {
  for (const value of JSON.parse(fs.readFileSync('scripts/i18n/extra-strings.json', 'utf8'))) {
    if (CJK.test(value)) desktop.add(value);
  }
}

const mobileEnglish = JSON.parse(fs.readFileSync('apps/mobile/src/i18n.en.json', 'utf8'));
const payload = {
  desktop: [...desktop].sort(),
  mobile: [...mobile].sort(),
  jsx: [...jsxKeys].sort(),
  legacyZh: legacy.zh,
  legacyEn: legacy.en,
  mobileEnglish,
};
fs.mkdirSync('scripts/i18n/data', { recursive: true });
fs.writeFileSync('scripts/i18n/data/sources.json', JSON.stringify(payload, null, 2));
console.log(JSON.stringify({ desktop: payload.desktop.length, mobile: payload.mobile.length, jsx: payload.jsx.length, legacyKeys: Object.keys(legacy.zh).length }));
