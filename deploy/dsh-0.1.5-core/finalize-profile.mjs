import { readFile, writeFile } from 'node:fs/promises'

const profileDir = process.argv[2]
if (!profileDir) throw new Error('profile directory is required')
const uiPolicyPath = process.argv[3]
if (!uiPolicyPath) throw new Error('UI policy path is required')

const uiPolicy = JSON.parse(await readFile(uiPolicyPath, 'utf8'))
const hostOnlyPackages = new Set(uiPolicy.hostOnlyPackages || [])

const manifestPath = `${profileDir}/package.json`
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))

for (const packageName of Object.keys(manifest.dependencies || {})) {
  const installedPath = `${profileDir}/node_modules/${packageName}/package.json`
  const installed = JSON.parse(await readFile(installedPath, 'utf8'))
  if (hostOnlyPackages.has(packageName) && installed.dsh?.client) {
    // UI publication decisions live in guanyin-ui-policy/build-policy.json.
    // Host bundles stay active while their browser administration pages do not.
    delete installed.dsh.client
    await writeFile(installedPath, `${JSON.stringify(installed, null, 2)}\n`)
  }
  manifest.dependencies[packageName] = installed.version
}

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
