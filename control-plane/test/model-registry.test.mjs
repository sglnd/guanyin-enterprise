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

test('gateway route UUID is independent of request model and full endpoints normalize once',async()=>{
 const {testModelConnection}=await import('../model-registry.mjs')
 for (const [api,suffix,response] of [['openai-completions','/chat/completions',{choices:[{message:{content:'OK'}}]}],['openai-responses','/responses',{object:'response',output:[]}],['anthropic-messages','/messages',{type:'message',content:[]}]]) {
   const base='http://gateway.test/api/model/ce0b0a31-f627-4c23-99d5-c9d949d0a9ad'
   const value=modelProviderInput({...input,code:'glm-gateway',name:'GLM',api,baseURL:base+suffix,requestModel:'glm-5',models:[{}]})
   assert.equal(value.config.models[0].id,'glm-5')
   const result=await testModelConnection(value,'private',async(url,options)=>{
     assert.equal(url,base+suffix)
     assert.equal(options.method,'POST')
     assert.equal(JSON.parse(options.body).model,'glm-5')
     return Response.json(response)
   })
   assert.equal(result.ok,true)
 }
 const value=modelProviderInput({...input,requestModel:'glm-5',models:[{id:'explicit-model'}]})
 assert.equal(value.config.models[0].id,'explicit-model')
 const failed=await testModelConnection(value,'private',async()=>Response.json({error:'secret'},{status:404}))
 assert.match(failed.message,/POST .*model=explicit-model/)
 assert.equal(failed.message.includes('secret'),false)
})

test('editing providers retains custom upstream IDs and multi-model identities',async()=>{
 const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm')
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8')
 const open=source.slice(source.indexOf('function openModelProvider('),source.indexOf("\n$('#model-provider-form').onsubmit"))
 for(const models of [[{id:'glm-5',name:'GLM',reasoningEfforts:false}],[{id:'a',name:'A'},{id:'b',name:'B'}]]){
   const provider={id:'test',code:'glm-route',name:'GLM',enabled:true,config:{api:'openai-completions',baseURL:'http://gateway.test/v1',models}}
   const form={reset(){},dataset:{},elements:Object.fromEntries(['code','name','apiKey','api','baseURL','streamIdleTimeoutMs','models','requestModel','compat','enabled'].map(k=>[k,{}])),querySelector:()=>({})}
   const nodes={'#model-provider-form':form,'#model-provider-title':{},'#model-provider-dialog':{showModal(){}}}
   runInNewContext(open+';openModelProvider("test")',{me:{role:'platform_admin'},modelProviders:[provider],$:s=>nodes[s]})
   const value=modelProviderInput({code:provider.code,name:provider.name,api:provider.config.api,baseURL:provider.config.baseURL,models:form.elements.models.value,requestModel:form.elements.requestModel.value})
   assert.deepEqual(value.config.models.map(m=>[m.id,m.name]),models.map(m=>[m.id,m.name]))
 }
})

test('model sync never reports success for stopped, unready or changed deployments',async()=>{
 const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm')
 const {modelSyncDeploymentReady}=await import('../model-registry.mjs')
 const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('const modelSyncQueues ='),source.indexOf('async function synchronizeProviderSpaces('))
 const ready={metadata:{generation:2},spec:{replicas:1},status:{observedGeneration:2,updatedReplicas:1,readyReplicas:1,availableReplicas:1}}
 for(const scenario of [
  {deployment:{...ready,spec:{replicas:0}},expected:'pending',posts:0},
  {deployment:{...ready,status:{}},expected:'pending',posts:0},
  {deployment:{...ready,status:{...ready.status,observedGeneration:1}},expected:'pending',posts:0},
  {deployment:ready,after:{...ready,spec:{replicas:0}},expected:'pending',posts:1},
  {deployment:ready,marked:false,expected:'pending',posts:1},
  {deployment:ready,expected:'synced',posts:1},
  {deployment:ready,badResponse:true,expected:'error',posts:1},
 ]){
  let posts=0,gets=0;const statuses=[]
  const context={modelSyncDeploymentReady,NAMESPACE:'instances',Buffer,AbortSignal,
   modelCredentialRef,managedProviderId:code=>'guanyin-'+code,instanceExtensionToken:async()=> 'test-token',
   store:{instanceById:async()=>({}),spaceModelConfig:async()=>({revision:3,providerIds:[],defaultProviderId:null}),markModelSync:async(id,revision,status)=>{statuses.push(status);return scenario.marked!==false}},
   k8sRequest:async()=>++gets===1?scenario.deployment:scenario.after||scenario.deployment,
   fetch:async()=>{posts++;return Response.json(scenario.badResponse?{ok:false}:{ok:true,providers:[]})},
  }
  const apply=runInNewContext(code+';applySpaceModels',context)
  if(scenario.expected==='error')await assert.rejects(apply({id:'space',slug:'test'}),/同步失败/)
  else assert.equal((await apply({id:'space',slug:'test'})).status,scenario.expected)
  assert.equal(posts,scenario.posts)
  if(scenario.posts===0)assert.deepEqual(statuses,['pending'])
 }
})

test('sync feedback distinguishes pending, error and confirmed success',async()=>{
 const {readFile}=await import('node:fs/promises'),{runInNewContext}=await import('node:vm')
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('function modelSyncFeedback('),source.indexOf('function renderModelSync('))
 const feedback=runInNewContext(code+';modelSyncFeedback')
 assert.match(feedback('pending'),/实际尚未同步/)
 assert.match(feedback('error'),/同步失败/)
 assert.equal(feedback('synced'),'模型已同步到 DSH。')
 assert.match(feedback('unknown'),/未确认/)
})

test('background model sync retries after container readiness, backs off failures and prevents overlapping scans',async()=>{
 const {createModelSyncReconciler}=await import('../model-registry.mjs')
 let time=1_000,ready=false,fail=false,calls=0,queued=false,instances=[{id:'space',slug:'test'}]
 const worker=createModelSyncReconciler({list:async()=>instances,now:()=>time,isQueued:()=>queued,
   apply:async()=>{calls++;if(fail)throw Error('upstream');return {status:ready?'synced':'pending'}}})
 await worker.tick();assert.equal(calls,1)
 ready=true;time+=15_000;await worker.tick();assert.equal(calls,1)
 time+=15_000;await worker.tick();assert.equal(calls,2)
 fail=true;await worker.tick();assert.equal(calls,3)
 time+=30_000;await worker.tick();assert.equal(calls,3)
 time+=30_000;queued=true;await worker.tick();assert.equal(calls,3)
 queued=false;fail=false;await worker.tick();assert.equal(calls,4)
 instances=[];await worker.tick();assert.equal(calls,4)
 worker.stop();instances=[{id:'space'}];await worker.tick();assert.equal(calls,4)
 let release,scans=0
 const blocked=createModelSyncReconciler({list:()=>{scans++;return new Promise(r=>{release=r})},apply:async()=>{}})
 const first=blocked.tick();await blocked.tick();assert.equal(scans,1)
 release([]);await first
 const recovered=createModelSyncReconciler({list:async()=>[{id:'persisted-pending'}],apply:async()=>{calls++;return {status:'synced'}}})
 await recovered.tick();assert.equal(calls,5)
})
