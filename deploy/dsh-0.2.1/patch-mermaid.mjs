import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const file = '/opt/dsh-runtime/node_modules/dsh-mermaid-web/lib/client.js'
let source = await readFile(file, 'utf8')
function replace(from, to) {
  if (source.split(from).length !== 2) throw new Error(`Mermaid compatibility target changed: ${from}`)
  source = source.replace(from, to)
}
// rc3 exposes the actual language even when syntax highlighting is unavailable.
replace('const language = ((block.children.item(0)?.children.item(0))?.children.item(0))?.textContent?.trim().toLowerCase();', 'const language = (block.dataset.codeLanguage ?? ((block.children.item(0)?.children.item(0))?.children.item(0))?.textContent)?.trim().toLowerCase();')
replace('if (block.closest("[data-streaming]") !== null) return;', 'if (block.dataset.codeStreaming === "true" || block.closest("[data-streaming]") !== null) return;')
replace('attributeFilter: ["data-streaming"]', 'attributeFilter: ["data-streaming", "data-code-streaming", "data-code-language"]')
for (const [a,b] of [['summary.textContent = "Mermaid source"','summary.textContent = "图表源码"'], ['button("Expand",','button("全屏",'], ['button("Fit",','button("适应窗口",'], ['button("Close",','button("关闭",']]) replace(a,b)
source = source.replace('//# sourceMappingURL=client.js.map', '')
await writeFile(file, source)
console.log('Installed rc3 Mermaid adapter:', createHash('sha256').update(source).digest('hex'))
