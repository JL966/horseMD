// parse(serialize(parse(md))) 结构稳定性冒烟测试
import { readFileSync } from 'node:fs'
import { parseMarkdown } from '../src/renderer/src/typora-engine/parser.js'
import { docToMarkdown } from '../src/renderer/src/typora-engine/serialize.js'

const corpus = readFileSync(new URL('./corpus.md', import.meta.url), 'utf8')
const docs = corpus.split('\n%%%\n')
let unstable = 0
docs.forEach((d, di) => {
  const t1 = parseMarkdown(d)
  const md1 = docToMarkdown(t1, {})
  const t2 = parseMarkdown(md1)
  const md2 = docToMarkdown(t2, {})
  if (md1 !== md2) {
    unstable++
    console.log('UNSTABLE doc', di)
    console.log('  pass1:', JSON.stringify(md1.slice(0, 200)))
    console.log('  pass2:', JSON.stringify(md2.slice(0, 200)))
  } else {
    // 结构对比: 类型序列一致
    const types = (t) => { const out = []; t.walk(b => out.push(b.type + (b.attrs.depth || ''))); return out.join(',') }
    if (types(t1) !== types(t2)) { unstable++; console.log('STRUCT DIFF doc', di) }
  }
})
console.log(unstable === 0 ? 'ROUNDTRIP STABLE' : unstable + ' UNSTABLE DOCS')
