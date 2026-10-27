import { readFile, writeFile } from 'node:fs/promises'
const file = '/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js'
const source = await readFile(file, 'utf8')
// An upload can fail before its body is consumed. Flush its JSON error before
// closing the unread request, otherwise intermediaries receive ECONNRESET/502.
const from = 'res.end();\n\t\tif (requestUnread) req.destroy();'
const to = 'res.end(() => { if (requestUnread) req.destroy(); }); // Guanyin: flush upload rejection'
const from2 = 'res.end();\n\tif (requestUnread) req.destroy();'
const to2 = 'res.end(() => { if (requestUnread) req.destroy(); }); // Guanyin: flush upload rejection'
let patched = source
if (!source.includes('Guanyin: flush upload rejection')) {
  if (source.split(from).length !== 2 || source.split(from2).length !== 2) throw new Error('HTTP bridge contract changed')
  patched = source.replace(from, to).replace(from2, to2)
}
const unread = 'const requestUnread = bodyMode === "streaming" && !req.readableEnded;'
const drain = `${unread}
\t// Guanyin: drain rejected upload without buffering before closing TCP.
\t// Closing with unread bytes can reset a proxy socket before JSON arrives.
\tif (requestUnread && request.body !== null && !request.body.locked) {
\t\tlet discarded = 0;
\t\tfor await (const chunk of request.body) {
\t\t\tdiscarded += chunk.byteLength;
\t\t\tif (discarded > maxRequestBodyBytes) {
\t\t\t\tres.writeHead(413, { connection: "close" });
\t\t\t\tres.end(() => req.destroy());
\t\t\t\treturn;
\t\t\t}
\t\t}
\t}`
if (!patched.includes('Guanyin: drain rejected upload')) {
  if (patched.split(unread).length !== 2) throw new Error('HTTP streaming bridge contract changed')
  patched = patched.replace(unread, drain)
}
await writeFile(file, patched)
