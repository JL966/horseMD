// TyporaEditor — Typora 风格 WYSIWYG 编辑器宿主(引擎见 ../typora-engine/)。
//
// 与 Editor.jsx(Milkdown/ProseMirror)实现同一份外壳契约,通过 EditorArea 的
// 引擎开关(settings.editorEngine)二选一挂载:
//   - onChange(md, isInitial)  → App.updateContent(isInitial=true 不采纳)
//   - onReady(api)             → 注册进 editorApiRegistry,方法名与 Editor.jsx
//     的 onReady 对齐(文档位置、导出、恢复等);Milkdown 专属的深集成能力
//     (source-sync、评审标记、高亮涂色)在 typora 引擎下是明确的无操作,
//     调用方都能安全降级。
// DOM 契约:#write + md-* 运行时类 + .md-meta/.md-content 语法字符机制,
// Typora 主题 CSS 直接命中(customThemes.js 注入的主题保持原加载顺序优势)。
import { useEffect, useMemo, useRef } from 'react'
import { Editor } from '../typora-engine/editor.js'
import { createImagePersister } from './editor-image-persistence.js'
import { fireToast } from '../ui.js'
import '../styles/typora-base.css'
import '../styles/typora-theme-default.css'

const EMIT_DEBOUNCE_MS = 200

export default function TyporaEditor({
  tabId,
  initialContent,
  docPath,
  imageUploadCommand,
  spellcheck,
  readOnly,
  markdownSyntax,
  effectiveKeybindings,
  onChange,
  onReady,
  onActiveBlock,
  onStructureChange,
  onRichEditPending,
  onToggleSourceRichSplit,
  onLoadingChange
}) {
  const writeRef = useRef(null)
  const editorRef = useRef(null)
  const emitTimerRef = useRef(0)
  const emitDirtyRef = useRef(false)

  // 回调一律走 ref,引擎实例只创建一次,不因父组件重渲染重建
  const cbRef = useRef({})
  cbRef.current = {
    onChange,
    onActiveBlock,
    onStructureChange,
    onRichEditPending,
    imageUploadCommand,
    docPath
  }

  const imagePersister = useMemo(
    () => createImagePersister({
      docPath,
      getUploadCommand: () => cbRef.current.imageUploadCommand,
      getT: () => '',
      notify: fireToast
    }),
    [docPath]
  )

  useEffect(() => {
    const writeEl = writeRef.current
    if (!writeEl) return
    let disposed = false

    const emitPending = () => {
      if (emitTimerRef.current) {
        clearTimeout(emitTimerRef.current)
        emitTimerRef.current = 0
      }
      if (!emitDirtyRef.current) return
      emitDirtyRef.current = false
      const editor = editorRef.current
      if (!editor || disposed) return
      try {
        cbRef.current.onChange?.(editor.getMarkdown(), false)
      } catch {
        /* teardown race */
      }
    }

    const editor = new Editor(writeEl, {
      headingStyle: 1,
      ulStyle: '-',
      olStyle: '.',
      spellcheck: !!spellcheck,
      readOnly: !!readOnly,
      markdownSyntax: {
        subscript: markdownSyntax?.subscript === true,
        superscript: markdownSyntax?.superscript === true
      },
      onChange: (dirty) => {
        if (!dirty) return
        emitDirtyRef.current = true
        cbRef.current.onRichEditPending?.()
        if (emitTimerRef.current) clearTimeout(emitTimerRef.current)
        emitTimerRef.current = setTimeout(emitPending, EMIT_DEBOUNCE_MS)
      },
      onStructureChange: () => cbRef.current.onStructureChange?.(),
      onActiveBlock: (cid) => cbRef.current.onActiveBlock?.(cid),
      onToast: (msg) => fireToast(msg),
      openExternal: (href) => window.api?.openExternal?.(href),
      onPasteImage: (file) => {
        // 与 Milkdown 引擎共用图床命令/入库管线,插入返回的 URL
        imagePersister(file, true).then((url) => {
          editorRef.current?.insertAtSelection('![图片粘贴](' + url + ')')
        }).catch(() => {})
      }
    })
    editorRef.current = editor
    editor.setMarkdown(initialContent || '')

    const scroller = () => writeEl.closest('.editor-scroll')

    onReady?.({
      setBlock: (cid, op) => editorSetBlock(editor, cid, op),
      getView: () => null,
      getExportSource: () => buildExportSource(editor),
      getPdfSource: () => buildExportSource(editor),
      getMarkdown: () => editor.getMarkdown(),
      toggleHighlight: () => false,
      applyReviewMarkup: () => false,
      replaceMarkdown: (md) => {
        emitDirtyRef.current = false
        if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = 0 }
        editor.replaceMarkdown(md)
      },
      flushMarkdown: () => {
        emitDirtyRef.current = false
        if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = 0 }
        return editor.getMarkdown()
      },
      flushMarkdownSettled: async () => {
        emitDirtyRef.current = false
        if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = 0 }
        return editor.getMarkdown()
      },
      getRecoveryMarkdown: () => editor.getMarkdown(),
      getSyncReport: () => null,
      restoreMarkdownOffset: (offset, focus) => {
        try { editor.focusMarkdownOffset(offset) } catch { /* 越界偏移落在默认位置 */ }
        return !!focus
      },
      markdownOffsetFromSelection: () => {
        try { return editor.markdownOffsetFromSelection() } catch { return null }
      },
      markdownOffsetFromViewportTop: () => {
        try { return editor.markdownOffsetFromViewportTop(scroller()) } catch { return null }
      },
      replaceFindRanges: (ranges, repl, all, activeIdx) => {
        try { return editor.replaceFindRanges(ranges, repl, all, activeIdx) } catch { return false }
      },
      destroy: () => {}
    })

    return () => {
      disposed = true
      emitPending()
      editor.destroy()
      if (editorRef.current === editor) editorRef.current = null
    }
    // 引擎生命周期只随挂载代际(tabId 含 reloadNonce)重建;其余 props 走 ref
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  // 只读开关热切换(阅读模式/移动端锁)
  useEffect(() => {
    editorRef.current?.setReadOnly(!!readOnly)
  }, [readOnly])

  // 拼写检查热切换
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    editor.opts.spellcheck = !!spellcheck
    editor.container.setAttribute('spellcheck', spellcheck ? 'true' : 'false')
  }, [spellcheck])

  return (
    <div className="hm-typora-host">
      <div
        ref={writeRef}
        id="write"
        className="hm-typora-engine"
        tabIndex={-1}
      />
    </div>
  )
}

/* ---------------- api 辅助 ---------------- */

// 块级转换(右键菜单/命令面板走 App 命令体系;这里按 cid 直改)。
// op 形如 { type: 'heading', level } | { type: 'paragraph' } | { type: 'quote' }
// | { type: 'list', ordered } | { type: 'fences' } — 与编辑器命令一一对应。
function editorSetBlock(editor, cid, op) {
  if (!op || typeof op !== 'object') return false
  const block = editor.nodeMap.get(cid)
  if (!block) return false
  editor.focusBlock(block, 0)
  switch (op.type) {
    case 'heading': return editor.execCommand('heading', op.level || 1)
    case 'paragraph': return editor.execCommand('paragraph')
    case 'quote': return editor.execCommand('quote')
    case 'orderedList': return editor.execCommand('orderedList')
    case 'unorderedList': return editor.execCommand('unorderedList')
    case 'fences': return editor.execCommand('fences')
    case 'mathBlock': return editor.execCommand('mathBlock')
    default: return false
  }
}

// 导出/打印源:渲染契约 DOM 克隆清理后输出(与 Editor.jsx 的
// createPdfSourceFromEditor 同形状 { html, headings, images })。
// 公式暂为 TeX 源码文本,见 docs/typora-engine.md 能力矩阵。
function buildExportSource(editor) {
  const clone = editor.container.cloneNode(true)
  clone.querySelectorAll('.md-meta, .md-content, .fences-header, .md-tooltip-hide')
    .forEach((el) => el.remove())
  clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
  clone.querySelectorAll('input[type="checkbox"]').forEach((el) => el.removeAttribute('contenteditable'))
  const headings = [...clone.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading, index) => {
    const id = `hm-pdf-heading-${index + 1}`
    heading.id = id
    return { id, level: Number(heading.tagName.slice(1)), text: heading.textContent?.trim() || '' }
  })
  const images = [...clone.querySelectorAll('img')].map((img) => img.getAttribute('src') || '')
  return { html: clone.innerHTML, headings, images }
}
