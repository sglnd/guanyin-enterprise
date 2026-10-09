const APIS = new Set(['openai-completions', 'openai-responses', 'anthropic-messages'])
const object = value => value && typeof value === 'object' && !Array.isArray(value)
function jsonObject(value, label) {
  if (typeof value === 'string') { try { value = JSON.parse(value || '{}') } catch { throw new Error(`${label} 必须是有效 JSON`) } }
  if (!object(value)) throw new Error(`${label} 必须是 JSON 对象`)
  return value
}
export function modelProviderInput(input) {
  const code = String(input.code || '').trim()
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(code) || ['constructor','prototype'].includes(code)) throw new Error('提供方编码须为小写字母开头的字母、数字或连字符，最多 48 位')
  const name = String(input.name || '').trim()
  if (!name || name.length > 120) throw new Error('请填写提供方名称（最多 120 字）')
  const api = input.api || 'openai-completions'
  if (!APIS.has(api)) throw new Error('不支持的模型 API 协议')
  let url
  try { url = new URL(String(input.baseURL || '').trim()) } catch { throw new Error('baseURL 必须是有效的 HTTP(S) 地址') }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseURL 不能包含账户、密码、查询参数或片段')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (api === 'openai-completions') url.pathname = url.pathname.replace(/\/chat\/completions$/, '')
  const timeout = Number(input.streamIdleTimeoutMs ?? 600000)
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 3600000) throw new Error('流空闲超时须为 1000–3600000 毫秒')
  let models = input.models
  if (typeof models === 'string') { try { models = JSON.parse(models) } catch { throw new Error('模型列表必须是有效 JSON 数组') } }
  if (!Array.isArray(models) || !models.length || models.length > 100) throw new Error('每个提供方需登记 1–100 个模型')
  const ids = new Set()
  models = models.map(model => {
    if (!object(model)) throw new Error('模型列表中的每一项必须是对象')
    const allowed = new Set(['id','name','contextWindow','maxTokens','reasoningEfforts','input'])
    if (Object.keys(model).some(k => !allowed.has(k))) throw new Error('模型包含不支持的字段')
    const id = String(model.id || code).trim(), modelName = String(model.name || name).trim()
    if (!id || id.length > 200 || !modelName || modelName.length > 200 || ids.has(id)) throw new Error('模型 ID 不能为空或重复，最多 200 字')
    ids.add(id)
    const result = { ...model, id, name: modelName }
    for (const key of ['contextWindow','maxTokens']) if (result[key] !== undefined && (!Number.isInteger(result[key]) || result[key] <= 0)) throw new Error(`${key} 必须是正整数`)
    if (result.reasoningEfforts !== undefined && result.reasoningEfforts !== false) {
      const efforts = jsonObject(result.reasoningEfforts, '推理等级')
      result.reasoningEfforts = efforts
      if (!Object.keys(efforts).some(level => level !== 'off')) throw new Error('推理等级至少需要一个非 off 等级；非推理模型可使用 false')
      for (const [level, wire] of Object.entries(efforts)) if (!['off','minimal','low','medium','high','xhigh','max'].includes(level) || (wire === null ? level !== 'off' : typeof wire !== 'string' || !wire.trim())) throw new Error('推理等级值必须为非空字符串，仅 off 可为 null')
    }
    if (result.input !== undefined && (!Array.isArray(result.input) || result.input.some(v => !['text','image'].includes(v)))) throw new Error('input 仅支持 text、image')
    return result
  })
  const compat = jsonObject(input.compat || {}, 'compat')
  const allowedCompat = new Set(['supportsReasoningEffort','supportsStore','supportsDeveloperRole','supportsUsageInStreaming','maxTokensField','thinkingFormat','requiresToolResultName','requiresAssistantAfterToolResult','requiresThinkingAsText','requiresMistralToolIds'])
  if (Object.keys(compat).some(k => !allowedCompat.has(k))) throw new Error('compat 包含不支持的字段')
  for (const [key,value] of Object.entries(compat)) if (['maxTokensField','thinkingFormat'].includes(key) ? typeof value !== 'string' || !value : typeof value !== 'boolean') throw new Error('compat 字段类型无效')
  const apiKey = input.apiKey === undefined || input.apiKey === '' ? undefined : String(input.apiKey).trim()
  if (apiKey !== undefined && (!apiKey || apiKey.length > 16384)) throw new Error('API Key 无效')
  return { code, name, config: { api, baseURL: url.href.replace(/\/$/, ''), streamIdleTimeoutMs: timeout, compat, models }, enabled: input.enabled === undefined || input.enabled === true || input.enabled === 'true', apiKey }
}
export const managedProviderId = code => `guanyin-${code}`
export const modelCredentialRef = id => `GUANYIN_MODEL_${id.replaceAll('-', '_').toUpperCase()}`

// A small real inference request; never expose gateway bodies or credentials.
export async function testModelConnection(value, apiKey, fetcher = fetch) {
  if (!apiKey) throw new Error('请填写 API Key，或先保存提供方密钥')
  const {config} = value, model = config.models[0].id
  const headers = {'content-type':'application/json'}
  let path, body
  if (config.api === 'anthropic-messages') {
    path='/messages'; headers['x-api-key']=apiKey; headers['anthropic-version']='2023-06-01'
    body={model,max_tokens:16,messages:[{role:'user',content:'Reply OK.'}]}
  } else {
    headers.authorization=`Bearer ${apiKey}`
    if(config.api==='openai-responses') {path='/responses';body={model,input:'Reply OK.',max_output_tokens:16,stream:false}}
    else {path='/chat/completions';body={model,messages:[{role:'user',content:'Reply OK.'}],stream:false,[config.compat.maxTokensField||'max_tokens']:16}}
  }
  const started=Date.now(),signal=AbortSignal.timeout(30000)
  try {
    const response=await fetcher(config.baseURL+path,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'})
    if(!response.ok) {
      const reason=({401:'鉴权失败，请检查 API Key',403:'访问被拒绝，请检查模型权限',404:'接口或模型不存在，请检查地址和提供方编码',429:'请求受限或额度不足'})[response.status]||'网关返回错误'
      await response.body?.cancel()
      return {ok:false,elapsedMs:Date.now()-started,message:`${reason}（HTTP ${response.status}）`}
    }
    const data=await response.json()
    const valid=config.api==='anthropic-messages'?data.type==='message'&&Array.isArray(data.content):config.api==='openai-responses'?data.object==='response'&&Array.isArray(data.output):Array.isArray(data.choices)&&data.choices.some(c=>c.message&&typeof c.message==='object')
    if(!valid||data.error)return {ok:false,elapsedMs:Date.now()-started,message:'接口可访问，但未返回有效的模型响应，请检查协议和地址'}
    return {ok:true,elapsedMs:Date.now()-started,message:'连接成功，模型已返回响应'}
  } catch {
    return {ok:false,elapsedMs:Date.now()-started,message:signal.aborted?'连接超时（30 秒），请检查网络或模型服务':'连接失败，请检查地址、网络、证书及响应格式'}
  }
}
