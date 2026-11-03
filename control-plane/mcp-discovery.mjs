// Administrative probe only; no upstream credential is returned to the browser.
export async function discoverMcpTools({ url, headers = {} }) {
  const target = new URL(url)
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('MCP 地址无效')
  let session
  const invoke = async (method, id) => {
    const response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-03-26', ...(session ? { 'Mcp-Session-Id': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(id ? { id } : {}), method, ...(method === 'initialize' ? { params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'guanyin-discovery', version: '1.0' } } } : {}) }) })
    session = response.headers.get('mcp-session-id') || session
    if (!response.ok) throw new Error(`MCP 返回 HTTP ${response.status}`)
    if (!id) { await response.body?.cancel(); return }
    const reader = response.body.getReader(); let text = ''; const decoder = new TextDecoder()
    try {
      for (;;) {
        const { value, done } = await reader.read(); if (done) break
        text += decoder.decode(value, { stream: true }); if (text.length > 4_000_000) throw new Error('工具列表过大')
        if (response.headers.get('content-type')?.includes('text/event-stream')) {
          for (const event of text.split(/\r?\n\r?\n/).slice(0, -1)) {
            const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n')
            if (!data) continue
            const message = JSON.parse(data); if (message.id === id) { if (message.error) throw new Error('MCP 协议错误'); return message.result }
          }
        }
      }
      const message = JSON.parse(text); if (message.error) throw new Error('MCP 协议错误'); return message.result
    } finally { await reader.cancel().catch(() => {}) }
  }
  try {
    await invoke('initialize', 1); await invoke('notifications/initialized')
    const result = await invoke('tools/list', 2)
    if (!Array.isArray(result?.tools)) throw new Error('MCP 未返回工具列表')
    return { tools: result.tools.map(({ name, description }) => ({ name, description })), hasMore: Boolean(result.nextCursor) }
  } finally {
    if (session) await fetch(target, { method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(3000), headers: { ...headers, 'Mcp-Session-Id': session } }).then(r => r.body?.cancel()).catch(() => {})
  }
}
