import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

const SRC_ROOT = path.resolve('apps/desktop/src');
const CJK = /[\u4e00-\u9fff]/;
const SQL_LIKE = /^\s*(select|insert|update|delete|create|drop|alter|show|describe|explain|with|grant|revoke|use|call|truncate|replace|merge)\b/i;
const CODE_TAGS = new Set(['code', 'pre', 'kbd', 'samp']);
const SKIP_DIRS = new Set(['i18n']);
const SKIP_FILES = new Set(['i18n.ts', 'main.tsx']);

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) walk(p, acc);
    } else if (/\.(tsx?|jsx?)$/.test(entry) && !/\.d\.ts$/.test(entry) && !SKIP_FILES.has(entry)) {
      acc.push(p);
    }
  }
  return acc;
}

function isInside(node, ancestors, predicate) {
  return ancestors.some((ancestor) => predicate(ancestor));
}

function isTranslationCall(node) {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    ['t', 'tr', 'translate'].includes(node.expression.text)
  );
}

function insideTranslationCall(ancestors) {
  return ancestors.some(isTranslationCall);
}

function insideConsole(ancestors) {
  return ancestors.some(
    (ancestor) =>
      ts.isCallExpression(ancestor) &&
      ts.isPropertyAccessExpression(ancestor.expression) &&
      ts.isIdentifier(ancestor.expression.expression) &&
      ancestor.expression.expression.text === 'console',
  );
}

function insideCodeTag(ancestors) {
  return ancestors.some((ancestor) => {
    if (!ts.isJsxElement(ancestor) && !ts.isJsxSelfClosingElement(ancestor)) return false;
    const opening = ts.isJsxElement(ancestor) ? ancestor.openingElement : ancestor;
    return CODE_TAGS.has(opening.tagName.getText());
  });
}

function sqlLike(text) {
  return SQL_LIKE.test(text);
}

function collectEdits(root, src, file) {
  const edits = [];
  const visit = (node, ancestors) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isTypeNode(node)) return;
    if (insideTranslationCall(ancestors) || insideConsole(ancestors) || insideCodeTag(ancestors)) return;

    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const text = node.text;
      if (!CJK.test(text) || sqlLike(text)) return;
      const parent = ancestors[ancestors.length - 1];
      if (parent && ts.isPropertyAssignment(parent) && parent.name === node) return;
      if (parent && ts.isElementAccessExpression(parent) && parent.argumentExpression === node) return;
      if (parent && ts.isCaseClause(parent)) return;
      if (parent && ts.isBinaryExpression(parent)) {
        const operator = parent.operatorToken.kind;
        if (
          operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
          operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
          operator === ts.SyntaxKind.EqualsEqualsToken ||
          operator === ts.SyntaxKind.ExclamationEqualsToken
        ) {
          return;
        }
      }
      if (parent && ts.isTaggedTemplateExpression(parent) && parent.template === node) return;
      const isAttr = parent && ts.isJsxAttribute(parent) && parent.initializer === node;
      edits.push({
        start: node.getStart(),
        end: node.getEnd(),
        text: isAttr ? `{tr(${JSON.stringify(text)})}` : `tr(${JSON.stringify(text)})`,
      });
      return;
    }

    if (ts.isTemplateExpression(node)) {
      if (ts.isTaggedTemplateExpression(ancestors[ancestors.length - 1] ?? node)) return;
      let pattern = node.head.text;
      const expressions = [];
      node.templateSpans.forEach((span, index) => {
        const innerEdits = collectEdits(span.expression, src, file);
        const start = span.expression.getStart();
        const end = span.expression.getEnd();
        let expressionText = src.slice(start, end);
        for (const edit of innerEdits.sort((a, b) => b.start - a.start)) {
          expressionText = expressionText.slice(0, edit.start - start) + edit.text + expressionText.slice(edit.end - start);
        }
        expressions.push(expressionText);
        pattern += `{${index}}` + span.literal.text;
      });
      if (!CJK.test(pattern) || sqlLike(pattern)) {
        // 模板本身没有中文时，仍要翻译插值表达式里的中文（例如 `${label}：${reason}`）
        for (const span of node.templateSpans) edits.push(...collectEdits(span.expression, src, file));
        return;
      }
      edits.push({
        start: node.getStart(),
        end: node.getEnd(),
        text: expressions.length ? `tr(${JSON.stringify(pattern)}, [${expressions.join(', ')}])` : `tr(${JSON.stringify(pattern)})`,
      });
      return;
    }

    if (ts.isJsxText(node)) {
      const text = node.text.replace(/[ \t\r\n]+/g, ' ');
      if (!CJK.test(text)) return;
      edits.push({ start: node.getStart(), end: node.getEnd(), text: `{tr(${JSON.stringify(text)})}` });
      return;
    }

    ts.forEachChild(node, (child) => visit(child, [...ancestors, node]));
  };
  visit(root, []);
  return edits;
}

let changedFiles = 0;
let changedNodes = 0;
for (const file of walk(SRC_ROOT)) {
  const src = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits = collectEdits(sf, src, file);
  if (!edits.length) continue;
  let out = src;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  if (!/\bimport\s*\{[^}]*\bas\s+tr\b[^}]*\}\s*from/.test(out)) {
    const relDir = path.relative(path.dirname(file), path.join(SRC_ROOT, 'i18n')).split(path.sep).join('/');
    const specifier = relDir.startsWith('.') ? relDir : `./${relDir}`;
    const imports = sf.statements.filter((statement) => ts.isImportDeclaration(statement));
    const insertAt = imports.length ? imports[imports.length - 1].getEnd() : 0;
    out = out.slice(0, insertAt) + `\nimport { t as tr } from '${specifier}';\n` + out.slice(insertAt);
  }
  fs.writeFileSync(file, out);
  changedFiles += 1;
  changedNodes += edits.length;
  console.log(`${path.relative('.', file).split(path.sep).join('/')}: ${edits.length}`);
}
console.log(JSON.stringify({ changedFiles, changedNodes }));
