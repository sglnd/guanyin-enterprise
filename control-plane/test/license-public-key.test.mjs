import assert from 'node:assert/strict'
import test from 'node:test'
import { createPublicKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const publicKeyPath = new URL('../../assets/licensing/guanyin-license-public.pem', import.meta.url)
const manifestPaths = [
  new URL('../../deploy/kubernetes.yaml', import.meta.url),
  new URL('../../deploy/production/kubernetes.yaml', import.meta.url),
]

function manifestKey(source) {
  const match = source.match(/^\s*licensePublicKey:\s*\|\s*\n((?:\s{4}.+\n)+)/m)
  assert.ok(match, 'manifest must define licensePublicKey')
  return match[1].replace(/^\s{4}/gm, '')
}

test('enterprise manifests pin the canonical license verification public key', async () => {
  const publicKey = await readFile(publicKeyPath, 'utf8')
  assert.doesNotThrow(() => createPublicKey(publicKey))
  for (const path of manifestPaths) assert.equal(manifestKey(await readFile(path, 'utf8')), publicKey)
})
