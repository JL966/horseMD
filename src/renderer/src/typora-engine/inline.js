/* ============================================================
 * inline.js — 内联 tokenizer + DOM 生成
 *
 * 核心不变式(整个引擎的基石):
 *   block DOM 的 textContent === 该块内联 markdown 源文本
 * 语法字符全部位于 .md-meta / .md-content span 中(默认 display:none,
 * 光标进入所在 [md-inline] 容器时加 .md-expand 显示)。
 * 由此:
 *   - 实时预览 = 重新 tokenize 后替换内联 DOM
 *   - 取回源码 = 读 textContent(无需专门反解析)
 *   - 光标位置 = 字符偏移(在重渲染前后保持一致)
 * ============================================================ */

const MAX_STEPS = 200000;

/* ---------- 工具 ---------- */
const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function el(tag, cls, mdInline) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (mdInline) e.setAttribute('md-inline', mdInline);
  return e;
}
function spanMeta(text) {
  const s = el('span', 'md-meta');
  s.textContent = text;
  return s;
}
function textNode(s) { return document.createTextNode(s); }

/* ---------- tokenizer ---------- */

const URL_START = /^(https?:\/\/|www\.)/i;
const TRAIL_PUNCT = /[.,;:!?)\]}'"]+$/;

/** 判断 x 是否紧跟词字符(用于 _ 的成对边界) */
function isWordChar(c) { return /[\w\u4e00-\u9fff]/.test(c); }

export function tokenizeInline(src, opts = {}) {
  const tokens = [];
  let plain = '';
  let i = 0;
  let steps = 0;
  const n = src.length;
  const flush = () => { if (plain) { tokens.push({ type: 'text', text: plain }); plain = ''; } };

  /** 找成对定界符: 从 i 处的 openLen 个字符开始,向后找相同序列 */
  function findClose(pos, mark, allowInlineEnd) {
    let j = pos + mark.length;
    while (j < n) {
      if (src.startsWith(mark, j)) {
        // closer 前不能是空白(open 侧要求已由调用方保证)
        return j;
      }
      j++;
    }
    return -1;
  }

  while (i < n) {
    if (++steps > MAX_STEPS) { plain += src.slice(i); break; }
    const c = src[i];

    // 转义
    if (c === '\\' && i + 1 < n && /[`*_[\]()#.!~^=$\\<>"&|+-]/.test(src[i + 1])) {
      flush();
      tokens.push({ type: 'escape', char: src[i + 1] });
      i += 2;
      continue;
    }

    // 行内代码(反引号串)
    if (c === '`') {
      let run = 0;
      while (i + run < n && src[i + run] === '`') run++;
      // 找等长或更长的反引号串作为闭合
      let j = i + run, close = -1;
      while (j < n) {
        if (src[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && src[j + r2] === '`') r2++;
          if (r2 === run) { close = j; break; }
          j += r2;
        } else j++;
      }
      if (close > i + run) {
        flush();
        const content = src.slice(i + run, close);
        // 内容首尾各去一个空格(仅当首尾都是空格且内容非全空格)
        let inner = content;
        if (/^ .+ $/.test(inner)) inner = inner.slice(1, -1);
        tokens.push({ type: 'code', mark: '`'.repeat(run), content: inner });
        i = close + run;
        continue;
      }
      plain += '`'.repeat(run);
      i += run;
      continue;
    }

    // 图片 ![alt](src)
    if (c === '!' && src[i + 1] === '[') {
      const m = /^!\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"([^"]*)")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'image', alt: m[1], src: m[2], title: m[3] || '', raw: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // 脚注引用 [^id]
    if (c === '[' && src[i + 1] === '^') {
      const m = /^\[\^([^\]\s]+)\]/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'footnote', ref: m[1], raw: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // 链接 [text](url)
    if (c === '[') {
      const m = /^\[((?:\[[^\]]*\]|[^\[\]])*)\]\(\s*([^)\s]*)(?:\s+"([^"]*)")?\s*\)/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'link', label: m[1], href: m[2], title: m[3] || '', rawTail: '](' + (m[2]) + (m[3] ? ' "' + m[3] + '"' : '') + ')', rawHead: '[' });
        i += m[0].length;
        continue;
      }
    }

    // 自动链接 <url> / 行内 <u>..</u> / 其他行内 html
    if (c === '<') {
      const auto = /^<([A-Za-z][A-Za-z0-9+.-]*:[^<>\s]+|www\.[^<>\s]+|[^<>\s@]+@[^<>\s.]+\.[^<>\s]+)>/.exec(src.slice(i));
      if (auto) {
        flush();
        tokens.push({ type: 'autolink', url: auto[1], rawHead: '<', rawTail: '>' });
        i += auto[0].length;
        continue;
      }
      const um = /^<u>([\s\S]*?)<\/u>/i.exec(src.slice(i));
      if (um) {
        flush();
        tokens.push({ type: 'u', content: um[1], rawHead: '<u>', rawTail: '</u>' });
        i += um[0].length;
        continue;
      }
      const hm = /^<[^<>\s]+[^<>]*>/.exec(src.slice(i));
      if (hm) {
        flush();
        tokens.push({ type: 'html', text: hm[0] });
        i += hm[0].length;
        continue;
      }
    }

    // 行内公式 $...$
    if (c === '$' && src[i + 1] !== '$') {
      const m = /^\$([^$\n]+?)\$(?![\d])/.exec(src.slice(i));
      if (m && !/^\s|\s$/.test(m[1])) {
        flush();
        tokens.push({ type: 'math', content: m[1], raw: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // 高亮 ==x==
    if (c === '=' && src[i + 1] === '=') {
      const close = findClose(i + 2, '==');
      const seg = src.slice(i + 2);
      const m = /^==(?=\S)([\s\S]*?\S)==/.exec(seg);
      if (m) {
        flush();
        tokens.push({ type: 'mark', mark: '==', content: m[1], children: tokenizeInline(m[1], opts) });
        i += 2 + m[0].length;
        continue;
      }
    }

    // 删除线 ~~x~~
    if (c === '~' && src[i + 1] === '~') {
      const m = /^~~(?=\S)([\s\S]*?\S)~~/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'del', mark: '~~', content: m[1], children: tokenizeInline(m[1], opts) });
        i += m[0].length;
        continue;
      }
    }

    // 下标 ~x~ (单个 ~;markdownSyntax.subscript 开启才启用, 默认关 —
    // 与 Typora 一致, 避免中文范围 "1~2天" 误判)
    if (c === '~' && opts.subscript) {
      const m = /^~(?=\S)((?:[^~\s]|\\\s)+?)~/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'sub', mark: '~', content: m[1], children: tokenizeInline(m[1], opts) });
        i += m[0].length;
        continue;
      }
    }

    // 上标 ^x^ (markdownSyntax.superscript 开启才启用, 默认关)
    if (c === '^' && opts.superscript) {
      const m = /^\^(?=\S)((?:[^\^\s]|\\\s)+?)\^/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'sup', mark: '^', content: m[1], children: tokenizeInline(m[1], opts) });
        i += m[0].length;
        continue;
      }
    }

    // 加粗 ** 或 __
    if ((c === '*' && src[i + 1] === '*') || (c === '_' && src[i + 1] === '_')) {
      const mark = c + c;
      // opener 后不能是空白; __ 不允许词内
      const after = src[i + 2];
      const ok = after && !/\s/.test(after) && !(c === '_' && i > 0 && isWordChar(src[i - 1]));
      if (ok) {
        let j = i + 2, close = -1;
        while (j < n) {
          if (src.startsWith(mark, j) && !/\s/.test(src[j - 1])) { close = j; break; }
          j++;
        }
        if (close > 0) {
          flush();
          const inner = src.slice(i + 2, close);
          tokens.push({ type: 'strong', mark, children: tokenizeInline(inner, opts) });
          i = close + 2;
          continue;
        }
      }
    }

    // 斜体 * 或 _
    if (c === '*' || c === '_') {
      const after = src[i + 1];
      const before = src[i - 1];
      const okOpen = after && !/\s/.test(after) && after !== c;
      const wordOk = c === '*' || !before || !isWordChar(before);
      if (okOpen && wordOk) {
        // 找 closer: 单字符,前面非空白,后面非同字符
        let j = i + 1;
        let close = -1;
        while (j < n) {
          if (src[j] === c && src[j - 1] !== ' ' && src[j - 1] !== '\n' && src[j + 1] !== c &&
              (c === '*' || !isWordChar(src[j + 1] || ' '))) { close = j; break; }
          if (src[j] === c && src[j + 1] === c) { j++; continue; } // 跳过 strong 的部分
          j++;
        }
        if (close > i) {
          flush();
          const inner = src.slice(i + 1, close);
          tokens.push({ type: 'em', mark: c, children: tokenizeInline(inner, opts) });
          i = close + 1;
          continue;
        }
      }
    }

    // 实体
    if (c === '&') {
      const m = /^&#?[a-zA-Z0-9]{1,10};/.exec(src.slice(i));
      if (m) {
        flush();
        tokens.push({ type: 'entity', raw: m[0] });
        i += m[0].length;
        continue;
      }
    }

    // 裸 URL
    if (URL_START.test(src.slice(i, i + 9)) && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      let j = i;
      while (j < n && !/\s/.test(src[j])) j++;
      let url = src.slice(i, j).replace(TRAIL_PUNCT, '');
      if (url.length > 4) {
        flush();
        tokens.push({ type: 'url', url, raw: url });
        i += url.length;
        continue;
      }
    }

    plain += c;
    i++;
  }
  flush();
  return tokens;
}

/* ---------- DOM 生成 ---------- */

function renderChildren(tokens, frag, opts) {
  for (const t of tokens) frag.appendChild(renderToken(t, opts));
}

function renderToken(t, opts = {}) {
  switch (t.type) {
    case 'text':
      return textNode(t.text);

    case 'escape': {
      const w = el('span', '', 'escape');
      w.appendChild(spanMeta('\\'));
      const p = el('span', 'md-plain');
      p.textContent = t.char;
      w.appendChild(p);
      return w;
    }

    case 'strong': {
      const s = el('strong', '', 'strong');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'em': {
      const s = el('em', '', 'em');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'del': {
      const s = el('del', '', 'del');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'mark': {
      const s = el('mark', '', 'mark');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'u': {
      const s = el('u', '', 'u');
      s.appendChild(spanMeta(t.rawHead));
      const p = el('span', 'md-plain');
      p.textContent = t.content;
      s.appendChild(p);
      s.appendChild(spanMeta(t.rawTail));
      return s;
    }

    case 'code': {
      const s = el('code', '', 'code');
      s.appendChild(spanMeta(t.mark));
      const p = el('span', 'md-plain');
      p.textContent = t.content;
      s.appendChild(p);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'math': {
      const w = el('span', 'md-inline-math', 'math');
      w.appendChild(spanMeta('$'));
      const d = el('span', 'math-display');
      d.textContent = t.content;   // 渲染区先显示 TeX 源;接 KaTeX/MathJax 后替换
      w.appendChild(d);
      w.appendChild(spanMeta('$'));
      return w;
    }

    case 'link': {
      const w = el('span', 'md-link', 'link');
      const head = el('span', 'md-content');
      head.textContent = t.rawHead;
      w.appendChild(head);
      const a = document.createElement('a');
      a.setAttribute('href', t.href || '#');
      a.setAttribute('spellcheck', 'false');
      if (t.title) a.setAttribute('title', t.title);
      renderChildren(tokenizeInline(t.label, opts), a, opts);
      w.appendChild(a);
      const tail = el('span', 'md-content');
      tail.textContent = '](' + t.href + (t.title ? ' "' + t.title + '"' : '') + ')';
      w.appendChild(tail);
      return w;
    }

    case 'image': {
      const w = el('span', 'md-image', 'image');
      const meta = el('span', 'md-meta');
      meta.textContent = '![' + t.alt + '](' + t.src + (t.title ? ' "' + t.title + '"' : '') + ')';
      w.appendChild(meta);
      const img = document.createElement('img');
      if (t.src) img.setAttribute('src', t.src);
      img.setAttribute('alt', t.alt);
      if (t.title) img.setAttribute('title', t.title);
      img.addEventListener('load', () => w.classList.add('md-img-loaded'));
      img.addEventListener('error', () => w.classList.add('md-img-error'));
      if (t.src) w.classList.add('md-img-loading');
      w.appendChild(img);
      return w;
    }

    case 'autolink': {
      const w = el('span', 'md-link', 'url');
      const head = el('span', 'md-content');
      head.textContent = t.rawHead;
      w.appendChild(head);
      const a = el('a', 'md-url');
      a.setAttribute('href', t.url);
      a.textContent = t.url;
      w.appendChild(a);
      const tail = el('span', 'md-content');
      tail.textContent = t.rawTail;
      w.appendChild(tail);
      return w;
    }

    case 'url': {
      const w = el('span', '', 'url');
      const a = el('a', 'md-url');
      a.setAttribute('href', t.url.startsWith('www.') ? 'https://' + t.url : t.url);
      a.textContent = t.raw;
      w.appendChild(a);
      return w;
    }

    case 'footnote': {
      const w = el('sup', 'md-footnote', 'footnote');
      w.appendChild(spanMeta('['));
      const p = el('span', 'md-plain');
      p.textContent = '^' + t.ref;
      w.appendChild(p);
      w.appendChild(spanMeta(']'));
      return w;
    }

    case 'sub': {
      const s = el('sub', '', 'sub');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'sup': {
      const s = el('sup', '', 'sup');
      s.appendChild(spanMeta(t.mark));
      renderChildren(t.children, s, opts);
      s.appendChild(spanMeta(t.mark));
      return s;
    }

    case 'entity': {
      const w = el('span', 'md-entity', 'entity');
      let decoded = t.raw;
      try { decoded = new DOMParser().parseFromString(t.raw, 'text/html').documentElement.textContent; } catch (e) { /* keep raw */ }
      w.setAttribute('data-content', decoded);
      const m = spanMeta(t.raw);
      w.appendChild(m);
      return w;
    }

    case 'html': {
      const w = el('span', 'md-html-inline', 'html');
      const p = el('span', 'md-plain');
      p.textContent = t.text;
      w.appendChild(p);
      return w;
    }

    default:
      return textNode(t.text || '');
  }
}

export function renderInlineDOM(tokens, opts) {
  const frag = document.createDocumentFragment();
  renderChildren(tokens, frag, opts);
  return frag;
}

/** 给定内联源文本 → DOM fragment */
export function inlineTextToDOM(text, opts) {
  return renderInlineDOM(tokenizeInline(text, opts), opts);
}
