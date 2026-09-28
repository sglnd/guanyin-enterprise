import http from 'node:http'
import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const upstreamHost = '127.0.0.1'
const upstreamPort = 3081

async function token() {
  try { return (await readFile('/tmp/dsh-web-token', 'utf8')).trim() } catch { return '' }
}

function hasDshSession(req) {
  return /(?:^|;\s*)dsh-auth-[^=]+=/.test(String(req.headers.cookie || ''))
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
  const response = await upstreamRequest(`/?token=${encodeURIComponent(webToken)}`, { method: 'GET', headers: { host: '127.0.0.1:18080' } })
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
      headers: { host: '127.0.0.1:18080', cookie: await dshSessionCookie(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
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
      headers: { host: '127.0.0.1:18080', cookie: await dshSessionCookie(), 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
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
  const internalMcp = path.match(/^\/__guanyin\/mcp-manager\/([A-Za-z0-9_$.-]+)$/)
  if (internalMcp) return handleGuanyinMcp(req, res, internalMcp[1])
  const internalSessionRpc = path.match(/^\/__guanyin\/dsh-rpc\/(session\/[A-Za-z0-9_$.-]+|skills\/[A-Za-z0-9_$.-]+)$/)
  if (internalSessionRpc) return handleGuanyinSessionRpc(req, res, internalSessionRpc[1])
  if (req.method === 'GET' && !hasDshSession(req)) {
    const webToken = await token()
    if (webToken) {
      const url = new URL(path, 'http://dsh.local')
      if (!url.searchParams.has('token')) url.searchParams.set('token', webToken)
      path = `${url.pathname}${url.search}`
    }
  }

  const upstream = http.request({
    hostname: upstreamHost,
    port: upstreamPort,
    method: req.method,
    path,
    headers: req.headers,
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers)
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
  try { if (internalStream) cookie = await dshSessionCookie() } catch { socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return }
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    const lines = [`${req.method} ${internalStream ? '/api/remote.mux' : req.url} HTTP/${req.httpVersion}`]
    if (internalStream) {
      for (const [name, value] of Object.entries(req.headers)) {
        if (name === 'host' || name === 'cookie' || name === 'x-guanyin-token' || value === undefined) continue
        lines.push(`${name}: ${Array.isArray(value) ? value.join(', ') : value}`)
      }
      lines.push('host: 127.0.0.1:18080', `cookie: ${cookie}`)
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
