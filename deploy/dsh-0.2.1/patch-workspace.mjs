import { readFile, writeFile } from 'node:fs/promises'
const file = '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-api-workspace-controller/lib/index.js'
const source = await readFile(file, 'utf8')
const from = 'return paths.join(directory, "deepseek-harness", DEFAULT_WORKSPACE_DIRECTORY);'
const to = 'return directory; // Guanyin: the mounted workspace is the default directory.'
if (source.includes(to)) process.exit(0)
if (source.split(from).length !== 2) throw new Error('Workspace initialization contract changed')
await writeFile(file, source.replace(from, to))
