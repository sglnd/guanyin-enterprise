import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'

const catalogFile = () => join(process.env.DSH_HOME || '/data/dsh', 'guanyin-workflow-models.json')

export async function saveWorkflowModels({ providers, defaultModel }) {
  const models = providers.flatMap(({ id, config }) => config.models.map(({ id: model }) => ({ provider: id, model })))
  const file = catalogFile()
  const pending = file + '.' + randomUUID()
  await writeFile(pending, JSON.stringify({ models, defaultModel }), { mode: 0o600, flag: 'wx' })
  await rename(pending, file)
}

function modelCatalog() {
  try { return JSON.parse(readFileSync(catalogFile(), 'utf8')) }
  catch { return { models: [] } }
}

function allowsModel(catalog, { provider, model }) {
  return catalog.models.some(entry => entry.provider === provider && entry.model === model)
}

export function workflowModels(entries) {
  const catalog = modelCatalog()
  return entries.filter(entry => allowsModel(catalog, entry))
}

export function resolveWorkflowModels(flow) {
  const catalog = modelCatalog()
  const copy = structuredClone(flow)
  if (!copy.nodes.some(node => node.kind === 'parent')) {
    let parentId = 'guanyin-default-parent'
    while (copy.nodes.some(node => node.id === parentId)) parentId += '-'
    copy.nodes.push({
      id: parentId, kind: 'parent',
      position: { x: 0, y: 0 }, data: { label: '编排父代理' },
    })
  }
  for (const node of copy.nodes) {
    if (!['parent', 'agent'].includes(node.kind)) continue
    const { provider, model } = node.data
    const selection = provider || model ? { provider, model } : catalog.defaultModel
    if (!selection || !allowsModel(catalog, selection)) {
      throw new Error('工作流节点需使用当前空间已授权的模型：' + node.data.label)
    }
    Object.assign(node.data, selection)
  }
  return copy
}

export function managedWorkflowMcp(server) {
  try {
    const { servers } = JSON.parse(readFileSync('/etc/guanyin/mcp/config.json', 'utf8'))
    return servers.some(binding => binding.enabled && binding.serverName === server.serverName && binding.url === server.url)
  } catch { return false }
}

const blockedEndpoints = new Set([
  'mcpPut', 'mcpDelete', 'mcpToggle', 'dbTest', 'putService', 'serviceStart',
  'serviceStop', 'serviceDebug', 'schedulerTaskPut', 'schedulerTaskDelete',
])
export function workflowEndpointAllowed(endpoint) {
  return !blockedEndpoints.has(endpoint)
}

function branchMatches(line, snapshot) {
  const source = snapshot.nodes.find(node => node.nodeId === line.source)
  if (line.condition.type === 'pass') return source?.status === 'ok'
  if (line.condition.type === 'fail') return source?.status === 'fail'
  if (source?.status !== 'ok') return false
  const rule = /^(\w+)=([^=]+)$/.exec(line.condition.label?.trim() || '')
  if (!rule) return false
  try {
    const output = JSON.parse(source.output)
    return output && Object.hasOwn(output, rule[1]) &&
      ['string', 'boolean', 'number'].includes(typeof output[rule[1]]) &&
      String(output[rule[1]]) === rule[2].trim()
  } catch { return false }
}

function conditionalLines(flow) {
  return flow.lines.filter(line => line.condition &&
    line.sourceHandle === 'flow-out' && line.targetHandle === 'flow-in')
}

export function assertWorkflowBranch(flow, snapshot, targetId) {
  const incoming = conditionalLines(flow).filter(line => line.target === targetId)
  if (incoming.length && !incoming.some(line => branchMatches(line, snapshot))) {
    throw new Error('分支条件未满足。内容条件使用 字段=值，源节点需输出 JSON 对象。')
  }
}

export function assertWorkflowBranchesFinished(flow, snapshot) {
  for (const line of conditionalLines(flow)) {
    if (!branchMatches(line, snapshot)) continue
    if (snapshot.nodes.find(node => node.nodeId === line.target)?.status !== 'ok') {
      throw new Error('满足条件的分支尚未执行完成')
    }
  }
}

export function assertWorkflowModel(selection) {
  if (!allowsModel(modelCatalog(), selection)) throw new Error('该模型已不在当前空间的授权范围内')
}

export function workflowToolAllowed(name) {
  if (!name.startsWith('mcp__')) return true
  try {
    const { servers } = JSON.parse(readFileSync('/etc/guanyin/mcp/config.json', 'utf8'))
    return servers.some(binding => binding.enabled && name.startsWith('mcp__' + binding.serverName + '__'))
  } catch { return false }
}

const workflowActor = new AsyncLocalStorage()

export function withWorkflowActor(claims, action) {
  return workflowActor.run({ userId: claims.user.id, spaceId: claims.space.id }, action)
}

export function workflowRunActor() {
  return workflowActor.getStore()
}

export async function workflowPromptSource(snapshot) {
  const actor = snapshot.guanyinActor
  if (!actor?.userId) return { kind: 'user' }
  const rpcId = randomUUID()
  const dir = join(process.env.DSH_HOME || '/data/dsh', 'guanyin-usage', 'actors')
  await mkdir(dir, { recursive: true })
  const key = createHash('sha256').update(`${snapshot.sessionId}:${rpcId}`).digest('hex')
  await writeFile(join(dir, key + '.json'), JSON.stringify({ userId: actor.userId, source: 'web' }), { mode: 0o600, flag: 'wx' })
  return { kind: 'user', rpcId }
}
