import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const key = 'guanyin-021-local-smoke-only'
let cookie = ''
let ready = false
const base = 'http://127.0.0.1:19093'
async function post(path, payload, internal = false) {
  const r = await fetch((internal ? 'http://127.0.0.1:19091' : base) + path, { method: 'POST', headers: { 'content-type': 'application/json', ...(internal ? { 'x-guanyin-token': key } : { cookie }) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(60000) })
  const text = await r.text()
  let body
  try { body = JSON.parse(text) } catch { throw new Error(`${path}: HTTP ${r.status}: ${text.slice(0, 300)}`) }
  assert.equal(r.status, 200, JSON.stringify(body))
  return body
}
// A local image import can compete with Chromium/Node for disk and CPU.
// Keep a bounded integration timeout without assuming a warm browser cache.
for (const deadline = Date.now() + 120000; Date.now() < deadline && !ready;) {
  try {
    const auth = await fetch(base, { headers: { accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(1500) })
    const cookies = auth.headers.getSetCookie()
    if (cookies.some(c => c.startsWith('dsh-auth-'))) cookie = cookies.map(c => c.split(';')[0]).join('; ')
    ready = Boolean(cookie) || (auth.status === 200 && auth.headers.get('content-type')?.includes('text/html'))
  } catch {}
  if (!ready) await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(ready, 'DSH did not become ready for authentication')
const initialState = await (await fetch('http://127.0.0.1:19092/state')).json()
const models = await post('/__guanyin/models/sync', {
  providers: [{ id: 'guanyin-smoke', authMode: 'none', config: { displayName: '本地验证模型', api: 'openai-completions', baseURL: 'http://host.docker.internal:19092/v1', models: [{ id: 'gy-smoke', contextWindow: 128000, maxTokens: 4096, input: ['text'] }] } }],
  defaultModel: { provider: 'guanyin-smoke', model: 'gy-smoke' },
}, true)
assert.equal(models.ok, true)
const mcp = await post('/__guanyin/mcp-manager/list', {}, true)
assert.equal(mcp.result?.ok, true, JSON.stringify(mcp))
const method = 'workspace/initializeDefault'
const initialized = await post('/api/' + method, { type: 'client-request', rpcId: randomUUID(), method, payload: { args: {} } })
assert.equal(initialized.result?.value?.workspace?.path, '/workspace', JSON.stringify(initialized))
const create = await post('/__guanyin/dsh-rpc/session/create', { request: { cwd: '/workspace', workspaceId: initialized.result.value.workspace.id } }, true)
assert.equal(create.result?.ok, true, JSON.stringify(create))
const sessionId = create.result.value.sessionId
assert.ok(sessionId)
const requestId = randomUUID()
const prompt = await post('/api/session/prompt', { type: 'client-request', rpcId: randomUUID(), method: 'session/prompt', payload: { args: { request: { sessionId, requestId, mode: 'queue', content: [{ type: 'text', text: 'BROWSER_SMOKE: open the test browser page.' }] } } } })
assert.equal(prompt.result?.ok, true, JSON.stringify(prompt))
let state
for (const deadline = Date.now() + 180000; Date.now() < deadline;) {
  state = await (await fetch('http://127.0.0.1:19092/state')).json()
  const calls = state.usage.filter(e => e.requestId === requestId)
  if (state.browserVisits > initialState.browserVisits && calls.filter(e => e.result === 'success').length >= 2) break
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.equal(state.unexpectedAuth, 0, 'Unauthenticated model received an Authorization header')
assert.ok(state.browserVisits > initialState.browserVisits, 'Browser never reached the test page')
const calls = state.usage.filter(e => e.requestId === requestId)
assert.ok(calls.filter(e => e.result === 'success' && e.totalTokens === 120 && e.userId === '11111111-1111-4111-8111-111111111111').length >= 2, JSON.stringify(calls))
console.log(JSON.stringify({ sessionId, requestId, modelSync: true, mcpContract: true, workspaceDirectory: '/workspace', browserVerified: true, authorizationAbsent: true, usageReported: true, attributedModelCalls: calls.length }))
