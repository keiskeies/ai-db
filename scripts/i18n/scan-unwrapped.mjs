import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const strict = process.argv.includes('--strict');

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (entry === 'i18n' || entry === 'node_modules' || entry === 'dist' || entry === '.expo') continue;
      walk(p, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.d\.ts$/.test(entry) && entry !== 'i18n.ts') {
      acc.push(p);
    }
  }
  return acc;
}

const CJK = /[\u4e00-\u9fff]/;
const SQL_LIKE = /^\s*(select|insert|update|delete|create|drop|alter|show|describe|explain|with|grant|revoke|use|call|truncate|replace|merge)\b/i;

const desktopCatalog = JSON.parse(fs.readFileSync('apps/desktop/src/i18n/locales/en.json', 'utf8'));
const mobileCatalog = JSON.parse(fs.readFileSync('apps/mobile/src/i18n/en.json', 'utf8'));

const unwrapped = [];
const missing = [];

function templatePattern(node) {
  let pattern = node.head.text;
  node.templateSpans.forEach((span, index) => {
    pattern += `{${index}}` + span.literal.text;
  });
  return pattern;
}

/**
 * 桌面端要求每条中文都显式经过 t()；移动端由 Text/TextInput 包装器在渲染时翻译，
 * 所以移动端只检查「词条是否进了词库」，不要求源码里出现 translate()。
 */
function checkFile(file, catalog, mode) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const label = (node) => `${file.split(path.sep).join('/')}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const visit = (node, ancestors) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    const insideTr = ancestors.some(
      (ancestor) => ts.isCallExpression(ancestor) && ts.isIdentifier(ancestor.expression) && ['t', 'tr', 'translate'].includes(ancestor.expression.text),
    );
    const insideConsole = ancestors.some(
      (ancestor) =>
        ts.isCallExpression(ancestor) &&
        ts.isPropertyAccessExpression(ancestor.expression) &&
        ts.isIdentifier(ancestor.expression.expression) &&
        ancestor.expression.expression.text === 'console',
    );
    const insideCodeTag = ancestors.some((ancestor) => {
      if (!ts.isJsxElement(ancestor) && !ts.isJsxSelfClosingElement(ancestor)) return false;
      const opening = ts.isJsxElement(ancestor) ? ancestor.openingElement : ancestor;
      return ['code', 'pre', 'kbd', 'samp'].includes(opening.tagName.getText());
    });
    const parent = ancestors[ancestors.length - 1];
    // 数据键（分组名等）必须保持原文，用 // i18n-ignore 显式豁免。
    const lineEnd = src.indexOf('\n', node.getStart());
    const lineText = src.slice(src.lastIndexOf('\n', node.getStart()) + 1, lineEnd === -1 ? src.length : lineEnd);
    const skip = insideConsole || insideCodeTag || lineText.includes('i18n-ignore');

    const register = (text, kind) => {
      if (skip) return;
      if (mode === 'desktop') {
        if (insideTr) {
          if (catalog[text] === undefined) missing.push(`${label(node)}: ${kind} ${JSON.stringify(text.slice(0, 80))}`);
        } else {
          unwrapped.push(`${label(node)}: ${kind} ${JSON.stringify(text.slice(0, 80))}`);
        }
      } else if (catalog[text] === undefined) {
        missing.push(`${label(node)}: ${kind} ${JSON.stringify(text.slice(0, 80))}`);
      }
    };

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      if (CJK.test(node.text) && !SQL_LIKE.test(node.text)) {
        const isKey = parent && ts.isPropertyAssignment(parent) && parent.name === node;
        const isCompare =
          parent &&
          ts.isBinaryExpression(parent) &&
          [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(parent.operatorToken.kind);
        if (!isKey && !isCompare) register(node.text, 'string');
      }
    } else if (ts.isTemplateExpression(node)) {
      const pattern = templatePattern(node);
      if (CJK.test(pattern) && !SQL_LIKE.test(pattern)) register(pattern, 'template');
    } else if (ts.isJsxText(node) && CJK.test(node.text)) {
      register(node.text.replace(/[ \t\r\n]+/g, ' '), 'jsx');
    }
    ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  };
  visit(sf, []);
}

for (const file of walk('apps/desktop/src')) checkFile(file, desktopCatalog, 'desktop');
for (const file of walk('apps/mobile')) checkFile(file, mobileCatalog, 'mobile');

console.log(`desktop strings not wrapped in t(): ${unwrapped.length}`);
for (const item of unwrapped.slice(0, 60)) console.log('  ' + item);
console.log(`entries missing from the English catalogs: ${missing.length}`);
for (const item of missing.slice(0, 60)) console.log('  ' + item);
if (strict && (unwrapped.length || missing.length)) {
  console.log('\nRun `npm run i18n:extract && npm run i18n:translate` to add the missing entries.');
  process.exitCode = 1;
}
