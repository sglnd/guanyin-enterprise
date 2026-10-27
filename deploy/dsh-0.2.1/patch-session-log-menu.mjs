import { readFile, writeFile } from 'node:fs/promises'
const file = '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-session-log-export/lib/client.js'
const before = 'const feedbackAvailable = useFeedbackAvailable((value) => value);'
const after = 'const feedbackAvailable = false; // guanyin: export menu keeps download only'
const source = await readFile(file, 'utf8')
if (source.includes(after) && !source.includes(before)) process.exit(0)
if (source.split(before).length !== 2) throw new Error('rc3 session log menu changed; review the feedback entry before upgrading')
await writeFile(file, source.replace(before, after))
