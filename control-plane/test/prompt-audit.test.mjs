import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import http from 'node:http'
import { once } from 'node:events'
import { auditPromptBeforeForward, PromptAuditError } from '../prompt-audit.mjs'

const user = { id: 'user-id', displayName: '测试用户' }
const instance = { id: 'space-id', name: '测试空间', tenantId: 'tenant-id', version: '0.2.1-rc.3', impersonated: true }
const request = { sessionId: 'session-test', requestId: 'request-test', content: [{ type: 'text', text: '  原文\n<script>alert(1)</script> 😀  ' }, { type: 'image', data: 'image-secret' }, { type: 'text', text: '第二段' }] }
const envelope = args => ({ method: 'session/prompt', payload: { args }, history: 'excluded-history', apiKey: 'excluded-secret' })
function incoming(body, path = '/api/session/prompt', headers = {}) {
  const req = Readable.from([Buffer.from(body)])
  return Object.assign(req, { method: 'POST', url: path, headers })
}
test('both DSH request envelopes preserve exact new text and omit all context/non-text content', async () => {
  for (const args of [{ request }, request]) {
    const bytes = Buffer.from(JSON.stringify(envelope(args))), entries = []
    const body = await auditPromptBeforeForward(incoming(bytes), { user, instance, save: async entry => entries.push(entry), ip: '127.0.0.1' })
    assert.deepEqual(body, bytes)
    assert.equal(entries.length, 1)
    const entry = entries[0]
    assert.equal(entry.action, 'user_chat_input'); assert.equal(entry.actorUserId, user.id)
    assert.equal(entry.targetInstanceId, instance.id); assert.equal(entry.details.impersonated, true)
    assert.deepEqual(entry.details.texts, [request.content[0].text, '第二段'])
    for (const secret of ['excluded-history', 'excluded-secret', 'image-secret']) assert.ok(!JSON.stringify(entry).includes(secret))
  }
})
test('other RPCs and binary uploads remain unconsumed and unaudited', async () => {
  for (const path of ['/api/session/uploadFileBinary', '/api/settings/mutate', '/api/session/get']) {
    const req = incoming('not-json', path)
    assert.equal(await auditPromptBeforeForward(req, { save: () => assert.fail('unexpected audit') }), undefined)
    assert.equal(req.readableEnded, false)
  }
})
test('malformed, oversized, and compressed prompt requests cannot pass the audit gate', async () => {
  for (const [body, headers, status] of [['{', {}, 400], [JSON.stringify(envelope({ request: { ...request, content: [{ type: 'text', text: {} }] } })), {}, 400], ['x'.repeat(16 * 1024 * 1024 + 1), {}, 413], ['{}', { 'content-encoding': 'gzip' }, 415]]) {
    await assert.rejects(auditPromptBeforeForward(incoming(body, undefined, headers), { user, instance, save: () => assert.fail('unexpected audit') }), error => error instanceof PromptAuditError && error.status === status)
  }
})
test('HTTP forwarding waits for persistence; database failure sends no bytes upstream', async t => {
  let fail = false, forwarded = 0, saved = 0
  const expected = JSON.stringify(envelope({ request }))
  const server = http.createServer(async (req, res) => {
    try {
      const body = await auditPromptBeforeForward(req, { user, instance, save: async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        assert.equal(forwarded, saved)
        if (fail) throw Error('private database error')
        saved++
      } })
      assert.equal(saved, forwarded + 1)
      assert.equal(body.toString(), expected)
      forwarded++; res.end('forwarded')
    } catch (error) { res.writeHead(error.status || 500).end(error.message) }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/api/session/prompt`
  const first = await fetch(url, { method: 'POST', body: expected }); assert.equal(first.status, 200)
  fail = true
  const second = await fetch(url, { method: 'POST', body: expected }); assert.equal(second.status, 503)
  assert.match(await second.text(), /消息尚未发送/)
  assert.equal(forwarded, 1); assert.equal(saved, 1)
})
