import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import * as store from './store.mjs'
import { ApiRunWorker, createDshAdapter, isTerminalApiRun, validateApiInput } from './api-runner.mjs'
import { generateApiDocumentation, normalizeApiManifest } from './api-contract.mjs'
import { managedMcpConfigMatches } from './mcp-sync.mjs'
import { apiBuilderTools, executeApiBuilderTool, generateApiDraftWithAi } from './api-builder-mcp.mjs'
import { createIdentityToken, withoutControlPlaneCookies, withoutInboundIdentityHeaders } from './guanyin-identity.mjs'
import { inspectLicense, normalizeCustomerName, publicLicenseStatus } from './license.mjs'

const PORT = Number(process.env.PORT || 8080)
const PUBLIC_DIR = process.env.PUBLIC_DIR || '/app/public'
const NAMESPACE = process.env.DSH_NAMESPACE || 'guanyin-enterprise-instances'
const DSH_IMAGE = process.env.DSH_IMAGE || 'bankops/guanyin-enterprise-dsh:0.1.5-rc.2-gy.ent.2-arm64'
const DSH_VERSION = process.env.DSH_VERSION || '0.1.5-rc.2-gy.ent.2'
const DSH_IMAGE_PULL_POLICY = process.env.DSH_IMAGE_PULL_POLICY || 'IfNotPresent'
const DSH_STORAGE_CLASS = process.env.DSH_STORAGE_CLASS || ''
const pvcSize = (name, fallback = '2Gi') => {
  const value = String(process.env[name] || fallback).trim()
  if (!/^[1-9]\d*(Mi|Gi|Ti)$/.test(value)) throw new Error(`${name} 必须是正整数容量，例如 2Gi、20Gi 或 1Ti`)
  return value
}
const DSH_PVC_SIZES = {
  data: pvcSize('DSH_DATA_PVC_SIZE'),
  home: pvcSize('DSH_HOME_PVC_SIZE'),
  workspace: pvcSize('DSH_WORKSPACE_PVC_SIZE'),
}
const PUBLIC_HOSTS = process.env.DSH_TRUSTED_HOSTS || 'localhost:18081,127.0.0.1:18081'
const DSH_PERMISSION_MODE = process.env.DSH_PERMISSION_MODE || 'danger-full-access'
const API_BUILDER_MCP_URL = process.env.API_BUILDER_MCP_URL || 'http://guanyin-control-plane.guanyin-enterprise-system.svc.cluster.local:18081/internal/mcp/api-builder'
const SESSION_TTL = 12 * 60 * 60 * 1000
const IDLE_TIMEOUT_MINUTES = Number(process.env.IDLE_TIMEOUT_MINUTES || 60)
const isDevelopment = process.env.NODE_ENV !== 'production'
const LICENSE_PUBLIC_KEY = String(process.env.GUANYIN_LICENSE_PUBLIC_KEY || '').replace(/\\n/g, '\n').trim()
const activeTouches = new Map()

async function licenseStatus() {
  const saved = await store.enterpriseLicense()
  if (!saved) return { valid: false, code: 'LICENSE_REQUIRED', message: '请配置客户名称和 License', customerName: '' }
  return inspectLicense({ customerName: saved.customerName, token: saved.token, publicKey: LICENSE_PUBLIC_KEY })
}

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

function sameSecret(actual, expected) {
  const left = Buffer.from(String(actual || ''))
  const right = Buffer.from(String(expected || ''))
  return left.length === right.length && timingSafeEqual(left, right)
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

function mcpInput(input, updating = false) {
  const name = String(input.name || '').trim()
  const serverName = String(input.serverName || '').trim()
  const description = String(input.description || '').trim()
  const url = String(input.url || '').trim()
  let headers
  if (!updating || input.headers !== undefined) {
    headers = typeof input.headers === 'string' ? JSON.parse(input.headers || '{}') : (input.headers || {})
    if (!headers || Array.isArray(headers) || Object.values(headers).some(value => typeof value !== 'string')) throw new Error('请求头必须是 JSON 字符串键值对象')
  }
  if (!name || !/^[A-Za-z0-9_-]{1,32}$/.test(serverName) || !/^https?:\/\/.+/.test(url)) throw new Error('MCP 名称、serverName 或服务地址无效')
  return { name, serverName, description, transport: 'streamable-http', url, headers, enabled: input.enabled === true || input.enabled === 'true' }
}

function publicUser(user) { return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, mcpAdmin: user.mcpAdmin, apiAdmin: user.apiAdmin, tenantId: user.tenantId, tenantName: user.tenantName, enabled: user.enabled } }

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
    ConfigMap: `/api/v1/namespaces/${NAMESPACE}/configmaps`,
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

async function upsertResource(kind, name, resource) {
  const paths = { ConfigMap: 'configmaps', Secret: 'secrets' }
  try {
    const created = await createResource(kind, resource)
    if (created) return created
    return k8sRequest('PATCH', `/api/v1/namespaces/${NAMESPACE}/${paths[kind]}/${name}`, resource)
  }
  catch (error) {
    if (!String(error.message).includes('already exists')) throw error
    return k8sRequest('PATCH', `/api/v1/namespaces/${NAMESPACE}/${paths[kind]}/${name}`, resource)
  }
}

function mcpResourceName(instance) { return `dsh-${instance.slug}-mcp` }

function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)) }

async function waitForDeploymentReady(path, generation, replicas, timeoutMs = 120_000) {
  if (replicas === 0) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const deployment = await k8sRequest('GET', path)
    const observed = Number(deployment.status?.observedGeneration || 0) >= Number(generation || 0)
    const ready = Number(deployment.status?.readyReplicas || 0) >= replicas
    const updated = Number(deployment.status?.updatedReplicas || 0) >= replicas
    const unavailable = Number(deployment.status?.unavailableReplicas || 0)
    if (observed && ready && updated && unavailable === 0) return
    await delay(2_000)
  }
  throw new Error('MCP 配置已保存，但空间刷新超时，请稍后查看空间状态')
}

function mcpEntry(item) {
  return { id: `guanyin-mcp-${item.serverName}`, config: {
    serverName: item.serverName, transport: item.transport, url: item.url,
    ...(Object.keys(item.headers || {}).length ? { headers: item.headers } : {}),
  } }
}

async function callMcpManager(instance, endpoint, payload = {}) {
  const token = await instanceExtensionToken(instance)
  const response = await fetch(`http://dsh-${instance.slug}.${NAMESPACE}.svc.cluster.local:3080/__guanyin/mcp-manager/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-guanyin-token': token },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(15_000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `DSH MCP Manager 返回 HTTP ${response.status}`)
  if (!data.result?.ok) throw new Error(data.result?.error?.message || 'DSH MCP Manager 调用失败')
  return data.result.value
}

async function instanceExtensionToken(instance) {
  const secret = await k8sRequest('GET', `/api/v1/namespaces/${NAMESPACE}/secrets/dsh-${instance.slug}`)
  const token = Buffer.from(secret.data?.extensionToken || '', 'base64').toString('utf8')
  if (!token) throw new Error('空间内部管理密钥不存在')
  return token
}

async function removeMcpEntries(instance, id) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await callMcpManager(instance, 'list')
    if (!(current.servers || []).some(item => item.id === id)) return
    if (attempt === 0) await callMcpManager(instance, 'remove', { id })
    await delay(500)
  }
  throw new Error(`MCP 配置 ${id} 删除后 DSH 重载未完成，请稍后重试`)
}

const mcpSyncQueues = new Map()
function applySpaceMcp(instance) {
  const previous = mcpSyncQueues.get(instance.id) || Promise.resolve()
  const next = previous.catch(() => {}).then(() => reconcileSpaceMcp(instance))
  mcpSyncQueues.set(instance.id, next)
  void next.finally(() => {
    if (mcpSyncQueues.get(instance.id) === next) mcpSyncQueues.delete(instance.id)
  }).catch(() => {})
  return next
}

async function waitForMcpEntry(instance, entry) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const current = await callMcpManager(instance, 'list')
    const matches = (current.servers || []).filter(item => item.id === entry.id)
    if (matches.length === 1 && managedMcpConfigMatches(matches[0], entry.config)) return
    await delay(500)
  }
  throw new Error(`MCP ${entry.config.serverName} 配置已保存，但 DSH 重载未完成，请稍后重试`)
}

async function reconcileSpaceMcp(instance) {
  const name = mcpResourceName(instance)
  const labels = { 'app.kubernetes.io/name': 'dsh', 'guanyin.io/instance': instance.id, 'guanyin.io/config': 'mcp' }
  const bindings = await store.listSpaceMcpBindings(instance.id, true)
  const revision = `${Date.now()}`
  await upsertResource('ConfigMap', name, { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name, labels }, data: {
    'config.json': JSON.stringify({ revision, servers: bindings.map(({ headers, ...item }) => item) }, null, 2),
  } })
  const deploymentPath = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}`
  const deployment = await k8sRequest('GET', deploymentPath)
  const replicas = Number(deployment.spec.replicas || 0)
  if (replicas === 0) return revision
  const token = await instanceExtensionToken(instance)
  const current = await callMcpManager(instance, 'list')
  const desired = new Map(bindings.filter(item => item.enabled).map(item => { const entry = mcpEntry(item); return [entry.id, entry] }))
  const apiBuilder = { id: 'guanyin-mcp-api-builder', config: {
    serverName: 'guanyin-api-builder', transport: 'streamable-http', url: API_BUILDER_MCP_URL,
    headers: { 'X-Guanyin-Instance': instance.id, 'X-Guanyin-Token': token },
  } }
  desired.set(apiBuilder.id, apiBuilder)
  const managed = (current.servers || []).filter(item => item.id.startsWith('guanyin-mcp-'))
  for (const id of new Set(managed.filter(item => !desired.has(item.id)).map(item => item.id))) {
    await removeMcpEntries(instance, id)
  }
  for (const entry of desired.values()) {
    const existing = managed.filter(item => item.id === entry.id)
    const unchanged = existing.length === 1 && managedMcpConfigMatches(existing[0], entry.config)
    if (unchanged) continue
    if (existing.length) await removeMcpEntries(instance, entry.id)
    await callMcpManager(instance, 'add', entry)
    await waitForMcpEntry(instance, entry)
  }
  return revision
}

async function syncSpaceMcpWhenReady(instance) {
  const path = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}`
  const deployment = await k8sRequest('GET', path)
  const replicas = Number(deployment.spec.replicas || 0)
  if (replicas === 0) return
  await waitForDeploymentReady(path, deployment.metadata?.generation, replicas)
  await applySpaceMcp(instance)
}

async function apiBuilderMcp(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
  const instanceId = String(req.headers['x-guanyin-instance'] || '')
  const instance = /^[0-9a-f-]{36}$/i.test(instanceId) ? await store.instanceById(instanceId) : undefined
  if (!instance) return sendJson(res, 401, { error: 'invalid space credential' })
  const expected = await instanceExtensionToken(instance)
  if (!sameSecret(req.headers['x-guanyin-token'], expected)) return sendJson(res, 401, { error: 'invalid space credential' })
  const message = await bodyJson(req)
  const rpc = async item => {
    const { id, method, params = {} } = item || {}
    if (method === 'initialize') return { jsonrpc: '2.0', id, result: {
      protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'guanyin-api-builder', version: '0.1.0' },
    } }
    if (method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: apiBuilderTools } }
    if (method === 'tools/call') {
      try {
        const value = await executeApiBuilderTool(params.name, params.arguments || {}, { store, instance, audit })
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } }
      } catch (error) {
        const message = error.code === '23505' ? '接口标识已存在，请换一个 slug' : error.message
        return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: message }] } }
      }
    }
    if (id === undefined) return undefined
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
  }
  const response = Array.isArray(message)
    ? (await Promise.all(message.map(rpc))).filter(Boolean)
    : await rpc(message)
  if (response === undefined || (Array.isArray(response) && response.length === 0)) {
    res.writeHead(202, { 'cache-control': 'no-store' }); return res.end()
  }
  return sendJson(res, 200, response)
}

async function manageableSpace(user, instanceId) {
  if (user.role === 'platform_admin') return store.instanceById(instanceId)
  const instance = await store.instanceOwnedByUser(instanceId, user.id)
  return instance && ['owner','operator'].includes(instance.accessRole) ? instance : undefined
}

async function provision(instance) {
  const name = `dsh-${instance.slug}`
  const labels = { 'app.kubernetes.io/name': 'dsh', 'guanyin.io/instance': instance.id }
  // Port 3080 belongs to the lightweight Guanyin proxy and opens before the
  // DSH web process on loopback port 3081.  Marking the pod ready from 3080
  // exposes a newly-created workspace too early and produces ECONNREFUSED
  // until DSH finishes starting.  Probe the actual DSH listener instead.
  const dshReadyCommand = [
    'node', '-e',
    "const net=require('net');const s=net.connect({host:'127.0.0.1',port:3081});const t=setTimeout(()=>{s.destroy();process.exit(1)},2000);s.once('connect',()=>{clearTimeout(t);s.destroy();process.exit(0)});s.once('error',()=>{clearTimeout(t);process.exit(1)})",
  ]
  await createResource('Secret', { apiVersion: 'v1', kind: 'Secret', metadata: { name, labels }, stringData: { extensionToken: randomBytes(32).toString('hex') } })
  const mcpName = mcpResourceName(instance)
  await createResource('ConfigMap', { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: mcpName, labels }, data: { 'config.json': JSON.stringify({ revision: 'initial', servers: [] }) } })
  for (const suffix of ['data', 'home', 'workspace']) await createResource('PersistentVolumeClaim', {
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: `${name}-${suffix}`, labels },
    spec: { accessModes: ['ReadWriteOnce'], ...(DSH_STORAGE_CLASS ? { storageClassName: DSH_STORAGE_CLASS } : {}), resources: { requests: { storage: DSH_PVC_SIZES[suffix] } } },
  })
  await createResource('Service', { apiVersion: 'v1', kind: 'Service', metadata: { name, labels }, spec: { selector: labels, ports: [{ name: 'web', port: 3080, targetPort: 3080 }] } })
  await createResource('Deployment', {
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, labels },
    // Each workspace uses ReadWriteOnce volumes. Recreate guarantees that an
    // update never starts two DSH processes against the same home/data PVCs.
    spec: { replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch', seccompProfile: { type: 'RuntimeDefault' } },
      containers: [{ name: 'dsh', image: DSH_IMAGE, imagePullPolicy: DSH_IMAGE_PULL_POLICY, ports: [{ containerPort: 3080 }],
        env: [
          { name: 'DSH_HOME', value: '/data/dsh' }, { name: 'BANKOPS_WEB_PROXY', value: '1' },
          { name: 'DSH_BROWSER_AUTH_MODE', value: 'trusted-host' }, { name: 'DSH_TRUSTED_HOSTS', value: PUBLIC_HOSTS },
          { name: 'DSH_PERMISSION_MODE', value: DSH_PERMISSION_MODE },
          { name: 'DSH_EXT_TOKEN', valueFrom: { secretKeyRef: { name, key: 'extensionToken' } } },
        ],
        securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
        resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: '2', memory: '4Gi' } },
        // A startup probe gives first-run profile migration enough time without
        // confusing initialization with a permanently unhealthy pod.
        startupProbe: { tcpSocket: { port: 3080 }, periodSeconds: 10, timeoutSeconds: 10, failureThreshold: 60 },
        readinessProbe: { exec: { command: dshReadyCommand }, periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 12 },
        volumeMounts: [{ name: 'data', mountPath: '/data/dsh' }, { name: 'home', mountPath: '/home/node' }, { name: 'workspace', mountPath: '/workspace' },
          { name: 'guanyin-mcp-config', mountPath: '/etc/guanyin/mcp', readOnly: true }],
      }],
      volumes: [{ name: 'data', persistentVolumeClaim: { claimName: `${name}-data` } }, { name: 'home', persistentVolumeClaim: { claimName: `${name}-home` } }, { name: 'workspace', persistentVolumeClaim: { claimName: `${name}-workspace` } },
        { name: 'guanyin-mcp-config', configMap: { name: mcpName } }],
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
  if (replicas > 0) {
    const path = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}`
    void (async () => {
      try {
        const deployment = await k8sRequest('GET', path)
        await waitForDeploymentReady(path, deployment.metadata?.generation, replicas)
        await applySpaceMcp(instance)
      } catch (error) {
        console.error(`failed to synchronize MCP for ${instance.id} after start:`, error)
      }
    })()
  }
  return instance
}

function apiSecret(req) {
  const authorization = String(req.headers.authorization || '')
  if (/^Bearer\s+\S+$/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '')
  return String(req.headers['x-api-key'] || '')
}

function publicRun(run) {
  return {
    id: run.id, requestId: run.requestId, conversationKey: run.conversationKey, status: run.status,
    output: run.output, error: run.errorCode ? { code: run.errorCode, message: run.errorMessage } : null,
    queuedAt: run.queuedAt, startedAt: run.startedAt, completedAt: run.completedAt,
  }
}

async function adapterForRun(run) {
  const instance = { id: run.instanceId, slug: run.instanceSlug }
  return createDshAdapter({ instance, token: await instanceExtensionToken(instance), namespace: NAMESPACE })
}

async function ensureApiInstanceReady(run) {
  const instance = await store.instanceById(run.instanceId)
  if (!instance) throw Object.assign(new Error('接口所属空间不存在'), { code: 'SPACE_NOT_FOUND' })
  await refreshInstanceStatus(instance)
  if (instance.status === 'stopped' || instance.status === 'stopping') await scaleInstance(instance, 1)
  if (instance.status !== 'running') {
    const path = `/apis/apps/v1/namespaces/${NAMESPACE}/deployments/dsh-${instance.slug}`
    const deployment = await k8sRequest('GET', path)
    await waitForDeploymentReady(path, deployment.metadata?.generation, 1)
  }
  markInstanceActive(instance.id)
}

async function streamRunEvents(req, res, run) {
  let closed = false
  req.on('close', () => { closed = true })
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive', 'x-accel-buffering': 'no',
  })
  res.write(': connected\n\n')
  let cursor = Math.max(Number(req.headers['last-event-id'] || 0) || 0, 0)
  let heartbeatAt = Date.now()
  while (!closed) {
    const events = await store.listApiRunEvents(run.id, cursor)
    for (const event of events) {
      cursor = Number(event.sequence)
      res.write(`id: ${cursor}\nevent: ${event.eventType}\ndata: ${JSON.stringify(event.data)}\n\n`)
    }
    const current = await store.apiRunById(run.id, run.credentialId)
    if (!current || (isTerminalApiRun(current.status) && events.length === 0)) break
    if (Date.now() - heartbeatAt >= 15_000) { res.write(': heartbeat\n\n'); heartbeatAt = Date.now() }
    await delay(750)
  }
  if (!res.writableEnded) res.end()
}

async function openApi(req, res, path) {
  const secret = apiSecret(req)
  if (!secret) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: '缺少 API Key' } })
  const create = path.match(/^\/openapi\/v1\/runs\/([a-z0-9-]+)$/)
  if (create && req.method === 'POST') {
    const invocation = await store.resolveApiInvocation(create[1], secret)
    if (!invocation) return sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'API Key 无权调用该接口' } })
    const body = await bodyJson(req)
    const input = body.input === undefined ? body : body.input
    const validation = validateApiInput(invocation.contract, input)
    if (!validation.valid) return sendJson(res, 400, { error: { code: 'INPUT_SCHEMA_VALIDATION_FAILED', message: '输入不符合接口 Schema', details: validation.errors } })
    const maxQueueSize = Math.max(Number(invocation.contract?.maxQueueSize || 100), 1)
    const requestId = String(req.headers['x-request-id'] || randomUUID()).slice(0, 128)
    const conversationKey = body.conversationKey == null ? null : String(body.conversationKey).slice(0, 128)
    const result = await store.createApiRun({ id: randomUUID(), apiReleaseId: invocation.apiReleaseId, credentialId: invocation.credentialId,
      instanceId: invocation.instanceId, requestId, conversationKey, input, maxQueueSize })
    if (result.queueFull) return sendJson(res, 429, { error: { code: 'QUEUE_FULL', message: '接口队列已满，请稍后重试' } }, { 'retry-after': '5' })
    if (!result.run) return sendJson(res, 409, { error: { code: 'REQUEST_ID_CONFLICT', message: 'requestId 已被其他凭证使用' } })
    if (result.created) await store.appendApiRunEvent(result.run.id, 'run.queued', { runId: result.run.id })
    return sendJson(res, result.created ? 202 : 200, { run: publicRun(result.run), events: `/openapi/v1/runs/${result.run.id}/events` })
  }
  const credential = await store.apiCredentialBySecret(secret)
  if (!credential) return sendJson(res, 401, { error: { code: 'UNAUTHORIZED', message: 'API Key 无效或已过期' } })
  const events = path.match(/^\/openapi\/v1\/runs\/([0-9a-f-]{36})\/events$/i)
  if (events && req.method === 'GET') {
    const run = await store.apiRunById(events[1], credential.id)
    if (!run) return sendJson(res, 404, { error: { code: 'RUN_NOT_FOUND', message: '运行记录不存在' } })
    return streamRunEvents(req, res, run)
  }
  const target = path.match(/^\/openapi\/v1\/runs\/([0-9a-f-]{36})$/i)
  if (target && req.method === 'GET') {
    const run = await store.apiRunById(target[1], credential.id)
    return run ? sendJson(res, 200, { run: publicRun(run) }) : sendJson(res, 404, { error: { code: 'RUN_NOT_FOUND', message: '运行记录不存在' } })
  }
  if (target && req.method === 'DELETE') {
    const current = await store.apiRunById(target[1], credential.id)
    if (!current) return sendJson(res, 404, { error: { code: 'RUN_NOT_FOUND', message: '运行记录不存在' } })
    if (isTerminalApiRun(current.status)) return sendJson(res, 200, { run: publicRun(current) })
    const cancelled = await store.cancelApiRun(current.id, credential.id)
    await store.appendApiRunEvent(current.id, 'run.cancelled', {})
    if (current.dshSessionId) {
      const context = await store.apiRunExecutionContext(current.id)
      const adapter = await adapterForRun(context)
      await adapter.cancel(current.dshSessionId).catch(() => {})
    }
    return sendJson(res, 200, { run: publicRun(cancelled) })
  }
  return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: '接口不存在' } })
}

async function api(req, res, path) {
  if (path === '/api/license/status' && req.method === 'GET') return sendJson(res, 200, { license: publicLicenseStatus(await licenseStatus()) })
  if (path === '/api/license/activate' && req.method === 'POST') {
    const input = await bodyJson(req)
    const customerName = normalizeCustomerName(input.customerName)
    const token = String(input.token || '').trim()
    const result = inspectLicense({ customerName, token, publicKey: LICENSE_PUBLIC_KEY })
    if (!result.valid) return sendJson(res, 400, { error: result.message, code: result.code })
    await store.saveEnterpriseLicense(customerName, token)
    return sendJson(res, 200, { license: publicLicenseStatus(result) })
  }
  if (path === '/api/login' && req.method === 'POST') {
    const license = await licenseStatus()
    if (!license.valid) return sendJson(res, 403, { error: license.message, code: license.code })
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
  const canManageApi = user.role === 'platform_admin' || user.apiAdmin
  if (path === '/api/api-builder/generate' && req.method === 'POST') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const input = await bodyJson(req)
    const instance = await store.instanceById(input.instanceId)
    const requirement = String(input.requirement || '').trim()
    if (!instance || requirement.length < 10 || requirement.length > 4_000) return sendJson(res, 400, { error: '请选择空间，并填写 10–4000 字的接口需求' })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('AI generation timeout')), 120_000)
    try {
      await ensureApiInstanceReady({ instanceId: instance.id })
      const adapter = createDshAdapter({ instance, token: await instanceExtensionToken(instance), namespace: NAMESPACE })
      const suggestion = await generateApiDraftWithAi(adapter, requirement, { signal: controller.signal })
      await audit({ actorUserId: user.id, action: 'api_definition_ai_generate', targetInstanceId: instance.id,
        details: { source: 'console-ai-helper', ip: clientIp(req) } })
      return sendJson(res, 200, { suggestion })
    } catch (error) {
      const message = controller.signal.aborted ? 'AI 生成超时，请稍后重试' : error.message
      return sendJson(res, 502, { error: message })
    } finally { clearTimeout(timer) }
  }
  if (path === '/api/api-catalog' && req.method === 'GET') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const [instances, identity] = await Promise.all([store.listAllInstances(), store.overview()])
    const members = Object.fromEntries(await Promise.all(instances.map(async instance => [instance.id, await store.listInstanceMembers(instance.id)])))
    return sendJson(res, 200, { instances, users: identity.users.map(publicUser), members })
  }
  if (path === '/api/api-definitions' && req.method === 'GET') {
    return sendJson(res, 200, { definitions: await store.listApiDefinitions(user, canManageApi), canManage: canManageApi })
  }
  if (path === '/api/api-definitions' && req.method === 'POST') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    try {
      const input = await bodyJson(req); const slug = safeName(input.slug); const name = String(input.name || '').trim()
      const instance = await store.instanceById(input.instanceId); const owner = await store.userById(input.ownerUserId)
      const members = instance ? await store.listInstanceMembers(instance.id) : []
      if (!slug || !name || !instance || !owner || !members.some(member => member.id === owner.id)) throw new Error('接口名称、标识、空间或负责人无效')
      const definition = await store.createApiDefinition({ id: randomUUID(), slug, name, description: String(input.description || '').trim(),
        instanceId: instance.id, ownerUserId: owner.id, manifest: normalizeApiManifest(input), createdBy: user.id })
      await audit({ actorUserId: user.id, action: 'api_definition_create', targetInstanceId: instance.id, details: { apiDefinitionId: definition.id, slug, ip: clientIp(req) } })
      return sendJson(res, 201, { definition })
    } catch (error) { return sendJson(res, error.code === '23505' ? 409 : 400, { error: error.code === '23505' ? '接口标识已存在' : error.message }) }
  }
  const apiDefinition = path.match(/^\/api\/api-definitions\/([^/]+)$/)
  if (apiDefinition && req.method === 'PATCH') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const current = await store.apiDefinitionById(apiDefinition[1]); if (!current) return sendJson(res, 404, { error: '接口不存在' })
    if (current.status === 'retired') return sendJson(res, 409, { error: '已下线接口不可编辑' })
    try {
      const input = await bodyJson(req); const instance = await store.instanceById(input.instanceId); const owner = await store.userById(input.ownerUserId)
      const members = instance ? await store.listInstanceMembers(instance.id) : []
      if (!safeName(input.slug) || !String(input.name || '').trim() || !owner || !members.some(member => member.id === owner.id)) throw new Error('接口名称、标识、空间或负责人无效')
      const definition = await store.updateApiDefinition(current.id, { slug: safeName(input.slug), name: String(input.name).trim(), description: String(input.description || '').trim(),
        instanceId: instance.id, ownerUserId: owner.id, manifest: normalizeApiManifest(input) })
      await audit({ actorUserId: user.id, action: 'api_definition_update', targetInstanceId: instance.id, details: { apiDefinitionId: current.id, ip: clientIp(req) } })
      return sendJson(res, 200, { definition })
    } catch (error) { return sendJson(res, error.code === '23505' ? 409 : 400, { error: error.code === '23505' ? '接口标识已存在' : error.message }) }
  }
  const validateDefinition = path.match(/^\/api\/api-definitions\/([^/]+)\/validate$/)
  if (validateDefinition && req.method === 'POST') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const definition = await store.apiDefinitionById(validateDefinition[1]); if (!definition) return sendJson(res, 404, { error: '接口不存在' })
    if (definition.status === 'retired') return sendJson(res, 409, { error: '已下线接口不可重新校验' })
    try { normalizeApiManifest(definition.draftManifest) } catch (error) { return sendJson(res, 400, { error: error.message }) }
    await store.setApiDefinitionValidated(definition.id)
    await audit({ actorUserId: user.id, action: 'api_definition_validate', targetInstanceId: definition.instanceId, details: { apiDefinitionId: definition.id, ip: clientIp(req) } })
    return sendJson(res, 200, { validated: true })
  }
  const publishDefinition = path.match(/^\/api\/api-definitions\/([^/]+)\/publish$/)
  if (publishDefinition && req.method === 'POST') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const definition = await store.apiDefinitionById(publishDefinition[1]); if (!definition) return sendJson(res, 404, { error: '接口不存在' })
    if (definition.status === 'retired') return sendJson(res, 409, { error: '已下线接口不可重新发布' })
    const release = await store.publishApiDefinition(definition.id, row => generateApiDocumentation({ slug: row.slug, name: row.name,
      description: row.description, version: row.version, contract: row.contract }), user.id)
    if (!release) return sendJson(res, 409, { error: '请先校验接口草稿，再进行发布' })
    await audit({ actorUserId: user.id, action: 'api_definition_publish', targetInstanceId: definition.instanceId, details: { apiDefinitionId: definition.id, releaseId: release.id, version: release.version, ip: clientIp(req) } })
    return sendJson(res, 201, { release })
  }
  const retireDefinition = path.match(/^\/api\/api-definitions\/([^/]+)\/retire$/)
  if (retireDefinition && req.method === 'POST') {
    if (!canManageApi) return sendJson(res, 403, { error: '需要平台管理员或接口管理员权限' })
    const definition = await store.apiDefinitionById(retireDefinition[1]); if (!definition) return sendJson(res, 404, { error: '接口不存在' })
    await store.retireApiDefinition(definition.id)
    await audit({ actorUserId: user.id, action: 'api_definition_retire', targetInstanceId: definition.instanceId, details: { apiDefinitionId: definition.id, ip: clientIp(req) } })
    return sendJson(res, 200, { retired: true })
  }
  const definitionDocs = path.match(/^\/api\/api-definitions\/([^/]+)\/documentation$/)
  if (definitionDocs && req.method === 'GET') {
    const definition = await store.apiDefinitionById(definitionDocs[1]); if (!definition) return sendJson(res, 404, { error: '接口不存在' })
    if (!canManageApi && !await manageableSpace(user, definition.instanceId)) return sendJson(res, 403, { error: '无权查看接口文档' })
    const release = await store.apiReleaseByDefinition(definition.id)
    return release ? sendJson(res, 200, { release }) : sendJson(res, 404, { error: '接口尚未发布' })
  }
  const definitionRuns = path.match(/^\/api\/api-definitions\/([^/]+)\/runs$/)
  if (definitionRuns && req.method === 'GET') {
    const definition = await store.apiDefinitionById(definitionRuns[1]); if (!definition) return sendJson(res, 404, { error: '接口不存在' })
    if (!canManageApi && !await manageableSpace(user, definition.instanceId)) return sendJson(res, 403, { error: '无权查看接口运行记录' })
    const runs = await store.listApiRunsByDefinition(definition.id)
    return sendJson(res, 200, { runs: runs.map(run => ({ ...publicRun(run), credentialName: run.credentialName, keyPrefix: run.keyPrefix })) })
  }
  const managedRunEvents = path.match(/^\/api\/api-runs\/([0-9a-f-]{36})\/events$/i)
  if (managedRunEvents && req.method === 'GET') {
    const run = await store.apiRunById(managedRunEvents[1]); if (!run) return sendJson(res, 404, { error: '运行记录不存在' })
    if (!canManageApi && !await manageableSpace(user, run.instanceId)) return sendJson(res, 403, { error: '无权查看运行事件' })
    return sendJson(res, 200, { events: await store.listApiRunEvents(run.id, 0, 500) })
  }
  const spaceCredentials = path.match(/^\/api\/instances\/([^/]+)\/api-credentials$/)
  if (spaceCredentials && req.method === 'GET') {
    const instance = await manageableSpace(user, spaceCredentials[1]); if (!instance) return sendJson(res, 403, { error: '无权管理该空间的接口凭证' })
    return sendJson(res, 200, { credentials: await store.listApiCredentials(instance.id) })
  }
  if (spaceCredentials && req.method === 'POST') {
    const instance = await manageableSpace(user, spaceCredentials[1]); if (!instance) return sendJson(res, 403, { error: '无权管理该空间的接口凭证' })
    const input = await bodyJson(req); const name = String(input.name || '').trim(); const maxConcurrency = Number(input.maxConcurrency || 1)
    if (!name || !Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 100) return sendJson(res, 400, { error: '凭证名称或并发数无效' })
    const secret = `gyn_${randomBytes(24).toString('base64url')}`; const id = randomUUID()
    await store.createApiCredential({ id, instanceId: instance.id, name, keyPrefix: secret.slice(0,12), secretHash: store.apiKeyHash(secret), maxConcurrency,
      expiresAt: input.expiresAt || null, createdBy: user.id })
    await audit({ actorUserId: user.id, action: 'api_credential_create', targetInstanceId: instance.id, details: { credentialId: id, ip: clientIp(req) } })
    return sendJson(res, 201, { credential: (await store.listApiCredentials(instance.id)).find(item => item.id === id), secret })
  }
  const credentialGrant = path.match(/^\/api\/instances\/([^/]+)\/api-credentials\/([^/]+)\/grants$/)
  if (credentialGrant && req.method === 'PUT') {
    const instance = await manageableSpace(user, credentialGrant[1]); const credential = await store.apiCredentialById(credentialGrant[2]); const input = await bodyJson(req)
    if (!instance || !credential || credential.instanceId !== instance.id) return sendJson(res, 403, { error: '无权管理该接口凭证' })
    const release = await store.apiReleaseByDefinition(input.apiDefinitionId)
    const definition = await store.apiDefinitionById(input.apiDefinitionId)
    if (!release || release.retiredAt || !definition || definition.instanceId !== instance.id) return sendJson(res, 400, { error: '只能授权本空间当前有效的发布接口' })
    await store.setApiCredentialGrant(credential.id, release.id, user.id, input.enabled !== false)
    await audit({ actorUserId: user.id, action: input.enabled === false ? 'api_credential_revoke' : 'api_credential_grant', targetInstanceId: instance.id,
      details: { credentialId: credential.id, apiDefinitionId: definition.id, releaseId: release.id, ip: clientIp(req) } })
    return sendJson(res, 200, { credentials: await store.listApiCredentials(instance.id) })
  }
  const credentialSettings = path.match(/^\/api\/instances\/([^/]+)\/api-credentials\/([^/]+)$/)
  if (credentialSettings && req.method === 'PATCH') {
    const instance = await manageableSpace(user, credentialSettings[1]); const credential = await store.apiCredentialById(credentialSettings[2]); const input = await bodyJson(req)
    const maxConcurrency = Number(input.maxConcurrency || 1)
    if (!instance || !credential || credential.instanceId !== instance.id) return sendJson(res, 403, { error: '无权管理该接口凭证' })
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 100) return sendJson(res, 400, { error: '凭证并发数无效' })
    const updated = await store.updateApiCredential(credential.id, instance.id, { enabled: input.enabled !== false, maxConcurrency })
    await audit({ actorUserId: user.id, action: updated.enabled ? 'api_credential_enable' : 'api_credential_disable', targetInstanceId: instance.id,
      details: { credentialId: credential.id, maxConcurrency, ip: clientIp(req) } })
    return sendJson(res, 200, { credential: updated })
  }
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
  const canManageMcp = user.role === 'platform_admin' || user.mcpAdmin
  if (path === '/api/mcp-servers' && req.method === 'GET') return sendJson(res, 200, { servers: await store.listMcpServers(), canManage: canManageMcp })
  if (path === '/api/mcp-servers' && req.method === 'POST') {
    if (!canManageMcp) return sendJson(res, 403, { error: '需要平台管理员或 MCP 管理员权限' })
    try {
      const value = mcpInput(await bodyJson(req))
      const created = { id: randomUUID(), ...value, createdBy: user.id }
      await store.createMcpServer(created)
      await audit({ actorUserId: user.id, action: 'mcp_create', details: { mcpServerId: created.id, serverName: created.serverName, ip: clientIp(req) } })
      return sendJson(res, 201, { server: await store.mcpServerById(created.id) })
    } catch (error) {
      if (error.code === '23505') return sendJson(res, 400, { error: 'serverName 已存在' })
      return sendJson(res, 400, { error: error.message })
    }
  }
  const mcpServer = path.match(/^\/api\/mcp-servers\/([^/]+)$/)
  if (mcpServer && req.method === 'PATCH') {
    if (!canManageMcp) return sendJson(res, 403, { error: '需要平台管理员或 MCP 管理员权限' })
    const current = await store.mcpServerById(mcpServer[1], true)
    if (!current) return sendJson(res, 404, { error: 'MCP 服务不存在' })
    try {
      const value = mcpInput(await bodyJson(req), true)
      const updated = await store.updateMcpServer(current.id, value)
      const spaces = await store.listMcpSpaces(current.id)
      await Promise.all(spaces.map(applySpaceMcp))
      await audit({ actorUserId: user.id, action: 'mcp_update', details: { mcpServerId: current.id, serverName: value.serverName, affectedSpaces: spaces.length, ip: clientIp(req) } })
      return sendJson(res, 200, { server: updated })
    } catch (error) {
      if (error.code === '23505') return sendJson(res, 400, { error: 'serverName 已存在' })
      return sendJson(res, 400, { error: error.message })
    }
  }
  if (mcpServer && req.method === 'DELETE') {
    if (!canManageMcp) return sendJson(res, 403, { error: '需要平台管理员或 MCP 管理员权限' })
    const current = await store.mcpServerById(mcpServer[1])
    if (!current) return sendJson(res, 404, { error: 'MCP 服务不存在' })
    const spaces = await store.listMcpSpaces(current.id)
    if (spaces.length) return sendJson(res, 409, { error: '请先取消所有空间接入，再删除 MCP' })
    await store.deleteMcpServer(current.id)
    await audit({ actorUserId: user.id, action: 'mcp_delete', details: { mcpServerId: current.id, serverName: current.serverName, ip: clientIp(req) } })
    return sendJson(res, 200, { ok: true })
  }
  const mcpSpaces = path.match(/^\/api\/mcp-servers\/([^/]+)\/spaces$/)
  if (mcpSpaces && req.method === 'GET') {
    if (!canManageMcp) return sendJson(res, 403, { error: '需要平台管理员或 MCP 管理员权限' })
    return sendJson(res, 200, { spaces: await store.listMcpSpaces(mcpSpaces[1]) })
  }
  const spaceMcp = path.match(/^\/api\/instances\/([^/]+)\/mcp-bindings$/)
  if (spaceMcp && req.method === 'GET') {
    const instance = await manageableSpace(user, spaceMcp[1])
    if (!instance) return sendJson(res, 403, { error: '无权管理该空间的 MCP' })
    return sendJson(res, 200, { bindings: await store.listSpaceMcpBindings(instance.id) })
  }
  if (spaceMcp && req.method === 'PUT') {
    const instance = await manageableSpace(user, spaceMcp[1]); const input = await bodyJson(req)
    const server = await store.mcpServerById(input.mcpServerId)
    if (!instance) return sendJson(res, 403, { error: '无权管理该空间的 MCP' })
    if (!server?.enabled) return sendJson(res, 400, { error: 'MCP 服务不存在或已停用' })
    await store.setSpaceMcpBinding(instance.id, server.id, user.id)
    const revision = await applySpaceMcp(instance)
    await audit({ actorUserId: user.id, action: 'space_mcp_connect', targetInstanceId: instance.id, details: { mcpServerId: server.id, serverName: server.serverName, revision, ip: clientIp(req) } })
    return sendJson(res, 200, { bindings: await store.listSpaceMcpBindings(instance.id), revision })
  }
  const removeSpaceMcp = path.match(/^\/api\/instances\/([^/]+)\/mcp-bindings\/([^/]+)$/)
  if (removeSpaceMcp && req.method === 'DELETE') {
    const instance = await manageableSpace(user, removeSpaceMcp[1]); const server = await store.mcpServerById(removeSpaceMcp[2])
    if (!instance) return sendJson(res, 403, { error: '无权管理该空间的 MCP' })
    if (!server || !await store.removeSpaceMcpBinding(instance.id, server.id)) return sendJson(res, 404, { error: '空间未接入该 MCP' })
    const revision = await applySpaceMcp(instance)
    await audit({ actorUserId: user.id, action: 'space_mcp_disconnect', targetInstanceId: instance.id, details: { mcpServerId: server.id, serverName: server.serverName, revision, ip: clientIp(req) } })
    return sendJson(res, 200, { bindings: await store.listSpaceMcpBindings(instance.id), revision })
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
    const updated = await store.updateUser(target.id, { displayName, role, tenantId: input.tenantId, enabled: input.enabled === true || input.enabled === 'true', mcpAdmin: input.mcpAdmin === true || input.mcpAdmin === 'true', apiAdmin: input.apiAdmin === true || input.apiAdmin === 'true' })
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
    const requestedVersion = String(input.version || DSH_VERSION)
    if (requestedVersion !== DSH_VERSION) return sendJson(res, 400, { error: '运行核心版本无效' })
    const instance = { id: randomUUID(), name: displayName, slug: `${slugBase}-${randomBytes(3).toString('hex')}`, version: DSH_VERSION, image: DSH_IMAGE, tenantId: input.tenantId, status: 'provisioning', idleTimeoutMinutes: timeout, createdAt: new Date().toISOString() }
    await store.createInstance(instance)
    try {
      await provision(instance); instance.status = 'starting'; await store.updateInstance(instance.id, { status: instance.status })
      void syncSpaceMcpWhenReady(instance).catch(error => console.error(`failed to initialize MCP for ${instance.id}:`, error))
      await audit({ actorUserId: user.id, action: 'space_create', targetInstanceId: instance.id, details: { version: instance.version, tenantId: instance.tenantId, idleTimeoutMinutes: timeout, ip: clientIp(req) } })
      return sendJson(res, 201, { instance })
    }
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
  if (owned) return { ...owned, impersonated: false }
  if (user.role === 'platform_admin' && await store.hasAdminAccess(cookies(req).guanyin_session, instanceId)) {
    const instance = await store.instanceById(instanceId)
    return instance ? { ...instance, accessRole: 'platform_admin', impersonated: true } : undefined
  }
  return undefined
}

async function proxyHttp(req, res, instance, user) {
  markInstanceActive(instance.id)
  const startedAt = Date.now()
  // DSH validates Origin against Host for its privileged /api RPC methods.
  // Preserve the browser-facing authority so settings, models and image-baked
  // management plugins keep the same-origin identity seen by the browser.
  const identity = createIdentityToken({ user, instance, impersonated: instance.impersonated }, await instanceExtensionToken(instance))
  const headers = { ...withoutControlPlaneCookies(withoutInboundIdentityHeaders(req.headers)), host: req.headers.host || PUBLIC_HOSTS.split(',')[0], 'x-guanyin-identity': identity }
  const upstream = http.request({ hostname: `dsh-${instance.slug}.${NAMESPACE}.svc.cluster.local`, port: 3080, path: req.url, method: req.method, headers }, upstreamRes => {
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
    if (path === '/api/license/status' || path === '/api/license/activate') return await api(req, res, path)
    if (path === '/login' || path === '/console' || path === '/console/' || path.startsWith('/app') || path === '/lifecycle.css' || path === '/guanyin-logo.png') return await staticFile(req, res, path === '/login' ? '/console/' : path)
    const license = await licenseStatus()
    if (!license.valid) return path === '/api' || path.startsWith('/api/') || path.startsWith('/openapi/') || path.startsWith('/internal/')
      ? sendJson(res, 403, { error: license.message, code: license.code })
      : redirect(res, '/login')
    if (path === '/internal/mcp/api-builder') return await apiBuilderMcp(req, res)
    if (path.startsWith('/openapi/v1/')) return await openApi(req, res, path)
    // DSH owns /api as its RPC carrier.  The control plane owns only its
    // explicit sub-routes; everything else is allowed through to the selected
    // image so image-baked settings/plugins/skills/MCP remain functional.
    const controlApi = path === '/api/login' || path === '/api/logout' || path === '/api/me' || path === '/api/instances'
      || /^\/api\/instances\/[^/]+\/(launch|start|stop)$/.test(path)
      || /^\/api\/instances\/[^/]+\/mcp-bindings(?:\/[^/]+)?$/.test(path)
      || /^\/api\/instances\/[^/]+\/api-credentials(?:\/[^/]+(?:\/grants)?)?$/.test(path)
      || path.startsWith('/api/mcp-servers')
      || path.startsWith('/api/api-definitions') || path.startsWith('/api/api-runs/') || path.startsWith('/api/api-builder/') || path === '/api/api-catalog'
      || path.startsWith('/api/admin/')
    if (controlApi) return await api(req, res, path)
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
  if (!(await licenseStatus()).valid) return socket.destroy()
  const instance = await selectedInstance(req)
  if (!instance) return socket.destroy()
  const user = await currentUser(req)
  if (!user) return socket.destroy()
  markInstanceActive(instance.id)
  let identity
  try { identity = createIdentityToken({ user, instance, impersonated: instance.impersonated }, await instanceExtensionToken(instance)) }
  catch { return socket.destroy() }
  const upstream = net.connect(3080, `dsh-${instance.slug}.${NAMESPACE}.svc.cluster.local`, () => {
    const headers = Object.entries({ ...withoutControlPlaneCookies(withoutInboundIdentityHeaders(req.headers)), 'x-guanyin-identity': identity }).map(([key, value]) => `${key}: ${value}`).join('\r\n')
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  upstream.on('error', () => socket.destroy())
})

await store.initialize({ adminUsername: process.env.BOOTSTRAP_ADMIN_USER || 'admin', adminPasswordHash: hashPassword(process.env.BOOTSTRAP_ADMIN_PASSWORD || 'Guanyin@2026') })
const apiRunWorker = new ApiRunWorker({ store, adapterFor: adapterForRun, ensureInstanceReady: ensureApiInstanceReady })
apiRunWorker.start()
server.listen(PORT, '0.0.0.0', () => console.log(`Guanyin control plane listening on ${PORT}`))

// Reconcile image-baked management MCPs after an upgrade. Calls are
// idempotent; sleeping spaces are skipped and receive them on their next start.
setTimeout(async () => {
  for (const instance of await store.listAllInstances()) {
    if (instance.version !== DSH_VERSION) continue
    try { await applySpaceMcp(instance) } catch (error) { console.error(`failed to reconcile MCP for ${instance.id}:`, error) }
  }
}, 3_000 + Math.floor(Math.random() * 2_000)).unref()

setInterval(async () => {
  try {
    for (const instance of await store.claimIdleInstances()) await scaleInstance(instance, 0)
  } catch (error) { console.error('idle instance reconciliation failed', error) }
}, 60_000).unref()

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  apiRunWorker.stop()
  server.close(async () => { await store.close(); process.exit(0) })
  setTimeout(() => process.exit(1), 10_000).unref()
})
