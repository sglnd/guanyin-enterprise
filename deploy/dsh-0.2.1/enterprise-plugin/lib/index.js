import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { connectorView } from './connectors.js'
import { installUsage } from './usage.js'
import { createSessionDeletion, captureSessionLifecycles, SessionDeletionError } from './sessions.js'
import { parseDocument, isMap, isSeq } from 'yaml'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { readProfilePatches, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'

export const inject = ['llm', 'sessions', 'agents', 'agentLoop', 'sessionPersistence', 'sessionQuery', 'workspaceRegistry', 'webServer', 'loader', 'tools', 'profileContext', 'hmr']

export async function apply(ctx) {
  installUsage(ctx)
  const deletion = createSessionDeletion(ctx, join(process.env.DSH_HOME || '/data/dsh', 'guanyin-session-deletions'), captureSessionLifecycles(ctx))
  const projectionCache = ctx.get('sessionProjectionCache')
  if (projectionCache?.put) {
    const original = projectionCache.put
    const wrapped = function (id, ...args) {
      // Disposed-session and in-flight cold reads must not recreate a deleted checkpoint.
      if (deletion.blocked.has(id) || deletion.deleted.has(id)) return Promise.resolve()
      return original.call(this, id, ...args)
    }
    projectionCache.put = wrapped
    ctx.effect(() => () => { if (projectionCache.put === wrapped) projectionCache.put = original }, 'guanyin: deleted projection guard')
  }
  ctx.on('session/created', session => {
    if (deletion.blocked.has(session.id) || deletion.blocked.has(session.header.parentSession)) throw new Error('Session is being deleted')
  })
  ctx.on('agent/pre-step', ({ agent }, next) => {
    if (deletion.blocked.has(agent.id)) throw new Error('Session is being deleted')
    return next()
  })
  await deletion.recover()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/guanyin-sessions', handler: async (req, res) => {
    const expected = Buffer.from(process.env.DSH_EXT_TOKEN || '')
    const actual = Buffer.from(String(req.headers['x-guanyin-token'] || ''))
    if (req.method !== 'POST' || !expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(404).end(); return }
    try {
      let bytes = 0; const chunks = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 8192) throw new SessionDeletionError('请求过大', 413); chunks.push(chunk) }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const actor = String(req.headers['x-guanyin-actor'] || '')
      const method = new URL(req.url, 'http://localhost').pathname
      if (!actor) throw new SessionDeletionError('缺少用户身份', 401)
      let value
      if (method === '/guanyin-sessions/prepare') value = await deletion.prepare(input.sessionId, actor)
      else if (method === '/guanyin-sessions/delete') value = await deletion.remove(input.sessionId, input.confirmation, actor)
      else throw new SessionDeletionError('无效操作', 404)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value))
    } catch (error) {
      if (!(error instanceof SessionDeletionError)) ctx.logger.warn('session deletion failed: %s', error.stack || error.message)
      res.writeHead(error.status || 503, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ error: error instanceof SessionDeletionError ? error.message : '删除尚未完成，请稍后刷新；如仍异常，请联系空间管理员' }))
    }
  } }), 'guanyin: session deletion')
  const profile = ctx.profileContext
  const hmr = ctx.hmr
  const file = profile.patchPath
  let queue = Promise.resolve()
  const list = () => ({ servers: [...ctx.loader.entries()]
    .filter(e => !e.options.group && e.options.name === '@deepseek-ai/dsh-mcp-client')
    .map(e => ({ id: String(e.id).replace(/^include:/, ''), ...e.options.config, enabled: !e.disabled, userManaged: String(e.id).replace(/^include:/, '').startsWith('guanyin-mcp-') })) })
  async function dispatch(method, input = {}) {
    if (method === 'list') return list()
    if (method === 'inspect') return connectorView(ctx.loader.entries(), ctx.tools.schemas())
    if (!['add', 'remove'].includes(method) || !/^guanyin-mcp-[a-z0-9-]{1,80}$/.test(input.id || '')) throw new Error('Invalid managed MCP operation')
    let entry
    if (method === 'add') {
      const c = input.config
      if (!c || c.transport !== 'streamable-http' || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.serverName || '')) throw new Error('Invalid MCP configuration')
      const url = new URL(c.url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid MCP URL')
      if (c.headers && (typeof c.headers !== 'object' || Array.isArray(c.headers) || !Object.values(c.headers).every(v => typeof v === 'string'))) throw new Error('Invalid MCP headers')
      entry = { id: input.id, name: '@deepseek-ai/dsh-mcp-client', config: {
        serverName: c.serverName, transport: c.transport, url: c.url, ...(c.headers ? { headers: c.headers } : {}),
      } }
    }
    // Share the native Settings editor's lock and HMR queue. Preserve its YAML
    // nodes (including !!js), so MCP edits cannot erase concurrent model edits.
    await hmr.runExclusive(() => withFileLock(join(profile.dir, 'package.json'), async () => {
      const before = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return '[]\n'; throw error })
      const document = parseDocument(before, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] })
      if (document.errors.length || !isSeq(document.contents)) throw new Error('Invalid managed profile patch')
      for (let i = document.contents.items.length - 1; i >= 0; i--) {
        const row = document.contents.items[i]
        if (!isMap(row)) continue
        if (row.get('id') === input.id) { document.delete(i); continue }
        const insert = row.get('insert', true)
        if (!isSeq(insert)) continue
        for (let j = insert.items.length - 1; j >= 0; j--) if (isMap(insert.items[j]) && insert.items[j].get('id') === input.id) insert.delete(j)
        if (!insert.items.length) document.delete(i)
      }
      if (entry) document.add(document.createNode({ insert: [entry] }))
      await writeFileAtomic(file, String(document), { mode: 0o600 })
      try { await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh') }
      catch (error) {
        await writeFileAtomic(file, before, { mode: 0o600 })
        await reconcileProfilePatches(ctx.root, readProfilePatches('dsh', profile), 'dsh')
        throw error
      }
    }))
    return { id: input.id }
  }
  const webServer = ctx.reflect.get('webServer')
  ctx.effect(() => webServer.register({ kind: 'prefix', path: '/mcp-manager', handler: async (req, res) => {
    const expected = Buffer.from(process.env.DSH_EXT_TOKEN || '')
    const actual = Buffer.from(String(req.headers['x-guanyin-token'] || ''))
    if (req.method !== 'POST' || !expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { res.writeHead(404).end(); return }
    let envelope
    try {
      let bytes = 0; const chunks = []
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk) }
      envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const method = new URL(req.url, 'http://localhost').pathname.split('/').pop()
      const result = queue.catch(() => {}).then(() => dispatch(method, envelope.payload))
      queue = result
      const value = await result
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
    } catch {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ type: 'server-response', rpcId: envelope?.rpcId, result: { ok: false, error: { code: 'MCP_MANAGEMENT_FAILED', message: 'MCP 配置操作失败' } } }))
    }
  } }), 'guanyin: managed MCP contract')
}
