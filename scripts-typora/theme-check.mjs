// Typora 主题兼容性验证:注入真实 Typora 主题 CSS(工作区分析副本),
// 验证 #write 契约命中 + 视觉渲染,输出截图。
// Run: node scripts-typora/theme-check.mjs <theme.css路径> [输出截图名]
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchBuiltElectron, stopBuiltElectron } from '../scripts/lib/electron-test-app.mjs'
import { sleep } from '../scripts/lib/cdp.mjs'

const themePath = process.argv[2] || 'C:/Users/long/.zcode/workspace/864eac9c-d333-46b2-90b1-39a965e723f9/typora-analysis/theme-samples/github.css'
const shotName = process.argv[3] || 'theme-github.png'

const themeCss = await readFile(themePath, 'utf8')
const root = await mkdtemp(join(tmpdir(), 'horsemd-typora-theme-'))
const file = join(root, 'rich.md')
await writeFile(file, [
  '# Typora 主题兼容验证',
  '',
  '这是一段普通段落,包含 **加粗文字**、*斜体*、`行内代码` 与 [链接](https://example.com)。',
  '',
  '## 二级标题',
  '',
  '> 引用块:Typora 的 github 主题会给引用不同的左边条与颜色。',
  '',
  '- 无序列表项甲',
  '- 无序列表项乙',
  '- [ ] 待办任务',
  '- [x] 已完成任务',
  '',
  '1. 有序第一项',
  '2. 有序第二项',
  '',
  '```js',
  'const greet = (name) => {',
  '  return `hello ${name}`',
  '}',
  '```',
  '',
  '| 功能 | 状态 | 备注 |',
  '| :--- | :---: | ---: |',
  '| 表格 | 可用 | 列对齐 |',
  '| 任务 | 可用 | 真实 checkbox |',
  '',
  '---',
  '',
  '末段文字。'
].join('\n'), 'utf8')

const port = 28000 + (process.pid % 500)
const app = await launchBuiltElectron({
  profileDir: join(root, 'profile'), cleanProfile: false, port, appArgs: [file]
})
try {
  await sleep(2500)
  // 以 customThemes.applyCustomTheme 的同款方式注入主题(head 尾部,#hm-custom-theme)
  await app.evaluate(`((css) => {
    let st = document.getElementById('hm-custom-theme')
    if (!st) {
      st = document.createElement('style')
      st.id = 'hm-custom-theme'
      document.head.appendChild(st)
    }
    st.textContent = css
    document.body.classList.add('hm-has-custom-theme')
    return true
  })(${JSON.stringify(themeCss)})`)
  await sleep(500)
  const metrics = await app.evaluate(`(() => {
    const w = [...document.querySelectorAll('#write')].find(x => x.offsetParent)
    if (!w) return null
    const cs = getComputedStyle(w)
    const h1 = w.querySelector('h1')
    const bq = w.querySelector('blockquote')
    return {
      writeMaxWidth: cs.maxWidth,
      writeBg: cs.backgroundColor,
      h1Font: getComputedStyle(h1).fontFamily.slice(0, 60),
      h1Border: getComputedStyle(h1).borderBottomWidth,
      quoteBorder: bq ? getComputedStyle(bq).borderLeftColor : null,
      themeStylePresent: !!document.getElementById('hm-custom-theme'),
      metaHidden: [...w.querySelectorAll('.md-meta')].every(m => getComputedStyle(m).display === 'none')
    }
  })()`)
  console.log('metrics:', JSON.stringify(metrics, null, 1))
  assert.ok(metrics, 'no visible #write')
  assert.ok(metrics.themeStylePresent, 'theme style missing')
  assert.ok(metrics.metaHidden, 'md-meta visible under theme')
  const shot = await app.send('Page.captureScreenshot', { format: 'png' })
  const data = shot?.data || shot?.result?.data
  if (data) {
    const out = join(process.cwd(), 'scripts-typora', shotName)
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(out, Buffer.from(data, 'base64'))
    console.log('截图:', out)
  }
  console.log('THEME OK')
} finally {
  await stopBuiltElectron(app)
  const { rm } = await import('node:fs/promises')
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
