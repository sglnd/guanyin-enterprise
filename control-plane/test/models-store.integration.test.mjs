import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test('model registry bindings enforce defaults, revisions, lifecycle and non-secret storage',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 process.env.DATABASE_URL=process.env.TEST_DATABASE_URL
 const store=await import('../store.mjs'),db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL})
 try {
  const username=`model-admin-${randomUUID()}`
  await store.initialize({adminUsername:username,adminPasswordHash:'test'})
  const admin=await store.userByUsername(username),id=randomUUID(),spaceId=randomUUID()
  const value={code:'model-'+id,name:'测试模型',enabled:true,config:{api:'openai-completions',baseURL:'http://example.test/v1',models:[{id:'model-a'}]}}
  await store.saveModelProvider(id,value,admin.id)
  await store.createInstance({id:spaceId,name:'模型测试空间',slug:'model-'+spaceId,tenantId:admin.tenantId,status:'stopped',version:'test',image:'test',idleTimeoutMinutes:null,createdAt:new Date()})
  assert.equal((await store.spaceModelConfig(spaceId)).revision,0)
  await assert.rejects(store.saveSpaceModelConfig(spaceId,{providerIds:[id],defaultProviderId:id,defaultModel:'missing',revision:0}),/默认模型/)
  const config=await store.saveSpaceModelConfig(spaceId,{providerIds:[id],defaultProviderId:id,defaultModel:'model-a',revision:0})
  assert.equal(config.revision,1)
  assert.ok((await store.listPendingModelSyncInstances()).some(i=>i.id===spaceId))
  assert.equal((await store.modelProviderSpaces(id)).length,1)
  await assert.rejects(store.deleteModelProvider(id,value.name),/取消接入/)
  await assert.rejects(store.saveSpaceModelConfig(spaceId,{providerIds:[],revision:0}),/配置已变化/)
  assert.equal(await store.markModelSync(spaceId,config.revision,'synced'),true)
  assert.equal((await store.listPendingModelSyncInstances()).some(i=>i.id===spaceId),false)
  await store.saveModelProvider(id,{...value,name:'已修改',enabled:false},admin.id)
  assert.equal((await store.spaceModelConfig(spaceId)).syncStatus,'pending')
  assert.equal(await store.markModelSync(spaceId,config.revision,'synced'),false)
  assert.ok((await store.listPendingModelSyncInstances()).some(i=>i.id===spaceId))
  assert.equal((await store.spaceModelConfig(spaceId)).syncStatus,'pending')
  const latest=await store.spaceModelConfig(spaceId)
  await store.saveSpaceModelConfig(spaceId,{providerIds:[],revision:latest.revision})
  let attempts=0
  await assert.rejects(store.deleteModelProvider(id,'已修改',async()=>{attempts++;throw Error('Secret forbidden')}),/Secret forbidden/)
  assert.equal((await store.modelProviderById(id)).name,'已修改')
  await assert.rejects(store.deleteModelProvider(id,'错误名称',async()=>{attempts++}),/确认名称/)
  assert.equal(attempts,1)
  await store.deleteModelProvider(id,'已修改',async()=>{attempts++})
  assert.equal(attempts,2)
  assert.equal(await store.modelProviderById(id),undefined)
  assert.equal((await store.spaceModelConfig(spaceId)).providerIds.length,0)
  const columns=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='model_providers'")).rows.map(r=>r.column_name)
  assert.equal(columns.some(c=>/key|secret|credential/.test(c)),false)
 } finally {await db.end();await store.close()}
})
