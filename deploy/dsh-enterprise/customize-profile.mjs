import { readFile, writeFile, readdir } from 'node:fs/promises'

const profileDir = process.argv[2]
const dshModulesDir = process.argv[3]
if (!profileDir || !dshModulesDir) throw new Error('profile and DSH modules directories are required')

async function replaceOnce(path, before, after, label) {
  const source = await readFile(path, 'utf8')
  const matches = source.split(before).length - 1
  if (matches !== 1) throw new Error(`${label}: expected one match, found ${matches}`)
  await writeFile(path, source.replace(before, after))
}

const modelsClient = `${dshModulesDir}/@deepseek-ai/dsh-client-ui-settings-models/lib/client.js`

await replaceOnce(
  modelsClient,
  'const configured = state.rows.filter((row) => row.configured);',
  'const configured = state.rows.filter((row) => row.configured && row.entry.provider !== "deepseek-official");',
  'hide configured DeepSeek official provider',
)

await replaceOnce(
  modelsClient,
  'const configurable = state.rows.filter((row) => state.namespaces.has(row.entry.settingsNs));',
  'const configurable = state.rows.filter((row) => row.entry.provider !== "deepseek-official" && state.namespaces.has(row.entry.settingsNs));',
  'hide addable DeepSeek official provider',
)

await replaceOnce(
  modelsClient,
  `\t\t\tctx.slots.inject("settings.onboarding", () => ctx.slots.register({
\t\t\t\tname: "settings.onboarding",
\t\t\t\tid: "deepseek-official",
\t\t\t\torder: 0,
\t\t\t\tinject: deepSeekOnboardingInjected
\t\t\t}, DeepSeekOnboardingDialog));`,
  '',
  'remove DeepSeek API key onboarding',
)

const policyPatch = `${profileDir}/node_modules/@guanyin/dsh-ui-policy/cordis.patch.yml`
const patch = await readFile(policyPatch, 'utf8')
if (!patch.includes('id: web-search-deepseek')) {
  await writeFile(policyPatch, `${patch.trimEnd()}\n- id: web-search-deepseek\n  disabled: true\n`)
}

const result = await readFile(modelsClient, 'utf8')
if (result.includes('id: "deepseek-official",\n\t\t\t\torder: 0')) throw new Error('DeepSeek onboarding is still registered')
if (!result.includes('row.entry.provider !== "deepseek-official"')) throw new Error('DeepSeek provider filter was not installed')

const enterpriseUiClient = await readFile(`${profileDir}/node_modules/@guanyin/dsh-ui-policy/lib/client.js`, 'utf8')
if (!enterpriseUiClient.includes("<strong>观因</strong>")) throw new Error('Guanyin enterprise brand is missing from the UI policy')
if (/文昌|Wenchang/i.test(enterpriseUiClient)) throw new Error('community Wenchang brand leaked into the enterprise UI policy')
const usagePolicy = await readFile(`${profileDir}/node_modules/@guanyin/dsh-ui-policy/lib/usage.js`, 'utf8')
if (!usagePolicy.includes('meterStream')) throw new Error('Guanyin enterprise usage policy is missing')

// Patch the shell before plugins load, so the initial spinner is branded too.
const frontend = `${dshModulesDir}/@deepseek-ai/dsh-web-frontend/dist`
const shellFiles = (await readdir(`${frontend}/assets`)).filter(name => /^index-.*\.js$/.test(name))
if (shellFiles.length !== 1) throw new Error('Expected exactly one DSH frontend shell bundle')
await replaceOnce(`${frontend}/assets/${shellFiles[0]}`, '"HARNESS"', '"观因智能空间"', 'brand workspace boot spinner')
await replaceOnce(`${frontend}/index.html`, '<title>DeepSeek Harness</title>', '<title>观因智能空间</title>', 'brand initial page title')
await replaceOnce(`${dshModulesDir}/@deepseek-ai/dsh-client-ui-chat/lib/client.js`, '"chat.deepDiving": "深度求索中..."', '"chat.deepDiving": "观因分析中..."', 'brand analysis status')
