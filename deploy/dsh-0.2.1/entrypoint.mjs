import { compatibleProfileUpgrade, managedBundles } from './profile-compat.mjs'
import { cp, mkdir, readFile, writeFile, access, rm, rename } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

// PTYs inherit these values, including on existing workspace PVCs.
process.env.LANG ||= 'C.UTF-8'
process.env.LC_ALL ||= 'C.UTF-8'
process.env.TERM ||= 'xterm-256color'

const home = process.env.DSH_HOME || '/data/dsh'
const seed = '/opt/dsh-seed'
const marker = '.guanyin-release'
await mkdir(home, { recursive: true })
let existing = false
try { await access(join(home, 'profiles/web/package.json')); existing = true } catch {}
if (existing) {
  let actual
  try { actual = await readFile(join(home, marker), 'utf8') } catch {}
  const desired = await readFile(join(seed, marker), 'utf8')
  if (actual !== desired) {
    if (!compatibleProfileUpgrade(actual, desired)) {
      console.error('空间数据版本与 0.2.1 镜像不匹配，请创建独立空间。')
      process.exit(78)
    }
    const packageFile = join(home, 'profiles/web/package.json')
    const packageText = await readFile(packageFile, 'utf8')
    const manifest = JSON.parse(packageText)
    const managed = JSON.parse(await readFile(join(seed, 'profiles/web/package.json'), 'utf8')).dsh.profile.bundles
    if (!Array.isArray(manifest.dsh?.profile?.bundles)) throw new Error('Invalid existing profile bundles')
    await writeFile(join(home, '.guanyin-profile-before-rc3.json'), packageText, { flag: 'wx', mode: 0o600 }).catch(e => { if (e.code !== 'EEXIST') throw e })
    manifest.dsh.profile.bundles = managedBundles(manifest.dsh.profile.bundles, managed)
    await writeFile(packageFile + '.rc3.tmp', JSON.stringify(manifest, null, 2), { mode: 0o600 })
    await rename(packageFile + '.rc3.tmp', packageFile)
    await writeFile(join(home, marker + '.previous'), actual, { mode: 0o600 })
    await writeFile(join(home, marker + '.tmp'), desired, { mode: 0o600 })
    await rename(join(home, marker + '.tmp'), join(home, marker))
    console.log('观因空间 profile 已兼容升级至 rc3；原设置与会话保留。')
  }
} else {
  // Never seed an existing 0.1.5/unmanaged data volume with the new profile.
  try { await access(join(home, '.bankops-release')); console.error('拒绝覆盖已有版本空间。'); process.exit(78) } catch {}
  await cp(seed, home, { recursive: true, dereference: false })
}
// Enterprise bundle policy must follow contributed plugin rows. Repair the
// ordering of existing rc3 profiles too, without removing custom bundles.
const profileFile = join(home, 'profiles/web/package.json')
const currentProfile = JSON.parse(await readFile(profileFile, 'utf8'))
const bundles = currentProfile.dsh?.profile?.bundles
if (!Array.isArray(bundles)) throw new Error('Invalid managed profile')
const ordered = managedBundles(bundles, [])
if (JSON.stringify(bundles) !== JSON.stringify(ordered)) {
  currentProfile.dsh.profile.bundles = ordered
  await writeFile(profileFile + '.order.tmp', JSON.stringify(currentProfile, null, 2), { mode: 0o600 })
  await rename(profileFile + '.order.tmp', profileFile)
}
await rm('/tmp/dsh-web-token', { force: true })
const proxy = spawn(process.execPath, ['/opt/dsh-runtime/web-proxy.mjs'], { stdio: 'inherit' })
const args = process.argv.slice(2)
if (args[0] === 'dsh') for (const host of (process.env.DSH_TRUSTED_HOSTS || '').split(',').filter(Boolean)) args.push('--trusted-host', host)
const child = spawn(args[0], args.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] })
for (const stream of [child.stdout, child.stderr]) {
  const lines = createInterface({ input: stream })
  lines.on('line', line => {
    console.log(line)
    const match = line.match(/[?&]token=([^\s\u001b]+)/)
    if (match) void writeFile('/tmp/dsh-web-token', decodeURIComponent(match[1]), { mode: 0o600 })
  })
}
let stopping = false
function stop(signal = 'SIGTERM') { if (stopping) return; stopping = true; child.kill(signal); proxy.kill(signal) }
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(signal))
proxy.on('exit', code => { if (!stopping) { console.error('空间代理退出'); stop(); process.exitCode = code || 1 } })
child.on('error', error => { console.error(error.message); stop(); process.exitCode = 1 })
child.on('exit', code => { stop(); process.exitCode = code ?? 1 })
