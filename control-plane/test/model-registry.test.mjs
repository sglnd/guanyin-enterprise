import test from 'node:test'
import assert from 'node:assert/strict'
import { modelProviderInput, modelCredentialRef } from '../model-registry.mjs'
import { synchronizeModels } from '../../deploy/dsh-0.1.5-core/model-sync.mjs'
const input={code:'deepseek-flash',name:'DeepSeek',baseURL:'http://example.test/api/model/id/chat/completions',api:'openai-completions',models:[{id:' model-1',reasoningEfforts:{off:null,high:'high'}}],compat:{supportsReasoningEffort:true},enabled:true,apiKey:'secret'}
test('model registration normalizes endpoint and model IDs and validates DSH fields',()=>{
  const result=modelProviderInput(input)
  assert.equal(result.config.baseURL,'http://example.test/api/model/id')
  assert.equal(result.config.models[0].id,'model-1')
  assert.equal(result.config.models[0].reasoningEfforts.off,null)
  assert.equal(modelCredentialRef('ab-cd'),'GUANYIN_MODEL_AB_CD')
  for(const patch of [{code:'__proto__'},{baseURL:'http://user:password@example.test'},{models:[{id:'same'},{id:'same'}]},{models:[{id:'test',reasoningEfforts:{low:null}}]},{streamIdleTimeoutMs:0},{compat:{apiKey:'leak'}}])assert.throws(()=>modelProviderInput({...input,...patch}))
})
function fixture(){
 const calls=[],namespaces=[{ns:'llm-pi-ai',revision:1,value:{providers:{local:{models:[{id:'local'}]},'guanyin-old':{apiKeyEnv:'GUANYIN_MODEL_AA'}}}},{ns:'agent-default-model',revision:1,value:{provider:'local',model:'local'}}]
 return {calls,namespaces,rpc:async(method,args)=>{calls.push([method,args]);if(method==='settings/describe')return {writable:true,namespaces};return {}}}
}
test('model sync writes one-way credentials and only mutates managed provider paths',async()=>{
 const f=fixture(),config=modelProviderInput(input).config
 await synchronizeModels({providers:[{id:'guanyin-deepseek-flash',credentialRef:'GUANYIN_MODEL_BB',apiKey:'private',config}],defaultModel:{provider:'guanyin-deepseek-flash',model:'model-1'}},f.rpc)
 const ops=f.calls.find(([m,a])=>m==='settings/mutate'&&a.ns==='llm-pi-ai')[1].ops
 assert.deepEqual(ops.map(op=>op.path),[['providers','guanyin-old'],['providers','guanyin-deepseek-flash']])
 assert.equal(ops[1].value.apiKeyEnv,'GUANYIN_MODEL_BB');assert.equal(JSON.stringify(ops).includes('private'),false)
 assert.ok(f.calls.some(([m,a])=>m==='credentials/unset'&&a.ref==='GUANYIN_MODEL_AA'))
 assert.ok(f.calls.some(([m])=>m==='settings/update'))
})
test('detaching all managed models preserves local default and removes stale credentials',async()=>{
 const f=fixture();await synchronizeModels({providers:[]},f.rpc)
 assert.equal(f.calls.some(([m,a])=>a.ns==='agent-default-model'),false)
 assert.ok(f.calls.some(([m])=>m==='credentials/unset'))
 const g=fixture();g.namespaces[1].value={provider:'guanyin-old',model:'old'}
 await synchronizeModels({providers:[]},g.rpc)
 assert.ok(g.calls.some(([m,a])=>m==='settings/mutate'&&a.ns==='agent-default-model'))
})
test('bridge rejects arbitrary provider and credential namespaces before invoking RPC',async()=>{
 const f=fixture()
 await assert.rejects(synchronizeModels({providers:[{id:'openai',credentialRef:'OPENAI_API_KEY',apiKey:'private',config:{models:[]}}]},f.rpc))
 assert.equal(f.calls.length,0)
})

test('model identity defaults to provider code and display name without duplicate JSON fields',()=>{
 const result=modelProviderInput({...input,models:[{reasoningEfforts:{off:null,high:'high'}}]})
 assert.equal(result.config.models[0].id,input.code)
 assert.equal(result.config.models[0].name,input.name)
 assert.equal(result.config.models[0].reasoningEfforts.high,'high')
 assert.throws(()=>modelProviderInput({...input,models:[{},{}]}))
})

test('connection test sends minimal protocol requests and never returns secrets or upstream errors',async()=>{
 const {testModelConnection}=await import('../model-registry.mjs')
 for(const [api,suffix,response] of [['openai-completions','/chat/completions',{choices:[{message:{content:'OK'}}]}],['openai-responses','/responses',{object:'response',output:[]}],['anthropic-messages','/messages',{type:'message',content:[]}]]) {
   const value=modelProviderInput({...input,api})
   const r=await testModelConnection(value,'private',async(url,options)=>{
     assert.ok(url.endsWith(suffix));assert.equal(options.redirect,'error')
     assert.equal(JSON.parse(options.body).model,'model-1')
     assert.equal(options.headers[api==='anthropic-messages'?'x-api-key':'authorization'],api==='anthropic-messages'?'private':'Bearer private')
     return Response.json(response)
   })
   assert.equal(r.ok,true);assert.equal(JSON.stringify(r).includes('private'),false)
 }
 const value=modelProviderInput(input)
 const failure=await testModelConnection(value,'private',async()=>Response.json({error:'private'},{status:401}))
 assert.equal(failure.ok,false);assert.match(failure.message,/鉴权失败/);assert.equal(JSON.stringify(failure).includes('private'),false)
 assert.equal((await testModelConnection(value,'private',async()=>Response.json({html:'login'}))).ok,false)
 assert.equal((await testModelConnection(value,'private',async()=>{throw Error('private')})).ok,false)
})
