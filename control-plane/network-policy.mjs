import { isIP } from 'node:net'
export function networkRulesInput(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\s,，、]+/).filter(Boolean)
  if (values.length > 200) throw new Error('每个空间最多配置 200 个访问地址')
  return [...new Set(values.map(value => {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[?#*]/.test(value)) throw new Error('请填写完整的 HTTP/HTTPS 地址，不支持通配符、路径、查询参数或账号密码')
    let u; try { u = new URL(value) } catch { throw new Error('访问地址格式无效') }
    if (u.username || u.password || !u.hostname || !['http:', 'https:'].includes(u.protocol) || (u.pathname && u.pathname !== '/')) throw new Error('只填写协议、域名/IP 和端口，不要填写页面路径或账号密码')
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    if (host === 'localhost' || host.endsWith('.localhost') || isIP(host) && (host.startsWith('127.') || host === '::1' || host === '0.0.0.0' || host.startsWith('169.254.') || host.toLowerCase().startsWith('fe80:'))) throw new Error('不能授权回环、未指定地址或链路本地地址')
    return `${u.protocol}//${u.hostname.toLowerCase()}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`
  }))]
}
