import { isIP } from 'node:net'
export const EGRESS_LABEL = 'guanyin.io/egress'
export const EGRESS_POLICY_NAME = 'guanyin-managed-space-egress'
export function dnsAddresses(text, override) {
  const values = override ? override.split(',').map(x=>x.trim()).filter(Boolean) : [...text.matchAll(/^nameserver\s+(\S+)/gm)].map(x=>x[1])
  if (!values.length || values.some(x=>!isIP(x))) throw new Error('无法识别集群 DNS 地址，请配置 DSH_DNS_IPS')
  return [...new Set(values)]
}
export function managedEgressPolicy({ namespace, systemNamespace, gatewayNamespace=systemNamespace, controlPort=8080, gatewayPort=8080, proxyPort=8081, dnsIPs }) {
  const peer=(ns,app)=>({namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':ns}},podSelector:{matchLabels:{app}}})
  const ports=values=>[...new Set(values)].map(port=>({protocol:'TCP',port}))
  return {apiVersion:'networking.k8s.io/v1',kind:'NetworkPolicy',metadata:{name:EGRESS_POLICY_NAME,namespace,labels:{'app.kubernetes.io/managed-by':'guanyin'}},spec:{podSelector:{matchLabels:{'app.kubernetes.io/name':'dsh',[EGRESS_LABEL]:'managed'}},policyTypes:['Egress'],egress:[
    {to:[peer(systemNamespace,'guanyin-control-plane')],ports:ports([controlPort])},
    {to:[peer(gatewayNamespace,'guanyin-mcp-gateway')],ports:ports([gatewayPort,proxyPort])},
    {to:[{namespaceSelector:{matchLabels:{'kubernetes.io/metadata.name':'kube-system'}},podSelector:{matchLabels:{'k8s-app':'kube-dns'}}},...dnsIPs.map(ip=>({ipBlock:{cidr:ip+'/'+(isIP(ip)===6?128:32)}}))],ports:[{protocol:'UDP',port:53},{protocol:'TCP',port:53}]}
  ]}}
}
export function managedProxyEnvironment(secretName, internalHosts=[]) {
  const ref={secretKeyRef:{name:secretName,key:'mcpProxyUrl'}}
  return [
    ...['GUANYIN_BROWSER_PROXY_URL','HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','GIT_CONFIG_VALUE_0'].map(name=>({name,valueFrom:ref})),
    {name:'NODE_USE_ENV_PROXY',value:'1'},
    ...['NO_PROXY','no_proxy'].map(name=>({name,value:['localhost','127.0.0.1','::1',...internalHosts].join(',')})),
    {name:'GIT_CONFIG_COUNT',value:'1'},{name:'GIT_CONFIG_KEY_0',value:'http.proxy'}
  ]
}
export function withManagedEgress(deployment,secretName,internalHosts=[]) {
  const template=structuredClone(deployment.spec.template)
  template.metadata ||= {};template.metadata.labels ||= {};template.metadata.labels[EGRESS_LABEL]='managed'
  template.spec.automountServiceAccountToken=false
  if(template.spec.hostNetwork===true||template.spec.hostPID===true||template.spec.hostIPC===true||template.spec.volumes?.some(v=>v.hostPath))throw new Error('hostNetwork 空间不能启用受管网络隔离')
  for(const c of [...(template.spec.containers||[]),...(template.spec.initContainers||[])])if(c.securityContext?.privileged||c.securityContext?.capabilities?.add?.some(x=>['NET_ADMIN','SYS_ADMIN','ALL'].includes(x)))throw new Error('特权容器不能启用受管网络隔离')
  const dsh=template.spec.containers.find(x=>x.name==='dsh');if(!dsh)throw new Error('缺少 dsh 容器')
  const injected=managedProxyEnvironment(secretName,internalHosts),names=new Set(injected.map(x=>x.name))
  if(dsh.securityContext?.privileged || dsh.securityContext?.capabilities?.add?.some(x=>['NET_ADMIN','SYS_ADMIN','ALL'].includes(x)))throw new Error('特权空间不能启用受管网络隔离')
  dsh.env=[...(dsh.env||[]).filter(x=>!names.has(x.name)),...injected]
  return template
}
export function createEgressReconciler({request,policy,list,migrate}) {
 let pending
 return {tick(){if(pending)return pending;pending=(async()=>{
   const base=`/apis/networking.k8s.io/v1/namespaces/${policy.metadata.namespace}/networkpolicies`
   let current
   try{current=await request('GET',base+'/'+policy.metadata.name)}catch(e){if(e.statusCode!==404)throw e}
   if(!current){try{await request('POST',base,policy)}catch(e){if(e.statusCode!==409)throw e;current=await request('GET',base+'/'+policy.metadata.name)}}
   if(current&&JSON.stringify(current.spec)!==JSON.stringify(policy.spec))await request('PATCH',base+'/'+policy.metadata.name,{spec:policy.spec})
   // Policy must exist before any pod is enrolled, including after deletion.
   for(const instance of await list())await migrate(instance)
  })().finally(()=>{pending=undefined});return pending}}
}

function selectorMatches(selector={},labels={}) {
 if(Object.entries(selector.matchLabels||{}).some(([k,v])=>labels[k]!==v))return false
 return (selector.matchExpressions||[]).every(({key,operator,values=[]})=>operator==='In'?values.includes(labels[key]):operator==='NotIn'?!values.includes(labels[key]):operator==='Exists'?key in labels:operator==='DoesNotExist'?!(key in labels):false)
}
export function assertNoExtraEgress(policies,labels) {
 for(const p of policies){if(p.metadata.name===EGRESS_POLICY_NAME)continue
  if((p.spec.policyTypes||[]).includes('Egress')&&p.spec.egress?.length&&selectorMatches(p.spec.podSelector,labels))throw new Error(`策略 ${p.metadata.name} 会额外放行该空间，需管理员处理后才能确认隔离`)
 }
}
