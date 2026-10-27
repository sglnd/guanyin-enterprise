import { randomUUID } from 'node:crypto'

export class PromptAuditError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

// Both supported DSH versions send new user content here. Never inspect model
// context, other RPCs, uploads, headers, or AI responses for audit content.
export async function auditPromptBeforeForward(req, { user, instance, save, ip }) {
  if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/api/session/prompt') return undefined
  if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw new PromptAuditError(415, '聊天输入暂不支持压缩请求')
  const limit = 16 * 1024 * 1024
  let size = 0, tooLarge = false
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) { tooLarge = true; chunks.length = 0 }
    if (!tooLarge) chunks.push(chunk)
  }
  if (tooLarge) throw new PromptAuditError(413, '聊天输入请求不能超过 16 MiB')
  const body = Buffer.concat(chunks)
  let request
  try {
    const envelope = JSON.parse(body.toString('utf8'))
    if (envelope.method !== 'session/prompt') throw new Error('method')
    request = envelope.payload?.args?.request || envelope.payload?.args
    if (!request || !Array.isArray(request.content)
      || !['sessionId', 'requestId'].every(key => typeof request[key] === 'string' && request[key].length > 0 && request[key].length <= 200)
      || request.content.some(block => !block || typeof block !== 'object' || (block.type === 'text' && typeof block.text !== 'string'))) throw new Error('content')
  } catch { throw new PromptAuditError(400, '聊天输入请求格式无效，消息尚未发送') }
  const texts = request.content.filter(block => block.type === 'text').map(block => block.text)
  try {
    // Deliberately do not use the best-effort audit() wrapper. Fail closed:
    // not one byte goes to DSH until the platform database confirms the write.
    await save({ id: randomUUID(), actorUserId: user.id, targetUserId: user.id,
      targetInstanceId: instance.id, action: 'user_chat_input', details: {
        sessionId: request.sessionId, requestId: request.requestId, texts,
        runtimeVersion: instance.version, spaceName: instance.name,
        userName: user.displayName || user.username, tenantId: instance.tenantId,
        impersonated: Boolean(instance.impersonated), ip,
      } })
  } catch { throw new PromptAuditError(503, '用户输入审计暂不可用，消息尚未发送，请稍后重试') }
  return body
}
