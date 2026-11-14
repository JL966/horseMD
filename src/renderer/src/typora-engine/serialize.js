/* ============================================================
 * serialize.js — 块树 → markdown
 * 对齐 Typora 行为: headingStyle(atx/atx闭合/setext)、ulStyle、
 * 有序 start、tight/loose 空行、表格列对齐与 | 转义、
 * 围栏长度自适应、YAML、[TOC]、脚注/引用定义。
 *
 * spans 契约:docToMarkdownWithSpans 额外返回
 *   Map<Block, {start, end}> —— 每个叶子文本块在 md 输出中的
 * 文本区域(quote 内含 "> " 前缀、列表续行含缩进;顶层块为
 * 纯文本切片),供 offsets.js 做 光标 ↔ markdown 偏移 双向映射。
 * ============================================================ */
import { T } from './model.js';

// 活跃的 span 收集器(单线程;子序列化先记录相对位置,组合器再换算为绝对)
let spanCollector = null;

function beginSpanCollection() {
  const map = new Map();
  spanCollector = map;
  return map;
}

function endSpanCollection() {
  spanCollector = null;
}

/** 记录一个叶子块的文本区域(w 内的相对位置;顶层 writer 即绝对位置) */
function markSpan(w, block, startRel, endRel) {
  if (spanCollector && endRel > startRel) spanCollector.set(block, { start: startRel, end: endRel });
}

function escapeCell(s) {
  return String(s).replace(/\|/g, '\\|');
}

function maxFenceRun(text, ch) {
  let max = 0, cur = 0;
  for (const c of text) {
    if (c === ch) { cur++; max = Math.max(max, cur); }
    else cur = 0;
  }
  return max;
}

/** 块序列(与 docToMarkdown 顶层语义一致:非空块以空行相连)。
 *  返回字符串;span 一律相对本 writer(即返回串)记录 —— 每块先在临时
 *  writer 中序列化,再连同 span 平移进主 writer,保证位置即最终位置。 */
function serializeBlocks(blocks, opts) {
  const w = new Writer();
  let first = true;
  for (const b of blocks) {
    const sizeBefore = spanCollector ? spanCollector.size : -1;
    const sub = new Writer();
    serializeBlockInto(sub, b, opts);
    if (sub.length === 0) continue;
    if (!first) w.push('\n\n');
    first = false;
    const shift = w.length - 0; // sub 内容将落在 w 的当前位置起
    w.push(sub.s);
    if (sizeBefore >= 0) remapWindow(sizeBefore, (p) => shift + p);
  }
  return w.s;
}

function serializeBlockInto(w, b, opts) {
  switch (b.type) {
    case T.paragraph: {
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      return;
    }

    case T.heading: {
      const depth = b.attrs.depth || 1;
      if (b.attrs.style === 'setext' && opts.headingStyle === 3 && depth <= 2) {
        const line = depth === 1 ? '=' : '-';
        w.push(b.text);
        w.push('\n');
        w.push(line.repeat(Math.max(3, b.text.length)));
        return;
      }
      w.push('#'.repeat(depth) + ' ');
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      if (opts.headingStyle === 2) w.push(' ' + '#'.repeat(depth));
      return;
    }

    case T.meta: {
      w.push('---\n');
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      w.push('\n---');
      return;
    }

    case T.quote: {
      const sizeBefore = spanCollector ? spanCollector.size : -1;
      const inner = serializeBlocks(b.children || [], opts);
      const alertLine = b.attrs.alert ? '[!' + b.attrs.alert.charAt(0).toUpperCase() + b.attrs.alert.slice(1) + ']\n' : '';
      const lines = (alertLine + inner).split('\n').map(l => '> ' + l);
      // 引用内叶子的 span 换算:基点 = 当前 w 位置;每个 '\n' 都带来 '> '
      const base = w.length;
      w.push(lines.join('\n'));
      if (spanCollector && sizeBefore >= 0) {
        const combined = alertLine + inner;
        const alertLen = alertLine.length;
        remapWindow(sizeBefore, (p) => {
          const q = alertLen + p; // inner 位置在 "alertLine+inner" 中的位置
          return base + 2 + q + 2 * countNL(combined, q);
        });
      }
      return;
    }

    case T.list:
      serializeListInto(w, b, opts);
      return;

    case T.fences: {
      const ch = (b.attrs.fence || '```')[0];
      const baseLen = (b.attrs.fence || '```').length;
      const run = maxFenceRun(b.text, ch);
      const len = run >= baseLen ? run + 1 : baseLen;
      const fence = ch.repeat(len);
      w.push(fence + (b.attrs.lang || ''));
      w.push('\n');
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      if (!b.attrs.noClose) {
        w.push('\n');
        w.push(fence);
      }
      return;
    }

    case T.math: {
      // 始终多行输出, 保证与块级解析严格互逆
      w.push('$$\n');
      const start = w.length;
      w.push(b.text || '');
      markSpan(w, b, start, w.length);
      w.push('\n$$');
      return;
    }

    case T.hr:
      w.push(b.attrs.pattern || '------');
      return;

    case T.toc:
      w.push('[TOC]');
      return;

    case T.html: {
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      return;
    }

    case T.defLink: {
      w.push('[');
      const s1 = w.length;
      w.push(b.attrs.ref || '');
      markSpan(w, b, s1, w.length);
      w.push(']: ');
      const s2 = w.length;
      w.push(b.attrs.href || '');
      markSpan(w, b, s2, w.length);
      w.push(b.attrs.title ? ' "' + b.attrs.title + '"' : '');
      return;
    }

    case T.defFootnote: {
      w.push('[^' + (b.attrs.ref || '') + ']: ');
      const start = w.length;
      w.push(b.text);
      markSpan(w, b, start, w.length);
      return;
    }

    case T.table:
      serializeTableInto(w, b, opts);
      return;

    default:
      return;
  }
}

function countNL(s, before) {
  let n = 0;
  for (let i = 0; i < before && i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/** 换算 collector 中 sizeBefore 之后新增的相对 span */
function remapWindow(sizeBefore, shift) {
  if (!spanCollector || sizeBefore < 0) return;
  const entries = [...spanCollector.entries()];
  for (let i = sizeBefore; i < entries.length; i++) {
    const [block, span] = entries[i];
    spanCollector.set(block, { start: shift(span.start), end: shift(span.end) });
  }
}

function serializeListInto(w, list, opts) {
  const ordered = !!list.attrs.ordered;
  const mark = ordered ? (opts.olStyle || '.') : (list.attrs.mark || opts.ulStyle || '-');
  const tight = list.attrs.tight !== false;
  const items = list.children || [];
  let num = (ordered ? (list.attrs.start || 1) : 1);
  let first = true;
  for (const item of items) {
    if (!first) w.push(tight ? '\n' : '\n\n');
    first = false;
    const itemBase = w.length;
    const sizeBefore = spanCollector ? spanCollector.size : -1;
    const inner = serializeBlocks(item.children || [], opts);
    let lines = inner.split('\n');
    let prefix;
    if (ordered) {
      prefix = num + mark + ' ';
      num++;
    } else {
      prefix = mark + ' ';
    }
    if (item.attrs.task) {
      lines[0] = (item.attrs.checked ? '[x] ' : '[ ] ') + (lines[0] || '');
    }
    // 续行按前缀宽度缩进(空行保持为空)
    const pad = ' '.repeat(prefix.length);
    const indented = lines.map((l, idx) => (idx === 0 ? prefix + l : (l === '' ? '' : pad + l)));
    w.push(indented.join('\n'));
    if (spanCollector && sizeBefore >= 0) {
      // 列表项内叶子:首行加 marker 前缀(任务项再加 '[x] '),
      // 续行加 pad —— 空行不加 pad(与序列化行为一致)
      const taskLen = item.attrs.task ? 4 : 0;
      const lines = inner.split('\n');
      remapWindow(sizeBefore, (p) => {
        let lineStart = 0;
        let pads = 0;
        for (let k = 0; k < lines.length; k++) {
          const len = lines[k].length;
          if (k >= 1 && len > 0 && lineStart <= p) pads++;
          lineStart += len + 1;
          if (lineStart > p && k >= 1 && len > 0 && lineStart - len - 1 <= p) {
            // 已计入当前行
          }
          if (lineStart > p) break;
        }
        return itemBase + prefix.length + taskLen + p + pads * pad.length;
      });
    }
  }
}

function serializeTableInto(w, table, opts) {
  const rows = table.children || [];
  if (!rows.length) return;
  const align = table.attrs.align || [];
  const grid = rows.map(r => (r.children || []).map(c => c.text));
  const nCols = Math.max(...grid.map(r => r.length));
  // 列宽
  const widths = [];
  for (let c = 0; c < nCols; c++) {
    let wdt = 3;
    for (const r of grid) wdt = Math.max(wdt, String(r[c] || '').length);
    widths.push(Math.min(wdt, 60));
  }
  const line = (cells) => '| ' + cells.map((s, i) => {
    const v = String(s || '');
    const pad = ' '.repeat(Math.max(0, widths[i] - v.length));
    return v + pad;
  }).join(' | ') + ' |';
  w.push(line(grid[0]));
  w.push('\n');
  // 分隔行(带对齐)
  const delim = widths.map((wdt, i) => {
    const a = align[i];
    if (a === 'center') return ':' + '-'.repeat(Math.max(1, wdt - 2)) + ':';
    if (a === 'left') return ':' + '-'.repeat(Math.max(1, wdt - 1));
    if (a === 'right') return '-'.repeat(Math.max(1, wdt - 1)) + ':';
    return '-'.repeat(wdt);
  });
  w.push('| ' + delim.join(' | ') + ' |');
  for (let r = 1; r < grid.length; r++) {
    w.push('\n');
    w.push(line(grid[r]));
  }
}

export function docToMarkdown(root, opts = {}) {
  const o = {
    headingStyle: opts.headingStyle || 1,
    ulStyle: opts.ulStyle || '-',
    olStyle: opts.olStyle || '.',
  };
  const w = new Writer();
  let first = true;
  for (const b of root.children || []) {
    const sizeBefore = spanCollector ? spanCollector.size : -1;
    const sub = new Writer();
    serializeBlockInto(sub, b, o);
    if (sub.length === 0) continue;
    if (!first) w.push('\n\n');
    first = false;
    const shift = w.length;
    w.push(sub.s);
    if (sizeBefore >= 0) remapWindow(sizeBefore, (p) => shift + p);
  }
  let md = w.s;
  if (opts.useCRLF) md = md.replace(/\n/g, '\r\n');
  return md;
}

/** 序列化并收集叶子文本区域(spans 为绝对偏移;quote/list 内已换算)。
 *  始终按 LF 计算偏移(CRLF 形态由调用方按换行数换算)。 */
export function docToMarkdownWithSpans(root, opts = {}) {
  const spans = beginSpanCollection();
  let md;
  try {
    md = docToMarkdown(root, { ...opts, useCRLF: false });
  } finally {
    endSpanCollection();
  }
  return { md, spans };
}

/** 独立 Writer(子序列化用,位置从 0 起) */
class Writer {
  constructor() { this.s = ''; }
  get length() { return this.s.length; }
  push(str) { this.s += str; }
  slice(from) { return this.s.slice(from); }
}
