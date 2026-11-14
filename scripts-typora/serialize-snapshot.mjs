// Snapshot docToMarkdown outputs for a corpus (used to verify the Writer
// rewrite keeps serialization byte-identical). Run: node scripts-typora/serialize-snapshot.mjs out.json
import { readFileSync, writeFileSync } from 'node:fs'
import { parseMarkdown } from '../src/renderer/src/typora-engine/parser.js'
import { docToMarkdown } from '../src/renderer/src/typora-engine/serialize.js'

const corpus = readFileSync(new URL('./corpus.md', import.meta.url), 'utf8')
const docs = corpus.split('\n%%%\n')
const out = docs.map((d, i) => {
  const tree = parseMarkdown(d)
  return docToMarkdown(tree, { headingStyle: 1, ulStyle: '-', olStyle: '.' })
})
writeFileSync(process.argv[2], JSON.stringify(out), 'utf8')
console.log('docs:', out.length, 'total:', out.reduce((a, b) => a + b.length, 0))
