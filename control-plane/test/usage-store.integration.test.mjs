import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {initializeUsage,ingestUsage,queryUsage,pruneUsage} from '../usage.mjs'
test('usage aggregates across spaces, isolates dimensions, deduplicates and expires details',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const schema='usage_'+randomUUID().replaceAll('-','')
 const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL})
 await admin.query(`CREATE SCHEMA ${schema}`)
 const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`})
 try{
  await db.query('CREATE TABLE tenants(id uuid PRIMARY KEY,name text);CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,username text,display_name text)')
  await initializeUsage(db)
  const tenant=randomUUID(),other=randomUUID(),user=randomUUID(),s1=randomUUID(),s2=randomUUID()
  await db.query("INSERT INTO tenants VALUES($1,'租户甲'),($2,'租户乙');",[tenant,other])
  await db.query("INSERT INTO users VALUES($1,$2,'actual','真实用户')",[user,tenant])
  const instance={id:s1,tenantId:tenant,name:'空间甲'},event={id:randomUUID(),userId:user,sessionId:'session',provider:'p',model:'m',occurredAt:new Date().toISOString(),inputTokens:40,outputTokens:10,totalTokens:50,cacheReadTokens:20,durationMs:100,result:'success',quality:'reported'}
  assert.equal(await ingestUsage(db,instance,[event]),1);assert.equal(await ingestUsage(db,instance,[event]),0)
  await ingestUsage(db,{...instance,id:s2,name:'空间乙'},[{...event,id:randomUUID(),result:'error'}])
  await ingestUsage(db,instance,[{...event,id:randomUUID(),quality:'unknown'}])
  await ingestUsage(db,{id:randomUUID(),tenantId:other,name:'其他租户'},[{...event,id:randomUUID()}])
  const users=await queryUsage(db,new URLSearchParams({group:'user',tenantId:tenant}))
  assert.equal(users.total,1);assert.equal(users.rows[0].calls,3);assert.equal(users.rows[0].totalTokens,'100');assert.equal(users.rows[0].unknown,1);assert.equal(users.rows[0].errors,1);assert.equal(users.summary.p50DurationMs,'100');assert.equal(users.trend.length,1);assert.equal(users.trend[0].totalTokens,'100');assert.equal(users.trend[0].calls,3)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'space',userId:user}))).total,2)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'tenant'}))).total,2)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'model'}))).rows[0].calls,4)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'detail',userId:'unattributed'}))).total,1)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'detail',q:'空间甲',tenantId:tenant}))).total,2)
  const old={...event,id:randomUUID(),occurredAt:'2020-01-01T00:00:00Z'}
  assert.equal(await ingestUsage(db,instance,[old]),0)
  await db.query("UPDATE model_usage_events SET occurred_at=now()-interval '2 years' WHERE id=$1",[event.id])
  assert.equal(await pruneUsage(db),1)
  assert.equal((await queryUsage(db,new URLSearchParams({group:'detail',tenantId:tenant}))).total,2)
 }finally{await db.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end()}
})
