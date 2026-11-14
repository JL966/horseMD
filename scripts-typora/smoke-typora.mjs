// Typora 引擎冒烟测试:内建应用 + CDP 验证 #write 契约 DOM、md-expand、
// 打字转换、Ctrl+B、undo,并输出截图。
// 注意:多个隐藏标签都挂载 id=write(主题 CSS 需要命中每个 pane),
// 因此测试一律取可见的 #write。
// Run: node scripts-typora/smoke-typora.mjs [--keep]
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from '../scripts/lib/electron-test-app.mjs'
import { sleep } from '../scripts/lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from '../scripts/lib/human-input.mjs'

const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'horsemd-typora-'))
const file = join(root, 'demo.md')
const source = [
  '# Typora 引擎演示',
  '',
  '普通段落,包含 **加粗**、*斜体*、`code` 与 [链接](https://example.com)。',
  '',
  '- 无序列表项 1',
  '- 无序列表项 2',
  '',
  '> 引用一行',
  '',
  '```js',
  'const a = 1',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  ''
].join('\n')
await writeFile(file, source, 'utf8')

const port = 28000 + (process.pid % 500)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'),
  cleanProfile: false,
  port,
  appArgs: [file]
})

// 可见 pane 的 #write(#write 在隐藏 pane 中也有,按 offsetParent 过滤)
const V = `const visibleWrite = () => [...document.querySelectorAll('#write')].find(w => w.offsetParent)`

const waitFor = async (fn, label) => {
  for (let i = 0; i < 120; i++) {
    const v = await fn()
    if (v) return v
    await sleep(100)
  }
  try {
    const dump = await app.evaluate(`(() => ({
      tabs: [...document.querySelectorAll('.tab')].map(t => t.className + '|' + (t.textContent || '').slice(0, 24)),
      writes: [...document.querySelectorAll('#write')].map(w => 'vis:' + !!w.offsetParent + ' h:' + w.querySelectorAll('h1').length),
      editorArea: !!document.querySelector('.editor-area'),
      bodyClass: document.body.className.slice(0, 80)
    }))()`)
    console.log('TIMEOUT DUMP:', JSON.stringify(dump, null, 1))
  } catch { /* 诊断失败不掩盖原超时 */ }
  throw new Error('timeout: ' + label)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}

const clickAt = async (point) => {
  assert.ok(point, 'missing click target')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}

try {
  // 0. 等待 demo.md 标签出现, 未激活则点一下
  const early = await app.evaluate(`(() => ({
    tabs: document.querySelectorAll('.tab').length,
    writes: [...document.querySelectorAll('#write')].filter(w => w.offsetParent).length
  }))()`).catch((e) => 'eval-error: ' + e.message)
  console.log('early state:', JSON.stringify(early))
  const tabPoint = await waitFor(() => app.evaluate(`(() => {
    const target = [...document.querySelectorAll('.tab')]
      .find(t => (t.textContent || '').includes('demo.md'))
    if (!target) return null
    if (target.className.includes('active')) return 'already-active'
    const r = target.getBoundingClientRect()
    if (!r.width) return null
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`), 'demo.md tab never appeared')
  if (tabPoint && tabPoint.x) {
    await clickAt(tabPoint)
    await sleep(300)
  }

  // 1. #write 挂载 + md-* 契约类
  const info = await waitFor(() => app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    if (!w) return null
    return {
      engine: w.className,
      headings: w.querySelectorAll('h1.md-heading').length,
      paras: w.querySelectorAll('p.md-p').length,
      fences: w.querySelectorAll('pre.md-fences').length,
      tables: w.querySelectorAll('table.md-table').length,
      quotes: w.querySelectorAll('blockquote').length,
      lists: w.querySelectorAll('ul').length,
      metaHidden: [...w.querySelectorAll('.md-meta')].filter(m => getComputedStyle(m).display === 'none').length,
      metaTotal: w.querySelectorAll('.md-meta').length,
      boldText: !!w.querySelector('strong'),
      codeEl: !!w.querySelector('p code'),
      linkEl: !!w.querySelector('[md-inline="link"] a')
    }
  })()`), 'visible #write did not render')
  check('#write 挂载 + md-* 契约类', info.headings === 1 && info.paras >= 1, JSON.stringify(info))
  check('代码块 pre.md-fences', info.fences === 1)
  check('表格 table.md-table', info.tables === 1)
  check('引用 blockquote', info.quotes === 1)
  check('列表 ul', info.lists === 1)
  check('strong/em/code/link 内联元素', info.boldText && info.codeEl && info.linkEl)
  check('语法字符 .md-meta 默认隐藏', info.metaHidden === info.metaTotal && info.metaTotal > 0,
    `${info.metaHidden}/${info.metaTotal}`)

  // 2. 光标进入加粗文本 → .md-expand,meta 显示
  const boldPoint = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const strong = w.querySelector('strong')
    strong.scrollIntoView({ block: 'center' })
    const r = strong.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await clickAt(boldPoint)
  await sleep(150)
  const expanded = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    // Typora 契约: md-expand 打在外层 md-pair-s wrapper 上, meta 是 wrapper 的直接子元素
    const wrap = w.querySelector('[md-inline="strong"]')
    const strong = wrap.querySelector('strong')
    const meta = wrap.querySelector(':scope > .md-meta')
    return {
      wrapExpand: wrap.classList.contains('md-expand'),
      expand: wrap.classList.contains('md-expand'),
      metaShown: meta ? getComputedStyle(meta).display !== 'none' : false,
      metaCls: meta ? meta.className : null,
      plainWrapped: !!strong.querySelector('span.md-plain')
    }
  })()`)
  check('光标进入内联样式 → wrapper md-expand 显示语法字符(Typora 契约)', expanded.expand && expanded.metaShown && expanded.plainWrapped && /md-before/.test(expanded.metaCls), JSON.stringify(expanded))

  // 3. 打字转换: 首个直接子段落清空后输入 "# 标题测试" → 变 h1
  const firstParaPoint = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const p = w.querySelector(':scope > p.md-p')
    if (!p) return null
    p.scrollIntoView({ block: 'center' })
    const r = p.getBoundingClientRect()
    return { x: r.left + 40, y: r.top + r.height / 2, len: p.textContent.length }
  })()`)
  await clickAt(firstParaPoint)
  await sleep(120)
  // 逐行 Home → shift+End → Backspace,清空整个段落(防多行折行)
  for (let round = 0; round < 4; round++) {
    await pressKey(app.send, { key: 'Home', code: 'Home' })
    await pressKey(app.send, { key: 'End', code: 'End', modifiers: 8 })
    await pressKey(app.send, { key: 'Backspace', code: 'Backspace' })
    const remaining = await app.evaluate(`(() => {
      ${V}
      const w = visibleWrite()
      const p = w.querySelector(':scope > p.md-p')
      return p ? p.textContent.length : -1
    })()`)
    if (remaining <= 0) break
  }
  const emptied = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const p = w.querySelector(':scope > p.md-p')
    return p ? p.textContent.length : -1
  })()`)
  assert.ok(emptied === 0, 'paragraph not emptied: ' + emptied)
  await typeTextLikeUser(app.send, '# 标题测试')
  await sleep(400)
  const conv = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const hs = [...w.querySelectorAll('h1.md-heading')]
    return { count: hs.length, text: hs[hs.length - 1]?.textContent || '' }
  })()`)
  check('输入 "# " 实时转标题', conv.count >= 2 && conv.text.includes('标题测试'), JSON.stringify(conv))

  // 4. Ctrl+B 加粗快捷键: 输入"加粗我" → 向左扩选 3 字 → Ctrl+B
  await typeTextLikeUser(app.send, '加粗我')
  await app.evaluate(`(() => {
    const s = getSelection()
    if (!s.rangeCount) return null
    for (let i = 0; i < 3; i++) s.modify('extend', 'backward', 'character')
    return true
  })()`)
  await pressKey(app.send, { key: 'b', code: 'KeyB', modifiers: 2, text: '' })
  await sleep(250)
  const boldCmd = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const hs = [...w.querySelectorAll('h1')]
    const last = hs[hs.length - 1]
    return { strong: !!last?.querySelector('strong'), md: last?.textContent || '' }
  })()`)
  check('Ctrl+B 切换加粗(文本含 ** 标记)', boldCmd.strong, boldCmd.md)

  // 5. undo (Ctrl+Z): 撤销加粗后 strong 消失
  await pressKey(app.send, { key: 'z', code: 'KeyZ', modifiers: 2, text: '' })
  await sleep(350)
  const undone = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const hs = [...w.querySelectorAll('h1')]
    const last = hs[hs.length - 1]
    return { strong: !!last?.querySelector('strong'), text: last?.textContent || '' }
  })()`)
  check('Ctrl+Z 撤销', !undone.strong || !undone.text.includes('**'), JSON.stringify(undone))

  // 6. 不变式: textContent === 内联 markdown 源文本(md-meta 在 DOM 里)
  const invariant = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const strongs = [...w.querySelectorAll('strong')]
    for (const s of strongs) {
      const raw = s.textContent
      if (!raw.startsWith('**') || !raw.endsWith('**')) return { ok: false, raw }
    }
    return { ok: true, n: strongs.length }
  })()`)
  check('不变式: textContent === 内联 markdown 源文本', invariant.ok, JSON.stringify(invariant))

  // 7. 截图
  await sleep(300)
  await app.send('Page.enable').catch(() => {})
  const shot = await app.send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) {
    const { writeFile: wf } = await import('node:fs/promises')
    const shotPath = join(process.cwd(), 'scripts-typora', 'typora-engine-smoke.png')
    await wf(shotPath, Buffer.from(data, 'base64'))
    console.log('截图:', shotPath)
  } else {
    console.log('截图不可用(跳过):', JSON.stringify(shot)?.slice(0, 120))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(failed.length ? `\n${failed.length} FAILED` : '\nALL PASS')
} finally {
  await stopBuiltElectron(app)
  if (!keep) {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
