import { mkdir, readFile, readdir, rename, rm, rmdir, lstat, realpath, open } from 'node:fs/promises'
import { resolve, relative, dirname, join, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

export class SessionDeletionError extends Error {
  constructor(message, status = 409) { super(message); this.status = status }
}
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(id)
const exists = async path => { try { return await lstat(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }
async function syncDir(path) { const handle = await open(path, 'r'); try { await handle.sync() } finally { await handle.close() } }

// Pinned rc3 backend adapter. No arbitrary client paths or work-directory
// deletion: only a canonical JSONL session directory can enter this journal.
export function captureSessionLifecycles(ctx) {
  // Retain the factory's public AgentHandle disposer. Disposing only an
  // Agent's registration scope does NOT release its persistence writer.
  const factory = ctx.agents.requireFactory().target
  const handles = new Map()
  for (const key of ['createAgent', 'resume']) {
    const original = factory[key]
    if (typeof original !== 'function') throw new Error('Unsupported AgentFactory lifecycle')
    const wrapped = async function (...args) {
      const handle = await original.apply(this, args)
      if (typeof handle?.dispose === 'function') handles.set(handle.agent.id, handle)
      return handle
    }
    factory[key] = wrapped
    ctx.effect(() => () => { if (factory[key] === wrapped) factory[key] = original }, `guanyin: ${key} lifecycle adapter`)
  }
  ctx.on('agent/disposed', ({ agent }) => handles.delete(agent.id))
  return { has: id => handles.has(id), dispose: async id => { const handle = handles.get(id); if (handle) await handle.dispose() } }
}

export function createSessionDeletion(ctx, journalRoot, lifecycle = { has: () => false, dispose: async () => {} }) {
  const p = ctx.sessionPersistence, registry = ctx.workspaceRegistry
  if (p.name !== 'session-persistence-jsonl' || !p.tracker?.claimWrite || !p.acquireLease || !p.findLog || !registry.headers?.delete || !registry.enqueueOperation) {
    throw new Error('Session deletion requires the validated rc3 JSONL/workspace adapter')
  }
  const blocked = new Set(), deleted = new Set(), confirmations = new Map()
  let tail = Promise.resolve()
  const serial = task => { const result = tail.then(task); tail = result.catch(() => {}); return result }
  async function roots() {
    await mkdir(p.root, { recursive: true, mode: 0o700 })
    await mkdir(journalRoot, { recursive: true, mode: 0o700 })
    const journal = await realpath(journalRoot)
    await syncDir(dirname(journal))
    return { root: await realpath(p.root), journal }
  }
  function validateRecord(record, root, journal, id) {
    if (!validId(id) || record.id !== id || !['prepared', 'committed'].includes(record.phase)) throw new Error('Invalid deletion journal')
    const source = resolve(root, record.sourceRelative)
    const parts = relative(root, source).split(sep)
    if (parts.length !== 2 || parts.some(v => !v || v === '..' || v === '.')) throw new Error('Invalid session directory')
    return { source, stage: join(journal, id, 'log'), file: join(journal, id, 'record.json') }
  }
  async function cleanIndexes(id) {
    for (const workspace of registry.list()) await workspace.detachSession(id)
    await registry.unpinSession(id)
    await registry.unarchiveSession(id)
    await registry.enqueueOperation(async () => {
      for (const name of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) registry[name].delete(id)
    })
    p.coldLogMemo?.delete(id)
    ctx.sessionQuery._observations?.cache?.delete(id)
    await ctx.get?.('sessionProjectionCache')?.table?.delete(id)
    ctx.emit('api-session/removed', id)
  }
  async function finish(record, root, journal) {
    const { source, stage, file } = validateRecord(record, root, journal, record.id)
    const staged = await exists(stage), original = await exists(source)
    if (original && staged) throw new Error('Session reappeared during deletion; refusing to remove either copy')
    if (original && !staged && record.phase === 'committed') throw new Error('Committed deletion source unexpectedly exists')
    if (!staged && original && record.phase === 'prepared') {
      if (!record.wasArchived) await registry.unarchiveSession(record.id)
      if (record.wasPinned) await registry.pinSession(record.id)
    } else {
      // The rename is the commit point; retries and restart recovery complete
      // index cleanup before purging the staged log. Shared attachments stay.
      deleted.add(record.id)
      await cleanIndexes(record.id)
      await rm(stage, { recursive: true, force: true })
    }
    await rm(file, { force: true })
    await rmdir(dirname(file)).catch(e => { if (e.code !== 'ENOENT') throw e })
    await syncDir(journal)
  }
  async function recover() {
    const { root, journal } = await roots()
    for (const entry of await readdir(journal, { withFileTypes: true })) {
      if (!entry.isDirectory() || !validId(entry.name)) continue
      const file = join(journal, entry.name, 'record.json')
      if (!await exists(file)) continue
      const record = JSON.parse(await readFile(file, 'utf8'))
      if (record.id !== entry.name) throw new Error('Deletion journal identity mismatch')
      blocked.add(record.id)
      await finish(record, root, journal)
      blocked.delete(record.id)
    }
  }
  async function inspect(id) {
    if (!validId(id)) throw new SessionDeletionError('无效的会话标识', 400)
    if (blocked.has(id)) throw new SessionDeletionError('会话正在删除，请稍后刷新')
    const all = await ctx.sessionQuery.listSessions()
    const item = all.find(item => item.header.id === id)
    if (!item) throw new SessionDeletionError('会话不存在或已删除', 404)
    if (item.header.origin === 'subagent') throw new SessionDeletionError('请通过所属主会话管理子智能体会话')
    if (all.some(item => item.header.parentSession === id)) throw new SessionDeletionError('此会话有关联分支或子智能体会话，暂不能删除，请先归档')
    const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
    if (activity.length) throw new SessionDeletionError('会话仍有运行任务或自动化任务，请先停止或移除任务')
    if (ctx.sessions.get(id) && !lifecycle.has(id)) throw new SessionDeletionError('当前会话的写入尚未释放，请重启空间后重试')
    return item
  }
  async function prepare(id, actor) {
    await inspect(id)
    for (const [key, value] of confirmations) if (value.until <= Date.now()) confirmations.delete(key)
    if (confirmations.size >= 1000) throw new SessionDeletionError('请求过多，请稍后重试', 429)
    const confirmation = randomBytes(24).toString('hex')
    confirmations.set(confirmation, { id, actor, until: Date.now() + 120000 })
    return { sessionId: id, confirmation }
  }
  async function remove(id, confirmation, actor) {
    return serial(async () => {
      const request = confirmations.get(confirmation)
      if (!request || request.id !== id || request.actor !== actor || request.until <= Date.now()) throw new SessionDeletionError('确认已过期，请重新打开删除对话框', 400)
      confirmations.delete(confirmation)
      await inspect(id)
      const { root, journal } = await roots()
      blocked.add(id)
      let lease, claimed = false, moved = false, record, paths
      const wasArchived = registry.archivedSessionIds.includes(id)
      const wasPinned = registry.pinnedSessionIds.includes(id)
      try {
        // Archive blocks every new turn before the live writer is disposed.
        await registry.archiveSession(id)
        const activity = await ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]))
        if (activity.length) throw new SessionDeletionError('会话状态发生变化，请停止任务后重试')
        await lifecycle.dispose(id)
        if (ctx.sessions.get(id)) throw new Error('Session writer did not detach')
        p.tracker.claimWrite(id); claimed = true
        const artifact = await p.findLog(id)
        if (!artifact) throw new Error('Session log is not materialized')
        const source = dirname(artifact.currentPath)
        if (await realpath(source) !== resolve(source) || !(await lstat(source)).isDirectory()) throw new Error('Noncanonical session directory')
        record = { id, sourceRelative: relative(root, source), wasArchived, wasPinned, phase: 'prepared' }
        paths = validateRecord(record, root, journal, id)
        lease = await p.acquireLease(id, undefined, source)
        await mkdir(dirname(paths.file), { mode: 0o700 })
        await writeFileAtomic(paths.file, JSON.stringify(record), { mode: 0o600 })
        await syncDir(dirname(paths.file)); await syncDir(journal)
        await rename(source, paths.stage); moved = true
        await syncDir(dirname(source)); await syncDir(dirname(paths.stage))
        record.phase = 'committed'
        await writeFileAtomic(paths.file, JSON.stringify(record), { mode: 0o600 })
        await syncDir(dirname(paths.file))
        await finish(record, root, journal)
        return { deleted: true, sessionId: id }
      } catch (error) {
        if (!moved) {
          if (!wasArchived) await registry.unarchiveSession(id)
          if (wasPinned) await registry.pinSession(id)
          if (paths) await rm(dirname(paths.file), { recursive: true, force: true })
        }
        throw error
      } finally {
        await lease?.release()
        if (claimed) p.tracker.releaseClaim(id)
        // A committed but interrupted deletion stays blocked until restart recovery.
        if (!moved || !await exists(paths.file)) blocked.delete(id)
      }
    })
  }
  return { recover, prepare, remove, blocked, deleted }
}
