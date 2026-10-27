import { readFile, writeFile, symlink, rm, readdir } from 'node:fs/promises'
const root = '/opt/dsh-runtime/node_modules'
const profile = '/opt/dsh-seed/profiles/web'
await rm(`${profile}/node_modules`, { recursive: true, force: true })
await symlink(root, `${profile}/node_modules`)
await writeFile(`${profile}/package.json`, JSON.stringify({ name: 'guanyin-enterprise-web-021', private: true, dsh: { profile: {
  bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@changfenhuang/dsh-genui', 'dsh-context', '@michengai/dsh-skills-manager', '@weibaohui/dsh-file-share', '@guanyin/dsh-enterprise'], patchReload: 'live',
} } }, null, 2))
await writeFile(`${profile}/cordis.patch.yml`, '[]\n', { mode: 0o600 })
await writeFile('/opt/dsh-seed/.guanyin-release', 'dsh=0.2.1-rc.3\nprofile=guanyin-enterprise-021-v1\n')
// Pinned-build shell/locale changes run before any client plugin can load.
// Fail the build when upstream changes a target, instead of silently losing brand.
async function replace(file, from, to, expected = 1) {
  const text = await readFile(file, 'utf8')
  const count = text.split(from).length - 1
  if (count !== expected) throw new Error(`Brand target changed: ${file}: expected ${expected}, got ${count}`)
  await writeFile(file, text.split(from).join(to))
}
const frontend = `${root}/@deepseek-ai/dsh-web-frontend/dist`
await replace(`${frontend}/index.html`, '<title>DeepSeek Harness</title>', '<title>观因智能空间</title>')
for (const name of await readdir(`${frontend}/assets`)) {
  if (/^index-.*\.js$/.test(name)) {
    await replace(`${frontend}/assets/${name}`, '"HARNESS"', '"观因智能空间"')
    // Preserve the actual fence language even when syntax highlighting does
    // not recognize it. The enterprise renderer consumes these DOM markers.
    await replace(`${frontend}/assets/${name}`, '"data-line-numbers":s||void 0,"data-code-wrap":p===void 0?void 0:A', '"data-code-language":t,"data-code-streaming":r===!0?"true":void 0,"data-line-numbers":s||void 0,"data-code-wrap":p===void 0?void 0:A')
  }
}
const models = `${root}/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`
await replace(models, 'const configured = state.rows.filter((row) => row.configured);', 'const configured = state.rows.filter((row) => row.configured && row.entry.provider !== "deepseek-official");')
await replace(models, 'const configurable = state.rows.filter((row) => state.namespaces.has(row.entry.settingsNs));', 'const configurable = state.rows.filter((row) => row.entry.provider !== "deepseek-official" && state.namespaces.has(row.entry.settingsNs));')
let source = await readFile(models, 'utf8')
const onboarding = /ctx\.slots\.inject\("settings\.onboarding", \(\) => ctx\.slots\.register\(\{\s*name: "settings\.onboarding",\s*id: "deepseek-official",[\s\S]*?\}, DeepSeekOnboardingDialog\)\);/
if (!onboarding.test(source)) throw new Error('Official model onboarding target changed')
source = source.replace(onboarding, '')
await writeFile(models, source)
const chat = `${root}/@deepseek-ai/dsh-client-ui-chat/lib/client.js`
await replace(chat, '深度求索中', '观因分析中', 2)
await replace(models, 'if (!("dshDesktop" in globalThis)) ctx.slots.inject', 'if (false) ctx.slots.inject')
await replace(`${root}/@deepseek-ai/dsh-client-ui-layout/lib/client.js`, 'const productTitle = "DeepSeek Harness";', 'const productTitle = "观因智能空间";')
const conversation = `${root}/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`
await replace(conversation, '"hero.headline": "探索未至之境"', '"hero.headline": "智能运维 · 办公提效 · 应用构建 · 代码审查"')
await replace(conversation, '"hero.preview": "预览版"', '"hero.preview": "企业版"')
