// 手感硬化检查:复制(含标记)、markdown 多行粘贴、表格 Tab/Enter、
// Shift+Enter 硬换行、跨块选区删除。
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from '../scripts/lib/electron-test-app.mjs'
import { sleep } from '../scripts/lib/cdp.mjs'
import { pressKey, typeTextLikeUser } from '../scripts/lib/human-input.mjs'

const root = await mkdtemp(join(tmpdir(), 'horsemd-typora-hard-'))
const file = join(root, 'hard.md')
await writeFile(file, [
  '# 硬化检查',
  '',
  '第一段有 **加粗** 内容。',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  ''
].join('\n'), 'utf8')

const port = 28000 + (process.pid % 500)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false, port, appArgs: [file]
})
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`)
}
const waitFor = async (fn, label) => {
  for (let i = 0; i < 120; i++) { const v = await fn(); if (v) return v; await sleep(100) }
  throw new Error('timeout: ' + label)
}
const clickAt = async (point) => {
  assert.ok(point, 'missing target')
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
}
// 产生文本输入的按键必须用 keyDown(带 text),rawKeyDown 不触发 beforeinput
const pressEnter = async (modifiers = 0) => {
  for (const type of ['keyDown', 'keyUp']) {
    await app.send('Input.dispatchKeyEvent', {
      type, key: 'Enter', code: 'Enter',
      windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
      modifiers, text: '\r'
    })
    await sleep(60)
  }
}
const V = `const visibleWrite = () => [...document.querySelectorAll('#write')].find(w => w.offsetParent)`

try {
  await waitFor(() => app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    return w && w.querySelectorAll('h1').length ? true : null
  })()`), 'doc not rendered')

  // ---- 1. 复制: 选中含加粗的文本,合成 copy 事件 → 纯文本含 ** 标记 ----
  const copyPayload = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const strong = w.querySelector('strong')
    const host = strong.closest('p')
    const range = document.createRange()
    range.setStart(host.firstChild, 0)
    range.setEndAfter(host.lastChild)
    const s = getSelection(); s.removeAllRanges(); s.addRange(range)
    let captured = null
    const dt = new DataTransfer()
    const ev = new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: dt })
    document.addEventListener('copy', (e) => {
      captured = { plain: e.clipboardData.getData('text/plain') }
    }, { once: true })
    host.dispatchEvent(ev)
    return captured
  })()`)
  check('复制纯文本含 ** 标记', copyPayload && copyPayload.plain && copyPayload.plain.includes('**加粗**'),
    JSON.stringify(copyPayload))

  // ---- 2. 粘贴 markdown 多行 → 解析成块 ----
  const pasteMd = '粘贴标题行\n\n- 粘贴项一\n- 粘贴项二'
  await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const ps = [...w.querySelectorAll(':scope > p.md-p')]
    const target = ps[ps.length - 1] || w.querySelector('h1')
    const r = target.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + r.height / 2 }
  })()`).then(async (pt) => { await clickAt(pt) })
  await sleep(150)
  await pressKey(app.send, { key: 'End', code: 'End' })
  await app.evaluate(`((md) => {
    ${V}
    const w = visibleWrite()
    const host = w.querySelector(':scope > p.md-p') || w.querySelector('h1')
    host.focus()
    const dt = new DataTransfer()
    dt.setData('text/plain', md)
    host.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    return true
  })(${JSON.stringify(pasteMd)})`)
  await sleep(400)
  const afterPaste = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    return {
      hasH2Paste: [...w.querySelectorAll('h1, h2')].some(h => h.textContent.includes('粘贴标题行')),
      listItems: [...w.querySelectorAll('li')].filter(li => li.textContent.includes('粘贴项')).length
    }
  })()`)
  check('粘贴多行 markdown 解析成块', afterPaste.hasH2Paste === false && afterPaste.listItems >= 2,
    JSON.stringify(afterPaste))
  // 注: 粘贴标题行 是纯文本行(无 #),应成为段落文本并入;列表项 2 条
  const paraLine = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    return [...w.querySelectorAll('p.md-p')].some(p => p.textContent.includes('粘贴标题行'))
  })()`)
  check('粘贴首行并入段落', paraLine, '')

  // ---- 3. 表格导航: 点击首格 → Tab → 第二格 ----
  const cellPoint = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const cell = w.querySelector('td .td-span')
    cell.scrollIntoView({ block: 'center' })
    const r = cell.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`)
  await clickAt(cellPoint)
  await sleep(150)
  await typeTextLikeUser(app.send, '甲')
  await pressKey(app.send, { key: 'Tab', code: 'Tab' })
  await sleep(200)
  await typeTextLikeUser(app.send, '乙')
  await sleep(400)
  const tableState = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const spans = [...w.querySelectorAll('.td-span')].map(s => s.textContent)
    return { spans }
  })()`)
  check('表格 Tab 移动 + 输入', tableState.spans.includes('甲乙') === false &&
    tableState.spans.some(t => t.includes('甲')) && tableState.spans.some(t => t.includes('乙')),
    JSON.stringify(tableState))

  // ---- 4. 表格末格 Enter → 新行(CDP 键必须带 text 才会产生 beforeinput) ----
  await pressKey(app.send, { key: 'Enter', code: 'Enter' })
  await sleep(300)
  const tableRows = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    return w.querySelectorAll('table.md-table tbody tr').length
  })()`)
  check('表格末格 Enter 加行', tableRows >= 2, 'tbody rows=' + tableRows)

  // ---- 5. Shift+Enter 硬换行 ----
  const paraPoint = await app.evaluate(`(() => {
    ${V}
    const w = visibleWrite()
    const p = [...w.querySelectorAll(':scope > p.md-p')].find(x => x.textContent.includes('第一段'))
    if (!p) return null
    p.scrollIntoView({ block: 'center' })
    const r = p.getBoundingClientRect()
    return { x: r.left + 30, y: r.top + r.height / 2 }
  })()`)
  if (paraPoint) {
    await clickAt(paraPoint)
    await sleep(120)
    await pressKey(app.send, { key: 'End', code: 'End' })
    await pressKey(app.send, { key: 'Enter', code: 'Enter', modifiers: 8 })
    await typeTextLikeUser(app.send, '硬换行后')
    await sleep(400)
    const brState = await app.evaluate(`(() => {
      ${V}
      const w = visibleWrite()
      const p = [...w.querySelectorAll(':scope > p.md-p')].find(x => x.textContent.includes('第一段'))
      return { text: p ? p.textContent : '', hasBreak: p ? p.innerHTML.includes('linebreak') || p.innerHTML.includes('br') : false }
    })()`)
    check('Shift+Enter 硬换行(源文本含两空格+换行)', brState.text.includes('硬换行后') && brState.text.includes('\n'),
      JSON.stringify(brState).slice(0, 140))
  }

  console.log(results.every(r => r.ok) ? '\nALL PASS' : `\n${results.filter(r => !r.ok).length} FAILED`)
} finally {
  await stopBuiltElectron(app)
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
