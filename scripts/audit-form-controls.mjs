import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 桌面端的表单控件全部由应用自己绘制。这些漂移都只在运行时表现为
// “某个控件突然变成系统样式”，e2e 覆盖不到的面板（如表设计器）更是完全静默。
const src = process.argv[2] ?? fileURLToPath(new URL('../apps/desktop/src', import.meta.url));
const problems = [];

function walk(dir, visit) {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, visit);
    else if (n.endsWith('.tsx') || n.endsWith('.css')) visit(p.replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
  }
}

const rel = (p) => p.replace(src.replace(/\\/g, '/') + '/', '');
const line = (text, index) => text.slice(0, index).split('\n').length;
// 注释里的 --token / select / prompt 不是真声明；抹成等长空格以保留行号
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));

// 1) var(--x) 必须有定义：tokens.css 里的主题 token，或组件样式里就地声明的局部变量
const defined = new Set();
walk(src, (p, text) => {
  if (!p.endsWith('.css')) return;
  for (const m of stripComments(text).matchAll(/(^|[\s;{])(--[a-z0-9-]+)\s*:/g)) defined.add(m[2]);
});
walk(src, (p, text) => {
  if (p.endsWith('.css')) text = stripComments(text);
  for (const m of text.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    if (!defined.has(m[1])) problems.push(`${rel(p)}:${line(text, m.index)} 未定义的 token ${m[1]}`);
  }
});

// 2) 原生 select 已被组件替换：样式里不该再留裸 select 元素选择器，JSX 里也不该再出现原生标签
walk(src, (p, text) => {
  if (!p.endsWith('.css')) return;
  text = stripComments(text);
  for (const m of text.matchAll(/(^|[\s,{])(select)\s*[:{,\s]/g)) {
    const start = m.index + m[1].length;
    problems.push(`${rel(p)}:${line(text, start)} 失效的元素选择器 "select"（已无原生 select）`);
  }
});
walk(src, (p, text) => {
  if (!p.endsWith('.tsx')) return;
  // 共享组件是 <Select>/<Option>/<OptGroup>/<Combo>；小写标签才是浏览器自己绘制的下拉列表
  for (const m of text.matchAll(/<(select|option|optgroup|datalist)[\s/>]/g)) {
    problems.push(`${rel(p)}:${line(text, m.index)} 原生 <${m[1]}> 标签（下拉/建议列表由系统绘制，用共享 Select / Combo）`);
  }
});

// 3) 系统绘制的表单控件必须由应用接管：appearance:none + 自绘标记
const themed = [];
walk(src, (p, text) => {
  if (!p.endsWith('.css')) return;
  for (const kind of ['checkbox', 'radio']) {
    if (new RegExp(`input\\[type='${kind}'\\][^{]*\\{[^}]*appearance:\\s*none`).test(text)) themed.push(kind);
  }
  if (/input\[type='number'\][^{]*\{[^}]*appearance:\s*textfield/.test(text)) themed.push('number');
  if (/details\s*>\s*summary\s*\{[^}]*list-style:\s*none/.test(text)) themed.push('details');
});
for (const kind of ['checkbox', 'radio', 'number', 'details']) {
  if (!themed.includes(kind)) problems.push(`styles/*.css 缺少 ${kind} 的自绘接管规则`);
}

// 4) 系统对话框会把主题和语言整个甩开（`.prompt(` 这类属性调用不算）
walk(src, (p, text) => {
  if (!p.endsWith('.tsx')) return;
  for (const m of text.matchAll(/(^|[^.\w$])(alert|confirm|prompt)\s*\(/g)) {
    problems.push(`${rel(p)}:${line(text, m.index)} 调用了系统对话框 ${m[2]}(`);
  }
});

// 5) 隐藏的文件选择框统一挂 .file-input：直接内联 display:none 会在别处漂移，
//    而漏掉隐藏配置的 <input type=file> 会在页面上画出系统的「选择文件」控件。
// 属性里有箭头函数（onChange={(e) => …}），按第一个 > 截断会读错，改成按括号深度找标签结尾。
function formTags(text) {
  const out = [];
  for (const m of text.matchAll(/<(input|textarea)\b/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let end = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if ('{(['.includes(ch)) depth++;
      else if ('})]'.includes(ch)) depth--;
      else if (ch === '>' && depth === 0) { end = i; break; }
      else if (ch === '/' && text[i + 1] === '>' && depth === 0) { end = i; break; }
    }
    if (end > 0) out.push({ index: m.index, props: text.slice(m.index + m[0].length, end) });
  }
  return out;
}
walk(src, (p, text) => {
  if (!p.endsWith('.tsx')) return;
  for (const tag of formTags(text)) {
    if (/style=\{\{[^}]*display:\s*'none'/.test(tag.props)) {
      problems.push(`${rel(p)}:${line(text, tag.index)} 用内联 display:none 隐藏控件（挂 .file-input / 用类名）`);
    }
    if (/type=["']file["']/.test(tag.props) && !/className=["']file-input["']/.test(tag.props)) {
      problems.push(`${rel(p)}:${line(text, tag.index)} <input type=file> 未隐藏，会露出系统选文件控件（挂 .file-input）`);
    }
  }
});

if (problems.length) {
  console.error(`表单控件审计发现 ${problems.length} 处问题:`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('表单控件审计通过：token 全部有定义、无失效元素选择器、系统控件已接管、无系统对话框、无裸文件选择框');
