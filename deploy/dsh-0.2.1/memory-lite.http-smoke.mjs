// Execute inside a running DSH container. Authentication stays in the container.
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
const base = 'http://127.0.0.1:3081'
const token = (await readFile('/tmp/dsh-web-token', 'utf8')).trim()
const auth = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
assert.equal(auth.status, 303)
const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
for (const encoding of ['identity', 'gzip']) {
  for (const method of ['memory-status/snapshot', 'memory-peers/snapshot']) {
    const response = await fetch(`${base}/api/${method}`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'accept-encoding': encoding },
      body: JSON.stringify({ type: 'client-request', rpcId: 'memory-smoke', method, payload: {} }),
    })
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.equal(result.result.ok, true)
    if (method === 'memory-status/snapshot') assert.equal(result.result.value.mode, 'incremental')
    console.log(`PASS ${encoding}: ${method}`)
  }
}
const unknown = await fetch(`${base}/api/nonexistent`, { headers: { cookie } })
assert.equal(unknown.status, 404)
await unknown.text()
const malformed = await fetch(`${base}/api/memory-status/snapshot`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{',
})
assert.equal(malformed.status, 400)
await malformed.text()
await assert.rejects(access('/opt/dsh-runtime/node_modules/@furongjun1999/dsh-memory'))
assert.match(await readFile('/data/dsh/.wenchang-release', 'utf8'), /profile=wenchang-community-021-v4/)
console.log('PASS errors return HTTP responses; legacy plugin absent; profile v4 active')
