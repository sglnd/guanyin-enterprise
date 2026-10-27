// Run only against test-fixture.mjs and an isolated test container.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
const base = 'http://127.0.0.1:19093'
const headers = { 'accept-encoding': 'gzip, deflate, br, zstd', 'origin': base, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', cookie: 'dsh-auth-web=another-space; guanyin-dsh-session=another-space' }
async function rpc(method, args = {}) {
  const r = await fetch(`${base}/api/${method}`, { method: 'POST', headers, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(60000) })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /application\/json/)
  const data = await r.json()
  assert.equal(data.result?.ok, true, JSON.stringify(data.result?.error))
  return data.result.value
}
const presets = await rpc('agentPresets/list')
assert.ok(presets.presets.some(p => p.id === 'standard'))
const settings = await rpc('settings/describe')
assert.equal(settings.writable, true)
const workspace = await rpc('workspace/initializeDefault')
const created = await rpc('session/create', { request: { cwd: '/workspace', workspaceId: workspace.workspace.id } })
const sessionId = created.sessionId
assert.ok(sessionId)
const bytes = await readFile(process.argv[2] || '/tmp/guanyin021-upload-test.docx')
for (const [name, body] of [['观因上传验证.docx', bytes], ['大文件验证.txt', Buffer.alloc(2 * 1024 * 1024, 'A')]]) {
  const r = await fetch(`${base}/api/session/uploadFileBinary?${new URLSearchParams({ sessionId, name })}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body, signal: AbortSignal.timeout(60000) })
  assert.equal(r.status, 200)
  assert.match(r.headers.get('content-type'), /application\/json/)
  const result = await r.json()
  assert.equal(result.ok, true, JSON.stringify(result.error))
  assert.ok(result.value.receiptId)
}
// Early streaming rejection must remain a complete JSON response, not 502.
const rejected = await fetch(`${base}/api/session/uploadFileBinary?${new URLSearchParams({ sessionId: `session-${randomUUID()}`, name: 'missing-session.txt' })}`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(2 * 1024 * 1024, 'A'), signal: AbortSignal.timeout(60000),
})
assert.equal(rejected.status, 200, await rejected.clone().text())
assert.equal((await rejected.json()).ok, false)
const denied = await fetch('http://127.0.0.1:19091/api/agentPresets/list', { method: 'POST', headers: { ...headers, 'x-guanyin-identity': 'invalid.signature.token' }, body: '{}' })
assert.equal(denied.status, 401)
console.log(JSON.stringify({ wrongBrowserCookieIgnored: true, agentPresets: true, docxUpload: true, largeBinaryUpload: true, invalidIdentityRejected: true, settingsWritable: true, sessionId }))
