import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

test('an earlier MCP save cannot close or modify a newly opened editor', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8')
  const start = source.indexOf("$('#mcp-form').onsubmit =")
  const end = source.indexOf("\n$('#", start + 1)
  const button = { disabled: false }
  const message = { textContent: '' }
  const form = {
    dataset: { id: 'cmdb' }, elements: { enabled: { checked: true } },
    querySelector: selector => selector === 'button[type=submit]' ? button : message,
  }
  const toasts = []
  let resolveSave, closed = 0
  const context = {
    mcpFormRevision: 1,
    $: selector => selector === '#mcp-form' ? form : { close() { closed++ } },
    FormData: class { *[Symbol.iterator]() { yield ['name', 'cmdb']; yield ['headers', ''] } },
    request: () => new Promise(resolve => { resolveSave = resolve }),
    toast: value => toasts.push(value),
    loadMcpServers: async () => {},
    watchMcpSave: async () => {},
  }
  runInNewContext(source.slice(start, end), context)
  const saving = form.onsubmit({ preventDefault() {}, target: form })
  context.mcpFormRevision = 2
  form.dataset.id = 'itsm'
  form.dataset.saving = 'true'
  message.textContent = 'ITSM saving'
  button.disabled = true
  resolveSave({})
  await saving
  assert.equal(closed, 0)
  assert.equal(message.textContent, 'ITSM saving')
  assert.equal(button.disabled, true)
  assert.equal(form.dataset.saving, 'true')
  assert.ok(toasts[0].startsWith('cmdb 已保存'))
})
