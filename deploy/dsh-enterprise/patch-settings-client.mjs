import { readFile, writeFile } from 'node:fs/promises'

const file = process.argv[2]
if (!file) throw new Error('settings client path is required')
const source = await readFile(file, 'utf8')
const original = 'const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";'
if (source.split(original).length !== 2) throw new Error('DSH settings client changed; review the production settings patch')
// The control plane signs each workspace identity and the runtime verifies it.
// Enable Host persistence only after that authenticated same-origin handshake.
// DSH still owns RPC authorization, secret redaction and write permissions.
const patched = source.replace(original, `let workspaceAuthenticated = false;
            try {
              const response = await fetch('/__guanyin/identity', { credentials: 'same-origin', cache: 'no-store' });
              if (response.ok) {
                const identity = await response.json();
                workspaceAuthenticated = Boolean(identity.user && identity.space);
              }
            } catch {}
            const persistence = ctx.remote.$host.isLoopback || workspaceAuthenticated ? "host" : "memory";`)
const marker = 'function apply(ctx) {'
if (patched.split(marker).length !== 2) throw new Error('DSH settings apply changed; review the production settings patch')
await writeFile(file, patched.replace(marker, 'async function apply(ctx) {'))
