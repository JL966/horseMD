/* ============================================================
 * parser.js — 块级解析器: markdown 文本 → 块树
 * 覆盖: YAML / ATX+Setext 标题 / 围栏代码(``` ~~~ 自适应) /
 * $$ 公式块 / 水平线 / 引用(+GFM alert) / 有序·无序·任务列表
 * (嵌套, tight/loose) / 管道表格(对齐) / [TOC] / 脚注·引用定义 /
 * HTML 块 / 多行段落(硬换行= 行尾两空格)
 * 全新实现, CommonMark 子集语义。
 * ============================================================ */
import { Block, T } from './model.js';

const RE = {
  blank: /^\s*$/,
  yamlOpen: /^---\s*$/,
  yamlClose: /^(---|\.\.\.)\s*$/,
  fence: /^ {0,3}(`{3,}|~{3,})\s*([^`]*)$/,
  fenceClose: /^ {0,3}(`{3,}|~{3,})\s*$/,
  mathOpen: /^ {0,3}\$\$\s*$/,
  atx: /^ {0,3}(#{1,6})(\s+(.*?))?\s*$/,
  setextEq: /^ {0,3}=+\s*$/,
  setextDash: /^ {0,3}-{1,}\s*$/,
  hr: /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/,
  quote: /^ {0,3}> ?(.*)$/,
  alert: /^\[!(note|important|warning|tip|caution)\]\s*$/i,
  listItem: /^(\s*)([-*+]|\d{1,9}[.)])(\s+(.*))?$/,
  task: /^\[([ xX])\]\s*(.*)$/,
  toc: /^ {0,3}\[TOC\]\s*$/,
  defFootnote: /^ {0,3}\[\^([^\]\s]+)\]:\s*(.*)$/,
  defLink: /^ {0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+["'(](.*?)["')])?\s*$/,
  htmlOpen: /^ {0,3}<(\/?[A-Za-z][^>]*>)\s*$/,
  pipeRow: /^\s{0,3}\|.*\|\s*$/,
  delimiter: /^ {0,3}\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/,
};

function cellSplit(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // 按未转义的 | 切分
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (s[i] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(delimiterLine) {
  return cellSplit(delimiterLine).map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

/** 两个 marker 是否属于同一列表(有序性一致; 无序的弹符号一致) */
function markerCompatible(listInfo, marker) {
  const mOrdered = /\d/.test(marker[0]);
  if (mOrdered !== listInfo.ordered) return false;
  if (!listInfo.ordered && !mOrdered) return marker === listInfo.mark;
  return true;
}

/** 前导空白宽度: tab 视为 4, 遇到非空白即停 */
function indentWidth(s) {
  let w = 0;
  for (const ch of s) {
    if (ch === '\t') w += 4;
    else if (ch === ' ') w += 1;
    else break;
  }
  return w;
}

/** 列表项内容行去前缀: 首行去 marker,后续行去 contentIndent 缩进 */
function stripIndent(line, n) {
  let removed = 0, i = 0;
  while (i < line.length && removed < n) {
    if (line[i] === '\t') { removed += 4; i++; }
    else if (line[i] === ' ') { removed++; i++; }
    else break;
  }
  return line.slice(i);
}

export function parseMarkdown(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const root = new Block(T.doc);
  root.children = parseBlockLines(lines, 0);
  for (const c of root.children) c.parent = root;
  return root;
}

function parseBlockLines(lines, ctxIndent) {
  const blocks = [];
  let i = 0;

  // YAML front matter 只出现在文档最前
  if (ctxIndent === 0 && blocks.length === 0 && i < lines.length && RE.yamlOpen.test(lines[i])) {
    const yaml = [];
    i++;
    while (i < lines.length && !RE.yamlClose.test(lines[i])) { yaml.push(lines[i]); i++; }
    if (i < lines.length) i++; // consume close
    blocks.push(new Block(T.meta, { text: yaml.join('\n') }));
  }

  while (i < lines.length) {
    const line = lines[i];

    if (RE.blank.test(line)) { i++; continue; }

    // ---- 围栏代码 ----
    const fm = line.match(RE.fence);
    if (fm) {
      const fenceChar = fm[1][0];
      const fenceLen = fm[1].length;
      const lang = (fm[2] || '').trim().split(/\s+/)[0] || '';
      const body = [];
      i++;
      let noClose = true;
      while (i < lines.length) {
        const cm = lines[i].match(RE.fenceClose);
        if (cm && cm[1][0] === fenceChar && cm[1].length >= fenceLen) { noClose = false; i++; break; }
        body.push(lines[i]); i++;
      }
      const b = new Block(T.fences, { text: body.join('\n') });
      b.attrs.lang = lang;
      b.attrs.fence = fenceChar.repeat(fenceLen);
      b.attrs.noClose = noClose;
      blocks.push(b);
      continue;
    }

    // ---- 公式块 $$ ----
    {
      const single = line.match(/^ {0,3}\$\$(.+)\$\$\s*$/);
      if (single) {
        blocks.push(new Block(T.math, { text: single[1].trim() }));
        i++;
        continue;
      }
    }
    if (RE.mathOpen.test(line)) {
      const body = [];
      i++;
      while (i < lines.length && !RE.mathOpen.test(lines[i])) { body.push(lines[i]); i++; }
      if (i < lines.length) i++;
      blocks.push(new Block(T.math, { text: body.join('\n') }));
      continue;
    }

    // ---- ATX 标题 ----
    const hm = line.match(RE.atx);
    if (hm) {
      const b = new Block(T.heading, { text: (hm[3] || '').replace(/\s+#+\s*$/, '') });
      b.attrs.depth = hm[1].length;
      b.attrs.style = 'atx';
      blocks.push(b);
      i++;
      continue;
    }

    // ---- 水平线 ----
    if (RE.hr.test(line)) {
      const b = new Block(T.hr);
      b.attrs.pattern = line.trim();
      blocks.push(b);
      i++;
      continue;
    }

    // ---- 引用(+alert) ----
    const qm = line.match(RE.quote);
    if (qm) {
      const inner = [qm[1]];
      i++;
      while (i < lines.length) {
        if (RE.blank.test(lines[i])) break;
        const q2 = lines[i].match(RE.quote);
        if (q2) { inner.push(q2[1]); i++; continue; }
        // 惰性续行: 非空、非新块起始 → 归入引用(仅段落文本)
        if (isParagraphLine(lines[i])) { inner.push(lines[i]); i++; continue; }
        break;
      }
      const q = new Block(T.quote);
      const first = inner[0].match(RE.alert);
      if (first) { q.attrs.alert = first[1].toLowerCase(); inner.shift(); }
      q.children = parseBlockLines(inner, ctxIndent);
      for (const c of q.children) c.parent = q;
      blocks.push(q);
      continue;
    }

    // ---- 列表 ----
    const lm = line.match(RE.listItem);
    if (lm) {
      const listInfo = { ordered: /\d/.test(lm[2][0]), mark: lm[2] };
      const baseW = indentWidth(lm[1]);
      const startNum = listInfo.ordered ? parseInt(lm[2], 10) : undefined;
      const items = [];
      let tight = true;
      let sawBlank = false;

      while (i < lines.length) {
        const cur = lines[i];
        if (RE.blank.test(cur)) { sawBlank = true; i++; continue; }
        const m2 = cur.match(RE.listItem);
        const curW = indentWidth(cur.match(/^\s*/)[0]);
        if (m2 && curW === baseW && markerCompatible(listInfo, m2[2])) {
          // 新的同级项
          if (sawBlank) tight = false;
          sawBlank = false;
          const content = m2[4] || '';
          const markerW = indentWidth(m2[1]) + m2[2].length + indentWidth(m2[3] || ' ');
          const itemLines = [content];
          i++;
          // 收集属于该项的续行(缩进 >= markerW 的行,或惰性段落行)
          while (i < lines.length) {
            const nx = lines[i];
            if (RE.blank.test(nx)) {
              // 空行后看后面是否还有更深层内容(同级新项不算续行, 由外层循环接管)
              let j = i + 1;
              while (j < lines.length && RE.blank.test(lines[j])) j++;
              if (j >= lines.length) break;
              const w2 = indentWidth(lines[j].match(/^\s*/)[0]);
              if (w2 < markerW) break;
              itemLines.push(''); i++; continue;
            }
            const w = indentWidth(nx.match(/^\s*/)[0]);
            if (w >= markerW) { itemLines.push(stripIndent(nx, markerW)); i++; continue; }
            const nm = nx.match(RE.listItem);
            if (nm && indentWidth(nm[1]) === baseW) break;   // 同级新项
            if (isParagraphLine(nx)) { itemLines.push(nx.trimStart()); i++; continue; } // 惰性续行
            break;
          }
          const item = new Block(T.listItem);
          const tm = itemLines[0].match(RE.task);
          if (tm) {
            item.attrs.task = true;
            item.attrs.checked = tm[1] !== ' ';
            itemLines[0] = tm[2];
          }
          item.children = parseBlockLines(itemLines, markerW);
          for (const c of item.children) c.parent = item;
          items.push(item);
          continue;
        }
        break;
      }

      const list = new Block(T.list, { children: items });
      list.attrs.ordered = listInfo.ordered;
      if (listInfo.ordered) {
        list.attrs.mark = lm[2].replace(/^\d+/, '');
        list.attrs.start = isNaN(startNum) ? 1 : startNum;
      } else {
        list.attrs.mark = lm[2];
      }
      list.attrs.tight = tight;
      blocks.push(list);
      continue;
    }

    // ---- 管道表格 ----
    if (line.includes('|') && i + 1 < lines.length &&
        RE.delimiter.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const align = parseAlign(lines[i + 1]);
      const header = cellSplit(line);
      const table = new Block(T.table);
      table.attrs.align = align;
      const hr = new Block(T.row);
      hr.attrs.head = true;
      hr.children = header.map(txt => { const c = new Block(T.cell, { text: txt }); c.attrs.th = true; return c; });
      for (const c of hr.children) c.parent = hr;
      table.children = [hr];
      hr.parent = table;
      i += 2;
      while (i < lines.length && !RE.blank.test(lines[i]) && lines[i].includes('|') &&
             !RE.fence.test(lines[i]) && !RE.atx.test(lines[i])) {
        const cells = cellSplit(lines[i]);
        const row = new Block(T.row);
        row.children = cells.map(txt => new Block(T.cell, { text: txt }));
        for (const c of row.children) c.parent = row;
        row.parent = table;
        table.children.push(row);
        i++;
      }
      blocks.push(table);
      continue;
    }

    // ---- [TOC] ----
    if (RE.toc.test(line)) { blocks.push(new Block(T.toc)); i++; continue; }

    // ---- 脚注/引用定义 ----
    const dfn = line.match(RE.defFootnote);
    if (dfn) {
      const txt = [dfn[2]];
      i++;
      while (i < lines.length && /^\s{4,}\S/.test(lines[i])) { txt.push(lines[i].trimStart()); i++; }
      const b = new Block(T.defFootnote, { text: txt.join('\n') });
      b.attrs.ref = dfn[1];
      blocks.push(b);
      continue;
    }
    const dl = line.match(RE.defLink);
    if (dl) {
      const b = new Block(T.defLink);
      b.attrs.ref = dl[1]; b.attrs.href = dl[2]; b.attrs.title = dl[3] || '';
      blocks.push(b);
      i++;
      continue;
    }

    // ---- HTML 块 ----
    if (RE.htmlOpen.test(line)) {
      const body = [line];
      i++;
      while (i < lines.length && !RE.blank.test(lines[i])) { body.push(lines[i]); i++; }
      blocks.push(new Block(T.html, { text: body.join('\n') }));
      continue;
    }

    // ---- 段落(含 Setext 标题回溯) ----
    {
      const para = [line];
      i++;
      while (i < lines.length) {
        const nx = lines[i];
        if (RE.blank.test(nx)) break;
        if (!isParagraphLine(nx)) break;
        // setext 下划线检测(在 isParagraphLine 已排除 ===,这里检测 -)
        para.push(nx);
        i++;
      }
      // setext: 段落只有一行且下一行是 ===/--- 下划线
      const last = lines[i];
      if (para.length === 1 && last && RE.setextEq.test(last)) {
        const b = new Block(T.heading, { text: para[0].trim() });
        b.attrs.depth = 1; b.attrs.style = 'setext';
        b.attrs.pattern = '=';
        blocks.push(b); i++;
        continue;
      }
      if (para.length === 1 && last && RE.setextDash.test(last) && !RE.hr.test(last)) {
        const b = new Block(T.heading, { text: para[0].trim() });
        b.attrs.depth = 2; b.attrs.style = 'setext';
        b.attrs.pattern = '-';
        blocks.push(b); i++;
        continue;
      }
      blocks.push(new Block(T.paragraph, { text: para.join('\n') }));
      continue;
    }
  }
  return blocks;
}

/** 行是否应继续当前段落(不开启新块) */
function isParagraphLine(line) {
  if (RE.blank.test(line)) return false;
  if (RE.fence.test(line)) return false;
  if (RE.mathOpen.test(line)) return false;
  if (RE.atx.test(line)) return false;
  if (RE.hr.test(line)) return false;
  if (RE.quote.test(line)) return false;
  if (RE.toc.test(line)) return false;
  if (RE.defFootnote.test(line)) return false;
  if (RE.defLink.test(line)) return false;
  if (RE.htmlOpen.test(line)) return false;
  if (RE.setextEq.test(line)) return false;
  const m = line.match(RE.listItem);
  if (m && indentWidth(m[1]) === 0) return false; // 顶格列表打断段落
  if (line.includes('|') && RE.delimiter.test(line)) return false; // 表格分隔行
  return true;
}
