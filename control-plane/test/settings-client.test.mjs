import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import vm from 'node:vm'

test('production settings require a verified enterprise workspace identity; loopback still works', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guanyin-enterprise-settings-'))
  try {
    const file = join(dir, 'client.js')
    await writeFile(file, 'function apply(ctx) { const persistence = ctx.remote.$host.isLoopback ? "host" : "memory"; return persistence; }')
    execFileSync(process.execPath, [new URL('../../deploy/dsh-enterprise/patch-settings-client.mjs', import.meta.url).pathname, file])
    const patched = await readFile(file, 'utf8')
    const mode = async (isLoopback, response) => {
      const context = vm.createContext({ fetch: async () => {
        if (response instanceof Error) throw response
        return { ok: response.ok, json: async () => response.identity }
      } })
      vm.runInContext(patched, context)
      return context.apply({ remote: { $host: { isLoopback } } })
    }
    assert.equal(await mode(false, { ok: true, identity: { user: { id: 'user' }, space: { id: 'space' } } }), 'host')
    assert.equal(await mode(false, { ok: false }), 'memory')
    assert.equal(await mode(false, { ok: true, identity: {} }), 'memory')
    assert.equal(await mode(false, new Error('network failure')), 'memory')
    assert.equal(await mode(true, new Error('no control plane')), 'host')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
