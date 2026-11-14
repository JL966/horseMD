/* ============================================================
 * render.js — 块树 → 契约 DOM
 * 每个块元素携带 cid + mdtype;可编辑区域划分:
 *   - 文本宿主: p / h1-h6 / td-span / 代码 shim / 公式输入区 /
 *     YAML pre / def-name·content → contenteditable=true
 *   - 容器/非编辑: blockquote, ul/ol/li, figure, hr, toc, html 块
 * ============================================================ */
import { T } from './model.js';
import { inlineTextToDOM } from './inline.js';
import { highlightCode } from './highlight.js';

const escapeHtmlAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function setBlockAttrs(el, b, extraCls = '') {
  el.setAttribute('cid', b.id);
  el.setAttribute('mdtype', b.type);
  if (extraCls) el.classList.add(...extraCls.split(' ').filter(Boolean));
  el.classList.add('md-end-block');
  return el;
}

/** heading 前缀字符(# / setext 用伪元素显示,不进 textContent) */
function headingPrefix(b) {
  if (b.attrs.style === 'setext') return '';
  return '#'.repeat(b.attrs.depth || 1) + ' ';
}

export function blockToDOM(b, ctx) {
  switch (b.type) {
    case T.paragraph: {
      const p = document.createElement('p');
      setBlockAttrs(p, b, 'md-p');
      p.appendChild(inlineTextToDOM(b.text, ctx.opts));
      return p;
    }
    case T.heading: {
      const depth = b.attrs.depth || 1;
      const h = document.createElement('h' + depth);
      setBlockAttrs(h, b, 'md-heading');
      h.setAttribute('data-prefix', headingPrefix(b));
      h.appendChild(inlineTextToDOM(b.text, ctx.opts));
      return h;
    }
    case T.meta: {
      const pre = document.createElement('pre');
      setBlockAttrs(pre, b, 'md-meta-block');
      pre.setAttribute('contenteditable', 'true');
      pre.setAttribute('spellcheck', 'false');
      pre.textContent = b.text;
      return pre;
    }
    case T.quote: {
      let host;
      if (b.attrs.alert) {
        host = document.createElement('div');
        setBlockAttrs(host, b, `md-alert md-alert-${b.attrs.alert}`);
        const marker = document.createElement('p');
        marker.className = 'md-alert-text md-alert-text-' + b.attrs.alert;
        marker.setAttribute('contenteditable', 'false');
        marker.textContent = '[!' + b.attrs.alert.charAt(0).toUpperCase() + b.attrs.alert.slice(1) + ']';
        host.appendChild(marker);
      } else {
        host = document.createElement('blockquote');
        setBlockAttrs(host, b);
      }
      for (const c of b.children || []) host.appendChild(blockToDOM(c, ctx));
      return host;
    }
    case T.list: {
      const ordered = !!b.attrs.ordered;
      const listEl = document.createElement(ordered ? 'ol' : 'ul');
      setBlockAttrs(listEl, b, ordered ? 'ol-list' : 'ul-list');
      if (ordered && b.attrs.start && b.attrs.start !== 1) listEl.setAttribute('start', b.attrs.start);
      if (!ordered) listEl.setAttribute('data-mark', b.attrs.mark || '-');
      for (const li of b.children || []) listEl.appendChild(blockToDOM(li, ctx));
      return listEl;
    }
    case T.listItem: {
      const li = document.createElement('li');
      const cls = ['md-list-item'];
      if (b.attrs.task) {
        cls.push('task-list-item', 'md-task-list-item', b.attrs.checked ? 'task-list-done' : 'task-list-not-done');
      }
      setBlockAttrs(li, b, cls.join(' '));
      if (b.attrs.task) {
        const input = document.createElement('input');
        input.type = 'checkbox';
        if (b.attrs.checked) input.setAttribute('checked', '');
        input.addEventListener('click', (e) => {
          e.preventDefault();
          ctx && ctx.onTaskToggle && ctx.onTaskToggle(b, input.checked);
        });
        li.appendChild(input);
      }
      for (const c of b.children || []) li.appendChild(blockToDOM(c, ctx));
      return li;
    }
    case T.fences: {
      const pre = document.createElement('pre');
      setBlockAttrs(pre, b, 'md-fences');
      pre.setAttribute('contenteditable', 'false');
      pre.setAttribute('spellcheck', 'false');
      if (b.attrs.lang) pre.setAttribute('lang', b.attrs.lang);
      const header = document.createElement('span');
      header.className = 'fences-header';
      header.textContent = (b.attrs.fence || '```') + (b.attrs.lang || '');
      pre.appendChild(header);
      const shim = document.createElement('div');
      shim.className = 'code-mirror-shim cm-s-inner';
      shim.setAttribute('contenteditable', 'true');
      shim.setAttribute('spellcheck', 'false');
      shim.innerHTML = highlightCode(b.attrs.lang || '', b.text);
      pre.appendChild(shim);
      return pre;
    }
    case T.math: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'mathjax-block md-math-block md-rawblock');
      div.setAttribute('contenteditable', 'false');
      div.setAttribute('spellcheck', 'false');
      const container = document.createElement('div');
      container.className = 'md-rawblock-container md-math-container';
      const before = document.createElement('div');
      before.className = 'md-rawblock-control md-rawblock-before';
      before.textContent = '$$';
      const input = document.createElement('div');
      input.className = 'md-rawblock-input md-mathblock-input';
      input.setAttribute('contenteditable', 'true');
      input.setAttribute('spellcheck', 'false');
      input.textContent = b.text;
      const after = document.createElement('div');
      after.className = 'md-rawblock-control md-rawblock-after';
      after.textContent = '$$';
      container.appendChild(before);
      container.appendChild(input);
      container.appendChild(after);
      div.appendChild(container);
      return div;
    }
    case T.hr: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'md-hr');
      div.setAttribute('contenteditable', 'false');
      div.setAttribute('tabindex', '-1');
      div.appendChild(document.createElement('hr'));
      return div;
    }
    case T.table: {
      const fig = document.createElement('figure');
      setBlockAttrs(fig, b, 'md-table-fig table-figure');
      fig.setAttribute('contenteditable', 'false');
      const table = document.createElement('table');
      table.className = 'md-table';
      const thead = document.createElement('thead');
      const tbody = document.createElement('tbody');
      let inHead = true;
      for (const row of b.children || []) {
        const tr = blockToDOM(row, ctx);
        if (row.attrs.head) { thead.appendChild(tr); }
        else { if (inHead) { inHead = false; } tbody.appendChild(tr); }
      }
      if (thead.hasChildNodes()) table.appendChild(thead);
      if (tbody.hasChildNodes()) table.appendChild(tbody);
      fig.appendChild(table);
      return fig;
    }
    case T.row: {
      const tr = document.createElement('tr');
      setBlockAttrs(tr, b);
      for (const cell of b.children || []) {
        const th = cell.attrs.th ? 'th' : 'td';
        const td = document.createElement(th);
        if (th === 'td' && tr.attrsAlign) td.setAttribute('style', 'text-align:' + tr.attrsAlign);
        td.appendChild(blockToDOM(cell, ctx));
        tr.appendChild(td);
      }
      return tr;
    }
    case T.cell: {
      const span = document.createElement('span');
      setBlockAttrs(span, b, 'td-span');
      span.setAttribute('contenteditable', 'true');
      span.appendChild(inlineTextToDOM(b.text, ctx.opts));
      return span;
    }
    case T.toc: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'md-toc');
      div.setAttribute('contenteditable', 'false');
      div.setAttribute('tabindex', '-1');
      const tip = document.createElement('div');
      tip.className = 'md-tooltip-hide md-toc-tooltip';
      tip.textContent = '[TOC] — 目录随文档自动更新';
      div.appendChild(tip);
      const content = document.createElement('p');
      content.className = 'md-toc-content';
      if (ctx && ctx.tocHTML) content.innerHTML = ctx.tocHTML;
      div.appendChild(content);
      return div;
    }
    case T.html: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'md-htmlblock md-rawblock');
      div.setAttribute('contenteditable', 'false');
      div.setAttribute('spellcheck', 'false');
      const head = document.createElement('div');
      head.className = 'md-rawblock-control';
      head.textContent = 'HTML';
      const src = document.createElement('div');
      src.className = 'md-raw-html-src';
      const inner = document.createElement('div');
      inner.className = 'md-raw-html-src-content';
      inner.textContent = b.text;
      src.appendChild(inner);
      div.appendChild(head);
      div.appendChild(src);
      return div;
    }
    case T.defLink: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'footnotes md-def-link');
      div.setAttribute('contenteditable', 'false');
      const name = document.createElement('span');
      name.className = 'md-def-name';
      name.setAttribute('contenteditable', 'true');
      name.textContent = b.attrs.ref || '';
      const content = document.createElement('span');
      content.className = 'md-def-content md-def-url';
      content.setAttribute('contenteditable', 'true');
      content.setAttribute('spellcheck', 'false');
      content.textContent = b.attrs.href || '';
      div.appendChild(name);
      div.appendChild(content);
      return div;
    }
    case T.defFootnote: {
      const div = document.createElement('div');
      setBlockAttrs(div, b, 'footnotes md-def-footnote');
      div.setAttribute('contenteditable', 'false');
      const name = document.createElement('span');
      name.className = 'md-def-name';
      name.setAttribute('contenteditable', 'true');
      name.textContent = b.attrs.ref || '';
      const content = document.createElement('span');
      content.className = 'md-def-content';
      content.setAttribute('contenteditable', 'true');
      content.textContent = b.text || '';
      div.appendChild(name);
      div.appendChild(content);
      return div;
    }
    default: {
      const p = document.createElement('p');
      setBlockAttrs(p, b);
      p.textContent = b.text || '';
      return p;
    }
  }
}

/** 生成 TOC 的内部 HTML(由 headings 列表) */
export function buildTocHTML(headings) {
  // headings: [{depth, text, id}]
  return headings.map(h =>
    `<span class="md-toc-item md-toc-h${h.depth}"><a class="md-toc-inner" href="#${h.id}">${escapeHtmlAttr(h.text) || '&nbsp;'}</a></span>`
  ).join('');
}

/** 渲染整棵文档树,替换容器内容 */
export function renderDoc(root, container, ctx = {}) {
  const frag = document.createDocumentFragment();
  for (const b of root.children || []) frag.appendChild(blockToDOM(b, ctx));
  container.replaceChildren(frag);
}

/** 渲染单个块(用于 brush 局部刷新): 返回新元素 */
export function renderBlock(b, ctx = {}) {
  return blockToDOM(b, ctx);
}
