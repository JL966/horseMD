/* ============================================================
 * offsets.js — 光标 ↔ markdown 字符偏移 双向映射
 *
 * 依据 serialize.js 的 spans(叶子文本区域,绝对偏移):
 *   - caret(block, local) → md offset   (保存文档位置/全局搜索跳转)
 *   - md offset → caret(block, local)   (重开文档恢复位置)
 *   - 视口顶部 → md offset              (分屏联动/位置兜底)
 * 区域内前缀(引用 "> "、列表缩进)按行对齐换算;表格内
 * \| 转义按线性近似。CRLF 文档按换行数在 LF/CRLF 形态间换算。
 * ============================================================ */
import { docToMarkdownWithSpans } from './serialize.js';

const spanCache = new WeakMap();

/** 取(并缓存)当前模型的 md + spans;模型变更时由 editor 递增 _mutVersion */
function cacheFor(editor) {
  const cached = spanCache.get(editor);
  if (cached && cached.version === editor._mutVersion) return cached;
  const { md, spans } = docToMarkdownWithSpans(editor.root, {
    headingStyle: editor.opts.headingStyle,
    ulStyle: editor.opts.ulStyle,
    olStyle: editor.opts.olStyle
  });
  const entry = {
    version: editor._mutVersion,
    md,
    spans,
    sorted: [...spans.entries()]
      .map(([block, span]) => ({ block, span }))
      .sort((a, b) => a.span.start - b.span.start)
  };
  spanCache.set(editor, entry);
  return entry;
}

/** 区域内 块内偏移 ↔ 区域偏移(按行对齐,吸收行首前缀) */
function alignLines(text, region, value, toRegion) {
  const tLines = text.split('\n');
  const rLines = region.split('\n');
  if (tLines.length !== rLines.length || region.length === text.length) {
    // 行数不一致(表格 \| 转义等)→ 线性近似
    if (toRegion) return Math.min(region.length, Math.round((value * region.length) / Math.max(1, text.length)));
    return Math.min(text.length, Math.round((value * text.length) / Math.max(1, region.length)));
  }
  let tOff = 0;
  let rOff = 0;
  for (let k = 0; k < tLines.length; k++) {
    const tLen = tLines[k].length;
    const rLen = rLines[k].length;
    if (toRegion) {
      if (value <= tOff + tLen) return rOff + (value - tOff);
    } else {
      if (value <= rOff + rLen) return tOff + (value - rOff);
    }
    tOff += tLen + 1;
    rOff += rLen + 1;
  }
  return toRegion ? region.length : text.length;
}

/** (block, local) → LF 形态 md 偏移;无法定位返回 null */
function caretToLF(editor, block, local) {
  const cache = cacheFor(editor);
  const span = cache.spans.get(block);
  if (!span) return null;
  const region = cache.md.slice(span.start, span.end);
  const inRegion = alignLines(block.text || '', region, Math.max(0, Math.min(local, (block.text || '').length)), true);
  return span.start + inRegion;
}

/** LF 偏移 → {block, local};找不到返回 null */
function lfToCaret(editor, lfOffset) {
  const cache = cacheFor(editor);
  const list = cache.sorted;
  for (const { block, span } of list) {
    if (lfOffset >= span.start && lfOffset <= span.end) {
      const region = cache.md.slice(span.start, span.end);
      const local = alignLines(block.text || '', region, lfOffset - span.start, false);
      return { block, local };
    }
  }
  return null;
}

/** LF 偏移 → CRLF 形态偏移(按文档换行数换算);无 CRLF 时原样 */
function lfToDocOffset(editor, lfOffset) {
  if (!editor._hadCRLF) return lfOffset;
  const cache = cacheFor(editor);
  return lfOffset + countNL(cache.md, lfOffset);
}

function docToLFOffset(editor, docOffset) {
  if (!editor._hadCRLF) return docOffset;
  const cache = cacheFor(editor);
  // CRLF 形态的 md(手动构造一次)
  const crlf = cache.md.includes('\r\n') ? cache.md : cache.md.replace(/\n/g, '\r\n');
  let lf = 0;
  let crlfOff = 0;
  while (crlfOff < docOffset && crlfOff < crlf.length) {
    if (crlf[crlfOff] === '\r' && crlf[crlfOff + 1] === '\n') crlfOff += 2;
    else crlfOff += 1;
    lf += 1;
  }
  return lf;
}

function countNL(s, before) {
  let n = 0;
  for (let i = 0; i < before && i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

/* ---------------- 对外 API(全部接收 editor 实例) ---------------- */

/** 当前选区 → md 偏移(文档形态);无有效光标返回 null */
export function markdownOffsetFromSelection(editor) {
  const info = editor.selInfo();
  if (!info || info.raw) return null;
  const lf = caretToLF(editor, info.block, Math.min(info.start, info.end));
  if (lf == null) return null;
  return lfToDocOffset(editor, lf);
}

/** 视口顶部可见的第一个块 → md 偏移;无可见块返回 null */
export function markdownOffsetFromViewportTop(editor, scroller) {
  if (!scroller) return null;
  const top = scroller.getBoundingClientRect().top;
  const els = scroller.querySelectorAll('[cid][mdtype]');
  for (const el of els) {
    const rect = el.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const block = editor.nodeMap.get(el.getAttribute('cid'));
    if (!block) continue;
    // 可见块:若其文本宿主部分已越过视口顶,取 0 偏移;否则继续
    const lf = caretToLF(editor, block, 0);
    if (lf == null) continue;
    return lfToDocOffset(editor, lf);
  }
  return null;
}

/** md 偏移(文档形态)→ 设置光标;成功返回 true */
export function focusMarkdownOffset(editor, offset) {
  const docOffset = Number(offset);
  if (!Number.isFinite(docOffset) || docOffset < 0) return false;
  const lf = docToLFOffset(editor, docOffset);
  const hit = lfToCaret(editor, lf);
  if (!hit) return false;
  editor.focusBlock(hit.block, hit.local, hit.local);
  return true;
}
