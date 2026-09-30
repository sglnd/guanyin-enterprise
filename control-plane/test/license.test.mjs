import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import test from 'node:test'
import { inspectLicense, publicLicenseStatus } from '../license.mjs'

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const pem = publicKey.export({ type: 'spki', format: 'pem' })
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
function token(overrides = {}) {
  const header = encode({ alg: 'EdDSA', typ: 'JWT' })
  const payload = encode({ iss: 'guanyin-license-issuer', aud: 'guanyin-enterprise', edition: 'enterprise', license_id: 'lic_test', customer_name: '示例客户', iat: 1_700_000_000, exp: 1_900_000_000, ...overrides })
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  return `${header}.${payload}.${signature}`
}

test('accepts a valid license for the exact normalized customer name', () => {
  const result = inspectLicense({ customerName: ' 示例客户 ', token: token(), publicKey: pem, now: new Date('2026-01-01T00:00:00Z') })
  assert.equal(result.valid, true)
  assert.deepEqual(publicLicenseStatus(result), { valid: true, code: 'LICENSE_VALID', message: 'License 有效', customerName: '示例客户', licenseId: 'lic_test', expiresAt: '2030-03-17T17:46:40.000Z' })
})

test('rejects customer mismatch, expiry and tampering', () => {
  assert.equal(inspectLicense({ customerName: '其他客户', token: token(), publicKey: pem }).code, 'LICENSE_CUSTOMER_MISMATCH')
  assert.equal(inspectLicense({ customerName: '示例客户', token: token({ exp: 1_700_000_001 }), publicKey: pem, now: new Date('2026-01-01') }).code, 'LICENSE_EXPIRED')
  const parts = token().split('.')
  const signature = Buffer.from(parts[2], 'base64url')
  signature[0] ^= 1
  const changed = `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`
  assert.equal(inspectLicense({ customerName: '示例客户', token: changed, publicKey: pem }).code, 'LICENSE_INVALID')
})
