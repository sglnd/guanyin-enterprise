// Local-only integration fixture: no customer models, keys, or data are used.
import http from 'node:http'
import net from 'node:net'
import { createIdentityToken } from '../../control-plane/guanyin-identity.mjs'
const secret = 'guanyin-021-local-smoke-only'
const userId = '11111111-1111-4111-8111-111111111111'
const usage = new Map()
let modelCalls = 0, browserVisits = 0, unexpectedAuth = 0
const identity = () => createIdentityToken({ user: { id: userId, username: 'smoke', displayName: '验证用户', tenantId: '22222222-2222-4222-8222-222222222222', tenantName: '验证租户' }, instance: { id: '33333333-3333-4333-8333-333333333333', name: '观因 0.2.1 验证空间', accessRole: 'owner' } }, secret)
http.createServer(async (req, res) => {
  if (req.url === '/state') return res.end(JSON.stringify({ modelCalls, browserVisits, unexpectedAuth, usage: [...usage.values()] }))
  if (req.url === '/browser-fixture') { browserVisits++; res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><html><title>GuanyinBrowserVerified</title><h1>GuanyinBrowserVerified</h1><button>Test button</button></html>') }
  let body = ''; for await (const chunk of req) body += chunk
  if (req.url === '/usage') {
    if (req.headers['x-guanyin-token'] !== secret) { res.writeHead(403).end(); return }
    for (const event of JSON.parse(body).events) usage.set(event.id, event)
    res.setHeader('content-type', 'application/json'); return res.end('{"ok":true}')
  }
  if (req.url === '/v1/models') return res.end('{"data":[{"id":"gy-smoke"}]}')
  if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
  modelCalls++
  if (req.headers.authorization) unexpectedAuth++
  const input = JSON.parse(body)
  const requestedBrowser = input.messages.some(m => typeof m.content === 'string' && m.content.includes('BROWSER_SMOKE'))
  const requestedGenui = input.messages.some(m => typeof m.content === 'string' && m.content.includes('GENUI_SMOKE'))
  const missingFinish = input.messages.some(m => typeof m.content === 'string' && m.content.includes('NO_FINISH_SMOKE'))
  const navigated = input.messages.some(m => m.role === 'tool')
  const navigate = input.tools?.find(t => t.function?.name?.includes('browser_navigate'))?.function?.name
  res.setHeader('content-type', 'text/event-stream')
  const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', model: 'gy-smoke', created: Math.floor(Date.now() / 1000), choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
  if (requestedBrowser && !navigated && navigate) {
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'browser-call', type: 'function', function: { name: navigate, arguments: '{"url":"http://host.docker.internal:19092/browser-fixture"}' } }] })
    chunk({}, 'tool_calls')
  } else {
    chunk({ role: 'assistant', content: requestedGenui ? '```dsh-ui\n{"title":"观因交互界面验证","items":[{"type":"stat","label":"验证通过","value":"100%"}]}\n```' : '观因验证成功。\n\n```mermaid\ngraph TD\n A[请求] --> B[上报]\n```\n' })
    if (!missingFinish) chunk({}, 'stop')
  }
  res.write('data: ' + JSON.stringify({ id: 'smoke', choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\ndata: [DONE]\n\n')
  res.end()
}).listen(19092, '0.0.0.0', () => console.log('Local model/usage/browser fixture: 19092'))
const gateway = http.createServer((req, res) => {
  const upstream = http.request({ hostname: '127.0.0.1', port: 19091, path: req.url, method: req.method, headers: { ...req.headers, 'x-guanyin-identity': identity() } }, r => { res.writeHead(r.statusCode, r.headers); r.pipe(res) })
  upstream.on('error', () => res.writeHead(502).end()); req.pipe(upstream)
})
gateway.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(19091, '127.0.0.1', () => {
    const headers = { ...req.headers, 'x-guanyin-identity': identity() }
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`)
    if (head.length) upstream.write(head)
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy())
})
gateway.listen(19093, '127.0.0.1', () => console.log('Signed local workspace gateway: http://127.0.0.1:19093'))
