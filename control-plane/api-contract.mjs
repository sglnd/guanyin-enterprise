import Ajv from 'ajv'

const ajv = new Ajv({ allErrors: true, strict: false })

export function normalizeApiManifest(input) {
  const manifest = {
    instruction: String(input.instruction || '').trim(),
    inputSchema: jsonObject(input.inputSchema, 'inputSchema'),
    outputSchema: jsonObject(input.outputSchema, 'outputSchema'),
    maxConcurrency: integer(input.maxConcurrency, 1, 100, 1),
    maxQueueSize: integer(input.maxQueueSize, 1, 10_000, 100),
    queueTimeoutSeconds: integer(input.queueTimeoutSeconds, 1, 86_400, 300),
    executionTimeoutSeconds: integer(input.executionTimeoutSeconds, 1, 86_400, 300),
  }
  if (!manifest.instruction) throw new Error('接口执行说明不能为空')
  for (const [name, schema] of [['inputSchema',manifest.inputSchema],['outputSchema',manifest.outputSchema]]) {
    if (schema.type !== 'object') throw new Error(`${name} 顶层类型必须是 object`)
    try { ajv.compile(schema) } catch (error) { throw new Error(`${name} 无效：${error.message}`) }
  }
  return manifest
}

function jsonObject(value, name) {
  let parsed = value
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) } catch { throw new Error(`${name} 必须是有效 JSON`) }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} 必须是 JSON 对象`)
  return parsed
}

function integer(value, min, max, fallback) {
  const number = value === '' || value == null ? fallback : Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`并发、队列或超时参数超出允许范围`)
  return number
}

export function generateApiDocumentation({ slug, name, description, version, contract }) {
  const runPath = `/openapi/v1/runs/${slug}`
  const openapi = {
    openapi: '3.1.0',
    info: { title: name, version: String(version), description: description || '' },
    servers: [{ url: '/' }],
    paths: {
      [runPath]: { post: {
        summary: name, description: description || '', operationId: `create_${slug.replaceAll('-','_')}_run`,
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'X-Request-ID', in: 'header', required: false, schema: { type: 'string', maxLength: 128 } }],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: {
          input: contract.inputSchema, conversationKey: { type: 'string', maxLength: 128 },
        } } } } },
        responses: { 202: { description: 'Run 已进入队列' }, 400: { description: '输入校验失败' }, 401: { description: 'API Key 无效' }, 429: { description: '队列已满' } },
      } },
      '/openapi/v1/runs/{runId}': { get: { summary: '查询 Run', security: [{ bearerAuth: [] }], parameters: [runIdParameter()], responses: { 200: { description: 'Run 状态' } } },
        delete: { summary: '取消 Run', security: [{ bearerAuth: [] }], parameters: [runIdParameter()], responses: { 200: { description: '取消结果' } } } },
      '/openapi/v1/runs/{runId}/events': { get: { summary: '订阅 Run SSE 事件', security: [{ bearerAuth: [] }], parameters: [runIdParameter(),
        { name: 'Last-Event-ID', in: 'header', schema: { type: 'integer', minimum: 0 } }], responses: { 200: { description: 'text/event-stream' } } } },
    },
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { Input: contract.inputSchema, Output: contract.outputSchema } },
  }
  const markdown = `# ${name}\n\n${description || ''}\n\n## 创建任务\n\n\`POST ${runPath}\`\n\n使用 \`Authorization: Bearer <API_KEY>\`。请求体包含 \`input\`，可选 \`conversationKey\`。\n\n## 查询与取消\n\n- \`GET /openapi/v1/runs/{runId}\`\n- \`DELETE /openapi/v1/runs/{runId}\`\n\n## SSE\n\n\`GET /openapi/v1/runs/{runId}/events\`，断线重连时传递 \`Last-Event-ID\`。\n`
  return { openapi, markdown }
}

function runIdParameter() { return { name: 'runId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } } }
