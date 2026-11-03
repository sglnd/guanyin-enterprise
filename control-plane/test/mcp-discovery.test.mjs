import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { discoverMcpTools } from '../mcp-discovery.mjs'
test('discovery initializes, carries upstream session and cleans it up without exposing headers', async t => {
  const methods=[]
  const server=http.createServer(async(req,res)=>{assert.equal(req.headers.authorization,'Bearer secret');if(req.method==='DELETE'){methods.push('DELETE');res.end();return}let body='';for await(const c of req)body+=c;const m=JSON.parse(body);methods.push(m.method);res.setHeader('content-type','application/json');if(m.method==='initialize'){res.setHeader('mcp-session-id','probe-session');res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}))}else{assert.equal(req.headers['mcp-session-id'],'probe-session');res.end(m.method==='tools/list'?JSON.stringify({jsonrpc:'2.0',id:2,result:{tools:[{name:'read',description:'read data',inputSchema:{}}]}}):'')}})
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());const result=await discoverMcpTools({url:`http://127.0.0.1:${server.address().port}`,headers:{Authorization:'Bearer secret'}});assert.deepEqual(result,{tools:[{name:'read',description:'read data'}],hasMore:false});assert.deepEqual(methods,['initialize','notifications/initialized','tools/list','DELETE'])
})
