import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const RPC_METHODS = new Set([
  'session/cancel',
  'session/create',
  'session/modelCatalog',
  'session/prompt',
  'session/selectModel',
  'skills/list',
])

function remoteError(method, error = {}) {
  const failure = new Error(error.message || `DSH Remote ${method} 调用失败`)
  failure.code = error.code || 'DSH_REMOTE_FAILED'
  failure.details = error.details || {}
  return failure
}

function parseRpc(method, response) {
  if (!response || response.type !== 'server-response' || !response.result) throw new Error(`DSH Remote ${method} 返回了无效响应`)
  if (!response.result.ok) throw remoteError(method, response.result.error)
  return response.result.value
}

export class DshAdapter {
  constructor({ instance, token, namespace = process.env.DSH_NAMESPACE || 'guanyin-enterprise-instances', fetchImpl = fetch, WebSocketImpl = WebSocket }) {
    if (!instance?.slug || !token) throw new Error('DSH Adapter requires instance.slug and extension token')
    this.httpBase = `http://dsh-${instance.slug}.${namespace}.svc.cluster.local:3080`
    this.wsUrl = `ws://dsh-${instance.slug}.${namespace}.svc.cluster.local:3080/__guanyin/dsh-stream`
    this.token = token
    this.fetchImpl = fetchImpl
    this.WebSocketImpl = WebSocketImpl
  }

  async rpc(method, args = {}, { signal, timeoutMs = 15_000 } = {}) {
    if (!RPC_METHODS.has(method)) throw new Error(`DSH Remote method is not allowed: ${method}`)
    const timeout = signal ? undefined : AbortSignal.timeout(timeoutMs)
    const response = await this.fetchImpl(`${this.httpBase}/__guanyin/dsh-rpc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-guanyin-token': this.token },
      body: JSON.stringify(args),
      signal: signal || timeout,
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data.error || `DSH Adapter 返回 HTTP ${response.status}`)
    return parseRpc(method, data)
  }

  createSession({ cwd = '/workspace', workspaceId, sessionId, agentPreset } = {}, options) {
    return this.rpc('session/create', { request: {
      ...(cwd ? { cwd } : {}), ...(workspaceId ? { workspaceId } : {}),
      ...(sessionId ? { sessionId } : {}), ...(agentPreset ? { agentPreset } : {}),
    } }, options)
  }

  prompt({ sessionId, content, mode = 'queue', requestId = randomUUID(), clientTimeZone = 'Asia/Shanghai' }, options) {
    return this.rpc('session/prompt', { request: { requestId, sessionId, mode, content, clientTimeZone } }, options)
  }

  cancel(sessionId, options) {
    return this.rpc('session/cancel', { request: { sessionId } }, options)
  }

  /** Open one DSH follow generation. Reopen on transport failure using the latest snapshot/cursor; never resubmit a prompt. */
  follow(sessionId, { maxMessages = 200, assistantStream = true, signal } = {}) {
    const socket = new this.WebSocketImpl(this.wsUrl, { headers: { 'x-guanyin-token': this.token } })
    const streamId = randomUUID()
    const frames = []
    let ended = false; let failure; let wake
    const notify = () => { wake?.(); wake = undefined }
    socket.on('open', () => socket.send(JSON.stringify({
      type: 'open', streamId, endpoint: 'session/follow',
      payload: { args: { request: { address: { kind: 'session', sessionId }, maxMessages, ...(assistantStream ? { assistantStream: true } : {}) } } },
    })))
    socket.on('message', bytes => {
      try {
        const message = JSON.parse(bytes.toString())
        if (message.streamId !== streamId) return
        if (message.type === 'item') frames.push(message.value)
        else if (message.type === 'error') failure = remoteError('session/follow', message.error)
        else if (message.type === 'end') ended = true
      } catch (error) { failure = error }
      notify()
    })
    socket.on('error', error => { failure = error; notify() })
    socket.on('close', () => { ended = true; notify() })
    const abort = () => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'cancel', streamId })); socket.close() }
    signal?.addEventListener('abort', abort, { once: true })
    return (async function* () {
      try {
        while (!ended || frames.length) {
          if (failure) throw failure
          if (frames.length) { yield frames.shift(); continue }
          await new Promise(resolve => { wake = resolve })
        }
        if (failure) throw failure
      } finally {
        signal?.removeEventListener('abort', abort)
        abort()
      }
    })()
  }
}

export function dshEventToApiEvent(frame) {
  if (frame?.type === 'assistant-stream') {
    const assistant = frame.frame || {}
    if (assistant.type === 'start') return { type: 'run.progress', data: { phase: 'model', state: 'started' } }
    if (assistant.type === 'end') return { type: 'run.progress', data: { phase: 'model', state: 'completed', outcome: assistant.outcome?.kind } }
    const chunk = assistant.chunk || {}
    if (['text','text-delta'].includes(chunk.type) && typeof (chunk.text || chunk.delta) === 'string') {
      return { type: 'run.progress', data: { phase: 'model', text: chunk.text || chunk.delta } }
    }
    // Reasoning/provider frames are deliberately not projected to the public API.
    return null
  }
  if (frame?.type !== 'event') return null
  const event = frame.event || {}
  // run.started is emitted by the Guanyin worker after it owns the execution;
  // DSH turn/start is an internal turn boundary and must not duplicate it.
  if (event.type === 'turn/start') return null
  if (event.type === 'step/start') return { type: 'step.started', data: event.data }
  if (event.type === 'step/end') return { type: 'step.completed', data: event.data }
  if (event.type === 'tool/call') return { type: 'tool.started', data: event.data }
  if (event.type === 'tool/result') return { type: 'tool.completed', data: event.data }
  if (event.type === 'turn/end') {
    const reason = event.data?.reason
    return reason?.kind === 'error'
      ? { type: 'run.failed', data: { error: reason.error || reason } }
      : { type: 'run.completed', data: event.data }
  }
  return null
}
