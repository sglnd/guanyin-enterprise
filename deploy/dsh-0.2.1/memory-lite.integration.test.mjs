// Run inside the image: bind this file at /opt/dsh-runtime/memory-lite.integration.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import yaml from './node_modules/js-yaml/index.js'
import { resolveConfig } from './node_modules/@alanzhao/dsh-memory-lite/lib/config.js'
import { MemoryStore } from './node_modules/@alanzhao/dsh-memory-lite/lib/memory-store.js'
import { applyRememberTool } from './node_modules/@alanzhao/dsh-memory-lite/lib/tools/remember.js'
import { extractOnce } from './node_modules/@alanzhao/dsh-memory-lite/lib/extract/index.js'
import { emptyCheckpoint } from './node_modules/@alanzhao/dsh-memory-lite/lib/extract/checkpoint.js'
import { createStatusTracker } from './node_modules/@alanzhao/dsh-memory-lite/lib/status.js'
import { capCatalogEntries, applyCatalogDecision } from './node_modules/@alanzhao/dsh-memory-lite/lib/inject.js'

const row = yaml.load(await readFile(new URL('./node_modules/@alanzhao/dsh-memory-lite/cordis.patch.yml', import.meta.url), 'utf8'))[0].insert[0]
test('light defaults explicitly disable frequent triggers and cross-directory peers', () => {
  const c = resolveConfig(row.config)
  assert.equal(c.root, '/data/dsh/.agent-memory')
  assert.equal(c.workspacePeers.enabled, false)
  assert.equal(c.extraction.turnStoppingTrigger, false)
  assert.equal(c.extraction.flushTrigger, false)
  assert.equal(c.extraction.windowTurns, 50)
  assert.equal(c.extraction.idleTimeoutMin, 30)
  assert.equal(c.extraction.llm.reasoningEffort, 'off')
  assert.equal(c.index.maxTokens, 800)
})
test('explicit memory survives a new store, is searchable, and rejects path escape', async () => {
  const root = await mkdtemp('/tmp/memory-lite-test-')
  try {
    const config = resolveConfig({ ...row.config, root })
    const store = new MemoryStore(root)
    let tool
    applyRememberTool({ tools: { register: value => { tool = value } } }, { config: () => config, store })
    await tool.execute({ category: 'preferences', title: '语言偏好', content: '默认使用中文回复。' }, {})
    const restarted = new MemoryStore(root)
    const entries = await restarted.readIndex('workspace')
    assert.equal(entries.length, 1)
    assert.ok((await restarted.search('workspace', '中文')).length)
    await assert.rejects(restarted.readFile('workspace', '../../outside.md'))
    const decision = applyCatalogDecision({ decision: { kind: 'enter', messages: [] }, history: { published: false }, entries: capCatalogEntries(entries, 800), peer: 'workspace' })
    assert.ok(decision.messages.some(m => JSON.stringify(m).includes(entries[0].path)))
    await restarted.softDelete('workspace', entries[0].path)
    assert.equal(await restarted.fileExists('workspace', entries[0].path), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('background extraction persists a streamed decision and does not re-extract the same window', async () => {
  const root = await mkdtemp('/tmp/memory-lite-extraction-')
  try {
    const config = resolveConfig({ ...row.config, root })
    const store = new MemoryStore(root)
    let calls = 0
    const ctx = { logger: { warn: () => {}, info: () => {} }, llm: { async *stream(options) {
      calls++
      assert.equal(options.maxTokens, 4096)
      assert.equal(options.reasoningEffort, 'off')
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ decision: 'create', category: 'preferences', title: '输出语言', content: '用户希望使用中文回复。' }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } }
    const session = { id: 'test-session', header: {}, requestHeader: () => ({}), snapshotEvents: () => [
      { seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '以后默认使用中文回复。' }] } },
    ] }
    const state = { pending: 1, lastExtractAt: null, inFlight: false, checkpoint: emptyCheckpoint(), idleDispose: null, cancel: null }
    const deps = { config: () => config, store, defaultModel: () => ({ provider: 'test', model: 'test' }) }
    const tracker = createStatusTracker()
    await extractOnce(session, state, ctx, deps, new AbortController().signal, tracker)
    assert.equal(tracker.snapshot('incremental').status, 'ok')
    assert.equal((await new MemoryStore(root).readIndex('workspace')).length, 1)
    assert.ok((await store.search('workspace', '中文')).length)
    assert.equal(state.checkpoint.checkpoint.seq, 1)
    await extractOnce(session, state, ctx, deps, new AbortController().signal, tracker)
    assert.equal(calls, 1)
  } finally { await rm(root, { recursive: true, force: true }) }
})
