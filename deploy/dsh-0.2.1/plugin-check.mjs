// Only run against test-fixture.mjs + an isolated, disposable test container.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
const base = 'http://127.0.0.1:19093'
const browserHeaders = { origin: base, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'gzip, deflate, br, zstd' }
async function rpc(method, args) {
  const r = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(60000) })
  assert.equal(r.status, 200)
  const result = (await r.json()).result
  assert.equal(result?.ok, true, JSON.stringify(result?.error))
  return result.value
}
const workspace = await rpc('workspace/initializeDefault', {})
const { sessionId } = await rpc('session/create', { request: { cwd: '/workspace', workspaceId: workspace.workspace.id } })
const fileName = '观因-rc3-传输验证.txt'
const bytes = Buffer.from('观因 rc3 文件管理验证。仅合成测试数据。\n'.repeat(1000))
const query = new URLSearchParams({ sessionId, path: '', name: fileName })
const upload = await fetch(`${base}/dsh-file-share/api/upload?${query}`, { method: 'POST', headers: browserHeaders, body: bytes })
assert.equal(upload.status, 201, await upload.text())
const download = await fetch(`${base}/dsh-file-share/api/download?${new URLSearchParams({ sessionId, path: fileName })}`, { headers: browserHeaders })
assert.equal(download.status, 200)
assert.match(download.headers.get('content-disposition'), /attachment/)
assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes)
const zip = await fetch(`${base}/dsh-file-share/api/download-zip?${new URLSearchParams({ sessionId, path: fileName })}`, { headers: browserHeaders })
assert.equal(zip.status, 200)
assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK')
const traversal = await fetch(`${base}/dsh-file-share/api/download?${new URLSearchParams({ sessionId, path: '../etc/passwd' })}`, { headers: browserHeaders })
assert.ok(traversal.status >= 400)
const state = await fetch(`${base}/api/dsh-skills-manager/state`, { headers: browserHeaders })
assert.equal(state.status, 200)
const skillState = await state.json()
assert.notEqual(skillState.ok, false, JSON.stringify(skillState))
const skillName = `gy-rc3-test-${Date.now()}`
const createdSkill = await fetch(`${base}/api/dsh-skills-manager/create`, {
  method: 'POST', headers: { ...browserHeaders, 'content-type': 'application/json', 'x-dsh-skills-manager': '1' },
  body: JSON.stringify({ name: skillName, root: 'dsh', description: 'Synthetic integration test', body: 'Only synthetic fixture data is used.' }),
})
assert.equal(createdSkill.status, 200)
assert.equal((await createdSkill.json()).ok, true)
const catalog = await rpc('skills/list', { request: { sessionId } })
assert.ok(JSON.stringify(catalog).includes(skillName), 'Created skill missing from native catalog')
const update = await fetch(`${base}/api/dsh-skills-manager/online-update`, { headers: browserHeaders })
assert.equal(update.status, 200)
const updateState = await update.json()
assert.equal(updateState.data?.locked, true, JSON.stringify(updateState))
const connectors = await fetch(`${base}/__guanyin/connectors`, { headers: browserHeaders })
assert.equal(connectors.status, 200, await connectors.clone().text())
assert.ok(Array.isArray((await connectors.json()).servers))
assert.equal((await fetch('http://127.0.0.1:19091/__guanyin/connectors')).status, 401)
console.log(JSON.stringify({ sessionId, uploadDownloadBytesEqual: true, zip: true, traversalRejected: true, skillsState: true, skillCreateAndDiscovery: true, pluginUpdaterLocked: true, connectorsReadOnly: true }))
