// MCP Manager 0.1.5 returns config fields on the server row itself.
export function managedMcpConfigMatches(server, desired) {
  const actual = server.config || server
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
    return value
  }
  return server.enabled !== false && Object.entries(desired).every(([key, value]) =>
    JSON.stringify(canonical(actual[key])) === JSON.stringify(canonical(value)))
    && JSON.stringify(canonical(actual.headers || {})) === JSON.stringify(canonical(desired.headers || {}))
}
