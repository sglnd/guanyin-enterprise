import { createPublicKey, verify } from 'node:crypto'

const ISSUER = 'guanyin-license-issuer'
const AUDIENCE = 'guanyin-enterprise'
const MAX_TOKEN_LENGTH = 16_384

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

export function normalizeCustomerName(value) {
  return String(value || '').trim().normalize('NFC')
}

export function inspectLicense({ customerName, token, publicKey, now = new Date() }) {
  const normalizedName = normalizeCustomerName(customerName)
  const compact = String(token || '').trim()
  const unavailable = (code, message, claims) => ({ valid: false, code, message, customerName: normalizedName, claims })
  if (!normalizedName || !compact) return unavailable('LICENSE_REQUIRED', '请填写客户名称和 License')
  if (!publicKey) return unavailable('LICENSE_PUBLIC_KEY_MISSING', '系统未配置 License 验签公钥')
  if (compact.length > MAX_TOKEN_LENGTH) return unavailable('LICENSE_INVALID', 'License 格式无效')
  const parts = compact.split('.')
  if (parts.length !== 3 || parts.some(part => !part)) return unavailable('LICENSE_INVALID', 'License 格式无效')
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts
    const header = decodeJson(encodedHeader)
    const claims = decodeJson(encodedPayload)
    if (header.alg !== 'EdDSA' || header.typ !== 'JWT') return unavailable('LICENSE_INVALID', 'License 签名算法无效')
    const signatureValid = verify(null, Buffer.from(`${encodedHeader}.${encodedPayload}`), createPublicKey(publicKey), Buffer.from(encodedSignature, 'base64url'))
    if (!signatureValid) return unavailable('LICENSE_INVALID', 'License 签名校验失败')
    if (claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.edition !== 'enterprise') return unavailable('LICENSE_INVALID', 'License 签发信息无效')
    if (!claims.license_id || !Number.isInteger(claims.iat) || !Number.isInteger(claims.exp)) return unavailable('LICENSE_INVALID', 'License 声明不完整')
    if (normalizeCustomerName(claims.customer_name) !== normalizedName) return unavailable('LICENSE_CUSTOMER_MISMATCH', '客户名称与 License 不匹配', claims)
    const timestamp = Math.floor(now.getTime() / 1000)
    if (Number.isInteger(claims.nbf) && timestamp < claims.nbf) return unavailable('LICENSE_NOT_YET_VALID', 'License 尚未生效', claims)
    if (timestamp >= claims.exp) return unavailable('LICENSE_EXPIRED', 'License 已过期，请更新 License', claims)
    return { valid: true, code: 'LICENSE_VALID', message: 'License 有效', customerName: normalizedName, claims }
  } catch {
    return unavailable('LICENSE_INVALID', 'License 格式或签名无效')
  }
}

export function publicLicenseStatus(result) {
  return {
    valid: result.valid,
    code: result.code,
    message: result.message,
    customerName: result.customerName || '',
    ...(result.claims ? {
      licenseId: result.claims.license_id,
      expiresAt: new Date(result.claims.exp * 1000).toISOString(),
    } : {}),
  }
}
