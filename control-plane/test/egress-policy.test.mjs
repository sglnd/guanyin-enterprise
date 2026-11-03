import test from 'node:test'
import assert from 'node:assert/strict'
import {dnsAddresses,managedEgressPolicy,withManagedEgress,createEgressReconciler,assertNoExtraEgress,EGRESS_POLICY_NAME} from '../egress-policy.mjs'
const policy=managedEgressPolicy({namespace:'spaces',systemNamespace:'system',dnsIPs:['10.96.0.10','169.254.20.10']})
test('base policy permits only platform peers and DNS, including NodeLocal DNS',()=>{
 assert.equal(policy.spec.podSelector.matchLabels['guanyin.io/egress'],'managed')
 assert.equal(policy.spec.egress.length,3)
 assert.deepEqual(policy.spec.egress[0].to[0],{namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'system'}},podSelector:{matchLabels:{app:'guanyin-control-plane'}}})
 assert.ok(policy.spec.egress[2].to.some(x=>x.ipBlock?.cidr==='169.254.20.10/32'))
 assert.deepEqual(dnsAddresses('nameserver 10.96.0.10\n'),['10.96.0.10'])
 assert.throws(()=>dnsAddresses('nameserver invalid'))
})
test('enrollment is immutable/idempotent, sets model/Git proxies, and does not bypass all internal services',()=>{
 const d={spec:{template:{metadata:{labels:{'app.kubernetes.io/name':'dsh'}},spec:{containers:[{name:'dsh',env:[{name:'DSH_HOME',value:'/data/dsh'}]}]}}}}
 const t=withManagedEgress(d,'space-secret',['control.system.svc.cluster.local'])
 assert.equal(d.spec.template.metadata.labels['guanyin.io/egress'],undefined)
 assert.equal(t.spec.automountServiceAccountToken,false)
 const env=t.spec.containers[0].env
 assert.equal(env.find(x=>x.name==='NODE_USE_ENV_PROXY').value,'1')
 assert.equal(env.find(x=>x.name==='GIT_CONFIG_KEY_0').value,'http.proxy')
 assert.equal(env.find(x=>x.name==='HTTP_PROXY').valueFrom.secretKeyRef.key,'mcpProxyUrl')
 assert.ok(!env.find(x=>x.name==='NO_PROXY').value.includes(',.svc'))
 assert.deepEqual(withManagedEgress({spec:{template:t}},'space-secret',['control.system.svc.cluster.local']),t)
 assert.throws(()=>withManagedEgress({spec:{template:{spec:{hostNetwork:true}}}},'secret'))
})
test('coordinator creates policy before enrolling spaces, repairs deletion and drift, and stops on RBAC failure',async()=>{
 let current;const events=[]
 const request=async(method,path,body)=>{events.push(method);if(method==='GET'){if(!current)throw Object.assign(Error('missing'),{statusCode:404});return current}if(method==='POST'){current=structuredClone(body)}if(method==='PATCH'){current.spec=body.spec}}
 const c=createEgressReconciler({request,policy,list:async()=>[{}],migrate:async()=>{assert.ok(current);events.push('migrate')}})
 await c.tick();assert.deepEqual(events,['GET','POST','migrate']);events.length=0
 await c.tick();assert.deepEqual(events,['GET','migrate'])
 current.spec.egress=[];await c.tick();assert.equal(current.spec.egress.length,3)
 current=undefined;await c.tick();assert.ok(current)
 let migrated=false;const denied=createEgressReconciler({request:async()=>{throw Object.assign(Error('forbidden'),{statusCode:403})},policy,list:async()=>[{}],migrate:async()=>{migrated=true}})
 await assert.rejects(denied.tick());assert.equal(migrated,false)
})
test('an additive allow-all policy is flagged instead of silently claiming isolation',()=>{
 assert.throws(()=>assertNoExtraEgress([{metadata:{name:'allow-all'},spec:{podSelector:{},policyTypes:['Egress'],egress:[{}]}}],{'guanyin.io/egress':'managed'}))
 assert.doesNotThrow(()=>assertNoExtraEgress([{metadata:{name:EGRESS_POLICY_NAME},spec:{egress:[{}]}}],{}))
})
