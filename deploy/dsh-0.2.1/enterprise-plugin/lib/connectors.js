// Read-only projection of public Loader and Tools registries. Never expose
// headers, environment values, command arguments, or URL query credentials.
export function connectorView(entries, schemas) {
  return { servers: [...entries].filter(e => !e.options.group && e.options.name === '@deepseek-ai/dsh-mcp-client').map(e => {
    const config = e.options.config || {}
    const id = String(e.id).replace(/^include:/, '')
    const serverName = String(config.serverName || id)
    const prefix = `mcp__${serverName}__`
    const tools = [...schemas].filter(t => t.name.startsWith(prefix)).map(t => ({ name: t.name.slice(prefix.length), description: t.description || '' }))
    let endpoint = ''
    try { const u = new URL(config.url); endpoint = `${u.protocol}//${u.host}${u.pathname}` } catch {}
    return { id, name: serverName, transport: config.transport || 'unknown', endpoint, enabled: !e.disabled,
      source: id.startsWith('guanyin-mcp-') ? '平台下发' : '空间配置', tools,
      status: e.disabled ? 'disabled' : tools.length ? 'tools-registered' : 'no-tools',
    }
  }) }
}
