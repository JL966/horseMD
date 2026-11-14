/* ============================================================
 * editor.js — 编辑器主体
 *
 * 架构(对齐 Typora 机制):
 *   model(Block 树)是唯一事实源;DOM 是它的渲染。
 *   - 打字: 放行原生编辑 → input 事件把 DOM textContent 同步回
 *     model → brush 重新 tokenize 该块 → 替换该块 DOM → 光标按
 *     字符偏移恢复(textContent 恒等于源文本, 偏移天然稳定)
 *   - 结构操作(Enter/Backspace/Tab/粘贴/命令): 直接改 model →
 *     全量/局部渲染 → 光标按 {cid, offset} 恢复
 *   - 语法字符的显示/隐藏: 光标所在 [md-inline] 容器加 .md-expand
 * ============================================================ */
import { Block, T } from './model.js';
import { parseMarkdown } from './parser.js';
import { inlineTextToDOM, tokenizeInline } from './inline.js';
import { renderDoc, renderBlock, buildTocHTML } from './render.js';
import { docToMarkdown } from './serialize.js';
import {
  markdownOffsetFromSelection as mapOffsetFromSelection,
  markdownOffsetFromViewportTop as mapOffsetFromViewportTop,
  focusMarkdownOffset as mapFocusOffset
} from './offsets.js';

const TEXT_HOSTS = new Set([T.paragraph, T.heading, T.cell, T.fences, T.math, T.meta]);

/* ---------------- 文本工具 ---------------- */

function textNodesUnder(el) {
  const out = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
  let n;
  while ((n = walker.nextNode())) out.push(n);
  return out;
}

/** (node, offset) 在 host 内的字符偏移 —— 用 Range.toString():
 *  与 DOM 顺序一致, 且包含隐藏 .md-meta 内的文本, 与 textContent 不变式吻合 */
function offsetOf(host, node, offset) {
  if (!host) return 0;
  if (node !== host && !host.contains(node)) return 0;
  try {
    const r = document.createRange();
    r.setStart(host, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  } catch (e) {
    return 0;
  }
}

/** 字符偏移 → (node, offset);返回 false 表示越界 */
function locate(host, off) {
  let acc = 0;
  for (const t of textNodesUnder(host)) {
    if (acc + t.length >= off) return { node: t, offset: off - acc };
    acc += t.length;
  }
  const list = textNodesUnder(host);
  if (!list.length) return { node: host, offset: 0 };
  const last = list[list.length - 1];
  return { node: last, offset: last.length };
}

function setSelection(host, start, end = start) {
  if (!host) return;
  const a = locate(host, Math.min(start, end));
  const b = locate(host, Math.max(start, end));
  const r = document.createRange();
  try { r.setStart(a.node, a.offset); r.setEnd(b.node, b.offset); } catch (e) { return; }
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ---------------- Editor ---------------- */

export class Editor {
  constructor(container, opts = {}) {
    this.container = container;          // #write
    this.opts = Object.assign({
      headingStyle: 1,
      ulStyle: '-',
      olStyle: '.',
      tabSize: 4,
      onStatus: null,      // ({chars, words, lines})
      onChange: null,      // (dirty)
      onToast: null,       // (msg)
      openExternal: null,  // (href)
      onStructureChange: null, // () — 块结构变化(宿主刷新大纲等)
      onActiveBlock: null,     // (cid) — 焦点块变化
      onPasteImage: null,      // (File) — 图片粘贴交给宿主
    }, opts);
    this.root = new Block(T.doc);
    this.nodeMap = new Map();
    this.focusCid = null;
    this.composing = false;
    this.expandEl = null;
    this.brushTimer = 0;
    this.undoStack = [];
    this.redoStack = [];
    this._undoArmed = null;
    this._undoTimer = 0;
    this.readOnly = !!opts.readOnly;
    this.destroyed = false;
    this._hadCRLF = false;
    this._hadBOM = false;
    this._mutVersion = 0;  // 模型变更计数(spans 偏移缓存失效)
    this._listeners = [];  // [target, type, fn] — destroy 时统一摘除
    this.ctx = {
      onTaskToggle: (b, checked) => this.onTaskToggle(b, checked),
      tocHTML: '',
      // 内联语法开关(markdownSyntax: subscript/superscript), 默认关 — Typora 同款
      opts: Object.assign({}, opts.markdownSyntax),
    };
    this._bind();
    this._status();
  }

  /* ============ 装载 ============ */

  setMarkdown(md) {
    const src = String(md || '');
    this._hadBOM = src.charCodeAt(0) === 0xfeff;
    this._hadCRLF = src.includes('\r\n');
    this.root = parseMarkdown(src);
    // 空文档引导: 至少一个空段落, 保证光标始终落在块内
    if (!this.root.children || !this.root.children.length) {
      this.root.appendChild(new Block(T.paragraph, { text: '' }));
    }
    this._rebuildMap();
    this.renderAll();
    this._mutVersion++;
    this.opts.onChange && this.opts.onChange(false);
    this._status();
  }

  /** 整体替换(宿主源码模式切回/查找替换): 重解析, 光标回文档首 */
  replaceMarkdown(md) {
    this.setMarkdown(md);
    this._mutVersion++;
    const first = this.root.children && this.root.children[0];
    if (first) this.focusBlock(first, 0);
    this.opts.onChange && this.opts.onChange(true);
  }

  /* ---- 光标 ↔ markdown 偏移(文档位置记忆/全局搜索) ---- */

  markdownOffsetFromSelection() {
    return mapOffsetFromSelection(this);
  }

  markdownOffsetFromViewportTop(scroller) {
    return mapOffsetFromViewportTop(this, scroller);
  }

  focusMarkdownOffset(offset) {
    return mapFocusOffset(this, offset);
  }

  getMarkdown() {
    let md = docToMarkdown(this.root, {
      headingStyle: this.opts.headingStyle,
      ulStyle: this.opts.ulStyle,
      olStyle: this.opts.olStyle,
    });
    // 保真: 载入时的 BOM / CRLF 在导出时还原(引擎内部一律 LF 处理)
    if (this._hadCRLF) md = md.replace(/\n/g, '\r\n');
    if (this._hadBOM) md = '\ufeff' + md;
    return md;
  }

  _rebuildMap() {
    this.nodeMap.clear();
    this.root.walk(b => this.nodeMap.set(b.id, b));
    this._refreshToc();
  }

  _refreshToc() {
    const heads = [];
    this.root.walk(b => {
      if (b.type === T.heading && b.text) heads.push({ depth: b.attrs.depth, text: b.text, id: b.id });
    });
    this.ctx.tocHTML = buildTocHTML(heads);
  }

  renderAll() {
    renderDoc(this.root, this.container, this.ctx);
    this.container.setAttribute('contenteditable', this.readOnly ? 'false' : 'true');
    this.container.setAttribute('spellcheck', this.opts.spellcheck ? 'true' : 'false');
  }

  /* ============ 事件绑定 ============ */

  /** 注册可销毁监听;keydown 只挂 document 一份(容器内/焦点在 body 都能覆盖,
   *  避免 Tab 等未被 stopPropagation 的键被两个监听各执行一次) */
  _on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this._listeners.push([target, type, fn, opts]);
  }

  _bind() {
    const c = this.container;

    this._on(c, 'beforeinput', (e) => this._onBeforeInput(e));
    this._on(c, 'input', (e) => this._onInput(e));
    this._on(c, 'compositionstart', () => { this.composing = true; });
    this._on(c, 'compositionend', () => { this.composing = false; this._onCompositionEnd(); });
    // 命令快捷键挂 document 级: 焦点掉到 body 时命令仍可用(Typora 同款)
    this._on(document, 'keydown', (e) => this._onKeyDown(e));
    this._on(c, 'paste', (e) => this._onPaste(e));
    this._on(c, 'copy', (e) => this._onCopy(e, false));
    this._on(c, 'click', (e) => this._onClick(e));
    this._on(document, 'selectionchange', () => this._updateCaretUI());
  }

  setReadOnly(v) {
    this.readOnly = !!v;
    this.container.setAttribute('contenteditable', this.readOnly ? 'false' : 'true');
    if (this.readOnly) this.flushBrush();
  }

  destroy() {
    this.destroyed = true;
    this.flushBrush();
    for (const [target, type, fn, opts] of this._listeners) {
      target.removeEventListener(type, fn, opts);
    }
    this._listeners = [];
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = 0; }
    clearTimeout(this.brushTimer);
    this.brushTimer = 0;
    this._pendingBrush = null;
  }

  _inside(target) {
    return this.container.contains(target) || target === this.container;
  }

  /* ---- beforeinput: 拦截结构性编辑, 放行文本编辑 ---- */
  _onBeforeInput(e) {
    if (this.composing || this.readOnly) return;
    if (!this._inside(e.target)) return;
    const t = e.inputType;

    if (t === 'historyUndo' || t === 'historyRedo') {
      e.preventDefault();
      t === 'historyUndo' ? this.undo() : this.redo();
      return;
    }
    if (t === 'insertParagraph') {
      e.preventDefault();
      this.armUndo();
      this.opEnter(false);
      return;
    }
    if (t === 'insertText') {
      // 光标不在任何文本宿主内 → 拒绝游离编辑(避免在模型外产生裸文本)
      if (!this.selInfo() || this.selInfo().raw) e.preventDefault();
      return;
    }
    if (t === 'insertLineBreak') {
      e.preventDefault();
      this.armUndo();
      this.opInsertHardBreak();
      return;
    }
    if (t === 'deleteContentBackward' || t === 'deleteContentForward') {
      const info = this.selInfo();
      if (!info) return;
      if (!info.collapsed) {
        // 跨块删除 → 结构化处理
        if (info.crossBlock) {
          e.preventDefault();
          this.armUndo();
          this.opDeleteSelection(info);
        }
        return; // 块内选择删除放行原生, input 同步
      }
      const atStart = info.start === 0 && t === 'deleteContentBackward';
      const atEnd = info.start >= info.hostLen && t === 'deleteContentForward';
      if (atStart || atEnd) {
        e.preventDefault();
        this.armUndo();
        t === 'deleteContentBackward' ? this.opBackspaceAtStart(info) : this.opDeleteAtEnd(info);
      }
      return;
    }
    if (t === 'insertFromPaste' || t === 'insertFromDrop') {
      // paste/drop 事件已接管; 兜底拦截
      e.preventDefault();
      return;
    }
    // insertText / insertCompositionText / deleteWordBackward / deleteByCut 等 → 放行
  }

  /* ---- input: 文本同步 + brush ---- */
  _onInput(e) {
    if (this.composing || this.readOnly) return;
    if (!this._inside(e.target)) return;
    const info = this.selInfo();
    if (!info) return;
    this.armUndo();
    const syntax = e.data && (/[*_`~$#\[\]()>!-+=^\\|]/.test(e.data) || e.data === ' ');
    this.brushBlock(info.block, syntax ? 0 : 180);
  }

  _onCompositionEnd() {
    const info = this.selInfo();
    if (!info) return;
    const host = this.hostEl(info.block, info.blockEl);
    if (!host) return;
    const cur = window.getSelection();
    const off = cur.rangeCount ? offsetOf(host, cur.anchorNode, cur.anchorOffset) : 0;
    info.block.text = host.textContent;
    this.brushBlock(info.block, 0, off);
    this.scheduleUndoCommit();
  }

  /* ---- keydown: 命令与 Tab ---- */
  _onKeyDown(e) {
    if (this.destroyed || e.isComposing || this.composing || e.keyCode === 229) return;
    // 事件目标: #write 内部, 或焦点掉到 body 时(document 级监听兜底);
    // 其他输入控件(查找框、侧栏等)不接管
    if (e.target !== document.body && !this._inside(e.target)) return;
    if (this.readOnly) return;
    const mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Tab') {
      e.preventDefault();
      this.armUndo();
      e.shiftKey ? this.opOutdent() : this.opIndent();
      return;
    }
    // Enter 在 keydown 层处理(Typora 同款 pressReturn 机制,不依赖
    // beforeinput 的投递):Shift+Enter = 硬换行,普通 = 拆块。
    // beforeinput 的 insertParagraph/insertLineBreak 分支保留作兜底。
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.armUndo();
      if (e.shiftKey) this.opInsertHardBreak();
      else this.opEnter(false);
      return;
    }
    if (!mod && !e.altKey) return;

    const k = (e.ctrlKey ? 'ctrl+' : e.metaKey ? 'cmd+' : '') +
      (e.altKey ? 'alt+' : '') + (e.shiftKey ? 'shift+' : '') +
      (e.key.length === 1 ? e.key.toLowerCase() : e.key);

    const commands = {
      'ctrl+b': () => this.execCommand('bold'),
      'cmd+b': () => this.execCommand('bold'),
      'ctrl+i': () => this.execCommand('italic'),
      'cmd+i': () => this.execCommand('italic'),
      'ctrl+u': () => this.execCommand('underline'),
      'cmd+u': () => this.execCommand('underline'),
      'alt+shift+5': () => this.execCommand('strike'),
      'ctrl+shift+`': () => this.execCommand('inlineCode'),
      'cmd+shift+`': () => this.execCommand('inlineCode'),
      'ctrl+1': () => this.execCommand('heading', 1),
      'ctrl+2': () => this.execCommand('heading', 2),
      'ctrl+3': () => this.execCommand('heading', 3),
      'ctrl+4': () => this.execCommand('heading', 4),
      'ctrl+5': () => this.execCommand('heading', 5),
      'ctrl+6': () => this.execCommand('heading', 6),
      'ctrl+0': () => this.execCommand('paragraph'),
      'cmd+1': () => this.execCommand('heading', 1),
      'cmd+2': () => this.execCommand('heading', 2),
      'cmd+3': () => this.execCommand('heading', 3),
      'cmd+4': () => this.execCommand('heading', 4),
      'cmd+5': () => this.execCommand('heading', 5),
      'cmd+6': () => this.execCommand('heading', 6),
      'cmd+0': () => this.execCommand('paragraph'),
      'ctrl+=': () => this.execCommand('increaseHeading'),
      'ctrl+-': () => this.execCommand('decreaseHeading'),
      'cmd+=': () => this.execCommand('increaseHeading'),
      'cmd+-': () => this.execCommand('decreaseHeading'),
      'ctrl+shift+[': () => this.execCommand('orderedList'),
      'ctrl+shift+]': () => this.execCommand('unorderedList'),
      'cmd+shift+[': () => this.execCommand('orderedList'),
      'cmd+shift+]': () => this.execCommand('unorderedList'),
      'ctrl+shift+q': () => this.execCommand('quote'),
      'cmd+shift+q': () => this.execCommand('quote'),
      'ctrl+shift+k': () => this.execCommand('fences'),
      'cmd+shift+k': () => this.execCommand('fences'),
      'ctrl+shift+m': () => this.execCommand('mathBlock'),
      'cmd+shift+m': () => this.execCommand('mathBlock'),
      'ctrl+t': () => this.execCommand('table'),
      'cmd+t': () => this.execCommand('table'),
      'ctrl+k': () => this.execCommand('link'),
      'cmd+k': () => this.execCommand('link'),
      'ctrl+shift+i': () => this.execCommand('image'),
      'cmd+shift+i': () => this.execCommand('image'),
      'ctrl+\\': () => this.execCommand('clearFormat'),
      'cmd+\\': () => this.execCommand('clearFormat'),
      'ctrl+z': () => this.execCommand('undo'),
      'cmd+z': () => this.execCommand('undo'),
      'ctrl+y': () => this.execCommand('redo'),
      'ctrl+shift+z': () => this.execCommand('redo'),
      'cmd+shift+z': () => this.execCommand('redo'),
      'ctrl+shift+c': () => this.execCommand('copyAsMarkdown'),
      'cmd+shift+c': () => this.execCommand('copyAsMarkdown'),
    };
    // 保存/另存/源码模式由宿主外壳(horseMD 菜单与键位系统)接管, 引擎不重复处理
    const fn = commands[k];
    if (fn) {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  }

  _onClick(e) {
    const a = e.target.closest && e.target.closest('[md-inline="link"] a, [md-inline="url"] a, a.md-url');
    if (a) {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const href = a.getAttribute('href') || '';
        this.opts.openExternal ? this.opts.openExternal(href) : window.open(href, '_blank');
      }
      return;
    }
  }

  _onPaste(e) {
    if (this.composing || this.readOnly || !this._inside(e.target)) return;
    const d = e.clipboardData;
    if (!d) return;
    // 图片粘贴交给宿主(图床命令/本地入库由外壳决定)
    const file = [...(d.files || [])].find((f) => f.type && f.type.startsWith('image/'));
    if (file) {
      e.preventDefault();
      this.opts.onPasteImage && this.opts.onPasteImage(file);
      return;
    }
    e.preventDefault();
    this.armUndo();
    const text = d.getData('text/plain') || '';
    const html = d.getData('text/html');
    this.opPaste(text, html);
  }

  _onCopy(e, forceMarkdown) {
    if (!this._inside(e.target)) return;
    const info = this.selInfo();
    let md;
    if (!info) {
      md = this.getMarkdown();
    } else if (info.crossBlock) {
      md = this._mdForRange(info);
    } else {
      md = info.block.text.slice(Math.min(info.start, info.end), Math.max(info.start, info.end));
    }
    e.preventDefault();
    e.clipboardData.setData('text/plain', md);
    e.clipboardData.setData('text/html', '<div>' + md.split('\n').map(l => '<p>' + l.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</p>').join('') + '</div>');
    this._toast(forceMarkdown ? '已复制为 Markdown' : '已复制');
  }

  /* ============ 选择 / 光标 ============ */

  /** 找光标所在块与文本宿主 */
  selInfo() {
    // 读取选区前先落盘挂起的重解析, 保证模型与光标同源(防 Enter 等竞态)
    this.flushBrush();
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    let node = r.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || !this._inside(node)) return null;
    const blockEl = node.closest && node.closest('[mdtype]');
    if (!blockEl || !this.container.contains(blockEl)) return null;
    const block = this.nodeMap.get(blockEl.getAttribute('cid'));
    if (!block) return null;
    const host = this.hostEl(block, blockEl);
    if (!host) {
      // def 块等特殊编辑区: 光标在其可编辑 span 中
      const span = node.closest && node.closest('[contenteditable="true"]');
      if (span && blockEl.contains(span)) {
        return { block, blockEl, host: span, start: 0, end: 0, collapsed: true, crossBlock: false, hostLen: 0, raw: true };
      }
      return null;
    }
    const start = offsetOf(host, r.startContainer, r.startOffset);
    const end = offsetOf(host, r.endContainer, r.endOffset);
    // 跨块判定: 结束点是否在同一 host 内
    const endInHost = host.contains(r.endContainer) || r.endContainer === host;
    // 即时 DOM→模型同步: 保证操作层读到的 block.text 与光标偏移同源
    // (input 事件的 brush 是防抖的, 命令层不能依赖它)
    {
      const t = host.textContent;
      if (t !== block.text) block.text = t;
    }
    return {
      block, blockEl, host,
      start, end,
      collapsed: r.collapsed,
      crossBlock: !endInHost,
      hostLen: host.textContent.length,
      raw: false,
    };
  }

  hostEl(block, blockEl) {
    if (!blockEl) blockEl = this.container.querySelector('[cid="' + block.id + '"]');
    if (!blockEl) return null;
    switch (block.type) {
      case T.fences: return blockEl.querySelector('.code-mirror-shim');
      case T.math: return blockEl.querySelector('.md-rawblock-input');
      case T.cell: case T.paragraph: case T.heading: case T.meta: return blockEl;
      case T.listItem: {
        // 光标一般落在 li 内的段落
        const p = blockEl.querySelector('[mdtype="' + T.paragraph + '"]');
        return p || blockEl;
      }
      default: return null;
    }
  }

  focusBlock(block, offset = 0, end = offset) {
    const blockEl = this.container.querySelector('[cid="' + block.id + '"]');
    if (!blockEl) return;
    let host;
    if (block.type === T.defLink) host = blockEl.querySelector('.md-def-name');
    else if (block.type === T.defFootnote) host = blockEl.querySelector('.md-def-content');
    else host = this.hostEl(block, blockEl);
    if (!host) return;
    host.focus && host.focus();
    const len = host.textContent.length;
    setSelection(host, Math.min(offset, len), Math.min(end, len));
    this._updateCaretUI();
  }

  /* ---- 焦点/展开/光标修正 ---- */
  _updateCaretUI() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    let node = sel.anchorNode;
    if (!node) return;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    if (!node || !this._inside(node)) return;

    // 块焦点标记
    const blockEl = node.closest && node.closest('[mdtype]');
    if (this._focusEl && this._focusEl !== blockEl) this._focusEl.classList.remove('md-focus');
    if (blockEl && this.container.contains(blockEl)) {
      blockEl.classList.add('md-focus');
      this._focusEl = blockEl;
      const cid = blockEl.getAttribute('cid');
      if (this.focusCid !== cid) {
        this.focusCid = cid;
        this.opts.onActiveBlock && this.opts.onActiveBlock(cid);
      }
    }

    // md-expand: 光标所在内联单元(Typora 语义)
    //  - 顶层 plain span 自身展开
    //  - pair(wrapper md-pair-s)内部任何位置(含内层 plain)→ 展开 wrapper
    let inlineEl = node.closest && node.closest('[md-inline]');
    if (inlineEl && inlineEl.getAttribute('md-inline') === 'plain') {
      const outer = inlineEl.parentElement && inlineEl.parentElement.closest('[md-inline]');
      if (outer && this.container.contains(outer)) inlineEl = outer;
    }
    const target = (inlineEl && this.container.contains(inlineEl) &&
      !(inlineEl.closest('[contenteditable="false"]') && !inlineEl.closest('.md-rawblock-input'))) ? inlineEl : null;
    if (this.expandEl !== target) {
      if (this.expandEl) {
        this.expandEl.classList.remove('md-expand');
        this.expandEl.querySelectorAll('.md-meta, .md-content').forEach(m => m.removeAttribute('contenteditable'));
      }
      this.expandEl = target;
      if (target) {
        target.classList.add('md-expand');
        target.querySelectorAll(':scope > .md-meta, :scope > .md-content').forEach(m => {
          m.setAttribute('contenteditable', 'true');
          m.setAttribute('spellcheck', 'false');
        });
      }
    }

    this._fixCaret(node, sel);
  }

  /** 光标落入隐藏的语法字符时, 移到可见边界(模拟 Typora 手感) */
  _fixCaret(node, sel) {
    const hidden = node.closest && node.closest('.md-meta, .md-content');
    if (!hidden) return;
    const container = hidden.closest('[md-inline]');
    if (!container || container.classList.contains('md-expand')) return;
    const r = document.createRange();
    if (container.firstChild === hidden || hidden.previousElementSibling === null) {
      r.setStartBefore(container);
    } else {
      r.setStartAfter(container);
    }
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /* ============ brush: 实时重解析 ============ */

  brushBlock(block, delay = 0, caretOffset = null) {
    clearTimeout(this.brushTimer);
    this._pendingBrush = { block, caretOffset };
    const run = () => {
      this.brushTimer = 0;
      this._pendingBrush = null;
      this._brushRun(block, caretOffset);
    };
    if (delay <= 0) run();
    else this.brushTimer = setTimeout(run, delay);
  }

  /** 立即执行挂起的重解析(结构化操作前必须调用, 避免与迟到的 brush 竞态) */
  flushBrush() {
    if (this.brushTimer) { clearTimeout(this.brushTimer); this.brushTimer = 0; }
    if (this._pendingBrush) {
      const p = this._pendingBrush;
      this._pendingBrush = null;
      this._brushRun(p.block, p.caretOffset);
    }
  }

  _brushRun(block, caretOffset) {
      const blockEl = this.container.querySelector('[cid="' + block.id + '"]');
      if (!blockEl) return;
      const host = this.hostEl(block, blockEl);
      if (!host) return;
      // 记录旧光标/选区(anchor 与 focus 都要保留,否则 brush 会把
      // "选中文本点工具栏" 一类的非折叠选区折叠成光标)
      const sel = window.getSelection();
      let anchorOff = null;
      let focusOff = null;
      if (caretOffset !== null) {
        anchorOff = focusOff = caretOffset;
      } else if (sel.rangeCount && (host.contains(sel.anchorNode) || host.contains(sel.focusNode))) {
        anchorOff = host.contains(sel.anchorNode) ? offsetOf(host, sel.anchorNode, sel.anchorOffset) : 0;
        focusOff = host.contains(sel.focusNode) ? offsetOf(host, sel.focusNode, sel.focusOffset) : anchorOff;
      }
      const off = anchorOff;
      const endOff = focusOff;

      const before = block.text;
      if (block.type === T.fences) {
        // 代码块: 文本来自 shim; 重新高亮即可(不换类型)
        const t = host.textContent;
        if (t !== block.text) block.text = t;
        host.innerHTML = '';
        const tmp = document.createElement('div');
        tmp.innerHTML = highlightCode(block.attrs.lang || '', block.text);
        while (tmp.firstChild) host.appendChild(tmp.firstChild);
        if (off !== null) setSelection(host, off, endOff);
      } else {
        const t = host.textContent;
        if (t !== block.text) block.text = t;
        // 打字级块转换(仅段落, 父为 doc/quote)
        let focusId = block.id;
        if (block.type === T.paragraph) {
          const conv = this._tryLiveConvert(block);
          if (conv) {
            focusId = conv;
            this._notifyStructure();
          }
        }
        this._refreshToc();
        const newEl = renderBlock(block, this.ctx);
        blockEl.replaceWith(newEl);
        // 先重建映射再恢复光标(转换可能产生新块)
        this._rebuildMapLight();
        if (off !== null) {
          const fb = this.nodeMap.get(focusId);
          if (fb) this.focusBlock(fb, off, endOff);
        }
      }
      this.opts.onChange && this.opts.onChange(true);
      this.scheduleUndoCommit();
      this._mutVersion++;
      this._status();
  }

  _notifyStructure() {
    this.opts.onStructureChange && this.opts.onStructureChange();
  }

  /** 轻量重建 map(不改结构) */
  _rebuildMapLight() {
    this.nodeMap.clear();
    this.root.walk(b => this.nodeMap.set(b.id, b));
  }

  /** 打字转换: `# ` → 标题, `- ` → 列表, `> ` → 引用等 */
  _tryLiveConvert(block) {
    const t = block.text;
    const parent = block.parent;
    if (!parent || (parent.type !== T.doc && parent.type !== T.quote)) return null;
    let m;
    if ((m = /^(#{1,6})(\s+)(.*)$/.exec(t)) || (m = /^(#{1,6})(\s+)$/.exec(t))) {
      block.type = T.heading;
      block.attrs.depth = m[1].length;
      block.attrs.style = 'atx';
      block.text = m[3] || '';
      return block.id;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) {
      block.type = T.hr;
      block.attrs.pattern = t.trim();
      block.text = '';
      return block.id;
    }
    if ((m = /^```(\w*)\s*$/.exec(t))) {
      block.type = T.fences;
      block.attrs.lang = m[1] || '';
      block.attrs.fence = '```';
      block.text = '';
      return block.id;
    }
    if (/^\$\$\s*$/.test(t)) {
      block.type = T.math;
      block.text = '';
      return block.id;
    }
    if (/^\[TOC\]\s*$/i.test(t)) {
      block.type = T.toc;
      block.text = '';
      return block.id;
    }
    if ((m = /^>\s?(.*)$/.exec(t))) {
      const inner = new Block(T.paragraph, { text: m[1] });
      block.type = T.quote;
      delete block.attrs.alert;
      block.children = [inner];
      inner.parent = block;
      block.text = '';
      return inner.id;
    }
    if ((m = /^([-*+])\s+\[([xX ])\]\s*(.*)$/.exec(t))) {
      return this._convertToList(block, false, m[1], { task: true, checked: m[2] !== ' ', rest: m[3] });
    }
    if ((m = /^([-*+])\s+(.*)$/.exec(t))) {
      return this._convertToList(block, false, m[1], { rest: m[2] });
    }
    if ((m = /^(\d{1,9})([.)])\s+(.*)$/.exec(t))) {
      return this._convertToList(block, true, m[2], { start: parseInt(m[1], 10) || 1, rest: m[3] });
    }
    return null;
  }

  _convertToList(block, ordered, mark, info) {
    const item = new Block(T.listItem);
    if (info.task) { item.attrs.task = true; item.attrs.checked = info.checked; }
    const para = new Block(T.paragraph, { text: info.rest || '' });
    item.appendChild(para);
    Object.assign(block, {
      type: T.list,
      text: '',
      attrs: Object.assign(block.attrs, { ordered, mark, start: ordered ? (info.start || 1) : undefined, tight: true }),
      children: [item],
    });
    item.parent = block;
    return para.id;
  }

  /* ============ 操作层(结构化) ============ */

  /** 替换块并渲染 + 定位光标 */
  _apply(fn, focus = null) {
    fn();
    this._refreshToc();
    this.renderAll();
    this._rebuildMapLight();
    if (focus && focus.block) this.focusBlock(focus.block, focus.offset, focus.end);
    else if (focus) this._lastFocusTarget = null;
    this.opts.onChange && this.opts.onChange(true);
    this.scheduleUndoCommit();
    this._mutVersion++;
    this._notifyStructure();
    this._status();
  }

  _newParagraph(text) { return new Block(T.paragraph, { text }); }

  /** Enter */
  opEnter(inTable) {
    const info = this.selInfo();
    if (!info || info.raw) return;
    const { block, start, end } = info;
    const hostText = block.text || '';
    const a = Math.min(start, end), b = Math.max(start, end);

    // 代码块/公式/YAML: 换行符
    if (block.type === T.fences || block.type === T.math || block.type === T.meta) {
      this._apply(() => { block.text = hostText.slice(0, a) + '\n' + hostText.slice(b); });
      this.focusBlock(block, a + 1);
      return;
    }
    // 表格单元格
    if (block.type === T.cell) {
      this.opCellEnter(block);
      return;
    }

    // 引用/列表/普通段落
    const li = this._ancestor(block, T.listItem);
    const quote = this._ancestor(block, T.quote);
    const first = hostText.slice(0, a);
    const second = hostText.slice(b);

    if (li) {
      const list = li.parent;
      if (first === '' && second === '') {
        // 空项回车 → 退出列表(光标落到列表后的新段落)
        let after = null;
        this._apply(() => { after = this._exitList(li); });
        if (after) this.focusBlock(after, 0);
        return;
      }
      const newLi = new Block(T.listItem);
      if (li.attrs.task) { newLi.attrs.task = true; newLi.attrs.checked = false; }
      newLi.appendChild(this._newParagraph(second));
      this._apply(() => {
        block.text = first;
        list.insertBefore(newLi, li.nextSibling() || null) ;
        if (!li.nextSibling()) list.appendChild(newLi);
      }, { block: newLi.children[0], offset: 0 });
      return;
    }

    if (quote && block.parent === quote) {
      if (first === '' && second === '') {
        // 空行回车 → 退出引用
        let after = null;
        this._apply(() => {
          after = this._newParagraph('');
          quote.parent.insertBefore(after, quote.nextSibling() || null);
          if (!quote.children.length) quote.remove();
        });
        if (after) this.focusBlock(after, 0);
        return;
      }
      const np = this._newParagraph(second);
      this._apply(() => {
        block.text = first;
        quote.insertBefore(np, block.nextSibling() || null);
      }, { block: np, offset: 0 });
      return;
    }

    // 标题回车 → 下方新段落
    const np = new Block(block.type === T.heading ? T.paragraph : T.paragraph, { text: second });
    this._apply(() => {
      block.text = first;
      const parent = block.parent || this.root;
      parent.insertBefore(np, block.nextSibling() || null);
    }, { block: np, offset: 0 });
  }

  opInsertHardBreak() {
    const info = this.selInfo();
    if (!info || info.raw) return;
    const { block, start, end } = info;
    if (![T.paragraph, T.heading, T.cell].includes(block.type)) return;
    const a = Math.min(start, end), b = Math.max(start, end);
    this._apply(() => {
      block.text = block.text.slice(0, a) + '  \n' + block.text.slice(b);
    });
    this.focusBlock(block, a + 3);
  }

  /** 行首 Backspace */
  opBackspaceAtStart(info) {
    const { block } = info;
    const hostText = block.text || '';

    // 空标题 → 段落; 非空标题行首退格 → 转段落
    if (block.type === T.heading) {
      this._apply(() => {
        block.type = T.paragraph;
        delete block.attrs.depth;
        delete block.attrs.style;
      }, { block, offset: 0 });
      return;
    }
    // 空段落/空YAML → 删除块
    if (hostText === '' && block.parent && block.parent.children.length > 1) {
      const prev = block.prevSibling();
      this._apply(() => block.remove());
      if (prev) this._caretToEndOf(prev);
      return;
    }
    if (block.type === T.cell) return; // 表格内原生处理
    if (block.type === T.fences || block.type === T.math) return;

    // 列表项: 项首
    const li = this._ancestor(block, T.listItem);
    if (li && li.children[0] === block) {
      const text = block.text;
      if (li.attrs.task && text === '') {
        // 空任务项退格 → 转普通段落退出列表
        let after = null;
        this._apply(() => { after = this._exitList(li); });
        if (after) this.focusBlock(after, 0);
        return;
      }
      const list = li.parent;
      const prevLi = li.prevSibling();
      if (!prevLi) {
        // 首项: 解包为段落
        const para = this._newParagraph('');
        this._apply(() => {
          para.text = (li.attrs.task ? (li.attrs.checked ? '[x] ' : '[ ] ') : '') + text;
          const idx = list.parent.children.indexOf(list);
          list.parent.children.splice(idx, 0, para);
          para.parent = list.parent;
          li.remove();
          if (!list.children.length) list.remove();
        }, { block: para, offset: para.text.length });
        return;
      }
      // 并入前一项
      const prevLast = prevLi.children[prevLi.children.length - 1];
      if (prevLast && prevLast.type === T.paragraph) {
        const joinAt = prevLast.text.length;
        this._apply(() => {
          prevLast.text += text;
          block.remove();
          li.remove();
          if (!list.children.length) list.remove();
        }, { block: prevLast, offset: joinAt });
      }
      return;
    }

    // 引用内层段首
    const quote = this._ancestor(block, T.quote);
    if (quote && quote.children[0] === block) {
      const gparent = quote.parent;
      const qIdx = gparent.children.indexOf(quote);
      if (gparent.type === T.quote) {
        // 嵌套引用 → 提升一层
        this._apply(() => {
          gparent.children.splice(qIdx, 1, block);
          block.parent = gparent;
          quote.remove();
        }, { block, offset: 0 });
        return;
      }
      // 解包为普通段落
      this._apply(() => {
        gparent.children.splice(qIdx, 1, block);
        block.parent = gparent;
        quote.remove();
      }, { block, offset: 0 });
      return;
    }

    // 普通段落: 与前一个文本块合并
    const prev = block.prevSibling();
    if (!prev) return;
    if ([T.paragraph, T.heading].includes(prev.type)) {
      const joinAt = prev.text.length;
      this._apply(() => {
        prev.type = T.paragraph;
        prev.text += block.text;
        delete prev.attrs.depth;
        block.remove();
      }, { block: prev, offset: joinAt });
      return;
    }
    if (prev.type === T.list) {
      const lastLi = prev.children[prev.children.length - 1];
      if (lastLi) {
        const lastPara = lastLi.children[lastLi.children.length - 1];
        const joinAt = lastPara ? lastPara.text.length : 0;
        this._apply(() => {
          if (lastPara && lastPara.type === T.paragraph) {
            lastPara.text += block.text;
          } else {
            lastLi.appendChild(this._newParagraph(block.text));
          }
          block.remove();
        }, { block: lastPara || lastLi.children[0], offset: joinAt });
      }
      return;
    }
    if (prev.type === T.quote) {
      const lastPara = prev.children[prev.children.length - 1];
      let focusBlock = null, focusAt = 0;
      this._apply(() => {
        if (lastPara && lastPara.type === T.paragraph) {
          focusAt = lastPara.text.length;
          lastPara.text += block.text;
          block.remove();
          focusBlock = lastPara;
        } else {
          prev.appendChild(this._newParagraph(block.text));
          block.remove();
          focusBlock = prev.children[prev.children.length - 1];
        }
      });
      if (focusBlock) this.focusBlock(focusBlock, focusAt);
      return;
    }
    if ([T.fences, T.math, T.meta, T.hr, T.toc, T.html].includes(prev.type)) {
      // 光标移入前块(不可合并)
      this._caretToEndOf(prev);
    }
  }

  /** 末尾 Delete: 与后一块合并 */
  opDeleteAtEnd(info) {
    const { block } = info;
    const next = block.nextSibling();
    if (!next) return;
    if ([T.paragraph, T.heading].includes(next.type)) {
      const joinAt = block.text.length;
      this._apply(() => {
        block.type = block.type === T.heading ? block.type : T.paragraph;
        block.text += next.text;
        next.remove();
      }, { block, offset: joinAt });
    } else if ([T.fences, T.math, T.hr, T.toc, T.html, T.meta].includes(next.type) && block.text === '') {
      this._apply(() => next.remove());
    }
  }

  /** 跨块选择删除 */
  opDeleteSelection(info) {
    const { block } = info;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const r = sel.getRangeAt(0);
    const endEl = r.endContainer.nodeType === Node.TEXT_NODE ? r.endContainer.parentElement : r.endContainer;
    const endBlockEl = endEl.closest && endEl.closest('[mdtype]');
    if (!endBlockEl) return;
    const endBlock = this.nodeMap.get(endBlockEl.getAttribute('cid'));
    if (!endBlock) return;
    const endHost = this.hostEl(endBlock, endBlockEl);
    if (!endHost) return;
    const endOff = offsetOf(endHost, r.endContainer, r.endOffset);

    this._apply(() => {
      block.text = block.text.slice(0, Math.min(info.start, info.end)) + endBlock.text.slice(endOff);
      // 删除中间块与 endBlock
      let cur = block.nextSibling();
      while (cur) {
        const nxt = cur.nextSibling();
        if (cur === endBlock) { cur.remove(); break; }
        cur.remove();
        cur = nxt;
      }
    }, { block, offset: Math.min(info.start, info.end) });
  }

  opPaste(text, html) {
    const info = this.selInfo();
    const clean = String(text || '').replace(/\r\n/g, '\n');
    if (!info) return;
    const { block, start, end } = info;

    // 代码块/公式/YAML: 原样插入
    if ([T.fences, T.math, T.meta].includes(block.type)) {
      const a = Math.min(start, end);
      this._apply(() => { block.text = block.text.slice(0, a) + clean + block.text.slice(Math.max(start, end)); });
      this.focusBlock(block, a + clean.length);
      return;
    }
    if (block.type === T.cell) {
      const a = Math.min(start, end);
      const t = clean.replace(/\n/g, ' ');
      this._apply(() => { block.text = block.text.slice(0, a) + t + block.text.slice(Math.max(start, end)); });
      this.focusBlock(block, a + t.length);
      return;
    }

    const a = Math.min(start, end), b = Math.max(start, end);
    const before = block.text.slice(0, a);
    const after = block.text.slice(b);
    const parsed = parseMarkdown(clean);
    const blocks = (parsed.children || []).slice();

    // 单段(单行)粘贴: 直接并入当前块
    if (blocks.length === 1 && blocks[0].type === T.paragraph) {
      this._apply(() => { block.text = before + blocks[0].text + after; });
      this.focusBlock(block, a + blocks[0].text.length);
      return;
    }

    // 多块粘贴: 首段并入当前块, 末段承接光标后的文本, 其余按块插入
    let focusAt = null;
    this._apply(() => {
      const parent = block.parent || this.root;
      if (blocks.length && blocks[0].type === T.paragraph) {
        const head = blocks.shift();
        block.text = before + head.text;
      } else {
        block.text = before;
      }
      let anchor = block;
      let last = null;
      for (const nb of blocks) {
        parent.insertBefore(nb, anchor.nextSibling() || null);
        anchor = nb;
        last = nb;
      }
      if (last && last.type === T.paragraph && after) {
        const mergedAt = last.text.length;
        last.text = last.text + after;
        focusAt = { block: last, offset: mergedAt };
      } else if (last) {
        focusAt = { block: last, offset: (last.text || '').length };
      } else {
        block.text += after;
        focusAt = { block, offset: before.length };
      }
    });
    if (focusAt) this.focusBlock(focusAt.block, focusAt.offset);
  }

  /** 在当前选区插入文本(图片链接等,宿主图片管线使用) */
  insertAtSelection(text) {
    if (!text) return;
    const info = this.selInfo();
    if (!info || info.raw) return;
    this.armUndo();
    this.opPaste(String(text), null);
  }

  /** DOM Range → {block, start, end}(宿主查找替换使用) */
  rangeToBlockSpan(range) {
    let node = range.startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    const blockEl = node && node.closest && node.closest('[mdtype]');
    if (!blockEl || !this.container.contains(blockEl)) return null;
    const block = this.nodeMap.get(blockEl.getAttribute('cid'));
    if (!block) return null;
    const host = this.hostEl(block, blockEl);
    if (!host) return null;
    if (!host.contains(range.startContainer) && range.startContainer !== host) return null;
    const start = offsetOf(host, range.startContainer, range.startOffset);
    const end = (host.contains(range.endContainer) || range.endContainer === host)
      ? offsetOf(host, range.endContainer, range.endOffset)
      : start;
    return { block, start: Math.min(start, end), end: Math.max(start, end) };
  }

  /** 查找替换:DOM Range 集合 → 按块文本拼接后一次性替换。
   *  ranges 来自宿主 findRangesInEl(单文本节点内,必属同一块)。 */
  replaceFindRanges(ranges, repl, all, activeIdx) {
    const spans = (ranges || []).map((r) => this.rangeToBlockSpan(r)).filter(Boolean);
    if (!spans.length) return false;
    this.armUndo();
    // 同块内多个命中:按 start 倒序拼接,避免偏移失效
    const byBlock = new Map();
    const picked = all ? spans : [spans[Math.max(0, Math.min(activeIdx || 0, spans.length - 1))]].filter(Boolean);
    for (const span of picked) {
      const list = byBlock.get(span.block) || [];
      list.push(span);
      byBlock.set(span.block, list);
    }
    let lastBlock = null;
    let lastCaret = 0;
    for (const [block, list] of byBlock) {
      list.sort((a, b) => b.start - a.start);
      let text = block.text || '';
      for (const span of list) {
        text = text.slice(0, span.start) + repl + text.slice(span.end);
        lastBlock = block;
        lastCaret = span.start + repl.length;
      }
      block.text = text;
    }
    if (!lastBlock) return false;
    this._refreshToc();
    this.renderAll();
    this._rebuildMapLight();
    this._mutVersion++;
    this.opts.onChange && this.opts.onChange(true);
    this.scheduleUndoCommit();
    this._notifyStructure();
    this._status();
    this.focusBlock(lastBlock, lastCaret);
    return true;
  }

  /* ---- 缩进 / 表格 ---- */

  opIndent() {
    const info = this.selInfo();
    if (!info || info.raw) return;
    const { block } = info;
    if (block.type === T.fences) {
      const a = Math.min(info.start, info.end);
      this._apply(() => { block.text = block.text.slice(0, a) + '    ' + block.text.slice(a); });
      this.focusBlock(block, a + 4);
      return;
    }
    // 表格: Tab → 下一格; 末格 → 新行
    if (block.type === T.cell) {
      const nav = this._cellNav(block);
      if (!nav) return;
      const { table, r, c, rows, cols } = nav;
      if (r === rows.length - 1 && c === cols - 1) {
        const row = new Block(T.row);
        for (let k = 0; k < cols; k++) row.appendChild(new Block(T.cell));
        this._apply(() => table.appendChild(row));
        this.focusBlock(row.children[0], 0);
      } else {
        this._focusCell(table, c === cols - 1 ? r + 1 : r, c === cols - 1 ? 0 : c + 1);
      }
      return;
    }
    const li = this._ancestor(block, T.listItem);
    if (li) {
      const prevLi = li.prevSibling();
      if (!prevLi) return;
      // 移入前一项的子列表
      this._apply(() => {
        let sub = prevLi.children.find(c => c.type === T.list);
        if (!sub) { sub = new Block(T.list); sub.attrs = Object.assign({}, li.parent.attrs); sub.attrs.tight = true; prevLi.appendChild(sub); }
        li.remove();
        sub.appendChild(li);
      });
      this._refocusById(block.id, 0);
      return;
    }
    // 普通段落: 插入 4 空格
    if ([T.paragraph, T.heading].includes(block.type)) {
      const a = Math.min(info.start, info.end);
      this._apply(() => { block.text = '    ' + block.text; });
      this.focusBlock(block, a + 4);
    }
  }

  opOutdent() {
    const info = this.selInfo();
    if (!info || info.raw) return;
    // 表格: Shift+Tab → 上一格
    if (info.block.type === T.cell) {
      const nav = this._cellNav(info.block);
      if (nav) {
        const { table, r, c } = nav;
        if (r === 0 && c === 0) return;
        this._focusCell(table, c === 0 ? r - 1 : r, c === 0 ? nav.cols - 1 : c - 1);
      }
      return;
    }
    const li = this._ancestor(info.block, T.listItem);
    if (!li) return;
    const list = li.parent;
    const outerLi = list.parent && list.parent.type === T.listItem ? list.parent : null;
    if (!outerLi) return;
    const outerList = outerLi.parent;
    this._apply(() => {
      li.remove();
      // 插到 outerLi 之后(其兄弟位置)
      const nxt = outerLi.nextSibling();
      if (nxt) outerList.insertBefore(li, nxt);
      else outerList.appendChild(li);
      if (!list.children.length) list.remove();
    });
    this._refocusById(info.block.id, 0);
  }

  opCellEnter(cell) {
    const nav = this._cellNav(cell);
    if (!nav) return;
    const { table, r, c, rows, cols } = nav;
    if (r === rows.length - 1 && c === cols - 1) {
      // 最后一格回车 → 添加行
      const row = new Block(T.row);
      for (let i = 0; i < cols; i++) row.appendChild(new Block(T.cell));
      this._apply(() => table.appendChild(row));
      this.focusBlock(row.children[0], 0);
      return;
    }
    this._focusCell(table, c === cols - 1 ? r + 1 : r, c === cols - 1 ? 0 : c + 1);
  }

  _cellNav(cell) {
    const row = cell.parent;
    const table = row && row.parent;
    if (!table || table.type !== T.table) return null;
    const rows = table.children || [];
    const r = rows.indexOf(row);
    const c = (row.children || []).indexOf(cell);
    return { table, r, c, rows, cols: Math.max(...rows.map(x => (x.children || []).length)) };
  }

  _focusCell(table, r, c) {
    const row = (table.children || [])[r];
    const cell = row && (row.children || [])[c];
    if (cell) this.focusBlock(cell, 0);
  }

  /* ---- 任务列表 ---- */
  onTaskToggle(block, checked) {
    this.armUndo();
    this._mutVersion++;
    this._apply(() => { block.attrs.checked = !!checked; });
    this._refocusById(block.id, 0);
  }

  /* ============ 命令 ============ */

  execCommand(name, arg) {
    switch (name) {
      case 'undo': return this.undo();
      case 'redo': return this.redo();
      case 'save': return this.opts.onSaveRequest && this.opts.onSaveRequest(false);
      case 'saveAs': return this.opts.onSaveRequest && this.opts.onSaveRequest(true);
      case 'sourceMode': return this.toggleSourceMode();
      case 'bold': return this.toggleStyle('strong', '**');
      case 'italic': return this.toggleStyle('em', '*');
      case 'strike': return this.toggleStyle('del', '~~');
      case 'highlight': return this.toggleStyle('mark', '==');
      case 'inlineCode': return this.toggleStyle('code', '`');
      case 'underline': return this.toggleStyle('u', '<u>', '</u>');
      case 'heading': return this._cmdHeading(arg);
      case 'paragraph': return this._cmdParagraph();
      case 'increaseHeading': return this._cmdHeadingStep(1);
      case 'decreaseHeading': return this._cmdHeadingStep(-1);
      case 'orderedList': return this._cmdList(true);
      case 'unorderedList': return this._cmdList(false);
      case 'quote': return this._cmdQuote();
      case 'fences': return this._cmdFences();
      case 'mathBlock': return this._cmdMath();
      case 'table': return this._cmdTable();
      case 'toc': return this._cmdToc();
      case 'link': return this._cmdLink();
      case 'image': return this._cmdImage();
      case 'clearFormat': return this._cmdClearFormat();
      case 'copyAsMarkdown': return this._copyAsMarkdown();
      case 'selectAll': {
        const first = this.root.children[0];
        if (first) this.focusBlock(first, 0);
        return;
      }
      default:
        this.opts.onToast && this.opts.onToast('未知命令: ' + name);
    }
  }

  /* ---- 内联样式切换 ---- */
  toggleStyle(type, mark, closeMark) {
    const info = this.selInfo();
    if (!info || info.raw) return;
    const { block } = info;
    if (![T.paragraph, T.heading, T.cell].includes(block.type)) return;
    const close = closeMark || mark;
    const a = Math.min(info.start, info.end);
    const b = Math.max(info.start, info.end);
    const t = block.text;

    if (a === b) {
      // 光标位于某个样式元素内部 → 切换为"取消该样式"(Typora 行为)
      const selNode = window.getSelection().anchorNode;
      const el = selNode && (selNode.nodeType === 3 ? selNode.parentElement : selNode);
      const wrap = el && el.closest &&
        el.closest('[md-inline="strong"],[md-inline="em"],[md-inline="del"],[md-inline="mark"],[md-inline="code"],[md-inline="underline"]');
      if (wrap && info.host.contains(wrap)) {
        const metas = wrap.querySelectorAll(':scope > .md-meta');
        if (metas.length >= 2) {
          const first = metas[0], lastM = metas[metas.length - 1];
          const headStart = offsetOf(info.host, first.firstChild, 0);
          const headLen = first.textContent.length;
          const tailEnd = offsetOf(info.host, lastM.firstChild, lastM.textContent.length);
          const tailLen = lastM.textContent.length;
          const t = info.block.text;
          const innerStart = headStart + headLen;
          const innerEnd = tailEnd - tailLen;
          if (headStart >= 0 && innerEnd >= innerStart && tailEnd <= t.length) {
            this._apply(() => {
              info.block.text = t.slice(0, headStart) + t.slice(innerStart, innerEnd) + t.slice(tailEnd);
            });
            this.focusBlock(info.block, headStart, headStart + (innerEnd - innerStart));
            return;
          }
        }
      }
      // 真正无样式: 插入一对标记, 光标居中
      this._apply(() => { block.text = t.slice(0, a) + mark + close + t.slice(a); });
      this.focusBlock(block, a + mark.length);
      return;
    }
    // 已包裹 → 取消
    if (t.slice(a - mark.length, a) === mark && t.slice(b, b + close.length) === close) {
      this._apply(() => {
        block.text = t.slice(0, a - mark.length) + t.slice(a, b) + t.slice(b + close.length);
      });
      this.focusBlock(block, a - mark.length, b - mark.length);
      return;
    }
    // 包裹
    this._apply(() => { block.text = t.slice(0, a) + mark + t.slice(a, b) + close + t.slice(b); });
    this.focusBlock(block, a + mark.length, b + mark.length);
  }

  /* ---- 块转换命令 ---- */
  _cmdHeading(depth) {
    const info = this.selInfo();
    if (!info) return;
    let block = info.block;
    const li = this._ancestor(block, T.listItem);
    if (li) block = li;
    const hostBlock = block.type === T.listItem ? block.children[0] : block;
    if (!hostBlock || ![T.paragraph, T.heading].includes(hostBlock.type)) return;
    this._apply(() => {
      hostBlock.type = T.heading;
      hostBlock.attrs.depth = depth;
      hostBlock.attrs.style = 'atx';
    }, { block: hostBlock, offset: Math.min(info.start, (hostBlock.text || '').length) });
  }

  _cmdHeadingStep(d) {
    const info = this.selInfo();
    if (!info) return;
    const block = info.block;
    if (block.type !== T.heading) {
      return this._cmdHeading(1);
    }
    const depth = Math.max(1, Math.min(6, (block.attrs.depth || 1) + d));
    this._apply(() => { block.attrs.depth = depth; }, { block, offset: info.start });
  }

  _cmdParagraph() {
    const info = this.selInfo();
    if (!info) return;
    let block = info.block;
    const li = this._ancestor(block, T.listItem);
    if (li) {
      this._apply(() => this._exitList(li));
      return;
    }
    const quote = this._ancestor(block, T.quote);
    if (quote && block.type === T.paragraph) {
      // 提出引用
      const gparent = quote.parent;
      this._apply(() => {
        const idx = gparent.children.indexOf(quote);
        gparent.children.splice(idx, 1, block);
        block.parent = gparent;
        quote.remove();
      }, { block, offset: info.start });
      return;
    }
    if ([T.heading, T.fences, T.math].includes(block.type)) {
      this._apply(() => {
        block.type = T.paragraph;
        ['depth', 'style', 'lang', 'fence', 'noClose'].forEach(k => delete block.attrs[k]);
      }, { block, offset: info.start });
    }
  }

  _cmdList(ordered) {
    const info = this.selInfo();
    if (!info) return;
    let target = info.block;
    const li = this._ancestor(target, T.listItem);
    if (li) {
      const list = li.parent;
      // 已在列表: 切换/取消
      if (!!list.attrs.ordered === ordered) {
        this._apply(() => this._exitList(li));
      } else {
        this._apply(() => {
          list.attrs.ordered = ordered;
          if (ordered) { list.attrs.mark = '.'; list.attrs.start = 1; }
          else list.attrs.mark = this.opts.ulStyle || '-';
        }, { block: info.block, offset: info.start });
      }
      return;
    }
    if (![T.paragraph, T.heading].includes(target.type)) return;
    const para = target;
    let inserted = null;
    this._apply(() => {
      const item = new Block(T.listItem);
      const p = this._newParagraph(para.text);
      item.appendChild(p);
      const list = new Block(T.list);
      list.attrs.ordered = ordered;
      if (ordered) { list.attrs.mark = '.'; list.attrs.start = 1; }
      else list.attrs.mark = this.opts.ulStyle || '-';
      list.attrs.tight = true;
      list.appendChild(item);
      para.replaceWith(list);
      inserted = p;
    });
    if (inserted) this.focusBlock(inserted, Math.min(info.start, para.text.length));
  }

  _cmdQuote() {
    const info = this.selInfo();
    if (!info) return;
    const block = info.block;
    const quote = this._ancestor(block, T.quote);
    if (quote) {
      // 已在引用: 退出
      if (block.type === T.paragraph && block.parent === quote) {
        const gparent = quote.parent;
        this._apply(() => {
          const idx = gparent.children.indexOf(quote);
          gparent.children.splice(idx, 1, block);
          block.parent = gparent;
          quote.remove();
        }, { block, offset: info.start });
      }
      return;
    }
    if (![T.paragraph, T.heading].includes(block.type)) return;
    this._apply(() => {
      const parent = block.parent;
      const q = new Block(T.quote);
      parent.insertBefore(q, block);
      block.remove();
      q.appendChild(block);
    });
    this._refocusById(block.id, info.start);
  }

  _cmdFences() {
    const info = this.selInfo();
    if (!info) return;
    const block = info.block;
    if (block.type === T.fences) return this._cmdParagraph();
    if (![T.paragraph, T.heading].includes(block.type)) return;
    this._apply(() => {
      block.type = T.fences;
      block.attrs.lang = '';
      block.attrs.fence = '```';
      block.text = block.text || '';
    }, { block, offset: 0 });
  }

  _cmdMath() {
    const info = this.selInfo();
    if (!info) return;
    const block = info.block;
    if (block.type === T.math) return this._cmdParagraph();
    if (![T.paragraph, T.heading].includes(block.type)) return;
    this._apply(() => {
      block.type = T.math;
      block.text = block.text || '';
    }, { block, offset: 0 });
  }

  _cmdTable() {
    const info = this.selInfo();
    const block = info ? info.block : null;
    const table = new Block(T.table);
    table.attrs.align = [];
    const head = new Block(T.row);
    head.attrs.head = true;
    for (let i = 0; i < 3; i++) head.appendChild(new Block(T.cell));
    table.appendChild(head);
    for (let r = 0; r < 2; r++) {
      const row = new Block(T.row);
      for (let i = 0; i < 3; i++) row.appendChild(new Block(T.cell));
      table.appendChild(row);
    }
    this._apply(() => {
      if (block && block.type === T.paragraph && block.text === '') {
        block.replaceWith(table);
      } else if (block && block.parent) {
        block.parent.insertBefore(table, block.nextSibling() || null);
      } else {
        this.root.appendChild(table);
      }
    }, { block: table.children[0].children[0], offset: 0 });
  }

  _cmdToc() {
    const info = this.selInfo();
    const block = info ? info.block : null;
    const toc = new Block(T.toc);
    this._apply(() => {
      if (block && block.parent) block.parent.insertBefore(toc, block.nextSibling() || null);
      else this.root.appendChild(toc);
    }, { block: null, offset: 0 });
    this._toast('已插入目录');
  }

  _cmdLink() {
    const info = this.selInfo();
    if (!info || ![T.paragraph, T.heading, T.cell].includes(info.block.type)) return;
    const { block } = info;
    const a = Math.min(info.start, info.end), b = Math.max(info.start, info.end);
    const label = block.text.slice(a, b) || '链接';
    const t = block.text;
    const insert = '[' + label + '](https://)';
    this._apply(() => { block.text = t.slice(0, a) + insert + t.slice(b); });
    this.focusBlock(block, a + label.length + 3, a + insert.length - 1);
    // 展开 url 编辑
    setTimeout(() => {
      const sel = window.getSelection();
      if (sel.rangeCount) this._updateCaretUI();
    }, 0);
  }

  _cmdImage() {
    const info = this.selInfo();
    if (!info || ![T.paragraph, T.heading].includes(info.block.type)) return;
    const { block } = info;
    const a = Math.min(info.start, info.end), b = Math.max(info.start, info.end);
    const t = block.text;
    const insert = '![图片](https://)';
    this._apply(() => { block.text = t.slice(0, a) + insert + t.slice(b); });
    this.focusBlock(block, a + insert.length - 1);
  }

  _cmdClearFormat() {
    const info = this.selInfo();
    if (!info || ![T.paragraph, T.heading, T.cell].includes(info.block.type)) return;
    const { block } = info;
    const a = Math.min(info.start, info.end), b = Math.max(info.start, info.end);
    const seg = block.text.slice(a, b);
    const clean = seg
      .replace(/(\*\*|__)(.*?)\1/g, '$2')
      .replace(/(\*|_)([^*_]+)\1/g, '$2')
      .replace(/~~(.*?)~~/g, '$1')
      .replace(/==(.*?)==/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<u>(.*?)<\/u>/gi, '$1');
    this._apply(() => { block.text = block.text.slice(0, a) + clean + block.text.slice(b); });
    this.focusBlock(block, a, a + clean.length);
  }

  _copyAsMarkdown() {
    const sel = window.getSelection();
    const md = (sel && !sel.isCollapsed) ? this._mdForSelection() : this.getMarkdown();
    navigator.clipboard && navigator.clipboard.writeText(md).then(
      () => this._toast('已复制 Markdown'),
      () => this._toast('复制失败'));
  }

  _mdForSelection() {
    const info = this.selInfo();
    if (!info) return this.getMarkdown();
    return this._mdForRange(info);
  }

  _mdForRange(info) {
    const sel = window.getSelection();
    if (!sel.rangeCount) return '';
    const r = sel.getRangeAt(0);
    const endEl = r.endContainer.nodeType === Node.TEXT_NODE ? r.endContainer.parentElement : r.endContainer;
    const endBlockEl = endEl.closest && endEl.closest('[mdtype]');
    const endBlock = endBlockEl && this.nodeMap.get(endBlockEl.getAttribute('cid'));
    const endHost = endBlock && this.hostEl(endBlock, endBlockEl);
    const endOff = endHost ? offsetOf(endHost, r.endContainer, r.endOffset) : 0;
    const parts = [];
    parts.push(info.block.text.slice(Math.min(info.start, info.end)));
    let cur = info.block.nextSibling();
    const topInfo = { block: info.block };
    while (cur && endBlock && cur !== endBlock) {
      parts.push(docToMarkdown(new Block(T.doc, { children: [cur] }), {}));
      cur = cur.nextSibling();
    }
    if (endBlock && endBlock !== info.block && endHost) {
      parts.push(endBlock.text.slice(0, endOff));
    }
    return parts.filter(p => p !== '').join('\n\n');
  }

  /* ============ 源码模式 ============ */

  toggleSourceMode() {
    this.sourceMode = !this.sourceMode;
    const write = this.container;
    const source = document.getElementById('typora-source');
    if (!source) return;
    if (this.sourceMode) {
      source.textContent = this.getMarkdown();
      source.style.display = 'block';
      write.style.display = 'none';
      source.focus();
    } else {
      const md = source.textContent;
      source.style.display = 'none';
      write.style.display = '';
      this.setMarkdown(md);
      const first = this.root.children[0];
      if (first) this.focusBlock(first, 0);
    }
    this.opts.onToast && this.opts.onToast(this.sourceMode ? '源码模式' : '所见即所得');
  }

  /* ============ 撤销/重做 ============ */

  snapState() {
    // 用"文本宿主序号 + 偏移"定位光标: cid 每次 parse 都会重建, 不可跨快照使用
    const info = this.selInfo();
    let idx = -1, off = 0;
    if (info && !info.raw) {
      const hosts = Block.flattenLeaves(this.root).filter(b => b.isTextHost());
      idx = hosts.indexOf(info.block);
      off = Math.min(info.start, (info.block.text || '').length);
    }
    return { md: this.getMarkdown(), idx, off };
  }

  armUndo() {
    if (this._undoArmed) return;
    this._undoArmed = this.snapState();
  }

  _commitUndo() {
    if (this._undoTimer) { clearTimeout(this._undoTimer); this._undoTimer = 0; }
    if (!this._undoArmed) return;
    this.undoStack.push(this._undoArmed);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this._undoArmed = null;
  }

  scheduleUndoCommit() {
    if (this._undoTimer) clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => this._commitUndo(), 400);
  }

  undo() {
    this._commitUndo();
    if (!this.undoStack.length) return;
    const target = this.undoStack.pop();
    this.redoStack.push(this.snapState());
    this._restore(target);
  }

  redo() {
    if (!this.redoStack.length) return;
    const target = this.redoStack.pop();
    this.undoStack.push(this.snapState());
    this._restore(target);
  }

  _restore(state) {
    this.setMarkdown(state.md);
    this.opts.onChange && this.opts.onChange(true);
    const hosts = Block.flattenLeaves(this.root).filter(b => b.isTextHost());
    const b = hosts[state.idx] || hosts[0];
    if (b) {
      const host = this.hostEl(b);
      if (host) this.focusBlock(b, Math.min(state.off || 0, host.textContent.length));
    }
  }

  /* ============ 辅助 ============ */

  _ancestor(block, type) {
    let p = block.parent;
    while (p) {
      if (p.type === type) return p;
      p = p.parent;
    }
    return null;
  }

  /** 空列表项退出: li → 列表后的段落(返回该段落, 供调用方聚焦) */
  _exitList(li) {
    const list = li.parent;
    const para = this._newParagraph('');
    const nxt = list.nextSibling();
    if (nxt) list.parent.insertBefore(para, nxt);
    else list.parent.appendChild(para);
    li.remove();
    if (!list.children.length) list.remove();
    return para;
  }

  _caretToEndOf(block) {
    const host = this.hostEl(block);
    if (host) this.focusBlock(block, host.textContent.length);
  }

  _refocusById(cid, offset) {
    const b = this.nodeMap.get(cid);
    if (b) this.focusBlock(b, offset);
  }

  _toast(msg) {
    this.opts.onToast && this.opts.onToast(msg);
  }

  _status() {
    if (!this.opts.onStatus) return;
    let chars = 0, cjk = 0, latinWords = 0, lines = 0;
    this.root.walk(b => {
      if (b.text) {
        chars += b.text.length;
        lines += b.text.split('\n').length - 1;
        cjk += (b.text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
        latinWords += (b.text.match(/[A-Za-z0-9]+/g) || []).length;
      }
    });
    lines += (this.root.children || []).length;
    this.opts.onStatus({ chars, words: cjk + latinWords, lines });
  }
}
