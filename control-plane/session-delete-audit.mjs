import { randomUUID } from 'node:crypto'

export class SessionDeleteAuditError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

export async function auditSessionDelete(req, { user, instance, save, complete, ip, log = () => {} }) {
  if (req.method !== 'POST' || new URL(req.url, 'http://localhost').pathname !== '/__guanyin/sessions/delete') return undefined
  const chunks = []; let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size <= 8192) chunks.push(chunk)
  }
  if (size > 8192) throw new SessionDeleteAuditError(413, '删除请求过大，操作尚未提交')
  let input
  const body = Buffer.concat(chunks)
  try {
    input = JSON.parse(body.toString('utf8'))
    if (!['sessionId', 'confirmation'].every(key => typeof input?.[key] === 'string' && input[key].length > 0 && input[key].length <= 200)) throw Error()
  } catch { throw new SessionDeleteAuditError(400, '删除请求格式无效，操作尚未提交') }
  const id = randomUUID()
  try {
    await save({ id, actorUserId: user.id, targetUserId: user.id, targetInstanceId: instance.id,
      action: 'session_delete', details: { sessionId: input.sessionId, deletionStatus: 'submitted',
        runtimeVersion: instance.version, spaceName: instance.name, tenantId: instance.tenantId,
        userName: user.displayName || user.username, impersonated: Boolean(instance.impersonated), ip } })
  } catch { throw new SessionDeleteAuditError(503, '删除审计暂不可用，操作尚未提交，请稍后重试') }
  let finished = false
  return { body, async finish(statusCode) {
    if (finished) return
    finished = true
    const deletionStatus = statusCode === 200 ? 'succeeded' : statusCode >= 400 && statusCode < 500 ? 'failed' : 'unknown'
    try { await complete(id, { deletionStatus, ...(statusCode ? { httpStatus: statusCode } : {}), completedAt: new Date().toISOString() }) }
    catch { log(`session deletion audit result pending: ${id}`) }
  } }
}
