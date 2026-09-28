import test from 'node:test'
import assert from 'node:assert/strict'
import { dshEventToApiEvent } from '../dsh-adapter.mjs'
import { validateApiInput, validateApiOutput } from '../api-runner.mjs'
import { generateApiDocumentation, normalizeApiManifest } from '../api-contract.mjs'
import { apiBuilderTools, executeApiBuilderTool, generateApiDraftWithAi } from '../api-builder-mcp.mjs'
import { createIdentityToken, verifyIdentityToken, withoutControlPlaneCookies, withoutInboundIdentityHeaders } from '../guanyin-identity.mjs'

test('public event projection omits reasoning and duplicate turn start', () => {
  assert.equal(dshEventToApiEvent({ type: 'event', event: { type: 'turn/start', data: { turn: 1 } } }), null)
  assert.equal(dshEventToApiEvent({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: 'private' } } }), null)
  assert.deepEqual(dshEventToApiEvent({ type: 'assistant-stream', frame: { type: 'chunk', chunk: { type: 'text-delta', text: 'visible' } } }),
    { type: 'run.progress', data: { phase: 'model', text: 'visible' } })
})

test('manifest normalization and OpenAPI generation use the published contract', () => {
  const contract = normalizeApiManifest({ instruction: '检查系统', inputSchema: '{"type":"object"}', outputSchema: { type: 'object' } })
  const documentation = generateApiDocumentation({ slug: 'system-check', name: '系统检查', version: 1, contract })
  assert.equal(contract.maxConcurrency, 1)
  assert.equal(documentation.openapi.openapi, '3.1.0')
  assert.ok(documentation.openapi.paths['/openapi/v1/runs/system-check'])
  assert.match(documentation.markdown, /Last-Event-ID/)
})

test('input and output schemas are enforced', () => {
  const contract = {
    inputSchema: { type: 'object', required: ['message'], properties: { message: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } }, additionalProperties: false },
  }
  assert.equal(validateApiInput(contract, { message: 'hello' }).valid, true)
  assert.equal(validateApiInput(contract, { message: 1 }).valid, false)
  assert.equal(validateApiOutput(contract, { ok: true }).valid, true)
  assert.equal(validateApiOutput(contract, { ok: 'yes' }).valid, false)
})

test('API Builder MCP exposes draft-only tools and scopes created drafts to the current space', async () => {
  assert.equal(apiBuilderTools.some(tool => /publish|credential|retire/.test(tool.name)), false)
  const calls = []
  const store = {
    listInstanceMembers: async () => [{ id: 'owner-1', accessRole: 'owner' }],
    createApiDefinition: async value => {
      calls.push(value)
      return { ...value, status: 'draft', draftManifest: value.manifest, ownerName: 'Owner' }
    },
  }
  const result = await executeApiBuilderTool('guanyin_create_api_draft', {
    name: '系统检查', slug: 'system-health-check', instruction: '检查系统并返回 JSON',
    inputSchema: { type: 'object', required: ['system'], properties: { system: { type: 'string' } }, additionalProperties: false },
    outputSchema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } }, additionalProperties: false },
  }, { store, instance: { id: 'space-1', name: '测试空间', slug: 'test' }, audit: async () => {} })
  assert.equal(calls[0].instanceId, 'space-1')
  assert.equal(calls[0].ownerUserId, 'owner-1')
  assert.equal(result.definition.status, 'draft')
})

test('console AI helper returns an editable normalized suggestion without saving it', async () => {
  let prompt
  const adapter = {
    createSession: async () => ({ sessionId: 'session-1' }),
    prompt: async value => { prompt = value },
    follow: async function* () {
      yield { type: 'snapshot' }
      yield { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '{"name":"检查接口","slug":"health-check","description":"检查","instruction":"检查并返回 JSON","inputSchema":{"type":"object"},"outputSchema":{"type":"object"}}' }] } } } }
      yield { type: 'event', event: { type: 'turn/end', data: { reason: { kind: 'completed' } } } }
    },
  }
  const result = await generateApiDraftWithAi(adapter, '检查业务系统状态')
  assert.match(prompt.content[0].text, /不调用任何工具/)
  assert.equal(result.slug, 'health-check')
  assert.equal(result.maxConcurrency, 1)
  assert.equal(result.inputSchema.type, 'object')
})

test('Guanyin identity tokens are short lived, scoped and cannot be overridden by inbound headers', () => {
  const now = Date.parse('2026-09-28T00:00:00Z')
  const token = createIdentityToken({
    user: { id: 'user-1', username: 'zhangsan', displayName: '张三', role: 'member', tenantId: 'tenant-1', tenantName: '风控团队' },
    instance: { id: 'space-1', name: '风险分析空间', accessRole: 'operator' },
  }, 'space-secret', now)
  const claims = verifyIdentityToken(token, 'space-secret', now + 30_000)
  assert.equal(claims.user.displayName, '张三')
  assert.equal(claims.space.role, 'operator')
  assert.equal(claims.exp - claims.iat, 60)
  assert.throws(() => verifyIdentityToken(token, 'wrong-secret', now), /signature/)
  assert.deepEqual(withoutInboundIdentityHeaders({ host: 'localhost', 'x-guanyin-identity': 'forged', 'X-Guanyin-Identity-Extra': 'forged' }), { host: 'localhost' })
  assert.deepEqual(withoutControlPlaneCookies({ cookie: 'guanyin_session=secret; dsh-auth-web=allowed; guanyin_instance=space-1' }), { cookie: 'dsh-auth-web=allowed' })
})
