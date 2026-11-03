// Local validation service. No production integrations or side effects.
import http from 'node:http'
import { randomUUID } from 'node:crypto'
const sessions = new Set(), state = { calls: 0, forbiddenCalls: 0 }
const tools = ['gateway_probe', 'gateway_slow', 'gateway_forbidden'].map(name => ({ name, description: `Local MCP gateway validation: ${name}`, inputSchema: { type: 'object', properties: { stream: { type: 'boolean' } } } }))
http.createServer(async (req, res) => {
  if (req.url === '/healthz') return res.end('ok')
  if (req.url === '/state') return res.end(JSON.stringify(state))
  if (req.headers.authorization !== `Bearer ${process.env.FIXTURE_TOKEN}`) return res.writeHead(401).end()
  const sid = req.headers['mcp-session-id']
  if (req.method === 'DELETE') { sessions.delete(sid); return res.writeHead(200).end() }
  if (req.method === 'GET') return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(': alive\n\n')
  let body = ''; for await (const c of req) body += c
  const msg = JSON.parse(body)
  if (msg.method !== 'initialize' && !sessions.has(sid)) return res.writeHead(404).end()
  if (msg.id === undefined) return res.writeHead(202).end()
  let result
  if (msg.method === 'initialize') { const session = randomUUID(); sessions.add(session); res.setHeader('Mcp-Session-Id', session); result = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'guanyin-gateway-smoke', version: '1.0' } } }
  else if (msg.method === 'tools/list') result = { tools }
  else if (msg.method === 'tools/call') {
    state.calls++; if (msg.params.name === 'gateway_forbidden') state.forbiddenCalls++
    if (msg.params.name === 'gateway_slow') await new Promise(resolve => setTimeout(resolve, 1500))
    result = { content: [{ type: 'text', text: 'GUANYIN_GATEWAY_PROBE_OK' }] }
  } else result = {}
  const output = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
  if (msg.params?.arguments?.stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(`event: message\ndata: ${output}\n\n`); res.end() }
  else res.writeHead(200, { 'content-type': 'application/json' }).end(output)
}).listen(8090, '0.0.0.0', () => console.log('Local MCP gateway validation fixture ready'))
