import {readFile,writeFile} from 'node:fs/promises'
const file='/opt/dsh-runtime/node_modules/@deepseek-ai/dsh-experimental-browser-use-playwright-mcp/lib/index.js'
let source=await readFile(file,'utf8')
if (!source.includes('guanyin-browser-proxy-v1')) {
 const needle='\tmountSessionMcp(ctx, {'
 if (source.split(needle).length!==2) throw new Error('Browser provider patch target changed')
 source='import { writeFileSync as guanyinWriteProxyConfig } from "node:fs";\n'+source
 source=source.replace(needle,`\t// guanyin-browser-proxy-v1: explicit Chromium proxy; credentials stay in a mode-0600 runtime file.
 if (process.env.GUANYIN_BROWSER_PROXY_URL) {
   if(config.mode !== 'launch') throw new Error('Managed browser proxy requires launch mode');
   const proxy = new URL(process.env.GUANYIN_BROWSER_PROXY_URL);
   const path = '/tmp/guanyin-playwright-proxy-' + process.pid + '.json';
   guanyinWriteProxyConfig(path,JSON.stringify({browser:{launchOptions:{proxy:{server:proxy.protocol+'//'+proxy.host,username:decodeURIComponent(proxy.username),password:decodeURIComponent(proxy.password),bypass:'<-loopback>'}}}}),{mode:0o600});
   args.push('--config',path);
 }
`+needle)
 await writeFile(file,source)
}
