import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { installUsage, actorPath } from '../../deploy/dsh-0.2.1/enterprise-plugin/lib/usage.js'
import { usageEvent } from '../usage.mjs'

test('0.2.1 attributes each exact request and never charges a schedule to the previous human', async () => {
  const before = process.env.DSH_HOME
  const home = await mkdtemp(join(tmpdir(), 'gy021-usage-'))
  process.env.DSH_HOME = home
  let hook, dispose
  const ctx = {
    on(name, callback) { assert.equal(name, 'llm/stream'); hook = callback },
    effect(callback) { dispose = callback() },
    logger: { warn() {} },
  }
  try {
    await mkdir(dirname(actorPath('s', 'request-a')), { recursive: true })
    await writeFile(actorPath('s', 'request-a'), JSON.stringify({ userId: 'actor-a', source: 'web' }))
    await writeFile(actorPath('s', 'request-b'), JSON.stringify({ userId: 'actor-b', source: 'web' }))
    installUsage(ctx)
    const human = id => ({ role: 'user', source: { kind: 'user', rpcId: id } })
    async function* stream() { yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } }; yield { type: 'finish', reason: { kind: 'stop' } } }
    for (const messages of [[human('request-a')], [human('request-a'), human('request-b'), { role: 'user', source: { kind: 'time-context' } }], [human('request-b'), { role: 'user', source: { kind: 'schedule' } }]]) {
      for await (const chunk of hook({ sessionId: 's', provider: 'p', model: 'm', messages }, stream)) {}
    }
    const dir = join(home, 'guanyin-usage/pending')
    const events = await Promise.all((await readdir(dir)).filter(n => n.endsWith('.json')).map(async n => JSON.parse(await readFile(join(dir, n), 'utf8'))))
    assert.equal(events.length, 3)
    assert.equal(events.find(e => e.requestId === 'request-a').userId, 'actor-a')
    assert.equal(events.find(e => e.requestId === 'request-b').userId, 'actor-b')
    assert.equal(events.find(e => e.source === 'schedule').userId, null)
    for (const event of events) assert.equal(usageEvent(event).totalTokens, 5)
  } finally {
    dispose?.()
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before
    await rm(home, { recursive: true, force: true })
  }
})
