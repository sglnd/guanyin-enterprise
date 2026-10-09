import http from 'node:http'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { synchronizeModels } from './model-sync.mjs'

const upstreamHost = '127.0.0.1'
const upstreamPort = 3081
const brandLogoPath = '/opt/dsh-runtime/guanyin-logo.png'

function verifyIdentity(req) {
  const secret = process.env.DSH_EXT_TOKEN || ''
  const [headerPart, payloadPart, actualPart, extra] = String(req.headers['x-guanyin-identity'] || '').split('.')
  if (!secret || !headerPart || !payloadPart || !actualPart || extra) throw new Error('missing identity')
  const input = `${headerPart}.${payloadPart}`
  const actual = Buffer.from(actualPart)
  const expected = Buffer.from(createHmac('sha256', secret).update(input).digest('base64url'))
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid identity')
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'))
  const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'))
  const now = Math.floor(Date.now() / 1000)
  if (header.alg !== 'HS256' || claims.iss !== 'guanyin-control-plane' || claims.aud !== 'guanyin-dsh' || claims.exp <= now || claims.iat > now + 5) throw new Error('expired identity')
  return claims
}

function publicIdentity(claims) {
  return { user: claims.user, tenant: claims.tenant, space: claims.space, impersonated: Boolean(claims.impersonated) }
}

async function token() {
  try { return (await readFile('/tmp/dsh-web-token', 'utf8')).trim() } catch { return '' }
}

function sessionFingerprint(webToken) {
  return createHash('sha256').update(webToken).digest('base64url')
}

function hasCurrentDshSession(req, webToken) {
  const expected = sessionFingerprint(webToken)
  const actual = String(req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith('guanyin-dsh-session='))?.slice('guanyin-dsh-session='.length)
  if (!actual) return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(new Error('invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function upstreamRequest(path, options = {}, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: upstreamHost, port: upstreamPort, path, ...options }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode || 502, headers: response.headers, body: Buffer.concat(chunks) }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

async function dshSessionCookie() {
  const webToken = await token()
  if (!webToken) throw new Error('DSH authentication token is not ready')
  const response = await upstreamRequest(`/?token=${encodeURIComponent(webToken)}`, { method: 'GET', headers: { host: '127.0.0.1:18081' } })
  const cookies = response.headers['set-cookie'] || []
  const cookie = cookies.map(value => value.split(';', 1)[0]).find(value => value.startsWith('dsh-auth-'))
  if (!cookie) throw new Error(`DSH authentication exchange failed with HTTP ${response.status}`)
  return cookie
}

async function handleGuanyinMcp(req, res, endpoint) {
  if (req.method !== 'POST' || !process.env.DSH_EXT_TOKEN || req.headers['x-guanyin-token'] !== process.env.DSH_EXT_TOKEN) {
    res.writeHead(404).end(); return
  }
  try {
    const payload = await readJson(req)
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload })
    const response = await upstreamRequest(`/mcp-manager/${endpoint}`, {
      method: 'POST',
      headers: { host: '127.0.0.1:18081', cookie: await dshSessionCookie(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, body)
    res.writeHead(response.status, { 'content-type': response.headers['content-type'] || 'application/json' })
    res.end(response.body)
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
}

const GUANYIN_SESSION_METHODS = new Set([
  'session/cancel',
  'session/create',
  'session/modelCatalog',
  'session/prompt',
  'session/selectModel',
  'skills/list',
])

function isGuanyinRequest(req) {
  return Boolean(process.env.DSH_EXT_TOKEN) && req.headers['x-guanyin-token'] === process.env.DSH_EXT_TOKEN
}

async function handleGuanyinSessionRpc(req, res, method) {
  if (req.method !== 'POST' || !isGuanyinRequest(req) || !GUANYIN_SESSION_METHODS.has(method)) {
    res.writeHead(404).end(); return
  }
  try {
    // The bridge accepts the generated Remote method's named arguments and owns
    // the DSH Connection envelope, correlation id, and browser authentication.
    const args = await readJson(req)
    const rpcId = randomUUID()
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } })
    const response = await upstreamRequest(`/api/${method}`, {
      method: 'POST',
      headers: { host: '127.0.0.1:18081', cookie: await dshSessionCookie(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, body)
    res.writeHead(response.status, { 'content-type': response.headers['content-type'] || 'application/json' })
    res.end(response.body)
  } catch (error) {
    res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: error.message }))
  }
}

const server = http.createServer(async (req, res) => {
  let path = req.url || '/'
  if (path === '/__guanyin/models/sync') {
    if (req.method !== 'POST' || !isGuanyinRequest(req)) { res.writeHead(404).end(); return }
    try {
      const cookie = await dshSessionCookie()
      const result = await synchronizeModels(await readJson(req, 8 * 1024 * 1024), async (method, args) => {
        const body = JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } })
        const response = await upstreamRequest(`/api/${method}`, { method: 'POST', headers: {
          host: '127.0.0.1:18081', cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        } }, body)
        const data = JSON.parse(response.body.toString('utf8'))
        if (response.status >= 300 || !data.result?.ok) throw new Error('DSH model settings RPC failed')
        return data.result.value
      })
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, ...result }))
    } catch {
      res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: '模型同步失败，请检查模型配置、凭证服务及设置版本后重试' }))
    }
    return
  }
  if (req.method === 'GET' && path === '/__guanyin/identity') {
    try {
      const body = JSON.stringify(publicIdentity(verifyIdentity(req)))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
      res.end(body)
    } catch {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ error: 'Guanyin identity required' }))
    }
    return
  }
  if (req.method === 'GET' && (path === '/__guanyin/brand/logo.png' || path === '/__guanyin/brand/favicon.png')) {
    try {
      const body = await readFile(brandLogoPath)
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'public, max-age=3600' })
      res.end(body)
    } catch { res.writeHead(404).end() }
    return
  }
  const internalMcp = path.match(/^\/__guanyin\/mcp-manager\/([A-Za-z0-9_$.-]+)$/)
  if (internalMcp) return handleGuanyinMcp(req, res, internalMcp[1])
  const internalSessionRpc = path.match(/^\/__guanyin\/dsh-rpc\/(session\/[A-Za-z0-9_$.-]+|skills\/[A-Za-z0-9_$.-]+)$/)
  if (internalSessionRpc) return handleGuanyinSessionRpc(req, res, internalSessionRpc[1])
  // All workspaces share the Guanyin browser origin.  A DSH cookie from a
  // different workspace must not suppress this process's token exchange.  A
  // non-secret fingerprint records which workspace most recently completed
  // the exchange, avoiding both stale-cookie failures and redirect loops.
  const acceptsHtml = String(req.headers.accept || '').includes('text/html')
  const documentRequest = req.headers['sec-fetch-dest'] === 'document' || acceptsHtml
  const webToken = documentRequest ? await token() : ''
  const bootstrapping = req.method === 'GET' && documentRequest && webToken && !hasCurrentDshSession(req, webToken)
  if (bootstrapping) {
      const url = new URL(path, 'http://dsh.local')
      url.searchParams.set('token', webToken)
      path = `${url.pathname}${url.search}`
  }

  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path,
    headers: req.headers,
  }, upstreamRes => {
    const headers = { ...upstreamRes.headers }
    if (bootstrapping) {
      const cookies = Array.isArray(headers['set-cookie']) ? headers['set-cookie'] : headers['set-cookie'] ? [headers['set-cookie']] : []
      cookies.push(`guanyin-dsh-session=${sessionFingerprint(webToken)}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`)
      headers['set-cookie'] = cookies
    }
    res.writeHead(upstreamRes.statusCode || 502, headers)
    upstreamRes.pipe(res)
  })
  upstream.on('error', error => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`DSH upstream unavailable: ${error.message}`)
  })
  req.pipe(upstream)
})

server.on('upgrade', async (req, socket, head) => {
  const internalStream = req.url === '/__guanyin/dsh-stream'
  if (internalStream && !isGuanyinRequest(req)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
  let cookie
  try { if (!internalStream) verifyIdentity(req) } catch { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return }
  try { if (internalStream) cookie = await dshSessionCookie() } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return }
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const lines = [`${req.method} ${internalStream ? '/api/remote.mux' : req.url} HTTP/${req.httpVersion}`]
    if (internalStream) {
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === 'host' || name === 'cookie' || name === 'x-guanyin-token' || value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push('host: 127.0.0.1:18081', `cookie: ${cookie}`)
    } else {
      for (let index = 0; index < req.rawHeaders.length; index += 2) lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream).pipe(socket)
  })
  const close = () => { socket.destroy(); upstream.destroy() }
  socket.on('error', close)
  upstream.on('error', close)
})

server.listen(3080, '0.0.0.0', () => {
  console.log('[guanyin-web-proxy:dsh] 0.0.0.0:3080 -> 127.0.0.1:3081')
})

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
