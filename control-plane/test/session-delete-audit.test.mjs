import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { auditSessionDelete } from '../session-delete-audit.mjs'
const input = { sessionId: 'session-test', confirmation: 'private-confirmation' }
function req(path = '/__guanyin/sessions/delete', body = JSON.stringify(input)) {
  return Object.assign(Readable.from([Buffer.from(body)]), { method: 'POST', url: path, headers: {} })
}
const identity = { user: { id: 'real-user', displayName: '测试用户' }, instance: { id: 'real-space', version: '0.2.1', name: '测试空间' } }
test('only submitted deletion is recorded; prepare/view requests remain untouched', async () => {
  for (const path of ['/__guanyin/sessions/prepare', '/api/session/get', '/api/session/prompt']) {
    const r = req(path)
    assert.equal(await auditSessionDelete(r, { save: () => assert.fail() }), undefined)
    assert.equal(r.readableEnded, false)
  }
})
test('audit persists before deletion; result updates the same record without retaining confirmation', async () => {
  for (const [status, expected] of [[200, 'succeeded'], [409, 'failed'], [503, 'unknown'], [undefined, 'unknown']]) {
    let saved, completions = 0
    const audit = await auditSessionDelete(req(), { ...identity, save: async entry => { saved = entry }, complete: async (id, details) => {
      assert.equal(id, saved.id); completions++; Object.assign(saved.details, details)
    } })
    assert.equal(saved.action, 'session_delete'); assert.equal(saved.actorUserId, 'real-user')
    assert.equal(saved.details.deletionStatus, 'submitted'); assert.equal(saved.details.sessionId, input.sessionId)
    assert.ok(!JSON.stringify(saved).includes(input.confirmation))
    assert.equal(audit.body.toString(), JSON.stringify(input))
    await audit.finish(status); await audit.finish(status)
    assert.equal(completions, 1); assert.equal(saved.details.deletionStatus, expected)
  }
})
test('audit failure blocks deletion; malformed requests are not forwarded', async () => {
  await assert.rejects(auditSessionDelete(req(), { ...identity, save: async () => { throw Error() } }), error => error.status === 503)
  for (const body of ['{', '{}', 'x'.repeat(8193)]) await assert.rejects(auditSessionDelete(req(undefined, body), { ...identity, save: () => assert.fail() }), error => [400, 413].includes(error.status))
})
test('lost result write retains submitted record rather than claiming deletion success', async () => {
  let saved
  const audit = await auditSessionDelete(req(), { ...identity, save: async entry => { saved = entry }, complete: async () => { throw Error() } })
  await audit.finish(200)
  assert.equal(saved.details.deletionStatus, 'submitted')
})
