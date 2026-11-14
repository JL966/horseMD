/* ============================================================
 * highlight.js — 简易语法高亮(纯前端, 零依赖)
 * 输出 .cm-* 类名并包裹在 .cm-s-inner 容器中(由 render.js 保证),
 * 与 Typora 主题的代码高亮契约兼容: 主题可用
 * `.cm-s-inner .cm-keyword { ... }` 覆盖颜色。
 * ============================================================ */

const KW = {
  js: 'const let var function return if else for while do class new import export from as async await try catch finally throw typeof instanceof this super switch case break continue default extends of in yield delete void static get set null undefined true false',
  python: 'def class return if elif else for while import from as with try except finally raise lambda yield pass break continue in is not and or global nonlocal assert async await del print',
  c: 'int char float double void long short unsigned signed struct union enum typedef static const volatile return if else for while do switch case break continue default sizeof goto extern register auto inline public private protected class new delete this virtual override namespace using template typename const_cast try catch throw operator',
  java: 'public private protected class interface extends implements static final void int long double float boolean char byte short new return if else for while do switch case break continue default try catch finally throw throws this super import package synchronized abstract enum instanceof assert transient volatile native strictfp',
  bash: 'if then else elif fi for while until do done case esac function return in local export readonly shift break continue exit',
  css: '',
  json: 'true false null',
  xml: '',
};

const BUILTIN = {
  js: 'console Math JSON Object Array String Number Boolean Promise Map Set Symbol Date RegExp Error parseInt parseFloat setTimeout setInterval fetch require module window document',
  python: 'len range str int float list dict set tuple bool abs min max sum sorted enumerate zip map filter open type isinstance super print round input',
  c: 'printf scanf malloc free memcpy strlen cout cin endl vector string map set',
  java: 'System String Integer Long Double Float Boolean Character ArrayList HashMap Math Object',
};

/** 组合正则构造器: 每条 [regex, className],按序尝试 */
function buildRules(lang) {
  const rules = [];
  const push = (re, cls) => rules.push([re, cls]);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  switch (lang) {
    case 'js': case 'javascript': case 'ts': case 'typescript': case 'jsx': case 'tsx':
    case 'java': case 'c': case 'cpp': case 'c++': case 'cs': case 'go': case 'rust': case 'dart': case 'kotlin': {
      const kw = KW[lang === 'javascript' ? 'js' : lang] || KW.js;
      push(/\/\/[^\n]*/, 'cm-comment');
      push(/\/\*[\s\S]*?\*\//, 'cm-comment');
      push(/`(?:\\.|[^`\\])*`/, 'cm-string');
      push(/"(?:\\.|[^"\\])*"/, 'cm-string');
      push(/'(?:\\.|[^'\\])*'/, 'cm-string');
      push(/\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLdDuU]?\b/, 'cm-number');
      push(new RegExp('\\b(?:' + kw.split(' ').map(esc).join('|') + ')\\b'), 'cm-keyword');
      push(new RegExp('\\b(?:' + (BUILTIN[lang] || BUILTIN.js).split(' ').map(esc).join('|') + ')\\b'), 'cm-builtin');
      push(/\b[A-Za-z_$][\w$]*(?=\s*\()/, 'cm-def');
      push(/\b[A-Z][\w$]*\b/, 'cm-variable-2');
      break;
    }
    case 'python': case 'py': {
      push(/#[^\n]*/, 'cm-comment');
      push(/"""[\s\S]*?"""|'''[\s\S]*?'''/, 'cm-string');
      push(/(?:[rbfu]{0,2})"(?:\\.|[^"\\])*"|(?:[rbfu]{0,2})'(?:\\.|[^'\\])*'/i, 'cm-string');
      push(/@[\w.]+/, 'cm-meta');
      push(/\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?j?\b/, 'cm-number');
      push(new RegExp('\\b(?:' + KW.python.split(' ').map(esc).join('|') + ')\\b'), 'cm-keyword');
      push(new RegExp('\\b(?:' + BUILTIN.python.split(' ').map(esc).join('|') + ')\\b'), 'cm-builtin');
      push(/\b[A-Za-z_]\w*(?=\s*\()/, 'cm-def');
      break;
    }
    case 'json': {
      push(/"(?:\\.|[^"\\])*"(?=\s*:)/, 'cm-attribute');
      push(/"(?:\\.|[^"\\])*"/, 'cm-string');
      push(/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'cm-number');
      push(/\b(?:true|false|null)\b/, 'cm-atom');
      break;
    }
    case 'css': case 'scss': case 'less': {
      push(/\/\*[\s\S]*?\*\//, 'cm-comment');
      push(/@[\w-]+/, 'cm-meta');
      push(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'cm-string');
      push(/#[0-9a-fA-F]{3,8}\b/, 'cm-number');
      push(/-?\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|vmin|vmax|%|s|ms|pt|ch|fr|deg)?\b/, 'cm-number');
      push(/[\w-]+(?=\s*:)/, 'cm-attribute');
      push(/\.[-\w]+|#[\w-]+(?![0-9a-fA-F]{3})/, 'cm-variable-2');
      push(/:{1,2}[-\w]+/, 'cm-builtin');
      break;
    }
    case 'html': case 'xml': case 'svg': case 'vue': {
      push(/<!--[\s\S]*?-->/, 'cm-comment');
      push(/<\/?[\w-]+/, 'cm-tag');
      push(/[\w-]+(?==)/, 'cm-attribute');
      push(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'cm-string');
      push(/\/?>/, 'cm-bracket');
      break;
    }
    case 'bash': case 'sh': case 'shell': case 'zsh': {
      push(/#[^\n]*/, 'cm-comment');
      push(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'cm-string');
      push(/\$\{?[\w@#?*]+\}?/, 'cm-variable-2');
      push(new RegExp('\\b(?:' + KW.bash.split(' ').map(esc).join('|') + ')\\b'), 'cm-keyword');
      break;
    }
    case 'yaml': case 'yml': {
      push(/#[^\n]*/, 'cm-comment');
      push(/^[\w.-]+(?=\s*:)/m, 'cm-attribute');
      push(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/, 'cm-string');
      push(/\b(?:true|false|null|~)\b/, 'cm-atom');
      push(/-?\b\d+(?:\.\d+)?\b/, 'cm-number');
      break;
    }
    case 'md': case 'markdown': {
      push(/^#{1,6}\s.*$/m, 'cm-header');
      push(/\*\*[^*]+\*\*/, 'cm-strong');
      push(/`[^`\n]+`/, 'cm-string');
      break;
    }
    default:
      return null;
  }
  return rules;
}

const ruleCache = new Map();

/** 返回高亮后的 HTML 字符串(仅包含 span 包裹,不增删任何字符) */
export function highlightCode(lang, code) {
  const l = String(lang || '').toLowerCase().trim();
  let rules = ruleCache.get(l);
  if (rules === undefined) { rules = buildRules(l); ruleCache.set(l, rules); }
  if (!rules) {
    return escapeHtmlText(code);
  }
  const master = new RegExp(rules.map(r => '(' + r[0].source + ')').join('|'), 'gm');
  const src = String(code);
  let out = '';
  let last = 0;
  let m;
  while ((m = master.exec(src)) !== null) {
    if (m.index > last) out += escapeHtmlText(src.slice(last, m.index));
    let cls = 'cm-keyword';
    for (let g = 1; g <= rules.length; g++) {
      if (m[g] !== undefined) { cls = rules[g - 1][1]; break; }
    }
    out += '<span class="' + cls + '">' + escapeHtmlText(m[0]) + '</span>';
    last = m.index + m[0].length;
    if (m[0].length === 0) master.lastIndex++;
  }
  out += escapeHtmlText(src.slice(last));
  return out;
}

function escapeHtmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
