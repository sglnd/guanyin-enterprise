import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {auditLogOptions,queryAuditLogs,pruneAuditLogs} from '../audit-log.mjs'
test('audit pagination and filters validate limits and user identity',()=>{
 assert.deepEqual(auditLogOptions({limit:null,offset:null,user:' Alice ',space:' 运维 '}),{limit:50,offset:0,userId:undefined,user:'Alice',space:'运维'})
 for(const options of [{limit:101},{offset:-1},{offset:'1.5'},{userId:'wrong'},{user:'x'.repeat(201)}])assert.throws(()=>auditLogOptions(options))
})
test('audit queries only the last year, combine user/space filters, clamp pages and expire old logs',{skip:!process.env.TEST_DATABASE_URL},async()=>{
 const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),db=await pool.connect(),schema='audit_'+randomUUID().replaceAll('-','')
 try{
  await db.query('BEGIN');await db.query(`CREATE SCHEMA ${schema}`);await db.query(`SET LOCAL search_path=${schema}`)
  await db.query('CREATE TABLE users(id uuid PRIMARY KEY,username text,display_name text);CREATE TABLE instances(id uuid PRIMARY KEY,name text);CREATE TABLE audit_logs(id uuid PRIMARY KEY,actor_user_id uuid,target_user_id uuid,target_instance_id uuid,action text,details jsonb,created_at timestamptz)')
  const alice=randomUUID(),bob=randomUUID(),s1=randomUUID(),s2=randomUUID()
  await db.query("INSERT INTO users VALUES($1,'alice','陈%甲'),($2,'bob','李乙')",[alice,bob]);await db.query("INSERT INTO instances VALUES($1,'智能运维'),($2,'研发空间')",[s1,s2])
  for(const [actor,target,space,age] of [[alice,bob,s1,'0 days'],[bob,alice,s2,'1 day'],[bob,null,s1,'0 days'],[alice,bob,s1,'2 years']])await db.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,'test','{}',now()-$5::interval)",[randomUUID(),actor,target,space,age])
  assert.equal((await queryAuditLogs(db)).total,3)
  assert.equal((await queryAuditLogs(db,{user:'alice'})).total,2)
  assert.equal((await queryAuditLogs(db,{user:'陈%'})).total,2)
  assert.equal((await queryAuditLogs(db,{space:'运维'})).total,2)
  assert.equal((await queryAuditLogs(db,{user:'alice',space:'运维'})).total,1)
  assert.equal((await queryAuditLogs(db,{user:alice,space:s1})).total,1)
  assert.equal((await queryAuditLogs(db,{userId:alice,space:s2})).total,1)
  assert.equal((await queryAuditLogs(db,{user:'无匹配_用户'})).total,0)
  const page=await queryAuditLogs(db,{limit:2,offset:999});assert.equal(page.offset,2);assert.equal(page.logs.length,1)
  assert.equal(await pruneAuditLogs(db),1);assert.equal((await db.query('SELECT count(*)::int AS count FROM audit_logs')).rows[0].count,3)
  await db.query('DELETE FROM users WHERE id=$1',[alice]);assert.equal((await queryAuditLogs(db)).logs.length,3)
 }finally{await db.query('ROLLBACK');db.release();await pool.end()}
})
