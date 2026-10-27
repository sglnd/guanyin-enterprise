import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, access, readdir, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSessionDeletion, captureSessionLifecycles } from '../enterprise-plugin/lib/sessions.js'
const id = 'session-delete-test'
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), 'gy-delete-')); t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'sessions'), dir = join(root, 'project', id), neighbor = join(root, 'project', 'neighbor')
  await mkdir(dir, { recursive: true }); await mkdir(neighbor)
  await writeFile(join(dir, 'current.v4.jsonl'), 'synthetic log'); await writeFile(join(neighbor, 'current.v4.jsonl'), 'neighbor log')
  await writeFile(join(home, 'shared-attachment'), 'shared')
  const live = new Map([[id, {}]]), pinned = new Set([id]), archived = new Set(), accounted = new Set([id, 'neighbor']), headers = new Map([[id, { id }]])
  const claims = new Set(), events = [], activity = [], checkpoints = new Map([[id, {}], ['neighbor', {}]])
  const registry = {
    headers, sessionPaths: new Map([[id, 'project']]), missingSessionPaths: new Set(), invalidSessionPaths: new Map(),
    enqueueOperation: fn => fn(), get archivedSessionIds() { return [...archived] }, get pinnedSessionIds() { return [...pinned] }, pinSession: async id => pinned.add(id),
    archiveSession: async id => { archived.add(id); pinned.delete(id) }, unarchiveSession: async id => archived.delete(id), unpinSession: async id => pinned.delete(id),
    list: () => [{ detachSession: async id => accounted.delete(id) }],
  }
  const agent = { scope: { dispose: async () => live.delete(id) } }
  const ctx = {
    sessionPersistence: { root, name: 'session-persistence-jsonl', tracker: { claimWrite: id => { assert.ok(!claims.has(id)); claims.add(id) }, releaseClaim: id => claims.delete(id) }, coldLogMemo: new Map([[id, {}]]), findLog: async () => ({ currentPath: join(dir, 'current.v4.jsonl') }), acquireLease: async () => ({ release: async () => {} }) },
    get: () => ({ table: { delete: async id => checkpoints.delete(id) } }), workspaceRegistry: registry, sessionQuery: { listSessions: async () => [...headers.values()].map(header => ({ header })) },
    agents: { get: key => live.has(key) ? agent : undefined }, sessions: { get: key => live.get(key) }, waterfall: async () => activity, emit: (...event) => events.push(event),
  }
  const journal = join(home, 'journal'), service = createSessionDeletion(ctx, journal, { has: key => live.has(key), dispose: async key => live.delete(key) })
  return { home, dir, neighbor, ctx, service, journal, live, headers, pinned, archived, accounted, claims, activity, events, checkpoints }
}
test('confirmed deletion purges only one log and its indexes, retaining shared/workspace files', async t => {
  const f = await fixture(t); const plan = await f.service.prepare(id, 'alice')
  await f.service.remove(id, plan.confirmation, 'alice')
  await assert.rejects(access(f.dir)); assert.equal(await readFile(join(f.neighbor, 'current.v4.jsonl'), 'utf8'), 'neighbor log')
  assert.equal(await readFile(join(f.home, 'shared-attachment'), 'utf8'), 'shared')
  assert.ok(!f.headers.has(id) && !f.live.has(id) && !f.pinned.has(id) && !f.archived.has(id) && !f.accounted.has(id))
  assert.deepEqual(await readdir(f.journal), []); assert.equal(f.claims.size, 0)
  assert.ok(!f.checkpoints.has(id) && f.checkpoints.has('neighbor')); assert.ok(f.service.deleted.has(id))
  assert.ok(f.events.some(event => event[0] === 'api-session/removed' && event[1] === id))
  await assert.rejects(f.service.remove(id, plan.confirmation, 'alice'))
})
test('confirmation is bound to actor and session; invalid IDs cannot become file paths', async t => {
  const f = await fixture(t); const plan = await f.service.prepare(id, 'alice')
  await assert.rejects(f.service.remove(id, plan.confirmation, 'bob'))
  for (const bad of ['../escape', '.', '', '/etc/passwd']) await assert.rejects(f.service.prepare(bad, 'alice'))
  await access(f.dir); assert.equal(f.live.size, 1)
})
test('active tasks and dependent sessions reject without archive or disk mutation', async t => {
  const f = await fixture(t); f.activity.push({ kind: 'turn' }); await assert.rejects(f.service.prepare(id, 'alice'), /任务/)
  f.activity.length = 0; f.headers.set('child', { id: 'child', parentSession: id }); await assert.rejects(f.service.prepare(id, 'alice'), /关联/)
  assert.equal(f.archived.size, 0); await access(f.dir)
})
test('activity is rechecked after confirmation', async t => {
  const f = await fixture(t); const plan = await f.service.prepare(id, 'alice'); f.activity.push({ kind: 'job' })
  await assert.rejects(f.service.remove(id, plan.confirmation, 'alice'), /任务/); await access(f.dir)
})
test('failure before rename restores visibility and releases admission/write guards', async t => {
  const f = await fixture(t); f.ctx.sessionPersistence.acquireLease = async () => { throw new Error('locked') }
  const plan = await f.service.prepare(id, 'alice'); await assert.rejects(f.service.remove(id, plan.confirmation, 'alice'), /locked/)
  await access(f.dir); assert.equal(f.archived.size, 0); assert.equal(f.service.blocked.size, 0); assert.equal(f.claims.size, 0)
})
test('committed deletion interrupted during index cleanup is recovered after restart', async t => {
  const f = await fixture(t), list = f.ctx.workspaceRegistry.list
  f.ctx.workspaceRegistry.list = () => [{ detachSession: async () => { throw new Error('storage unavailable') } }]
  const plan = await f.service.prepare(id, 'alice'); await assert.rejects(f.service.remove(id, plan.confirmation, 'alice'))
  await assert.rejects(access(f.dir)); assert.ok(f.service.blocked.has(id))
  f.ctx.workspaceRegistry.list = list; const restarted = createSessionDeletion(f.ctx, f.journal); await restarted.recover()
  assert.deepEqual(await readdir(f.journal), []); assert.ok(!f.headers.has(id)); assert.equal(restarted.blocked.size, 0)
})
test('session symlink cannot cause deletion outside the persistence root', async t => {
  const f = await fixture(t); await rm(f.dir, { recursive: true }); await symlink(f.neighbor, f.dir)
  const plan = await f.service.prepare(id, 'alice'); await assert.rejects(f.service.remove(id, plan.confirmation, 'alice'), /Noncanonical/)
  await access(join(f.neighbor, 'current.v4.jsonl')); assert.equal(f.archived.size, 0)
})

test('factory lifecycle adapter retains the full disposer and restores factory methods', async () => {
  const disposers = [], hooks = new Map(); let released = false
  const factory = { async createAgent() { return { agent: { id: 'test-agent' }, dispose: async () => { released = true } } }, async resume() {} }
  const original = factory.createAgent
  const ctx = { agents: { requireFactory: () => ({ target: factory }) }, effect: cb => disposers.push(cb()), on: (name, cb) => hooks.set(name, cb) }
  const lifecycle = captureSessionLifecycles(ctx)
  await factory.createAgent(); assert.ok(lifecycle.has('test-agent'))
  await lifecycle.dispose('test-agent'); assert.ok(released)
  hooks.get('agent/disposed')({ agent: { id: 'test-agent' } }); assert.ok(!lifecycle.has('test-agent'))
  for (const dispose of disposers.reverse()) dispose()
  assert.equal(factory.createAgent, original)
})
