import { readFileSync } from 'node:fs'
import { parseMarkdown } from '../src/renderer/src/typora-engine/parser.js'
import { docToMarkdownWithSpans } from '../src/renderer/src/typora-engine/serialize.js'

const corpus = readFileSync(new URL('./corpus.md', import.meta.url), 'utf8')
const docs = corpus.split('\n%%%\n')
let bad = 0
docs.forEach((d, di) => {
  const tree = parseMarkdown(d)
  const { md, spans } = docToMarkdownWithSpans(tree, {})
  for (const [block, span] of spans) {
    const region = md.slice(span.start, span.end)
    const firstLine = (block.text || '').split('\n')[0].trim()
    const regionFirst = region.split('\n')[0].replace(/^[ >\s]*/, '').trim()
    if (firstLine && !regionFirst.endsWith(firstLine)) {
      bad++
      console.log('BAD span doc', di, block.type, JSON.stringify(firstLine), '->', JSON.stringify(regionFirst))
    }
  }
})
console.log(bad === 0 ? 'ALL SPANS OK' : bad + ' BAD SPANS')
