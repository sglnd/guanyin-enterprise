import test from 'node:test'
import assert from 'node:assert/strict'
import { gatewayMcpEntry, managedMcpConfigMatches } from '../mcp-sync.mjs'

const config = { serverName: 'itsm-prd', transport: 'streamable-http', url: 'http://example.test/mcp', headers: { Authorization: 'test', Accept: 'application/json' } }
test('MCP Manager flat rows match without repeated removal and re-addition', () => {
  assert.equal(managedMcpConfigMatches({ ...config, id: 'guanyin-mcp-itsm-prd', enabled: true, toolCount: 2, fiberPhase: 'active' }, config), true)
})
test('header order and optional manager fields do not trigger reconciliation', () => {
  assert.equal(managedMcpConfigMatches({ ...config, headers: { Accept: 'application/json', Authorization: 'test' }, command: undefined }, config), true)
})
test('changed URLs, disabled entries and removed secrets require reconciliation', () => {
  assert.equal(managedMcpConfigMatches({ ...config, url: 'http://other.test/mcp' }, config), false)
  assert.equal(managedMcpConfigMatches({ ...config, enabled: false }, config), false)
  const { headers, ...withoutHeaders } = config
  assert.equal(managedMcpConfigMatches(config, withoutHeaders), false)
  assert.equal(managedMcpConfigMatches(withoutHeaders, withoutHeaders), true)
})

test('gateway registration uses a DSH-compatible stable UUID and never distributes upstream credentials', () => {
  const item = { id: '12345678-1234-4234-8234-123456789abc', serverName: 'CRM_test', url: 'https://upstream/private', headers: { Authorization: 'upstream-secret' } }
  const entry = gatewayMcpEntry(item, 'space-token', 'http://gateway:8080/')
  assert.match(entry.id, /^guanyin-mcp-[a-z0-9-]{1,80}$/)
  assert.equal(entry.id, gatewayMcpEntry({ ...item, serverName: 'renamed' }, 'space-token', 'http://gateway:8080').id)
  assert.equal(entry.config.url, 'http://gateway:8080/mcp/' + item.id)
  assert.equal(entry.config.serverName, 'CRM_test')
  assert.deepEqual(entry.config.headers, { Authorization: 'Bearer space-token' })
  assert.ok(!JSON.stringify(entry).includes('upstream-secret'))
})
