import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

// Run against an isolated database, never a production database.
test('admin pagination and deletion preserve history while revoking access', { skip: !process.env.TEST_DATABASE_URL }, async t => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  const store = await import('../store.mjs'), db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  try {
    await store.initialize({ adminUsername: `test-${randomUUID()}`, adminPasswordHash: 'test-hash' })
    const tenantId = randomUUID(), otherTenantId = randomUUID(), memberId = randomUUID()
    await db.query('INSERT INTO tenants(id,name,code) VALUES($1,$2,$3),($4,$5,$6)', [tenantId,'分页租户',randomUUID(),otherTenantId,'其他租户',randomUUID()])
    for (let index = 0; index < 31; index++) await db.query('INSERT INTO users(id,username,display_name,role,tenant_id,password_hash,enabled) VALUES($1,$2,$3,$4,$5,$6,$7)', [index === 0 ? memberId : randomUUID(),`page-user-${index}-${tenantId}`,index === 0 ? '成员%甲' : `成员${index}`,index%2 ? 'tenant_admin' : 'member',tenantId,'test',index%3 !== 0])
    const ids = []
    for (let index = 0; index < 25; index++) {
      const id = randomUUID();ids.push(id)
      await db.query("INSERT INTO instances(id,name,slug,version,image,tenant_id,status) VALUES($1,$2,$3,'test','test',$4,$5)", [id,`分页空间${index}`,`page-${id}`,tenantId,index%2 ? 'stopped' : 'running'])
      await store.setInstanceMember(id, memberId, 'owner')
    }
    await t.test('spaces paginate, clamp after filtering and search member names literally', async () => {
      const first = await store.listAdminInstances(new URLSearchParams('q=分页空间&pageSize=12'))
      const second = await store.listAdminInstances(new URLSearchParams('q=分页空间&pageSize=12&page=2'))
      assert.equal(first.total,25);assert.equal(first.instances.length,12)
      assert.equal(second.instances.some(row => first.instances.some(item=>item.id===row.id)), false)
      const filtered = await store.listAdminInstances(new URLSearchParams('q=分页空间&status=stopped&page=999&pageSize=10'))
      assert.equal(filtered.total,12);assert.equal(filtered.page,2);assert.equal(filtered.instances.length,2)
      assert.equal((await store.listAdminInstances(new URLSearchParams('q=成员%甲'))).total,25)
      assert.equal((await store.listAdminInstances(new URLSearchParams('q=%不存在'))).total,0)
    })
    await t.test('users query pages with tenant, enabled and role filters', async () => {
      const query = new URLSearchParams({tenantId,pageSize:'10'})
      const first = await store.listAdminUsers(query);query.set('page','2')
      const second = await store.listAdminUsers(query)
      assert.equal(first.total,31);assert.equal(first.users.length,10)
      assert.equal(second.users.some(row=>first.users.some(item=>item.id===row.id)),false)
      const filtered = await store.listAdminUsers(new URLSearchParams({tenantId,role:'member',status:'false'}))
      assert.equal(filtered.total,6)
      assert.equal((await store.listAdminUsers(new URLSearchParams({tenantId:otherTenantId}))).total,0)
      const metadata = await store.overview(true)
      assert.equal(metadata.users.length,0);assert.equal(metadata.tenants.find(row=>row.id===tenantId).memberCount,31)
    })
    const instanceId=ids[0],definitionId=randomUUID(),releaseId=randomUUID(),credentialId=randomUUID(),runId=randomUUID()
    await db.query("INSERT INTO api_definitions(id,slug,name,instance_id,owner_user_id,status,created_by) VALUES($1,$2,'接口',$3,$4,'published',$4)",[definitionId,randomUUID(),instanceId,memberId])
    await db.query("INSERT INTO api_releases(id,api_definition_id,version,contract,documentation,published_by) VALUES($1,$2,1,'{}','{}',$3)",[releaseId,definitionId,memberId])
    await db.query("INSERT INTO api_credentials(id,instance_id,name,key_prefix,secret_hash,created_by) VALUES($1,$2,'test',$3,$4,$5)",[credentialId,instanceId,randomUUID(),store.apiKeyHash('test-secret'),memberId])
    await db.query("INSERT INTO api_runs(id,api_release_id,credential_id,instance_id,request_id,status,input) VALUES($1,$2,$3,$4,$5,'queued','{}')",[runId,releaseId,credentialId,instanceId,randomUUID()])
    await t.test('active jobs block deletion without changing credentials or state',async()=>{
      await assert.rejects(store.beginSpaceDeletion(instanceId),/API 任务/)
      assert.equal((await store.apiCredentialById(credentialId)).enabled,true)
      assert.equal((await store.instanceById(instanceId)).status,'running')
    })
    await db.query("UPDATE api_runs SET status='succeeded' WHERE id=$1",[runId])
    await t.test('deletion blocks access and new runs, retries, then hides space without erasing audit history',async()=>{
      await store.createAuditLog({id:randomUUID(),actorUserId:memberId,action:'test',targetInstanceId:instanceId,details:{}})
      await store.beginSpaceDeletion(instanceId)
      assert.equal(await store.instanceById(instanceId),undefined)
      assert.equal(await store.instanceOwnedByUser(instanceId,memberId),undefined)
      assert.equal((await store.apiCredentialById(credentialId)).enabled,false)
      assert.equal((await store.listAdminInstances(new URLSearchParams('status=deleting'))).total,1)
      assert.equal((await store.createApiRun({instanceId})).unavailable,true)
      await store.beginSpaceDeletion(instanceId)
      await store.finishSpaceDeletion(instanceId)
      assert.equal(await store.instanceById(instanceId,true),undefined)
      assert.equal((await store.listAdminInstances(new URLSearchParams('q=分页空间'))).total,24)
      assert.equal((await store.listInstances({id:memberId})).length,24)
      assert.equal(await store.apiCredentialBySecret('test-secret'),undefined)
      assert.equal(await store.apiDefinitionById(definitionId),undefined)
      assert.equal((await store.listApiDefinitions({id:memberId},true)).length,0)
      assert.notEqual((await db.query('SELECT retired_at FROM api_releases WHERE id=$1',[releaseId])).rows[0].retired_at,null)
      assert.equal((await db.query('SELECT id FROM audit_logs WHERE target_instance_id=$1',[instanceId])).rowCount,1)
      assert.equal((await db.query('SELECT id FROM api_runs WHERE id=$1',[runId])).rowCount,1)
    })
    await t.test('user deletion revokes sessions and grants, protects owners and preserves audit history', async () => {
      await assert.rejects(store.deleteUser(memberId, (await store.userById(memberId)).username), /负责人/)
      const userId=randomUUID(),username=`delete-${userId}`
      await store.createUser({id:userId,username,displayName:'待删除用户',role:'member',tenantId,passwordHash:'test',enabled:true,createdAt:new Date()})
      await store.setInstanceMember(ids[1],userId,'member')
      await store.createSession('deleted-user-session',userId,Date.now()+60000)
      await store.createAuditLog({id:randomUUID(),actorUserId:userId,action:'test'})
      await assert.rejects(store.deleteUser(userId,'wrong'), /用户名/)
      await store.deleteUser(userId,username)
      assert.equal(await store.userById(userId),undefined)
      assert.equal(await store.userByUsername(username),undefined)
      assert.equal(await store.userBySession('deleted-user-session'),undefined)
      assert.equal((await store.listAdminUsers(new URLSearchParams({q:username}))).total,0)
      assert.equal((await db.query('SELECT * FROM instance_members WHERE user_id=$1',[userId])).rowCount,0)
      assert.equal((await db.query('SELECT * FROM audit_logs WHERE actor_user_id=$1',[userId])).rowCount,1)
      await assert.rejects(store.setInstanceMember(ids[1],userId,'member'), /已删除/)
      const admin=(await db.query("SELECT id,username FROM users WHERE role='platform_admin' LIMIT 1")).rows[0]
      await assert.rejects(store.deleteUser(admin.id,admin.username), /平台管理员/)
    })
    await t.test('tenants can be renamed, but only empty non-default tenants can be removed', async () => {
      await assert.rejects(store.deleteTenant(tenantId,'分页租户'), /用户.*空间/)
      const id=randomUUID(),code=`tenant-${id}`
      await store.createTenant({id,name:'空租户',code,createdAt:new Date()})
      await store.updateTenant(id,{name:'新租户名',code})
      assert.equal((await store.tenantById(id)).name,'新租户名')
      await assert.rejects(store.deleteTenant(id,'空租户'), /完整租户名称/)
      await store.deleteTenant(id,'新租户名')
      assert.equal(await store.tenantById(id),undefined)
      assert.equal(await store.tenantExists(id),false)
      assert.equal((await store.overview(true)).tenants.some(t=>t.id===id),false)
      await assert.rejects(store.createUser({id:randomUUID(),username:randomUUID(),tenantId:id}), /已删除/)
      const defaultTenant=(await db.query("SELECT id,name FROM tenants WHERE code='default'")).rows[0]
      await assert.rejects(store.deleteTenant(defaultTenant.id,defaultTenant.name), /默认租户/)
      await store.updateTenant(defaultTenant.id,{name:'修改后的默认租户',code:'default'})
      await store.initialize({adminUsername:`test-${randomUUID()}`,adminPasswordHash:'test'})
      assert.equal((await store.tenantById(defaultTenant.id)).name,'修改后的默认租户')
    })
  } finally { await db.end();await store.close() }
})
