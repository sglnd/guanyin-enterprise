// Synthetic local MCP + OpenAI-compatible model for the two-runtime contract check.
import http from 'node:http'
const state = { '015': { discovered: 0, toolCalls: 0, auth: [] }, '021': { discovered: 0, toolCalls: 0, auth: [] } }
http.createServer(async (req, res) => {
  if (req.url === '/state') return res.end(JSON.stringify(state))
  const name = req.url.split('/')[1], stats = state[name]
  if (!stats) { res.writeHead(404).end(); return }
  let body = ''; for await (const chunk of req) body += chunk
  const input = body ? JSON.parse(body) : {}
  if (req.url.endsWith('/mcp')) {
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    if (input.id === undefined) { res.writeHead(202).end(); return }
    let result
    if (input.method === 'initialize') result = { protocolVersion: input.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'guanyin-sync-proof', version: '1.0.0' } }
    else if (input.method === 'tools/list') { stats.discovered++; result = { tools: [{ name: 'sync_probe', description: 'Synthetic synchronization check', inputSchema: { type: 'object', properties: {} } }] } }
    else if (input.method === 'tools/call') { stats.toolCalls++; result = { content: [{ type: 'text', text: 'GUANYIN_SYNC_PROBE_OK' }] } }
    else result = {}
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result })); return
  }
  if (req.url.endsWith('/chat/completions')) {
    stats.auth.push(req.headers.authorization || null)
    const tool = input.tools?.find(tool => tool.function?.name?.includes('sync_probe'))?.function.name
    const done = input.messages?.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('GUANYIN_SYNC_PROBE_OK'))
    const call = tool && !done
    const message = call ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_sync_probe', type: 'function', function: { name: tool, arguments: '{}' } }] } : { role: 'assistant', content: 'SYNC_MODEL_OK' }
    const finish = call ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 }
    if (!input.stream) { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: 'sync-proof', object: 'chat.completion', created: 1, model: input.model, choices: [{ index: 0, message, finish_reason: finish }], usage })); return }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const delta = call ? { role: 'assistant', tool_calls: [{ index: 0, ...message.tool_calls[0] }] } : { role: 'assistant', content: 'SYNC_MODEL_OK' }
    for (const frame of [{ choices: [{ index: 0, delta, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: finish }], usage }]) res.write(`data: ${JSON.stringify({ id: 'sync-proof', object: 'chat.completion.chunk', created: 1, model: input.model, ...frame })}\n\n`)
    res.end('data: [DONE]\n\n'); return
  }
  res.writeHead(404).end()
}).listen(19094, '0.0.0.0', () => console.log('Synthetic dual-runtime fixture listening on 19094'))
