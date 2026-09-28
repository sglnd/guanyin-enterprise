import { randomUUID } from 'node:crypto'
import { normalizeApiManifest } from './api-contract.mjs'

const schemaProperties = {
  name: { type: 'string', minLength: 1, maxLength: 80, description: '面向使用者的中文接口名称。' },
  slug: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 32, description: '全局唯一的英文短标识，例如 system-health-check。' },
  description: { type: 'string', maxLength: 500, description: '接口用途、适用范围和限制。' },
  instruction: { type: 'string', minLength: 1, description: 'DSH 执行任务时使用的完整业务说明，包含工具选择和输出约束。' },
  inputSchema: { type: 'object', description: 'JSON Schema 2020-12 风格的输入对象 Schema，顶层 type 必须为 object。' },
  outputSchema: { type: 'object', description: 'JSON Schema 2020-12 风格的输出对象 Schema，顶层 type 必须为 object。' },
  maxConcurrency: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
  maxQueueSize: { type: 'integer', minimum: 1, maximum: 10000, default: 100 },
  queueTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
  executionTimeoutSeconds: { type: 'integer', minimum: 1, maximum: 86400, default: 300 },
}

const contractRequired = ['name', 'slug', 'instruction', 'inputSchema', 'outputSchema']

export const apiBuilderTools = [
  {
    name: 'guanyin_get_context',
    description: '获取当前观因空间及接口草稿权限边界。创建接口前先调用。此工具不会返回任何模型、MCP 或 API 密钥。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'guanyin_list_api_drafts',
    description: '列出当前空间的接口草稿和发布状态，用于避免重复创建。只能查看当前空间。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'guanyin_get_api_draft',
    description: '读取当前空间内一个接口草稿的完整契约，便于继续完善。',
    inputSchema: { type: 'object', properties: { definitionId: { type: 'string', format: 'uuid' } }, required: ['definitionId'], additionalProperties: false },
  },
  {
    name: 'guanyin_create_api_draft',
    description: '根据当前对话中已经确认的业务能力创建观因接口草稿。先设计清晰的输入输出 Schema；只创建草稿，不会发布接口。',
    inputSchema: { type: 'object', properties: schemaProperties, required: contractRequired, additionalProperties: false },
  },
  {
    name: 'guanyin_update_api_draft',
    description: '修改当前空间内尚未下线的接口草稿。必须提交完整契约；修改已发布接口只更新草稿，不改变线上版本。',
    inputSchema: { type: 'object', properties: { definitionId: { type: 'string', format: 'uuid' }, ...schemaProperties }, required: ['definitionId', ...contractRequired], additionalProperties: false },
  },
  {
    name: 'guanyin_validate_api_draft',
    description: '校验当前空间中的接口草稿及 JSON Schema。校验成功后仍需接口管理员在观因后台审核发布。',
    inputSchema: { type: 'object', properties: { definitionId: { type: 'string', format: 'uuid' } }, required: ['definitionId'], additionalProperties: false },
  },
]

function slug(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function contract(args) {
  return normalizeApiManifest({
    instruction: args.instruction,
    inputSchema: args.inputSchema,
    outputSchema: args.outputSchema,
    maxConcurrency: args.maxConcurrency,
    maxQueueSize: args.maxQueueSize,
    queueTimeoutSeconds: args.queueTimeoutSeconds,
    executionTimeoutSeconds: args.executionTimeoutSeconds,
  })
}

function view(definition) {
  return {
    id: definition.id, name: definition.name, slug: definition.slug, description: definition.description,
    status: definition.status, ownerUserId: definition.ownerUserId, ownerName: definition.ownerName,
    manifest: definition.draftManifest, updatedAt: definition.updatedAt,
  }
}

export async function executeApiBuilderTool(name, args, { store, instance, audit }) {
  if (name === 'guanyin_get_context') return {
    space: { id: instance.id, name: instance.name, slug: instance.slug },
    policy: {
      scope: 'current-space-only', canCreateDraft: true, canUpdateDraft: true, canValidateDraft: true,
      canPublish: false, canManageCredentials: false,
      nextStep: '接口管理员在观因平台审核、试运行并发布。',
    },
  }

  if (name === 'guanyin_list_api_drafts') {
    const definitions = await store.listApiDefinitionsByInstance(instance.id)
    return { definitions: definitions.map(view) }
  }

  const definitionId = String(args?.definitionId || '')
  if (name === 'guanyin_get_api_draft') {
    const definition = await store.apiDefinitionById(definitionId)
    if (!definition || definition.instanceId !== instance.id) throw new Error('接口草稿不存在或不属于当前空间')
    return { definition: view(definition) }
  }

  const members = await store.listInstanceMembers(instance.id)
  const owner = members.find(member => member.accessRole === 'owner') || members[0]
  if (!owner) throw new Error('当前空间没有可作为接口负责人的成员')

  if (name === 'guanyin_create_api_draft') {
    const value = {
      id: randomUUID(), slug: slug(args?.slug), name: String(args?.name || '').trim(),
      description: String(args?.description || '').trim(), instanceId: instance.id, ownerUserId: owner.id,
      manifest: contract(args || {}), createdBy: owner.id,
    }
    if (!value.slug || !value.name) throw new Error('接口名称或标识无效')
    const definition = await store.createApiDefinition(value)
    await audit({ actorUserId: owner.id, action: 'api_definition_create', targetInstanceId: instance.id,
      details: { apiDefinitionId: definition.id, slug: value.slug, source: 'dsh-ai-builder' } })
    return { definition: view(definition), message: '接口草稿已创建，请到观因平台审核、试运行并发布。' }
  }

  if (name === 'guanyin_update_api_draft') {
    const current = await store.apiDefinitionById(definitionId)
    if (!current || current.instanceId !== instance.id) throw new Error('接口草稿不存在或不属于当前空间')
    if (current.status === 'retired') throw new Error('已下线接口不可修改')
    const value = {
      slug: slug(args?.slug), name: String(args?.name || '').trim(), description: String(args?.description || '').trim(),
      instanceId: instance.id, ownerUserId: current.ownerUserId, manifest: contract(args || {}),
    }
    if (!value.slug || !value.name) throw new Error('接口名称或标识无效')
    const definition = await store.updateApiDefinition(current.id, value)
    await audit({ actorUserId: owner.id, action: 'api_definition_update', targetInstanceId: instance.id,
      details: { apiDefinitionId: definition.id, source: 'dsh-ai-builder' } })
    return { definition: view(definition), message: '接口草稿已更新，线上已发布版本未改变。' }
  }

  if (name === 'guanyin_validate_api_draft') {
    const definition = await store.apiDefinitionById(definitionId)
    if (!definition || definition.instanceId !== instance.id) throw new Error('接口草稿不存在或不属于当前空间')
    if (definition.status === 'retired') throw new Error('已下线接口不可校验')
    normalizeApiManifest(definition.draftManifest)
    await store.setApiDefinitionValidated(definition.id)
    await audit({ actorUserId: owner.id, action: 'api_definition_validate', targetInstanceId: instance.id,
      details: { apiDefinitionId: definition.id, source: 'dsh-ai-builder' } })
    return { definitionId: definition.id, validated: true, message: '校验通过，仍需接口管理员在观因平台手动发布。' }
  }

  throw new Error(`未知工具：${name}`)
}

function assistantText(frame) {
  if (frame?.type !== 'event' || frame.event?.type !== 'assistant/message') return ''
  const content = frame.event.data?.message?.content
  return Array.isArray(content) ? content.filter(block => block?.type === 'text').map(block => block.text || '').join('') : ''
}

function parseJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!value) throw new Error('模型没有返回接口草稿')
  return JSON.parse(value)
}

export async function generateApiDraftWithAi(adapter, requirement, { signal } = {}) {
  const sessionId = (await adapter.createSession({ cwd: '/workspace' }, { signal })).sessionId
  const prompt = `你是观因平台的 API 设计助手。请把用户需求转换成一个可编辑的接口草稿建议。

要求：
1. 不调用任何工具，不创建或发布接口，只输出 JSON。
2. slug 使用小写英文、数字和连字符，最长 32 个字符。
3. inputSchema 和 outputSchema 顶层 type 必须是 object，并尽可能设置 required 和 additionalProperties=false。
4. instruction 必须清楚说明业务任务、可使用当前空间已有能力，并要求最终只返回符合 outputSchema 的 JSON。
5. 只返回以下结构，不要 Markdown：
{"name":"接口名称","slug":"api-slug","description":"接口说明","instruction":"执行说明","inputSchema":{"type":"object"},"outputSchema":{"type":"object"},"maxConcurrency":1,"maxQueueSize":100,"queueTimeoutSeconds":300,"executionTimeoutSeconds":300}

用户需求：
${String(requirement || '').trim()}`
  let submitted = false; let text = ''
  for await (const frame of adapter.follow(sessionId, { signal })) {
    if (!submitted && frame.type === 'snapshot') {
      submitted = true
      await adapter.prompt({ sessionId, content: [{ type: 'text', text: prompt }] }, { signal })
    }
    text += assistantText(frame)
    if (frame?.type === 'event' && frame.event?.type === 'turn/end') {
      if (frame.event.data?.reason?.kind === 'error') throw new Error(frame.event.data.reason.error?.message || '模型生成接口草稿失败')
      break
    }
  }
  const suggestion = parseJson(text)
  const manifest = normalizeApiManifest(suggestion)
  const name = String(suggestion.name || '').trim()
  const normalizedSlug = slug(suggestion.slug)
  if (!name || !normalizedSlug) throw new Error('模型生成的接口名称或标识无效')
  return { name, slug: normalizedSlug, description: String(suggestion.description || '').trim(), ...manifest }
}
