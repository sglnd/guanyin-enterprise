import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv[2] || '/opt/dsh-runtime/node_modules/dsh-context/lib/client.js'
const source = await readFile(file, 'utf8')
const registration = /\(\)=>[\w$]+\.insightsEntry\(\)===`show`(?=,\(\)=>\[[\w$]+\.slots\.inject\(`main`)/g
const patched = source.replace(registration, '()=>false/* guanyin: hide global context insights */')
if (patched === source) {
  if (!source.includes('/* guanyin: hide global context insights */')) throw new Error('DSH Context Insights registration changed')
} else {
  await writeFile(file, patched)
}
