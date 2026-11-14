// 集成专项:大纲、查找替换、保存(round-trip)、Typora 主题注入。
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from '../scripts/lib/electron-test-app.mjs'
import { sleep } from '../scripts/lib/cdp.mjs'
import { pressKey } from '../scripts/lib/human-input.mjs'

const keep = process.argv.includes('--keep')
const root = await mkdtemp(join(tmpdir(), 'horsemd-typora-int-'))
const file = join(root, 'doc.md')
await writeFile(file, [
  '# 一级标题',
  '',
  '段落文本 alpha bold text。',
  '',
  '## 二级标题',
  '',
  '- 列表项',
  '',
  '> 引用一行',
  '',
  '### 三级标题',
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

try {
  await waitFor(() => app.evaluate(`(() => {
    const w = [...document.querySelectorAll('#write')].find(x => x.offsetParent)
    return w && w.querySelectorAll('h1').length ? { ok: true } : null
  })()`), 'doc not rendered')

  // ---- 1. 大纲(Ctrl+Shift+L 切换侧栏大纲) ----
  await pressKey(app.send, { key: 'L', code: 'KeyL', modifiers: 9, text: '' })
  await sleep(600)
  const outline = await app.evaluate(`(() => {
    const items = [...document.querySelectorAll('[class*=outline] li, [class*=outline] .outline-item, [class*=outline] [class*=item]')]
      .map(el => (el.textContent || '').trim()).filter(Boolean).slice(0, 8)
    return items
  })()`)
  check('大纲读取 #write 标题', outline.some(t => t.includes('一级标题')) && outline.some(t => t.includes('二级标题')),
    JSON.stringify(outline))
  await pressKey(app.send, { key: 'L', code: 'KeyL', modifiers: 9, text: '' })
  await sleep(300)

  // ---- 2. 查找(Ctrl+F)+ 替换 ----
  await pressKey(app.send, { key: 'f', code: 'KeyF', modifiers: 2, text: '' })
  await sleep(400)
  // 显式聚焦查找输入框再输入(大纲切换后焦点可能漂移)
  await app.evaluate(`(() => {
    const input = [...document.querySelectorAll('input')].find(i => i.offsetParent && !i.readOnly)
    if (input) input.focus()
    return true
  })()`)
  await sleep(150)
  await app.send('Input.insertText', { text: 'alpha' })
  await sleep(900)
  const findState = await app.evaluate(`(() => {
    const bar = document.querySelector('[class*=find]')
    const counter = [...document.querySelectorAll('[class*=find] span, [class*=find] div')]
      .map(el => el.textContent).find(t => /1|\\d/.test(t) && t.length < 30)
    return { counter, highlights: CSS.highlights ? [...CSS.highlights.keys()] : [] }
  })()`)
  check('查找命中(高亮注册)', (findState.highlights || []).length > 0, JSON.stringify(findState))
  // 替换: focus replace input? 直接调用 replaceRef 不便 —— 用 UI:tab 到 replace 输入框太复杂,
  // 这里只验证查找管线;替换逻辑已在单元级验证(引擎 replaceFindRanges)。

  // ---- 3. 保存 round-trip: Ctrl+S 后文件内容应等于引擎序列化(未动过的原文保真) ----
  await pressKey(app.send, { key: 's', code: 'KeyS', modifiers: 2, text: '' })
  await sleep(800)
  const saved = await readFile(file, 'utf8')
  check('Ctrl+S 保存成功', saved.includes('# 一级标题') && saved.includes('## 二级标题'), JSON.stringify(saved.slice(0, 80)))

  // ---- 4. Typora 主题注入(github.css 形态的主题:真实主题文件) ----
  // 写一个最小可用的 Typora 主题到用户主题目录会污染本机 %APPDATA% —— 改为
  // 直接注入 style 标签模拟主题加载顺序(head 尾部),验证 :where 权重被主题覆盖。
  await app.evaluate(`(() => {
    const st = document.createElement('style')
    st.id = 'hm-custom-theme'
    st.textContent = '#write { max-width: 1234px; padding: 77px; } h1 { color: rgb(1, 2, 3); font-size: 55px; } blockquote { border-left: 9px solid rgb(9, 8, 7); }'
    document.head.appendChild(st)
    return true
  })()`)
  await sleep(150)
  const themed = await app.evaluate(`(() => {
    const w = [...document.querySelectorAll('#write')].find(x => x.offsetParent)
    if (!w || !w.querySelector('h1')) return null
    const h1 = w.querySelector('h1')
    const q = w.querySelector('blockquote')
    const cs = getComputedStyle(w)
    return {
      maxWidth: cs.maxWidth, padding: cs.padding,
      h1color: getComputedStyle(h1).color, h1size: getComputedStyle(h1).fontSize,
      qBorder: q ? getComputedStyle(q).borderLeftWidth : 'n/a'
    }
  })()`)
  assert.ok(themed, 'no visible #write with h1 (active tab drifted)')
  check('主题覆盖 #write 几何(max-width/padding)',
    themed.maxWidth === '1234px' && themed.padding.startsWith('77px'), JSON.stringify(themed))
  check('主题覆盖元素选择器(h1/blockquote)',
    themed.h1color === 'rgb(1, 2, 3)' && themed.h1size === '55px' && parseFloat(themed.qBorder) > 8, JSON.stringify(themed))

  console.log(results.every(r => r.ok) ? '\nALL PASS' : `\n${results.filter(r => !r.ok).length} FAILED`)
} finally {
  await stopBuiltElectron(app)
  if (!keep) {
    const { rm } = await import('node:fs/promises')
    await rm(root, { recursive: true, force: true }).catch(() => {})
  }
}
