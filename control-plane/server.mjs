import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import * as store from './store.mjs'

const PORT = Number(process.env.PORT || 8080)
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/app/public'
const NAMESPACE = process.env.DSH_NAMESPACE || 'guanyin-instances'
const DSH_IMAGE = process.env.DSH_IMAGE || 'bankops/deepseek-harness-agent:0.2.9-arm64'
const DSH_VERSION = process.env.DSH_VERSION || '0.2.9-arm64'
const PUBLIC_HOSTS = process.env.DSH_TRUSTED_HOSTS || 'localhost:18080,127.0.0.1:18080'
const DSH_PERMISSION_MODE = process.env.DSH_PERMISSION_MODE || 'danger-full-access'
const SESSION_TTL = 12 * 60 * 60 * 1000
const IDLE_TIMEOUT_MINUTES = Number(process.env.IDLE_TIMEOUT_MINUTES || 60)
const isDevelopment = process.env.NODE_ENV !== 'production'
const activeTouches = new Map()

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}

function verifyPassword(password, encoded) {
  const [salt, expectedHex] = String(encoded).split(':')
  if (!salt || !expectedHex) return false
  const actual = scryptSync(password, salt, 64)
  const expected = Buffer.from(expectedHex, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(Boolean).map(v => {
    const index = v.indexOf('=')
    return [decodeURIComponent(v.slice(0, index)), decodeURIComponent(v.slice(index + 1))]
  }))
}

async function currentUser(req) { return store.userBySession(cookies(req).guanyin_session) }

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, ...headers })
  res.end()
}

async function bodyJson(req) {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 1_000_000) throw new Error('request_too_large')
  }
  return body ? JSON.parse(body) : {}
}

function safeName(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32)
}

function idleTimeout(value) {
  if (value === '' || value === null || value === undefined || value === 'never') return null
  const minutes = Number(value)
  return Number.isInteger(minutes) && minutes >= 15 && minutes <= 10080 ? minutes : undefined
}

function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, tenantId: user.tenantId, tenantName: user.tenantName, enabled: user.enabled } }

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim().slice(0, 64)
}

function temporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const bytes = randomBytes(16)
  return [...bytes].map(value => alphabet[value % alphabet.length]).join('')
}

function audit(entry) {
  return store.createAuditLog({ id: randomUUID(), ...entry }).catch(error => console.error('audit write failed', error))
}

function markInstanceActive(id) {
  const now = Date.now()
  if (now - (activeTouches.get(id) || 0) < 60_000) return
  activeTouches.set(id, now)
  store.touchInstance(id).catch(error => console.error('instance activity update failed', error))
}

function k8sClient() {
  const host = process.env.KUBERNETES_SERVICE_HOST
  if (!host) return null
  return {
    host,
    port: Number(process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443),
    tokenPath: '/var/run/secrets/kubernetes.io/serviceaccount/token',
    caPath: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
  }
}

async function k8sRequest(method, path, payload) {
  const client = k8sClient()
  if (!client) throw new Error('Kubernetes API is unavailable')
  const [token, ca] = await Promise.all([readFile(client.tokenPath, 'utf8'), readFile(client.caPath)])
  return new Promise((resolve, reject) => {
    const request = https.request({ hostname: client.host, port: client.port, path, method, ca, headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      ...(payload ? { 'content-type': method === 'PATCH' ? 'application/merge-patch+json' : 'application/json' } : {}),
    } }, response => {
      let content = ''
      response.on('data', chunk => { content += chunk })
      response.on('end', () => {
        const parsed = content ? JSON.parse(content) : {}
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(parsed)
        else reject(new Error(parsed.message || `Kubernetes API returned ${response.statusCode}`))
      })
    })
    request.on('error', reject)
    if (payload) request.end(JSON.stringify(payload)); else request.end()
  })
}

async function createResource(kind, resource) {
  const paths = {
    Secret: `/api/v1/namespaces/${NAMESPACE}/secrets`,
    PersistentVolumeClaim: `/api/v1/namespaces/${NAMESPACE}/persistentvolumeclaims`,
    Service: `/api/v1/namespaces/${NAMESPACE}/services`,
    Deployment: `/apis/apps/v1/namespaces/${NAMESPACE}/deployments`,
  }
  try { return await k8sRequest('POST', paths[kind], resource) }
  catch (error) {
    if (String(error.message).includes('already exists')) return undefined
    throw error
  }
}

async function provision(instance) {
  const name = `dsh-${instance.slug}`
  const labels = { 'app.kubernetes.io/name': 'dsh', 'guanyin.io/instance': instance.id }
  const probeHttpGet = { path: '/', port: 3080, httpHeaders: [{ name: 'Host', value: PUBLIC_HOSTS.split(',')[0] }] }
  await createResource('Secret', { apiVersion: 'v1', kind: 'Secret', metadata: { name, labels }, stringData: { extensionToken: randomBytes(32).toString('hex') } })
  for (const suffix of ['data', 'home']) await createResource('PersistentVolumeClaim', {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${name}-${suffix}`, labels },
    spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '2Gi' } } },
  })
  await createResource('Service', { apiVersion: 'v1', kind: 'Service', metadata: { name, labels }, spec: { selector: labels, ports: [{ name: 'web', port: 3080, targetPort: 3080 }] } })
  await createResource('Deployment', {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, labels },
    // Each workspace uses ReadWriteOnce volumes. Recreate guarantees that an
    // update never starts two DSH processes against the same home/data PVCs.
    spec: { replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'dsh', image: DSH_IMAGE, imagePullPolicy: 'Never', ports: [{ containerPort: 3080 }],
        env: [
          { name: 'DSH_HOME', value: '/data/dsh' }, { name: 'BANKOPS_WEB_PROXY', value: '1' },
          { name: 'DSH_BROWSER_AUTH_MODE', value: 'trusted-host' }, { name: 'DSH_TRUSTED_HOSTS', value: PUBLIC_HOSTS },
          { name: 'DSH_PERMISSION_MODE', value: DSH_PERMISSION_MODE }, { name: 'DEEPSEEK_API_KEY', value: 'pending-model-service' },
          { name: 'DEEPSEEK_BASE_URL', value: 'https://api.deepseek.com' },
          { name: 'DSH_EXT_TOKEN', valueFrom: { secretKeyRef: { name, key: 'extensionToken' } } },
        ],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '2', memory: '4Gi' } },
        // A startup probe gives first-run profile migration enough time without
        // confusing initialization with a permanently unhealthy pod.
        startupProbe: { httpGet: probeHttpGet, periodSeconds: 10, timeoutSeconds: 10, failureThreshold: 60 },
        readinessProbe: { httpGet: probeHttpGet, periodSeconds: 10, timeoutSeconds: 10, failureThreshold: 6 },
        volumeMounts: [{ name: 'data', mountPath: '/data/dsh' }, { name: 'home', mountPath: '/home/node' }, { name: 'workspace', mountPath: '/workspace' }],
      }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }, { name: 'home', persistentVolumeClaim: { claimName: `${name}-home` } }, { name: 'workspace', emptyDir: {} }],
    } } },
  })
}

async function refreshInstanceStatus(instance) {
  try {
    const deployment = await k8sRequest('GET', `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}`)
    instance.status = deployment.spec?.replicas === 0 ? 'stopped' : deployment.status?.readyReplicas > 0 ? 'running' : 'starting'
  } catch { instance.status = 'error' }
  await store.updateInstance(instance.id, { status: instance.status })
}

async function scaleInstance(instance, replicas) {
  await k8sRequest('PATCH', `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}/scale`, { spec: { replicas } })
  const status = replicas === 0 ? 'stopped' : 'starting'
  await store.updateInstance(instance.id, { status, error: null })
  instance.status = status
  return instance
}

async function api(req, res, path) {
  if (path === '/api/login' && req.method === 'POST') {
    const input = await bodyJson(req)
    const user = await store.userByUsername(String(input.username || '').trim())
    if (!user || !user.enabled || !verifyPassword(String(input.password || ''), user.passwordHash)) return sendJson(res, 401, { error: '用户名或密码错误' })
    const token = randomBytes(32).toString('base64url')
    await store.createSession(token, user.id, Date.now() + SESSION_TTL)
    await audit({ actorUserId: user.id, action: 'user_login', targetUserId: user.id, details: { ip: clientIp(req) } })
    return sendJson(res, 200, { user: publicUser(user) }, { 'set-cookie': `guanyin_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}` })
  }
  const user = await currentUser(req)
  if (!user) return sendJson(res, 401, { error: '请先登录' })
  if (path === '/api/logout' && req.method === 'POST') {
    await audit({ actorUserId: user.id, action: 'user_logout', targetUserId: user.id, details: { ip: clientIp(req) } })
    await store.deleteSession(cookies(req).guanyin_session)
    return sendJson(res, 200, { ok: true }, { 'set-cookie': 'guanyin_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' })
  }
  if (path === '/api/me') return sendJson(res, 200, { user: publicUser(user), version: DSH_VERSION })
  if (path === '/api/instances' && req.method === 'GET') {
    const instances = await store.listInstances(user)
    await Promise.all(instances.map(refreshInstanceStatus))
    return sendJson(res, 200, { instances })
  }
  const launch = path.match(/^\/api\/instances\/([^/]+)\/launch$/)
  if (launch && req.method === 'POST') {
    const instance = await store.instanceOwnedByUser(launch[1], user.id)
    if (!instance) return sendJson(res, 403, { error: '无权访问该实例' })
    await refreshInstanceStatus(instance)
    if (instance.status === 'stopped' || instance.status === 'stopping') { await scaleInstance(instance, 1); return sendJson(res, 202, { starting: true }) }
    if (instance.status !== 'running') return sendJson(res, 202, { starting: true })
    markInstanceActive(instance.id)
    await audit({ actorUserId: user.id, action: 'dsh_enter', targetInstanceId: instance.id, targetUserId: user.id, details: { accessRole: instance.accessRole, ip: clientIp(req) } })
    return sendJson(res, 200, { location: '/' }, { 'set-cookie': `guanyin_instance=${instance.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}` })
  }
  const lifecycle = path.match(/^\/api\/instances\/([^/]+)\/(start|stop)$/)
  if (lifecycle && req.method === 'POST') {
    const instance = user.role === 'platform_admin' ? await store.instanceById(lifecycle[1]) : await store.instanceOwnedByUser(lifecycle[1], user.id)
    const allowed = instance && (user.role === 'platform_admin' || lifecycle[2] === 'start' || ['owner','operator'].includes(instance.accessRole))
    if (!allowed) return sendJson(res, 403, { error: '无权管理该空间' })
    const result = await scaleInstance(instance, lifecycle[2] === 'start' ? 1 : 0)
    await audit({
      actorUserId: user.id, action: `${user.role === 'platform_admin' ? 'admin_' : ''}instance_${lifecycle[2]}`,
      targetInstanceId: instance.id, targetUserId: user.id,
      details: { source: user.role === 'platform_admin' ? 'instance_management' : 'workspace', ip: clientIp(req) },
    })
    return sendJson(res, 202, { instance: result })
  }
  if (user.role !== 'platform_admin') return sendJson(res, 403, { error: '需要平台管理员权限' })
  if (path === '/api/admin/overview') { const data = await store.overview(); return sendJson(res, 200, { tenants: data.tenants, users: data.users.map(publicUser), versions: [{ id: DSH_VERSION, image: DSH_IMAGE, enabled: true }] }) }
  if (path === '/api/admin/instances' && req.method === 'GET') {
    const instances = await store.listAllInstances()
    await Promise.all(instances.map(refreshInstanceStatus))
    return sendJson(res, 200, { instances })
  }
  const instanceMembers = path.match(/^\/api\/admin\/instances\/([^/]+)\/members$/)
  if (instanceMembers && req.method === 'GET') {
    if (!await store.instanceById(instanceMembers[1])) return sendJson(res, 404, { error: '空间不存在' })
    return sendJson(res, 200, { members: await store.listInstanceMembers(instanceMembers[1]) })
  }
  if (instanceMembers && req.method === 'PUT') {
    const instance = await store.instanceById(instanceMembers[1]); const input = await bodyJson(req)
    const member = await store.userById(input.userId); const accessRole = ['owner','operator','member'].includes(input.accessRole) ? input.accessRole : undefined
    if (!instance || !member || !accessRole) return sendJson(res, 400, { error: '空间、用户或空间角色无效' })
    if (member.tenantId !== instance.tenantId) return sendJson(res, 400, { error: '只能绑定同一租户内的用户' })
    const currentMembers = await store.listInstanceMembers(instance.id)
    const current = currentMembers.find(item => item.id === member.id)
    if (current?.accessRole === 'owner' && accessRole !== 'owner') return sendJson(res, 400, { error: '不能直接降低负责人的权限，请先将另一名成员设为负责人' })
    await store.setInstanceMember(instance.id, member.id, accessRole)
    await audit({ actorUserId: user.id, action: 'space_member_set', targetInstanceId: instance.id, targetUserId: member.id, details: { accessRole, ip: clientIp(req) } })
    return sendJson(res, 200, { members: await store.listInstanceMembers(instance.id) })
  }
  const removeMember = path.match(/^\/api\/admin\/instances\/([^/]+)\/members\/([^/]+)$/)
  if (removeMember && req.method === 'DELETE') {
    const instance = await store.instanceById(removeMember[1]); const member = await store.userById(removeMember[2])
    if (!instance || !member) return sendJson(res, 404, { error: '空间或用户不存在' })
    if (!await store.removeInstanceMember(instance.id, member.id)) return sendJson(res, 400, { error: '空间负责人不能直接移除，请先指定新的负责人' })
    await audit({ actorUserId: user.id, action: 'space_member_remove', targetInstanceId: instance.id, targetUserId: member.id, details: { ip: clientIp(req) } })
    return sendJson(res, 200, { members: await store.listInstanceMembers(instance.id) })
  }
  const updateSpace = path.match(/^\/api\/admin\/instances\/([^/]+)$/)
  if (updateSpace && req.method === 'PATCH') {
    const instance = await store.instanceById(updateSpace[1]); const input = await bodyJson(req)
    const name = String(input.name || '').trim(); const timeout = idleTimeout(input.idleTimeoutMinutes)
    if (!instance) return sendJson(res, 404, { error: '空间不存在' })
    if (!name || timeout === undefined) return sendJson(res, 400, { error: '空间名称或休眠规则无效' })
    const updated = await store.updateInstanceSettings(instance.id, { name, idleTimeoutMinutes: timeout })
    await audit({ actorUserId: user.id, action: 'space_update', targetInstanceId: instance.id, details: { before: { name: instance.name, idleTimeoutMinutes: instance.idleTimeoutMinutes }, after: { name, idleTimeoutMinutes: timeout }, ip: clientIp(req) } })
    return sendJson(res, 200, { instance: updated })
  }
  if (path === '/api/admin/audit-logs' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    return sendJson(res, 200, await store.listAuditLogs({ limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }))
  }
  const userAudit = path.match(/^\/api\/admin\/users\/([^/]+)\/audit-logs$/)
  if (userAudit && req.method === 'GET') {
    if (!await store.userById(userAudit[1])) return sendJson(res, 404, { error: '用户不存在' })
    const url = new URL(req.url, 'http://localhost')
    return sendJson(res, 200, await store.listAuditLogs({ userId: userAudit[1], limit: url.searchParams.get('limit'), offset: url.searchParams.get('offset') }))
  }
  const impersonate = path.match(/^\/api\/admin\/instances\/([^/]+)\/impersonate$/)
  if (impersonate && req.method === 'POST') {
    const instance = await store.instanceById(impersonate[1])
    if (!instance) return sendJson(res, 404, { error: '实例不存在' })
    await refreshInstanceStatus(instance)
    if (instance.status !== 'running') return sendJson(res, 409, { error: '实例尚未就绪，请先启动并等待运行中' })
    await audit({ actorUserId: user.id, action: 'admin_impersonation_start', targetInstanceId: instance.id, details: { source: 'space_management', ip: clientIp(req) } })
    await store.grantAdminAccess(cookies(req).guanyin_session, instance.id, Date.now() + SESSION_TTL)
    markInstanceActive(instance.id)
    return sendJson(res, 200, { location: '/', warning: `您正在以平台管理员身份代入访问空间 ${instance.name}` }, { 'set-cookie': `guanyin_instance=${instance.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}` })
  }
  if (path === '/api/admin/tenants' && req.method === 'POST') {
    const input = await bodyJson(req); const code = safeName(input.code)
    if (!input.name || !code) return sendJson(res, 400, { error: '租户名称或编码无效/重复' })
    const tenant = { id: randomUUID(), name: String(input.name).trim(), code, createdAt: new Date().toISOString() }
    try { return sendJson(res, 201, { tenant: await store.createTenant(tenant) }) } catch (error) { if (error.code === '23505') return sendJson(res, 400, { error: '租户编码已存在' }); throw error }
  }
  if (path === '/api/admin/users' && req.method === 'POST') {
    const input = await bodyJson(req); const username = safeName(input.username)
    if (!username || String(input.password || '').length < 8 || !await store.tenantExists(input.tenantId)) return sendJson(res, 400, { error: '用户信息无效；密码至少 8 位且用户名不能重复' })
    const created = { id: randomUUID(), username, displayName: String(input.displayName || username).trim(), role: input.role === 'tenant_admin' ? 'tenant_admin' : 'member', tenantId: input.tenantId, passwordHash: hashPassword(input.password), enabled: true, createdAt: new Date().toISOString() }
    try {
      const createdUser = await store.createUser(created)
      await audit({ actorUserId: user.id, action: 'user_create', targetUserId: createdUser.id, details: { role: createdUser.role, tenantId: createdUser.tenantId, ip: clientIp(req) } })
      return sendJson(res, 201, { user: publicUser(createdUser) })
    } catch (error) { if (error.code === '23505') return sendJson(res, 400, { error: '用户名已存在' }); throw error }
  }
  const updateUser = path.match(/^\/api\/admin\/users\/([^/]+)$/)
  if (updateUser && req.method === 'PATCH') {
    const target = await store.userById(updateUser[1]); const input = await bodyJson(req)
    if (!target) return sendJson(res, 404, { error: '用户不存在' })
    if (target.role === 'platform_admin') return sendJson(res, 400, { error: '平台管理员资料暂不在此处修改' })
    const role = input.role === 'tenant_admin' ? 'tenant_admin' : 'member'
    const displayName = String(input.displayName || '').trim()
    if (!displayName || !await store.tenantExists(input.tenantId)) return sendJson(res, 400, { error: '用户名称或租户无效' })
    const updated = await store.updateUser(target.id, { displayName, role, tenantId: input.tenantId, enabled: input.enabled === true || input.enabled === 'true' })
    await audit({ actorUserId: user.id, action: 'user_update', targetUserId: target.id, details: { before: { displayName: target.displayName, role: target.role, tenantId: target.tenantId, enabled: target.enabled }, after: { displayName: updated.displayName, role: updated.role, tenantId: updated.tenantId, enabled: updated.enabled }, ip: clientIp(req) } })
    return sendJson(res, 200, { user: publicUser(updated) })
  }
  const resetPassword = path.match(/^\/api\/admin\/users\/([^/]+)\/reset-password$/)
  if (resetPassword && req.method === 'POST') {
    const target = await store.userById(resetPassword[1])
    if (!target) return sendJson(res, 404, { error: '用户不存在' })
    if (target.role === 'platform_admin') return sendJson(res, 400, { error: '平台管理员密码暂不在此处初始化' })
    const password = temporaryPassword()
    await store.resetUserPassword(target.id, hashPassword(password))
    await audit({ actorUserId: user.id, action: 'user_password_reset', targetUserId: target.id, details: { sessionsRevoked: true, ip: clientIp(req) } })
    return sendJson(res, 200, { temporaryPassword: password })
  }
  if (path === '/api/admin/instances' && req.method === 'POST') {
    const input = await bodyJson(req); const displayName = String(input.name || '').trim(); const slugBase = safeName(displayName) || 'workspace'; const timeout = idleTimeout(input.idleTimeoutMinutes)
    if (!displayName || !await store.tenantExists(input.tenantId) || timeout === undefined) return sendJson(res, 400, { error: '空间名称、租户或休眠规则无效' })
    const instance = { id: randomUUID(), name: displayName, slug: `${slugBase}-${randomBytes(3).toString('hex')}`, version: DSH_VERSION, image: DSH_IMAGE, tenantId: input.tenantId, status: 'provisioning', idleTimeoutMinutes: timeout, createdAt: new Date().toISOString() }
    await store.createInstance(instance)
    try { await provision(instance); instance.status = 'starting'; await store.updateInstance(instance.id, { status: instance.status }); await audit({ actorUserId: user.id, action: 'space_create', targetInstanceId: instance.id, details: { version: instance.version, tenantId: instance.tenantId, idleTimeoutMinutes: timeout, ip: clientIp(req) } }); return sendJson(res, 201, { instance }) }
    catch (error) { instance.status = 'error'; instance.error = error.message; await store.updateInstance(instance.id, { status: instance.status, error: instance.error }); return sendJson(res, 500, { error: error.message, instance }) }
  }
  return sendJson(res, 404, { error: '接口不存在' })
}

async function staticFile(req, res, path) {
  const file = path === '/console' || path === '/console/' ? 'index.html' : path.slice(1)
  if (file.includes('..')) return sendJson(res, 404, { error: 'not found' })
  try {
    const content = await readFile(join(PUBLIC_DIR, file))
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(content)
  } catch { sendJson(res, 404, { error: 'not found' }) }
}

async function selectedInstance(req) {
  const user = await currentUser(req)
  if (!user) return undefined
  const instanceId = cookies(req).guanyin_instance
  if (!/^[0-9a-f-]{36}$/i.test(instanceId || '')) return undefined
  const owned = await store.instanceOwnedByUser(instanceId, user.id)
  if (owned) return owned
  if (user.role === 'platform_admin' && await store.hasAdminAccess(cookies(req).guanyin_session, instanceId)) return store.instanceById(instanceId)
  return undefined
}

function proxyHttp(req, res, instance, user) {
  markInstanceActive(instance.id)
  const startedAt = Date.now()
  // DSH validates Origin against Host for its privileged /api RPC methods.
  // Preserve the browser-facing authority so settings, models and image-baked
  // management plugins keep the same-origin identity seen by the browser.
  const upstream = http.request({ hostname: `dsh-${instance.slug}.${NAMESPACE}.svc.cluster.local`, port: 3080, path: req.url, method: req.method, headers: { ...req.headers, host: req.headers.host || PUBLIC_HOSTS.split(',')[0], 'x-guanyin-user': user.id, 'x-guanyin-instance': instance.id } }, upstreamRes => {
    if (req.method === 'POST') {
      const rpcPath = new URL(req.url, 'http://localhost').pathname.slice(0, 200)
      audit({ actorUserId: user.id, action: 'dsh_operation', targetInstanceId: instance.id, targetUserId: user.id, details: { method: req.method, path: rpcPath, status: upstreamRes.statusCode, durationMs: Date.now() - startedAt, ip: clientIp(req) } })
    }
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers); upstreamRes.pipe(res)
  })
  upstream.on('error', error => sendJson(res, 502, { error: `DSH 实例暂不可用：${error.message}` }))
  req.pipe(upstream)
}

const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname
    if (path === '/healthz') return sendJson(res, 200, { ok: true })
    if (path === '/readyz') { await store.health(); return sendJson(res, 200, { ok: true }) }
    // DSH owns /api as its RPC carrier.  The control plane owns only its
    // explicit sub-routes; everything else is allowed through to the selected
    // image so image-baked settings/plugins/skills/MCP remain functional.
    const controlApi = path === '/api/login' || path === '/api/logout' || path === '/api/me' || path === '/api/instances'
      || /^\/api\/instances\/[^/]+\/(launch|start|stop)$/.test(path)
      || path.startsWith('/api/admin/')
    if (controlApi) return await api(req, res, path)
    if (path === '/login' || path === '/console' || path === '/console/' || path.startsWith('/app') || path === '/lifecycle.css' || path === '/guanyin-logo.png') return await staticFile(req, res, path === '/login' ? '/console/' : path)
    const user = await currentUser(req)
    if (!user) return redirect(res, '/login')
    if (path === '/' && !cookies(req).guanyin_instance) return redirect(res, '/console')
    const instance = await selectedInstance(req)
    if (!instance) return path === '/api' || path.startsWith('/api/')
      ? sendJson(res, 403, { error: '请先选择工作空间' })
      : redirect(res, '/console')
    return proxyHttp(req, res, instance, user)
  } catch (error) {
    if (isDevelopment) console.error(error)
    sendJson(res, 500, { error: '服务器内部错误' })
  }
})

server.on('upgrade', async (req, socket, head) => {
  const instance = await selectedInstance(req)
  if (!instance) return socket.destroy()
  markInstanceActive(instance.id)
  const upstream = net.connect(3080, `dsh-${instance.slug}.${NAMESPACE}.svc.cluster.local`, () => {
    const headers = Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
})

await store.initialize({ adminUsername: process.env.BOOTSTRAP_ADMIN_USER || 'admin', adminPasswordHash: hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Guanyin@2026') })
server.listen(PORT, '0.0.0.0', () => console.log(`Guanyin control plane listening on ${PORT}`))

setInterval(async () => {
  try {
    for (const instance of await store.claimIdleInstances()) await scaleInstance(instance, 0)
  } catch (error) { console.error('idle instance reconciliation failed', error) }
}, 60_000).unref()

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(async () => { await store.close(); process.exit(0) })
  setTimeout(() => process.exit(1), 10_000).unref()
})
