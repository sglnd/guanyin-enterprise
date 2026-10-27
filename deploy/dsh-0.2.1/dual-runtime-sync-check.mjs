// Only run with the synthetic fixture and disposable containers on 19095/19096.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { managedMcpConfigMatches } from '../../control-plane/mcp-sync.mjs'
const token = process.env.GUANYIN_SYNC_TOKEN || 'guanyin-dual-sync-proof-only'
const versions = [['015', 19095], ['021', 19096]]
async function check([name, port]) {
  const base = `http://127.0.0.1:${port}`
  async function post(path, payload) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-guanyin-token': token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(Number(process.env.GUANYIN_SYNC_REQUEST_TIMEOUT_MS || 60000)) })
    const result = await r.json(); assert.equal(r.status, 200, JSON.stringify(result)); return result
  }
  async function mcp(method, payload = {}) {
    const result = await post('/__guanyin/mcp-manager/' + method, payload)
    assert.equal(result.result?.ok, true, JSON.stringify(result)); return result.result.value
  }
  async function rpc(method, payload) {
    const result = await post('/__guanyin/dsh-rpc/' + method, payload)
    assert.equal(result.result?.ok, true, JSON.stringify(result)); return result.result.value
  }
  for (const deadline = Date.now() + Number(process.env.GUANYIN_SYNC_STARTUP_TIMEOUT_MS || 240000); ; ) {
    try { await mcp('list'); break } catch (e) { if (Date.now() > deadline) throw e }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const provider = (mode, model = `probe-${mode}`) => ({ id: `guanyin-sync-${mode}`, ...(mode === 'none' ? { authMode: 'none' } : { credentialRef: 'GUANYIN_MODEL_ABCD', apiKey: 'synthetic-sync-key' }), config: { displayName: '合成同步验证', api: 'openai-completions', baseURL: `http://host.docker.internal:19094/${name}/v1`, models: [{ id: model, input: ['text'], contextWindow: 128000, maxTokens: 4096 }] } })
  const sync = async (providers, defaultModel) => {
    const result = await post('/__guanyin/models/sync', { providers, defaultModel })
    assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual([...result.providers].sort(), providers.map(p => p.id).sort())
  }
  const entry = { id: 'guanyin-mcp-sync-proof', config: { serverName: 'sync-proof', transport: 'streamable-http', url: `http://host.docker.internal:19094/${name}/mcp`, headers: { 'X-Sync-Probe': '1' } } }
  async function remove() {
    if ((await mcp('list')).servers.some(row => row.id === entry.id)) await mcp('remove', { id: entry.id })
    for (let i = 0; i < 60; i++) {
      if (!(await mcp('list')).servers.some(row => row.id === entry.id)) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw Error(`${name}: MCP removal did not settle`)
  }
  await sync([provider('none'), provider('key')], { provider: 'guanyin-sync-none', model: 'probe-none' })
  await remove()
  await mcp('add', entry)
  async function matched() {
    for (let i = 0; i < 60; i++) {
      const rows = (await mcp('list')).servers.filter(row => row.id === entry.id)
      if (rows.length === 1 && managedMcpConfigMatches(rows[0], entry.config)
        && (name !== '015' || rows[0].toolCount > 0)) return
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw Error(`${name}: MCP reload did not match`)
  }
  await matched()
  for (let i = 0; i < 60; i++) {
    if ((await (await fetch('http://127.0.0.1:19094/state')).json())[name].discovered > 0) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const prompt = async () => {
    const { sessionId } = await rpc('session/create', { request: { cwd: '/workspace' } })
    const result = await rpc('session/prompt', { request: { sessionId, requestId: randomUUID(), mode: 'queue', content: [{ type: 'text', text: 'Call sync_probe once, then reply with SYNC_MODEL_OK.' }] } })
    assert.ok(result)
    return sessionId
  }
  const first = await prompt()
  async function waitTool(count) {
    for (let i = 0; i < 120; i++) {
      const stats = (await (await fetch('http://127.0.0.1:19094/state')).json())[name]
      if (stats.toolCalls >= count && stats.auth.length >= count * 2) return stats
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    throw Error(`${name}: synchronized model did not invoke MCP tool`)
  }
  const noAuth = await waitTool(1); assert.ok(noAuth.auth.includes(null), 'No-key model did not run without Authorization')
  await remove()
  entry.config.headers['X-Sync-Probe'] = '2'; await mcp('add', entry); await matched()
  await sync([provider('none'), provider('key', 'probe-key-updated')], { provider: 'guanyin-sync-key', model: 'probe-key-updated' })
  const second = await prompt()
  const withAuth = await waitTool(2); assert.ok(withAuth.auth.includes('Bearer synthetic-sync-key'), 'Key model did not use the synchronized credential')
  await sync([provider('none')], { provider: 'guanyin-sync-none', model: 'probe-none' })
  await remove()
  for (let i = 0; i < 60; i++) {
    if (!(await mcp('list')).servers.some(row => row.id === entry.id)) break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  assert.ok(!(await mcp('list')).servers.some(row => row.id === entry.id))
  return { version: name, first, second, modelSync: true, modelUpdateAndRemoval: true, noKeyInvocation: true, keyedInvocation: true, mcpSyncAndUpdate: true, mcpToolExecuted: withAuth.toolCalls, mcpRemoval: true }
}
for (const target of versions.filter(([name]) => !process.argv[2] || process.argv[2] === name)) console.log(JSON.stringify(await check(target)))
