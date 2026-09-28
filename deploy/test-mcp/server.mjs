import http from 'node:http'

const PORT = Number(process.env.PORT || 19090)
const PROTOCOL_VERSION = '2025-03-26'

function json(res, status, value) {
  const body = value === undefined ? '' : JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value }
}

function rpc(message) {
  const { id, method, params = {} } = message
  if (method === 'initialize') return result(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: { listChanged: false } },
    serverInfo: { name: 'guanyin-test-mcp', version: '0.1.0' },
  })
  if (method === 'ping') return result(id, {})
  if (method === 'tools/list') return result(id, { tools: [{
    name: 'echo',
    description: '回显输入文本，用于验证观因空间的 MCP 注入和调用链路。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '需要回显的文本' } },
      required: ['text'],
      additionalProperties: false,
    },
  }] })
  if (method === 'tools/call' && params.name === 'echo') return result(id, {
    content: [{ type: 'text', text: `观因测试 MCP 收到：${String(params.arguments?.text || '')}` }],
  })
  if (id === undefined) return undefined
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, name: 'guanyin-test-mcp' })
  if (req.method === 'OPTIONS') return json(res, 204)
  if (req.method !== 'POST' || req.url !== '/mcp') return json(res, 404, { error: 'not found' })
  try {
    let body = ''
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1_000_000) throw new Error('request too large')
    }
    const message = JSON.parse(body)
    const response = Array.isArray(message) ? message.map(rpc).filter(Boolean) : rpc(message)
    if (response === undefined || (Array.isArray(response) && response.length === 0)) return json(res, 202)
    return json(res, 200, response)
  } catch (error) {
    return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } })
  }
})

server.listen(PORT, '0.0.0.0', () => console.log(`Guanyin test MCP listening on http://0.0.0.0:${PORT}/mcp`))
