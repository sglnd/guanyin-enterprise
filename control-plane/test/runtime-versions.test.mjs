import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeVersions, versionForCreation, imageForSpace } from '../runtime-versions.mjs'

test('two versions create distinct spaces without changing existing image pins', () => {
  const catalog = runtimeVersions({ defaultVersion: '0.1.5', defaultImage: 'gy:015', additional: JSON.stringify([{ id: '0.2.1', image: 'gy:021' }]) })
  assert.equal(versionForCreation(catalog, '0.1.5').image, 'gy:015')
  assert.equal(versionForCreation(catalog, '0.2.1').image, 'gy:021')
  assert.equal(imageForSpace({ version: '0.1.5', image: 'gy:015-pinned' }, catalog), 'gy:015-pinned')
  assert.equal(imageForSpace({ version: '0.1.5' }, catalog), 'gy:015')
  assert.throws(() => versionForCreation(catalog, 'unknown'))
})
test('disabled versions cannot be created but their existing spaces still restart', () => {
  const catalog = runtimeVersions({ defaultVersion: '0.1.5', defaultImage: 'gy:015', additional: '[{"id":"0.2.1","image":"gy:021","enabled":false}]' })
  assert.throws(() => versionForCreation(catalog, '0.2.1'))
  assert.equal(imageForSpace({ version: '0.2.1', image: 'gy:021' }, catalog), 'gy:021')
  assert.throws(() => imageForSpace({ version: 'missing' }, catalog))
  assert.throws(() => runtimeVersions({ defaultVersion: '0.1.5', defaultImage: 'gy:015', additional: '[{"id":"0.1.5","image":"gy:other"}]' }))
})

test('creation defaults to rc3 while retaining a separately pinned rc2 choice', () => {
  const catalog = runtimeVersions({ defaultVersion: '0.2.1-rc.3-gy.ent.7', defaultImage: 'gy:021', additional: '[{"id":"0.1.5-rc.2-gy.ent.8","image":"gy:015"}]' })
  assert.deepEqual(catalog.map(row => row.label), ['0.2.1-rc3', '0.1.5-rc2'])
  assert.equal(versionForCreation(catalog, catalog[0].id).image, 'gy:021')
  assert.equal(versionForCreation(catalog, catalog[1].id).image, 'gy:015')
  assert.equal(imageForSpace({ version: '0.1.5-rc.2-gy.ent.8', image: 'gy:015-original' }, catalog), 'gy:015-original')
})
