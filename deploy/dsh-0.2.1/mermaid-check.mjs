// Run inside the disposable 0.2.1 runtime, never against customer sessions.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  await page.setContent('<html><head></head><body></body></html>')
  await page.evaluate(() => {
    window.__ModuleLoader__ = { load({factory}) { window.plugin = factory(() => { throw Error('unexpected external dependency') }) } }
    window.cleanups = []
  })
  await page.addScriptTag({ path: '/opt/dsh-runtime/node_modules/dsh-mermaid-web/lib/client.js' })
  await page.evaluate(() => {
    window.plugin.apply({effect(fn) { const dispose=fn(); if(typeof dispose==='function')window.cleanups.push(dispose) }})
    const add = (id, source, streaming=false) => {
      const block=document.createElement('div');block.className='md-code-block';block.id=id
      block.dataset.codeLanguage='mermaid';block.dataset.codeStreaming=String(streaming)
      block.innerHTML='<div><div><span>text</span></div></div><pre></pre>'
      block.querySelector('pre').textContent=source;document.body.append(block)
    }
    add('good', 'flowchart LR\n A[用户] --> B[观因]')
    add('stream', 'sequenceDiagram\n Alice->>Bob: Hello', true)
    add('bad', 'not a valid diagram')
  })
  await page.waitForSelector('#good svg', { timeout: 30000 })
  assert.equal(await page.locator('#good svg').count(), 1)
  assert.equal(await page.locator('#stream svg').count(), 0)
  await page.waitForSelector('#bad .dsh-mermaid-error')
  assert.equal(await page.locator('#bad pre').first().isVisible(), true)
  await page.evaluate(()=>document.querySelector('#stream').dataset.codeStreaming='false')
  await page.waitForSelector('#stream svg')
  await page.locator('#good').getByRole('button', {name: 'Zoom in', exact: true}).click()
  assert.equal(await page.locator('#good .dsh-mermaid-zoom-reset').textContent(), '125%')
  await page.locator('#good .dsh-mermaid-expand').click()
  await page.waitForSelector('dialog[open] svg')
  await page.keyboard.press('Escape')
  await page.waitForSelector('#good svg')
  await page.evaluate(()=>window.cleanups.reverse().forEach(fn=>fn()))
  assert.equal(await page.locator('#good svg').count(),0)
  assert.equal(await page.locator('#good pre').isVisible(),true)
  console.log(JSON.stringify({rc3LanguageMarker:true, rendered:true, zoom:true, streamingDeferred:true, fullscreen:true, parseErrorFallback:true, disposalRestoresSource:true}))
} finally { await browser.close() }
