import test from 'node:test'
import assert from 'node:assert/strict'
import { enterpriseSessionCookies, withoutControlPlaneCookies } from '../guanyin-identity.mjs'

test('community and enterprise logins/workspaces coexist on the same hostname', () => {
  const header = 'guanyin_session=community; guanyin_ent_session=enterprise; guanyin_instance=community-space; guanyin_ent_instance=enterprise-space; dsh-auth-web=native'
  assert.deepEqual(enterpriseSessionCookies(header), { sessionToken: 'enterprise', instanceId: 'enterprise-space' })
  assert.deepEqual(enterpriseSessionCookies('guanyin_session=community; guanyin_instance=community-space'), { sessionToken: undefined, instanceId: undefined })
  assert.deepEqual(withoutControlPlaneCookies({ Cookie: header }), { Cookie: 'dsh-auth-web=native' })
})
