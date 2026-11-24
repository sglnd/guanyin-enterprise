import test from 'node:test'
import assert from 'node:assert/strict'
import { compatibleProfileUpgrade, managedBundles, withoutLegacyMemory } from './profile-compat.mjs'

const marker = v => `dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v${v}\n`
test('only supported enterprise profiles upgrade to memory-lite; rollback is rejected', () => {
  for (const v of [1, 2]) assert.equal(compatibleProfileUpgrade(marker(v), marker(3)), true)
  assert.equal(compatibleProfileUpgrade(marker(3), marker(2)), false)
  assert.equal(compatibleProfileUpgrade('dsh=0.1.5\n', marker(2)), false)
  assert.equal(compatibleProfileUpgrade(undefined, marker(2)), false)
})
test('replacement removes Lingshu, preserves custom bundles and policy ordering', () => {
  const old = ['@guanyin/dsh-enterprise', 'custom', '@furongjun1999/dsh-memory']
  const next = managedBundles(old, ['@alanzhao/dsh-memory-lite'])
  assert.deepEqual(next, ['custom', '@alanzhao/dsh-memory-lite', '@guanyin/dsh-enterprise'])
  assert.deepEqual(managedBundles(next, ['@alanzhao/dsh-memory-lite']), next)
  assert.ok(managedBundles(old, []).includes('@furongjun1999/dsh-memory'))
})
test('legacy composition rows are removed without changing other config', () => {
  const custom = { id: 'custom', config: { nested: { name: '@furongjun1999/dsh-memory' } } }
  const rows = [custom, { insert: [{ id: 'furongjun1999-dsh-memory' }, { name: 'keep' }] }, { name: '@furongjun1999/dsh-memory' }]
  assert.deepEqual(withoutLegacyMemory(rows), [custom, { insert: [{ name: 'keep' }] }])
  assert.deepEqual(withoutLegacyMemory([{ insert: [{ id: 'furongjun1999-dsh-memory' }] }]), [])
  assert.equal(rows.length, 3)
})
