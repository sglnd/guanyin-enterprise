import Ajv from 'ajv'
import { DshAdapter, dshEventToApiEvent } from './dsh-adapter.mjs'

const ajv = new Ajv({ allErrors: true, strict: false })
const terminalStatuses = new Set(['succeeded','failed','cancelled','timed_out'])

export function validateApiInput(contract, input) {
  if (!contract?.inputSchema) return { valid: true }
  const validate = ajv.compile(contract.inputSchema)
  return validate(input) ? { valid: true } : { valid: false, errors: validate.errors }
}

export function validateApiOutput(contract, output) {
  if (!contract?.outputSchema) return { valid: true }
  const validate = ajv.compile(contract.outputSchema)
  return validate(output) ? { valid: true } : { valid: false, errors: validate.errors }
}

function promptText(contract, input) {
  const instruction = String(contract?.instruction || contract?.prompt || '').trim()
  return `${instruction}${instruction ? '\n\n' : ''}请根据以下接口输入完成任务，并只返回符合输出 Schema 的 JSON。\n<api-input>\n${JSON.stringify(input)}\n</api-input>`
}

function textFromAssistantEvent(frame) {
  if (frame?.type !== 'event' || frame.event?.type !== 'assistant/message') return ''
  const content = frame.event.data?.message?.content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
}

function parseModelJson(text) {
  const trimmed = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  if (!trimmed) return {}
  return JSON.parse(trimmed)
}

export class ApiRunWorker {
  constructor({ store, adapterFor, ensureInstanceReady, concurrency = 4, pollMs = 500 }) {
    this.store = store
    this.adapterFor = adapterFor
    this.ensureInstanceReady = ensureInstanceReady
    this.concurrency = concurrency
    this.pollMs = pollMs
    this.active = new Set()
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.pollMs)
    this.timer.unref()
    void this.tick()
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  async tick() {
    try {
      await this.store.expireQueuedApiRuns()
      while (this.active.size < this.concurrency) {
        const run = await this.store.claimApiRun()
        if (!run) break
        this.active.add(run.id)
        void this.execute(run.id).catch(error => console.error(`API run ${run.id} failed`, error)).finally(() => this.active.delete(run.id))
      }
    } catch (error) { console.error('API run claim failed', error) }
  }

  async execute(runId) {
    const run = await this.store.apiRunExecutionContext(runId)
    let adapter; let sessionId; let finalText = ''
    const timeoutMs = Math.max(Number(run.contract?.executionTimeoutSeconds || 300), 1) * 1000
    const execution = new AbortController()
    const timeout = setTimeout(() => execution.abort(new Error('execution timeout')), timeoutMs)
    try {
      await this.ensureInstanceReady(run)
      adapter = await this.adapterFor(run)
      const conversation = await this.store.getApiConversation(run.credentialId, run.apiReleaseId, run.conversationKey)
      if (conversation) sessionId = conversation.dshSessionId
      else {
        sessionId = (await adapter.createSession({ cwd: '/workspace' })).sessionId
        await this.store.setApiConversation(run.credentialId, run.apiReleaseId, run.conversationKey, sessionId)
      }
      await this.store.setApiRunSession(run.id, sessionId)
      await this.store.appendApiRunEvent(run.id, 'run.started', { runId: run.id })
      let submitted = false; let terminal
      for await (const frame of adapter.follow(sessionId, { signal: execution.signal })) {
        if (!submitted && frame.type === 'snapshot') {
          submitted = true
          await adapter.prompt({ sessionId, content: [{ type: 'text', text: promptText(run.contract, run.input) }] }, { signal: execution.signal })
        }
        finalText += textFromAssistantEvent(frame)
        const projected = dshEventToApiEvent(frame)
        if (!projected) continue
        if (projected.type === 'run.completed' || projected.type === 'run.failed') { terminal = projected; break }
        await this.store.appendApiRunEvent(run.id, projected.type, projected.data)
      }
      if (terminal?.type === 'run.failed') throw remoteRunError(terminal.data?.error)
      const output = parseModelJson(finalText)
      const validation = validateApiOutput(run.contract, output)
      if (!validation.valid) {
        const error = new Error('模型返回结果不符合接口输出 Schema')
        error.code = 'OUTPUT_SCHEMA_VALIDATION_FAILED'; error.details = validation.errors
        throw error
      }
      await this.store.finishApiRun(run.id, { status: 'succeeded', output })
      await this.store.appendApiRunEvent(run.id, 'run.completed', { output })
    } catch (error) {
      const current = await this.store.apiRunById(run.id)
      if (current?.status === 'cancelled') return
      const timedOut = execution.signal.aborted
      const code = timedOut ? 'EXECUTION_TIMEOUT' : (error.code || 'DSH_EXECUTION_FAILED')
      const message = timedOut ? '接口执行超时' : error.message
      await this.store.finishApiRun(run.id, { status: timedOut ? 'timed_out' : 'failed', errorCode: code, errorMessage: message })
      await this.store.appendApiRunEvent(run.id, 'run.failed', { code, message })
      if (adapter && sessionId) await adapter.cancel(sessionId).catch(() => {})
    } finally { clearTimeout(timeout) }
  }
}

function remoteRunError(value = {}) {
  const error = new Error(value.message || 'DSH 执行失败')
  error.code = value.code || 'DSH_EXECUTION_FAILED'
  return error
}

export function createDshAdapter(options) { return new DshAdapter(options) }
export function isTerminalApiRun(status) { return terminalStatuses.has(status) }
