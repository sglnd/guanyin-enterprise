import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertWorkflowBranch, assertWorkflowBranchesFinished, assertWorkflowModel,
  resolveWorkflowModels, saveWorkflowModels, withWorkflowActor, workflowEndpointAllowed,
  workflowPromptSource, workflowRunActor,
} from '../workflow-policy.mjs'

test('workflow inherits the synced default, preserves the definition and rejects revoked routes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guanyin-wf-models-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const defaultModel = { provider: 'guanyin-test', model: 'fixture' }
    const providers = [{ id: defaultModel.provider, config: { models: [{ id: defaultModel.model }] }, apiKey: 'synthetic-not-stored' }]
    await saveWorkflowModels({ providers, defaultModel })
    const flow = { nodes: [{ id: 'agent', kind: 'agent', data: { label: '分类' } }] }
    const resolved = resolveWorkflowModels(flow)
    assert.deepEqual(flow.nodes, [{ id: 'agent', kind: 'agent', data: { label: '分类' } }])
    assert.equal(resolved.nodes.find(node => node.kind === 'parent').data.model, 'fixture')
    assert.equal(resolved.nodes[0].data.provider, 'guanyin-test')
    assert.doesNotMatch(await readFile(join(dir, 'guanyin-workflow-models.json'), 'utf8'), /synthetic-not-stored/)
    await saveWorkflowModels({ providers: [] })
    assert.throws(() => assertWorkflowModel(defaultModel), /授权/)
    assert.throws(() => resolveWorkflowModels(flow), /授权/)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    await rm(dir, { recursive: true, force: true })
  }
})

test('structured branch rejects early and mismatched dispatch and incomplete finish', () => {
  const flow = {
    lines: ['high', 'low'].map(level => ({
      source: 'classify', target: level, sourceHandle: 'flow-out', targetHandle: 'flow-in',
      condition: { type: 'content', label: 'risk=' + level },
    })),
  }
  const source = { nodeId: 'classify', status: 'running', output: '{"risk":"high"}' }
  const high = { nodeId: 'high', status: 'pending' }
  const snapshot = { nodes: [source, high] }
  assert.throws(() => assertWorkflowBranch(flow, snapshot, 'high'))
  source.status = 'ok'
  assert.doesNotThrow(() => assertWorkflowBranch(flow, snapshot, 'high'))
  assert.throws(() => assertWorkflowBranch(flow, snapshot, 'low'))
  assert.throws(() => assertWorkflowBranchesFinished(flow, snapshot))
  high.status = 'ok'
  assert.doesNotThrow(() => assertWorkflowBranchesFinished(flow, snapshot))
})

test('workflow attribution is keyed to the exact request and restricted endpoints remain blocked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guanyin-wf-actor-'))
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const claims = { user: { id: 'fixture-user' }, space: { id: 'fixture-space' } }
    const snapshot = { sessionId: 'fixture-session' }
    const source = await withWorkflowActor(claims, async () => {
      snapshot.guanyinActor = workflowRunActor()
      return workflowPromptSource(snapshot)
    })
    assert.equal(workflowRunActor(), undefined)
    const key = createHash('sha256').update(`${snapshot.sessionId}:${source.rpcId}`).digest('hex')
    const attribution = JSON.parse(await readFile(join(dir, 'guanyin-usage', 'actors', key + '.json'), 'utf8'))
    assert.deepEqual(attribution, { userId: 'fixture-user', source: 'web' })
    for (const method of ['mcpPut', 'dbTest', 'serviceStart', 'schedulerTaskPut']) {
      assert.equal(workflowEndpointAllowed(method), false)
    }
    assert.equal(workflowEndpointAllowed('putWorkflow'), true)
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
    await rm(dir, { recursive: true, force: true })
  }
})
