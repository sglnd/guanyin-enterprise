import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import net from 'node:net'
import pg from 'pg'

test('first-login gate, password validation, reset and session revocation', {skip:!process.env.TEST_DATABASE_URL,timeout:30000},async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519')
 const licenseKey=publicKey.export({type:'spki',format:'pem'})
 const header=Buffer.from(JSON.stringify({alg:'EdDSA',typ:'JWT'})).toString('base64url')
 const payload=Buffer.from(JSON.stringify({iss:'guanyin-license-issuer',aud:'guanyin-enterprise',edition:'enterprise',license_id:'password-test',customer_name:'Password Test',iat:Math.floor(Date.now()/1000)-60,exp:Math.floor(Date.now()/1000)+3600})).toString('base64url')
 const licenseToken=header+'.'+payload+'.'+sign(null,Buffer.from(header+'.'+payload),privateKey).toString('base64url')
 const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL}),schema='password_'+randomUUID().replaceAll('-','');let child
 try{
  await db.query(`CREATE SCHEMA ${schema}`)
  const url=new URL(process.env.TEST_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`)
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r))
  child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,GUANYIN_LICENSE_PUBLIC_KEY:licenseKey,DATABASE_URL:url.href,PORT:String(port),DSH_EGRESS_MODE:'disabled',BOOTSTRAP_ADMIN_USER:'admin',BOOTSTRAP_ADMIN_PASSWORD:'AdminTest1!'},stdio:'ignore'})
  const request=async(path,body,cookie)=>{const r=await fetch(`http://127.0.0.1:${port}${path}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')}}
  for(let i=0;i<100;i++){try{await request('/api/me');break}catch{await new Promise(r=>setTimeout(r,100))}}
  assert.equal((await request('/api/license/activate',{customerName:'Password Test',token:licenseToken})).status,200)
  const admin=await request('/api/login',{username:'admin',password:'AdminTest1!'});assert.equal(admin.status,200);assert.equal(admin.data.user.mustChangePassword,false)
  const created=await request('/api/admin/users',{username:'password-test',password:'Initial12!',tenantId:admin.data.user.tenantId},admin.cookie);assert.equal(created.status,201);assert.equal(created.data.user.mustChangePassword,true)
  const restart=async()=>{
   const exited=once(child,'exit');child.kill('SIGTERM');await exited
   child=spawn(process.execPath,['server.mjs'],{cwd:new URL('..',import.meta.url),env:{...process.env,GUANYIN_LICENSE_PUBLIC_KEY:licenseKey,DATABASE_URL:url.href,PORT:String(port),DSH_EGRESS_MODE:'disabled',BOOTSTRAP_ADMIN_USER:'admin',BOOTSTRAP_ADMIN_PASSWORD:'AdminTest1!'},stdio:'ignore'})
   for(let i=0;i<100;i++){try{await request('/api/me');return}catch{await new Promise(r=>setTimeout(r,100))}}
   throw Error('Server restart timed out')
  }
  // Simulate an account created before the retroactive migration was shipped.
  await db.query(`UPDATE ${schema}.users SET must_change_password=false WHERE username='password-test'`)
  await db.query(`DELETE FROM ${schema}.platform_migrations WHERE id='require-existing-users-password-change-v1'`)
  await restart()
  assert.equal((await request('/api/me',null,admin.cookie)).data.user.mustChangePassword,false)
  const login=()=>request('/api/login',{username:'password-test',password:'Initial12!'})
  const first=await login(),second=await login();assert.equal(first.data.user.mustChangePassword,true)
  assert.equal((await request('/api/instances',null,first.cookie)).status,403)
  const change=(patch={})=>request('/api/change-password',{currentPassword:'Initial12!',newPassword:'Changed12!',confirmPassword:'Changed12!',...patch},first.cookie)
  for(const patch of [{newPassword:'weakpass',confirmPassword:'weakpass'},{currentPassword:'wrong'},{confirmPassword:'different'},{newPassword:'Initial12!',confirmPassword:'Initial12!'}])assert.equal((await change(patch)).status,400)
  assert.equal((await change()).status,200)
  assert.equal((await request('/api/me',null,first.cookie)).status,401);assert.equal((await request('/api/me',null,second.cookie)).status,401)
  assert.equal((await login()).status,401)
  const fresh=await request('/api/login',{username:'password-test',password:'Changed12!'});assert.equal(fresh.status,200);assert.equal(fresh.data.user.mustChangePassword,false)
  assert.equal((await request('/api/instances',null,fresh.cookie)).status,200)
  await restart()
  assert.equal((await request('/api/me',null,fresh.cookie)).data.user.mustChangePassword,false)
  assert.equal((await request('/api/instances',null,fresh.cookie)).status,200)
  const reset=await request(`/api/admin/users/${created.data.user.id}/reset-password`,{},admin.cookie);assert.equal(reset.status,200)
  assert.equal((await request('/api/me',null,fresh.cookie)).status,401)
  const again=await request('/api/login',{username:'password-test',password:reset.data.temporaryPassword});assert.equal(again.data.user.mustChangePassword,true)
  assert.equal((await request('/api/admin/overview',null,again.cookie)).status,403)
 }finally{
  if(child&&child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited}
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await db.end()
 }
})
