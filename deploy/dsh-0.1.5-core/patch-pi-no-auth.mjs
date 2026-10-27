// 0.1.5 OpenAI-compatible routes use the same SDK credential gate as 0.2.1.
// Only platform-managed providers without a supplied key use the marker;
// Authorization is explicitly omitted before constructing the SDK client.
import { readFile, writeFile } from 'node:fs/promises'
const root = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api'
for (const api of ['openai-completions', 'openai-responses']) {
  const file = `${root}/${api}.js`
  let source = await readFile(file, 'utf8')
  if (source.includes('Symbol("guanyin-no-auth")')) continue
  const replacements = [
    ['function getClientApiKey(provider, apiKey, headers) {', 'const GUANYIN_NO_AUTH = Symbol("guanyin-no-auth");\nfunction getClientApiKey(provider, apiKey, headers) {'],
    ['    throw new Error(`No API key for provider: ${provider}`);', '    if (provider.startsWith("guanyin-")) return GUANYIN_NO_AUTH;\n    throw new Error(`No API key for provider: ${provider}`);'],
    ['    return new OpenAI({\n        apiKey,', '    if (apiKey === GUANYIN_NO_AUTH) { headers.Authorization = null; apiKey = "unused"; }\n    return new OpenAI({\n        apiKey,'],
  ]
  for (const [from, to] of replacements) {
    if (source.split(from).length !== 2) throw new Error(`0.1.5 no-auth patch target changed: ${file}`)
    source = source.replace(from, to)
  }
  await writeFile(file, source)
}
