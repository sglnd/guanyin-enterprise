// Run inside the control-plane container via stdin. Fetches metadata only.
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import { createHmac, createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const require = createRequire('/app/package.json')
const { Pool } = require('pg')
const { discoverMcpTools } = await import('/app/mcp-discovery.mjs')
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const spaceName = process.env.DIAG_SPACE_NAME
if (!spaceName) throw new Error('请通过 DIAG_SPACE_NAME 指定诊断空间名称')
const namespace = process.env.DSH_NAMESPACE || 'guanyin-enterprise-instances'
const root = '/var/run/secrets/kubernetes.io/serviceaccount'
async function secret(name) {
  const token = await readFile(root + '/token', 'utf8')
  const ca = await readFile(root + '/ca.crt')
  return new Promise((resolve, reject) => {
    const req = https.get({
      hostname: process.env.KUBERNETES_SERVICE_HOST,
      port: process.env.KUBERNETES_SERVICE_PORT || 443, ca,
      path: '/api/v1/namespaces/' + namespace + '/secrets/' + name,
      headers: { Authorization: 'Bearer ' + token },
    }, res => {
      let text = ''
      res.on('data', chunk => { text += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('Secret HTTP ' + res.statusCode))
        try { resolve(JSON.parse(text)) } catch { reject(new Error('Invalid Secret JSON')) }
      })
    })
    req.setTimeout(8000, () => req.destroy(new Error('Secret timeout')))
    req.on('error', reject)
  })
}
async function probe(label, url, headers) {
  try {
    const result = await discoverMcpTools({ url, headers })
    const names = result.tools.map(tool => tool.name)
    console.log(label, JSON.stringify({ count: names.length, names, hasMore: result.hasMore }))
    return names
  } catch (error) {
    // Discovery emits protocol/status errors without credentials or response bodies.
    console.log(label, error.message)
  }
}
try {
  const spaces = (await pool.query("SELECT id,slug,version FROM instances WHERE name=$1 AND deleted_at IS NULL", [spaceName])).rows
  if (!spaces.length) throw new Error('未找到空间 ' + spaceName)
  for (const space of spaces) {
    console.log('SPACE', spaceName, space.version)
    const data = await secret('dsh-' + space.slug)
    const extension = Buffer.from(data.data.extensionToken, 'base64').toString()
    const gatewayToken = createHmac('sha256', extension).update('guanyin-mcp-gateway-v1').digest('hex')
    const hash = createHash('sha256').update(gatewayToken).digest('hex')
    const registered = await pool.query('SELECT 1 FROM mcp_gateway_tokens WHERE instance_id=$1 AND token_hash=$2', [space.id, hash])
    console.log('Gateway token registered', registered.rowCount === 1)
    const servers = (await pool.query(`SELECT m.id,m.server_name,m.url,m.headers,m.allowed_tools,m.enabled
      FROM space_mcp_bindings b JOIN mcp_servers m ON m.id=b.mcp_server_id
      WHERE b.instance_id=$1 ORDER BY m.server_name`, [space.id])).rows
    for (const server of servers) {
      console.log('SERVER', server.server_name, JSON.stringify({ enabled: server.enabled, allowedTools: server.allowed_tools }))
      const upstream = await probe('UPSTREAM', server.url, server.headers || {})
      if (upstream) console.log('WHITELIST MATCHES', upstream.filter(name => !server.allowed_tools.length || server.allowed_tools.includes(name)).length)
      if (process.env.MCP_GATEWAY_URL) {
        await probe('GATEWAY', process.env.MCP_GATEWAY_URL.replace(/\/$/, '') + '/mcp/' + server.id, { Authorization: 'Bearer ' + gatewayToken })
      } else {
        console.log('GATEWAY', 'MCP_GATEWAY_URL 未配置')
      }
    }
  }
} catch (error) {
  console.error('DIAGNOSTIC', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
