import { readFile, writeFile } from 'node:fs/promises'
const root = '/opt/dsh-runtime/node_modules/@earendil-works/pi-ai/dist/api'
async function replace(file, from, to) {
  const source = await readFile(file, 'utf8')
  if (source.split(from).length !== 2) throw new Error(`pi-ai no-auth patch target changed: ${file}`)
  await writeFile(file, source.replace(from, to))
}
// Managed routes without apiKeyEnv intentionally have no credentials. The
// SDK still requires a constructor string: use an internal marker and then
// explicitly omit Authorization at its header layer. Nothing is saved as a
// credential and the marker must never travel to the model server.
for (const api of ['openai-completions', 'openai-responses']) {
  const file = `${root}/${api}.js`
  await replace(file, 'function getClientApiKey(provider, apiKey, headers) {', 'const GUANYIN_NO_AUTH = Symbol("guanyin-no-auth");\nfunction getClientApiKey(provider, apiKey, headers) {')
  await replace(file,
    '    throw new Error(`No API key for provider: ${provider}`);',
    '    if (provider.startsWith("guanyin-")) return GUANYIN_NO_AUTH;\n    throw new Error(`No API key for provider: ${provider}`);')
  await replace(file, '    return new OpenAI({\n        apiKey,',
    '    if (apiKey === GUANYIN_NO_AUTH) { headers.Authorization = null; apiKey = "unused"; }\n    return new OpenAI({\n        apiKey,')
}
const anthropic = `${root}/anthropic-messages.js`
await replace(anthropic, '    if (!hasRequestAuth(apiKey, headers))', '    if (!provider.startsWith("guanyin-") && !hasRequestAuth(apiKey, headers))')
await replace(anthropic, '    const client = new PiAnthropic({\n        apiKey: apiKey ?? null,',
  '    if (model.provider.startsWith("guanyin-") && !hasRequestAuth(apiKey, defaultHeaders)) { defaultHeaders["x-api-key"] = null; defaultHeaders.Authorization = null; }\n    const client = new PiAnthropic({\n        apiKey: apiKey ?? null,')
