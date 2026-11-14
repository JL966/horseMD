/* ============================================================
 * model.js — 文档块模型
 * 结构: 树状块节点(容器块有 children, 叶子块有 text)。
 * 契约: 每个渲染为 DOM 元素的块都有唯一 cid;叶子块的 text
 * 即该块的 markdown 内联源文本(DOM textContent 与之互逆)。
 * ============================================================ */

export const T = {
  doc: 'document',
  meta: 'meta_block',      // YAML front matter
  heading: 'heading',
  paragraph: 'paragraph',
  quote: 'blockquote',
  list: 'list',
  listItem: 'list_item',
  fences: 'fences',        // 代码块
  math: 'math_block',
  hr: 'hr',
  table: 'table',
  row: 'table_row',
  cell: 'table_cell',
  toc: 'toc',
  html: 'html_block',
  defLink: 'def_link',
  defFootnote: 'def_footnote',
};

let CID = 0;
export function newCid() { return 'c' + (++CID); }

const CONTAINER_TYPES = new Set([T.doc, T.quote, T.list, T.listItem, T.table, T.row]);

export class Block {
  constructor(type, props = {}) {
    this.id = newCid();
    this.type = type;
    this.text = props.text || '';
    this.attrs = {};               // depth / lang / alert / ordered / start / mark / tight / checked / align ...
    Object.assign(this.attrs, props.attrs || {});
    this.children = props.children || null;   // 容器块: Block[]
    this.parent = null;
    if (this.children) for (const c of this.children) { c.parent = this; }
  }

  get isContainer() { return CONTAINER_TYPES.has(this.type); }

  /** 在 children 数组中的前驱/后继兄弟 */
  prevSibling() {
    if (!this.parent) return null;
    const arr = this.parent.children;
    const i = arr.indexOf(this);
    return i > 0 ? arr[i - 1] : null;
  }
  nextSibling() {
    if (!this.parent) return null;
    const arr = this.parent.children;
    const i = arr.indexOf(this);
    return i >= 0 && i < arr.length - 1 ? arr[i + 1] : null;
  }
  appendChild(b) { b.parent = this; (this.children || (this.children = [])).push(b); return b; }
  insertBefore(b, ref) {
    b.parent = this;
    const arr = this.children || (this.children = []);
    const i = ref ? arr.indexOf(ref) : arr.length;
    arr.splice(i < 0 ? arr.length : i, 0, b);
    return b;
  }
  replaceWith(...blocks) {
    if (!this.parent) return;
    const arr = this.parent.children;
    const i = arr.indexOf(this);
    arr.splice(i, 1, ...blocks);
    for (const b of blocks) { b.parent = this.parent; }
    this.parent = null;
  }
  remove() {
    if (!this.parent) return;
    const arr = this.parent.children;
    const i = arr.indexOf(this);
    if (i >= 0) arr.splice(i, 1);
    this.parent = null;
  }

  /** 光标可落在其中的"叶子内容块"(paragraph/heading/cell/fences代码区/meta/math源区) */
  isTextHost() {
    return this.type === T.paragraph || this.type === T.heading || this.type === T.cell ||
      this.type === T.fences || this.type === T.math || this.type === T.meta;
  }

  /** 深度优先找包含某 DOM 元素对应 cid 的块 —— 由 editor 维护 nodeMap,一般不走这里 */
  walk(fn) {
    fn(this);
    if (this.children) for (const c of this.children) c.walk(fn);
  }

  /** 扁平化文本宿主块序列(用于序列化与相邻判断) */
  static flattenLeaves(root) {
    const out = [];
    (function rec(b) {
      if (!b.children || b.type === T.table || b.type === T.row) { out.push(b); return; }
      for (const c of b.children) rec(c);
    })(root);
    return out;
  }
}

/** 便于序列化判断:两个叶子块是否"位于同一容器上下文"(决定块间空行) */
export function sameNesting(a, b) {
  return a.parent === b.parent;
}
