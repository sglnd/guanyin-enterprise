import { readFile, writeFile } from 'node:fs/promises'
const root = process.argv[2] || '/opt/dsh-runtime/node_modules/@alanzhao/dsh-memory-lite'
const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
if (manifest.version !== '0.5.1') throw new Error('Review memory-lite patches before upgrading')
for (const [file, from, to] of [
  ['lib/extract/index.js', 'const EXTRACTION_MAX_TOKENS = 32768;', 'const EXTRACTION_MAX_TOKENS = 4096;'],
  ['lib/client.js', 'const POLL_MS = 10000;', 'const POLL_MS = 30000;'],
]) {
  const path = `${root}/${file}`
  const text = await readFile(path, 'utf8')
  if (text.includes(to)) continue
  if (text.split(from).length !== 2) throw new Error(`memory-lite patch target changed: ${file}`)
  await writeFile(path, text.replace(from, to))
}
