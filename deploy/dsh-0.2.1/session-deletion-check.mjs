// Destructive checks run ONLY against the disposable local fixture/container.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const base = 'http://127.0.0.1:19093'
const headers = { origin: base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', 'x-guanyin-action': 'session-delete' }
async function rpc(method, args) {
  const r = await fetch(`${base}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) })
  assert.equal(r.status, 200)
  const result = (await r.json()).result
  assert.equal(result?.ok, true, JSON.stringify(result?.error)); return result.value
}
async function action(method, body, overrides = {}) {
  const r = await fetch(`${base}/__guanyin/sessions/${method}`, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) })
  return { status: r.status, data: await r.json().catch(() => ({})) }
}
let ready = false
for (let i = 0; i < 90; i++) {
  try { const r = await fetch(`${base}/__guanyin/identity`); if (r.ok) { const list = await rpc('session/list', { _request: {} }); ready = !!list; if (ready) break } } catch {}
  await new Promise(resolve => setTimeout(resolve, 500))
}
assert.ok(ready, 'fixture did not start')
const sync = await fetch('http://127.0.0.1:19091/__guanyin/models/sync', { method: 'POST', headers: { 'content-type': 'application/json', 'x-guanyin-token': 'guanyin-021-local-smoke-only' }, body: JSON.stringify({ providers: [{ id: 'guanyin-smoke', authMode: 'none', config: { displayName: '本地验证模型', api: 'openai-completions', baseURL: 'http://host.docker.internal:19092/v1', models: [{ id: 'gy-smoke', contextWindow: 128000, maxTokens: 4096, input: ['text'] }] } }], defaultModel: { provider: 'guanyin-smoke', model: 'gy-smoke' } }) })
assert.equal(sync.status, 200)
const workspace = (await rpc('workspace/initializeDefault', {})).workspace
const create = () => rpc('session/create', { request: { cwd: '/workspace', workspaceId: workspace.id } })
const target = (await create()).sessionId, keep = (await create()).sessionId
assert.equal((await fetch('http://127.0.0.1:19091/__guanyin/sessions/prepare', { method: 'POST', headers, body: JSON.stringify({ sessionId: target }) })).status, 401)
assert.equal((await action('prepare', { sessionId: target }, { 'sec-fetch-site': 'cross-site' })).status, 403)
assert.equal((await action('prepare', { sessionId: target }, { origin: 'broken-origin' })).status, 403)
assert.equal((await action('delete', { sessionId: target })).status, 400)
const plan = await action('prepare', { sessionId: target }); assert.equal(plan.status, 200, JSON.stringify(plan))
const deleted = await action('delete', { sessionId: target, confirmation: plan.data.confirmation }); assert.equal(deleted.status, 200, JSON.stringify(deleted))
assert.equal(deleted.data.deleted, true)
const list = await rpc('session/list', { _request: {} })
assert.ok(!list.items.some(item => item.sessionId === target), 'deleted session remained in native list')
assert.ok(list.items.some(item => item.sessionId === keep), 'neighbor session disappeared')
const restored = await rpc('workspace/initializeDefault', {})
assert.ok(!JSON.stringify(restored).includes(target), 'deleted identity remained in workspace index')
assert.equal((await action('delete', { sessionId: target, confirmation: plan.data.confirmation })).status, 400)
assert.equal((await action('prepare', { sessionId: target })).status, 404)
await rpc('workspace/archiveSession', { request: { sessionId: keep } })
const archivedPlan = await action('prepare', { sessionId: keep }); assert.equal(archivedPlan.status, 200, JSON.stringify(archivedPlan))
const archivedDeleted = await action('delete', { sessionId: keep, confirmation: archivedPlan.data.confirmation }); assert.equal(archivedDeleted.status, 200, JSON.stringify(archivedDeleted))
assert.ok(!JSON.stringify(await rpc('workspace/initializeDefault', {})).includes(keep))
const ui = (await create()).sessionId
console.log(JSON.stringify({ target, keep, uiSessionId: ui, nativeListUpdated: true, indexesCleaned: true, archivedDeletion: true, replayRejected: true, authenticationAndCsrf: true }))
