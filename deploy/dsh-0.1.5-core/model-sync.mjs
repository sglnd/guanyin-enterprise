// This bridge only owns guanyin-* provider routes and GUANYIN_MODEL_* credentials.
// The caller is authenticated by web-proxy with the workspace extension token.
export async function synchronizeModels(payload, rpc) {
  if (!payload || !Array.isArray(payload.providers) || payload.providers.length > 100) throw new Error('invalid providers')
  const desired = new Map()
  for (const item of payload.providers) {
    const unauthenticated = item?.authMode === 'none'
    if (!/^guanyin-[a-z][a-z0-9-]{0,47}$/.test(item?.id) || !item.config || !Array.isArray(item.config.models)) throw new Error('invalid managed model provider')
    if (!unauthenticated && (!/^GUANYIN_MODEL_[A-F0-9_]+$/.test(item.credentialRef) || typeof item.apiKey !== 'string' || !item.apiKey)) throw new Error('invalid managed model provider')
    if (unauthenticated && (item.credentialRef !== undefined || item.apiKey !== undefined)) throw new Error('invalid managed model provider')
    if (desired.has(item.id)) throw new Error('duplicate managed provider')
    desired.set(item.id, item)
  }
  if (payload.defaultModel && !desired.get(payload.defaultModel.provider)?.config.models.some(m => m.id === payload.defaultModel.model)) throw new Error('invalid default model')
  const snapshot = await rpc('settings/describe', {})
  const ns = snapshot.namespaces.find(item => item.ns === 'llm-pi-ai')
  if (!snapshot.writable || !ns) throw new Error('model settings are unavailable')
  const previous = ns.value?.providers || {}
  const stale = Object.entries(previous).filter(([id]) => id.startsWith('guanyin-') && !desired.has(id))
  const ops = stale.map(([id]) => ({ op: 'unset', path: ['providers', id] }))
  for (const item of desired.values()) {
    if (item.authMode === 'none') {
      const previousRef = previous[item.id]?.apiKeyEnv
      if (/^GUANYIN_MODEL_[A-F0-9_]+$/.test(previousRef || '')) await rpc('credentials/unset', {ref:previousRef})
      ops.push({ op: 'set', path: ['providers', item.id], value: { ...item.config } })
    } else {
      await rpc('credentials/set', {ref:item.credentialRef,value:item.apiKey})
      ops.push({ op: 'set', path: ['providers', item.id], value: { ...item.config, apiKeyEnv: item.credentialRef } })
    }
  }
  if (ops.length) await rpc('settings/mutate', {ns:'llm-pi-ai',ops,expectedRevision:ns.revision})
  const defaults = snapshot.namespaces.find(item => item.ns === 'agent-default-model')
  if (payload.defaultModel) {
    const provider = desired.get(payload.defaultModel.provider)
    if (!provider?.config.models.some(model => model.id === payload.defaultModel.model)) throw new Error('invalid default model')
    await rpc('settings/update', {ns:'agent-default-model',patch:payload.defaultModel,expectedRevision:defaults?.revision})
  } else if (defaults?.value?.provider?.startsWith('guanyin-')) {
    await rpc('settings/mutate', {ns:'agent-default-model',ops:[{op:'unset',path:['provider']},{op:'unset',path:['model']}],expectedRevision:defaults.revision})
  }
  for (const [, item] of stale) if (/^GUANYIN_MODEL_[A-F0-9_]+$/.test(item.apiKeyEnv)) await rpc('credentials/unset', {ref:item.apiKeyEnv})
  return { providers: [...desired.keys()] }
}
