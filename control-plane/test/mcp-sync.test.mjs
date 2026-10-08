import test from 'node:test'
import assert from 'node:assert/strict'
import { managedMcpConfigMatches } from '../mcp-sync.mjs'

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
