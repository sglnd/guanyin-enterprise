import test from 'node:test'
import assert from 'node:assert/strict'
import { connectorView } from '../enterprise-plugin/lib/connectors.js'
import { compatibleProfileUpgrade, managedBundles } from '../profile-compat.mjs'
test('existing profiles retain custom bundles while enterprise policy follows managed plugins', () => {
  const enterprise = '@guanyin/dsh-enterprise'
  const result = managedBundles(['base', enterprise, 'custom'], ['base', 'skills', enterprise])
  assert.deepEqual(result, ['base', 'custom', 'skills', enterprise])
  assert.deepEqual(managedBundles(result, []), result)
})
test('only explicit rc2 -> rc3 profile upgrade is admitted', () => {
  const marker = v => `dsh=${v}\nprofile=guanyin-enterprise-021-v1\n`
  assert.equal(compatibleProfileUpgrade(marker('0.2.1-rc.2'), marker('0.2.1-rc.3')), true)
  for (const v of ['0.1.5-rc.2', '0.2.1-rc.1', '0.2.1-rc.4']) assert.equal(compatibleProfileUpgrade(marker(v), marker('0.2.1-rc.3')), false)
  assert.equal(compatibleProfileUpgrade(marker('0.2.1-rc.3'), marker('0.2.1-rc.2')), false)
})
test('connector view is read-only, redacts credentials, and does not equate tools to connectivity', () => {
  const entry = (id,config,disabled=false)=>({id,disabled,options:{name:'@deepseek-ai/dsh-mcp-client',config}})
  const result=connectorView([
    entry('include:guanyin-mcp-test',{serverName:'test',transport:'streamable-http',url:'https://user:pass@host.test/mcp?key=SECRET',headers:{Authorization:'secret'},env:{API_KEY:'secret'}}),
    entry('include:off',{serverName:'off',transport:'stdio',command:'private-command',args:['secret']},true),
    entry('include:empty',{serverName:'empty'}),
  ],[{name:'mcp__test__read',description:'Read only'},{name:'mcp__testing__unrelated'}])
  assert.equal(result.servers[0].endpoint,'https://host.test/mcp')
  assert.deepEqual(result.servers[0].tools,[{name:'read',description:'Read only'}])
  assert.deepEqual(result.servers.map(s=>s.status),['tools-registered','disabled','no-tools'])
  assert.doesNotMatch(JSON.stringify(result),/SECRET|Authorization|API_KEY|private-command|pass/)
})
