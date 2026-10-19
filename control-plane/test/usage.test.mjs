import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {dirname,join} from 'node:path'
import {usageEvent,usageQuery} from '../usage.mjs'
import {usageCounts,meterStream,installUsage,actorPath} from '../../deploy/dsh-0.1.5-core/guanyin-ui-policy/lib/usage.js'
test('usage is nullable, validated, and queries are limited to the rolling calendar year',()=>{
 const e={id:randomUUID(),occurredAt:new Date().toISOString(),provider:'p',model:'m',result:'success',quality:'unknown',inputTokens:0}
 assert.equal(usageEvent(e).inputTokens,null)
 assert.throws(()=>usageEvent({...e,totalTokens:-1}))
 assert.throws(()=>usageQuery(new URLSearchParams('group=arbitrary')))
 const q=usageQuery(new URLSearchParams('from=2020-01-01&group=space'),new Date('2026-10-13T00:00:00Z'))
 assert.equal(q.from.toISOString(),'2025-10-13T00:00:00.000Z')
 assert.equal(q.pageSize,20)
 assert.equal(usageCounts(undefined).quality,'unknown')
 assert.equal(usageCounts({inputTokens:0,outputTokens:0,totalTokens:0}).totalTokens,null)
 const counts=usageCounts({inputTokens:20,outputTokens:10,totalTokens:50,cacheReadTokens:20})
 assert.equal(counts.inputTokens,40);assert.equal(counts.totalTokens,50)
})
test('one record per actual stream, last cumulative usage wins, no prompt text stored',async()=>{
 const records=[],options={provider:'p',model:'m',sessionId:'s',messages:[{content:'PRIVATE'}]}
 async function* stream(){yield {type:'usage',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};yield {type:'usage',usage:{inputTokens:2,outputTokens:3,totalTokens:5}};yield {type:'finish',reason:{kind:'stop'}}}
 for(let i=0;i<2;i++)for await(const c of meterStream(options,stream,e=>records.push(e),{userId:'actor'})){}
 assert.equal(records.length,2);assert.notEqual(records[0].id,records[1].id)
 assert.equal(records[0].totalTokens,5);assert.equal(records[0].userId,'actor');assert.equal(records[0].result,'success')
 assert.equal(JSON.stringify(records).includes('PRIVATE'),false)
 async function* bad(){throw Error('UPSTREAM PRIVATE')}
 await assert.rejects(async()=>{for await(const c of meterStream(options,bad,e=>records.push(e))){}},/UPSTREAM/)
 assert.equal(records[2].result,'error');assert.equal(records[2].totalTokens,null)
 async function* finishError(){yield {type:'finish',reason:{kind:'error'}}}
 for await(const c of meterStream(options,finishError,e=>records.push(e))){}
 assert.equal(records[3].result,'error')
 async function* cancelled(){yield {type:'text',text:'private'}}
 for await(const c of meterStream(options,cancelled,e=>records.push(e))){break}
 assert.equal(records[4].result,'cancelled')
})

test('user attribution ignores injected skill messages after the real user prompt',async()=>{
 const oldHome=process.env.DSH_HOME,home=await mkdtemp(join(tmpdir(),'usage-actor-'));process.env.DSH_HOME=home
 let hook,dispose
 const ctx={sessions:{get:()=>({snapshotEvents:()=>[{type:'user/message',data:{source:{kind:'user',rpcId:'r'}}},{type:'user/message',data:{source:{kind:'skill-catalog'}}}]})},on:(event,callback)=>{hook=callback},effect:callback=>{dispose=callback()},logger:{warn:()=>{}}}
 try{
  await mkdir(dirname(actorPath('s','r')),{recursive:true});await writeFile(actorPath('s','r'),JSON.stringify({userId:'actual-user'}))
  installUsage(ctx)
  async function* stream(){yield {type:'finish',reason:{kind:'stop'}}}
  for await(const c of hook({sessionId:'s',provider:'p',model:'m'},stream)){}
  const {readdir,readFile}=await import('node:fs/promises'),pending=join(home,'guanyin-usage/pending')
  const files=(await readdir(pending)).filter(n=>n.endsWith('.json'));assert.equal(files.length,1)
  assert.equal(JSON.parse(await readFile(join(pending,files[0]),'utf8')).userId,'actual-user')
 }finally{dispose?.();if(oldHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=oldHome;await rm(home,{recursive:true,force:true})}
})
