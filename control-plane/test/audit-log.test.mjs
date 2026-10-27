import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {auditLogOptions,queryAuditLogs,pruneAuditLogs,shouldRecordAudit} from '../audit-log.mjs'
test('audit records only login, user chat input and session deletion',()=>{
 for(const action of ['user_login','user_chat_input','session_delete'])assert.equal(shouldRecordAudit(action),true)
 for(const action of ['dsh_operation','user_logout','space_update','space_delete','admin_impersonation_start','unknown',undefined])assert.equal(shouldRecordAudit(action),false)
})
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
  for(const [actor,target,space,age] of [[alice,bob,s1,'0 days'],[bob,alice,s2,'1 day'],[bob,null,s1,'0 days'],[alice,bob,s1,'2 years']])await db.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,$6,'{}',now()-$5::interval)",[randomUUID(),actor,target,space,age,target===null?'session_delete':actor===bob?'user_chat_input':'user_login'])
  for(const action of ['dsh_operation','user_logout','space_update'])await db.query("INSERT INTO audit_logs VALUES($1,$2,$3,$4,$5,'{}',now())",[randomUUID(),alice,bob,s1,action])
  assert.equal((await queryAuditLogs(db)).total,3)
  assert.equal((await queryAuditLogs(db,{user:'alice'})).total,2)
  assert.equal((await queryAuditLogs(db,{user:'陈%'})).total,2)
  assert.equal((await queryAuditLogs(db,{space:'运维'})).total,2)
  assert.equal((await queryAuditLogs(db,{user:'alice',space:'运维'})).total,1)
  assert.equal((await queryAuditLogs(db,{user:alice,space:s1})).total,1)
  assert.equal((await queryAuditLogs(db,{userId:alice,space:s2})).total,1)
  assert.equal((await queryAuditLogs(db,{user:'无匹配_用户'})).total,0)
  const page=await queryAuditLogs(db,{limit:2,offset:999});assert.equal(page.offset,2);assert.equal(page.logs.length,1)
  assert.equal(await pruneAuditLogs(db),1);assert.equal((await db.query('SELECT count(*)::int AS count FROM audit_logs')).rows[0].count,6)
  await db.query('DELETE FROM users WHERE id=$1',[alice]);assert.equal((await queryAuditLogs(db)).logs.length,3)
  const texts=['  用户原文\n<script>不执行</script> 😀  ']
  await db.query("UPDATE audit_logs SET action='user_chat_input',details=$1 WHERE id=(SELECT id FROM audit_logs WHERE target_instance_id=$2 AND action='user_login' LIMIT 1)",[JSON.stringify({texts,sessionId:'deleted-session',spaceName:'智能运维',userName:'测试用户'}),s1])
  await db.query('DELETE FROM instances WHERE id=$1',[s1])
  const input=(await queryAuditLogs(db)).logs.find(row=>row.action==='user_chat_input')
  assert.deepEqual(input.details.texts,texts)
  assert.equal(input.details.sessionId,'deleted-session')
  assert.equal(input.targetInstance,null)
 }finally{await db.query('ROLLBACK');db.release();await pool.end()}
})
