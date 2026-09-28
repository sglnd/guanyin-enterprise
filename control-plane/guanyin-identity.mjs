import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const ISSUER = 'guanyin-control-plane'
const AUDIENCE = 'guanyin-dsh'

function encode(value) {
  return Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
}

function signature(input, secret) {
  return createHmac('sha256', secret).update(input).digest('base64url')
}

export function createIdentityToken({ user, instance, impersonated = false }, secret, now = Date.now()) {
  if (!secret) throw new Error('空间身份签名密钥不存在')
  const issuedAt = Math.floor(now / 1000)
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({
    iss: ISSUER,
    aud: AUDIENCE,
    sub: user.id,
    iat: issuedAt,
    exp: issuedAt + 60,
    jti: randomUUID(),
    user: { id: user.id, username: user.username, displayName: user.displayName, platformRole: user.role },
    tenant: { id: user.tenantId, name: user.tenantName },
    space: { id: instance.id, name: instance.name, role: instance.accessRole || (impersonated ? 'platform_admin' : 'member') },
    impersonated: Boolean(impersonated),
  })
  const input = `${header}.${payload}`
  return `${input}.${signature(input, secret)}`
}

export function verifyIdentityToken(token, secret, now = Date.now()) {
  const [headerPart, payloadPart, actualPart, extra] = String(token || '').split('.')
  if (!headerPart || !payloadPart || !actualPart || extra || !secret) throw new Error('invalid identity token')
  const input = `${headerPart}.${payloadPart}`
  const actual = Buffer.from(actualPart)
  const expected = Buffer.from(signature(input, secret))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid identity signature')
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  const timestamp = Math.floor(now / 1000)
  if (header.alg !== 'HS256' || payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.exp <= timestamp || payload.iat > timestamp + 5) throw new Error('expired or invalid identity claims')
  return payload
}

export function withoutInboundIdentityHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !name.toLowerCase().startsWith('x-guanyin-identity')))
}

export function withoutControlPlaneCookies(headers = {}) {
  const sanitized = { ...headers }
  const cookieKey = Object.keys(sanitized).find(name => name.toLowerCase() === 'cookie')
  if (!cookieKey) return sanitized
  const cookies = String(sanitized[cookieKey] || '').split(';').map(value => value.trim()).filter(Boolean)
    .filter(value => !/^guanyin_(?:session|instance)=/i.test(value))
  if (cookies.length) sanitized[cookieKey] = cookies.join('; ')
  else delete sanitized[cookieKey]
  return sanitized
}
