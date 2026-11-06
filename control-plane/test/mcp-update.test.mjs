import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { gatewayMcpEntry, managedMcpConfigMatches } from '../mcp-sync.mjs'

const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8')
const service = { id: '12345678-1234-4234-8234-123456789abc', name: '测试 MCP', serverName: 'crm',
  url: 'https://example.test/mcp', enabled: true, allowedTools: ['read'], maxConcurrency: 2, requestsPerMinute: 30 }
const jobId = '22345678-1234-4234-8234-123456789abc'

test('MCP save returns before space sync and reports failed and sleeping spaces separately', async () => {
  let release, completed, savedInput
  const barrier = new Promise(resolve => { release = resolve })
  const calls = []
  const context = {
    user: { id: 'admin', role: 'platform_admin' }, randomUUID: () => jobId,
    MCP_GATEWAY_URL: 'http://gateway:8080', delay: () => barrier,
    bodyJson: async req => req.body, audit: async () => {}, clientIp: () => 'test',
    sendJson: (res, status, body) => ({ status, body }),
    applySpaceMcp: async (space, refreshId) => { calls.push([space.id, refreshId]); if (space.id === 'failed') throw Error('unreachable') },
    store: {
      mcpServerById: async () => service,
      updateMcpServer: async (id, input) => { savedInput = input; return { ...service, ...input } },
      listMcpSpaces: async () => [{ id: '015', version: '0.1.5-rc.2', status: 'running' },
        { id: '021', version: '0.2.1-rc.3', status: 'running' },
        { id: 'sleeping', status: 'stopped' }, { id: 'failed', name: '故障空间', status: 'running' }],
      createMcpSyncJob: async () => {},
      finishMcpSyncJob: async job => { completed = JSON.parse(JSON.stringify(job)) },
      mcpSyncJob: async () => completed,
    },
  }
  // Execute the real route and validator without starting the control plane or touching customer spaces.
  const validator = source.slice(source.indexOf('function mcpInput('), source.indexOf('\nfunction publicUser('))
  const routes = source.slice(source.indexOf('  const canManageMcp ='), source.indexOf("  if (mcpServer && req.method === 'DELETE')"))
  runInNewContext(`${validator}\nasync function handle(req,res,path) {${routes}\n}`, context)
  const result = await context.handle({ method: 'PATCH', body: { name: service.name, serverName: service.serverName,
    url: service.url, enabled: true } }, {}, `/api/mcp-servers/${service.id}`)
  assert.equal(result.status, 202)
  assert.equal(result.body.syncId, jobId)
  assert.deepEqual(calls, [])
  assert.equal(completed, undefined)
  assert.deepEqual(Array.from(savedInput.allowedTools), ['read'])
  assert.equal(savedInput.maxConcurrency, 2)
  assert.equal(savedInput.requestsPerMinute, 30)
  release()
  for (let count = 0; count < 20 && !completed; count++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, [['015', service.id], ['021', service.id], ['failed', service.id]])
  assert.equal(completed.status, 'error')
  assert.equal(completed.pendingSpaces, 1)
  assert.deepEqual(completed.failedSpaces, ['故障空间'])
  context.user.role = 'member'
  assert.equal((await context.handle({ method: 'GET' }, {}, `/api/mcp-sync/${jobId}`)).status, 403)
  assert.equal((await context.handle({ method: 'PATCH', body: {} }, {}, `/api/mcp-servers/${service.id}`)).status, 403)
  context.user.mcpAdmin = true
  assert.equal((await context.handle({ method: 'GET' }, {}, `/api/mcp-sync/${jobId}`)).body.status, 'error')
})

for (const version of ['0.1.5-rc.2', '0.2.1-rc.3']) {
  test(`${version} refreshes the changed MCP even when the gateway URL is unchanged`, async () => {
    const token = 'test-space-token', gateway = 'http://gateway:8080'
    const entry = gatewayMcpEntry(service, token, gateway)
    const other = gatewayMcpEntry({ ...service, id: 'other', serverName: 'other' }, token, gateway)
    const apiBuilder = { id: 'guanyin-mcp-api-builder', config: { serverName: 'guanyin-api-builder',
      transport: 'streamable-http', url: 'http://api-builder', headers: { 'X-Guanyin-Instance': 'space', 'X-Guanyin-Token': 'test-extension' } } }
    const rows = [entry, other, apiBuilder].map(item => version.startsWith('0.1.5') ? { id: item.id, ...item.config } : item)
    const changes = []
    const context = {
      store: { instanceById: async () => ({}), listSpaceMcpBindings: async () => [service, { ...service, id: 'other', serverName: 'other' }] },
      mcpResourceName: () => 'test-config', upsertResource: async () => {},
      NAMESPACE: 'test', MCP_GATEWAY_URL: gateway, API_BUILDER_MCP_URL: 'http://api-builder',
      k8sRequest: async () => ({ spec: { replicas: 1 } }), instanceExtensionToken: async () => 'test-extension',
      spaceMcpToken: async () => token, gatewayMcpEntry, managedMcpConfigMatches,
      callMcpManager: async (space, method, value) => { if (method === 'list') return { servers: rows }; changes.push([method, value.id]) },
      removeMcpEntries: async (space, id) => changes.push(['remove', id]), waitForMcpEntry: async () => {},
    }
    runInNewContext(source.slice(source.indexOf('async function reconcileSpaceMcp('), source.indexOf('\nasync function syncSpaceMcpWhenReady(')), context)
    await context.reconcileSpaceMcp({ id: 'space', slug: 'test', version }, service.id)
    assert.deepEqual(changes, [['remove', entry.id], ['add', entry.id]])
    changes.length = 0
    await context.reconcileSpaceMcp({ id: 'space', slug: 'test', version })
    assert.deepEqual(changes, [])
  })
}
