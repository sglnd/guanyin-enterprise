import test from 'node:test'
import assert from 'node:assert/strict'
import { spaceListOptions, userListOptions, removeSpaceResources } from '../space-admin.mjs'

test('pagination validates boundaries, status, role and tenant filters', () => {
  assert.equal(spaceListOptions(new URLSearchParams()).pageSize, 20)
  assert.equal(userListOptions(new URLSearchParams('status=false&role=member&page=2')).status, 'false')
  for (const query of ['page=-1','page=1.2','pageSize=101','pageSize=0','status=unknown']) assert.throws(() => spaceListOptions(new URLSearchParams(query)))
  for (const query of ['role=admin','tenantId=invalid','status=enabled']) assert.throws(() => userListOptions(new URLSearchParams(query)))
})

test('space removal waits for deployment termination and NEVER deletes PVCs', async () => {
  const calls = [], missing = Object.assign(new Error('missing'), { statusCode: 404 })
  let polls = 0
  await removeSpaceResources({ slug: 'test' }, { namespace: 'test-instances', delay: async () => {}, request: async (method, path) => {
    calls.push([method, path])
    if (method === 'GET' && ++polls > 1) throw missing
  } })
  assert.equal(calls.filter(([method]) => method === 'DELETE').length, 4)
  assert.equal(calls.some(([,path]) => path.includes('persistentvolumeclaims')), false)
  assert.equal(calls[0][1].endsWith('/deployments/dsh-test'), true)
  assert.equal(calls[3][1].endsWith('/services/dsh-test'), true)
})

test('resource deletion is retryable after partial cleanup and rejects real API failures', async () => {
  await removeSpaceResources({ slug: 'test' }, { namespace: 'test', request: async () => { throw Object.assign(new Error('missing'), { statusCode: 404 }) } })
  await assert.rejects(removeSpaceResources({ slug: 'test' }, { namespace: 'test', request: async () => { throw Object.assign(new Error('forbidden'), { statusCode: 403 }) } }), /forbidden/)
  await assert.rejects(removeSpaceResources({ slug: 'test' }, { namespace: 'test', delay: async () => {}, request: async () => ({}) }), /仍在删除中/)
})
