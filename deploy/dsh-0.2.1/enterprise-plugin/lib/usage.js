import {randomUUID,createHash} from 'node:crypto'
import {mkdir,writeFile,readdir,readFile,unlink,stat,rename} from 'node:fs/promises'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'
export const usageRoot=()=>join(process.env.DSH_HOME||'/data/dsh','guanyin-usage')
export const actorPath=(sessionId,requestId)=>join(usageRoot(),'actors',createHash('sha256').update(`${sessionId}:${requestId}`).digest('hex')+'.json')
export function usageCounts(usage){
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:null
 const raw={inputTokens:count(usage?.inputTokens),outputTokens:count(usage?.outputTokens),totalTokens:count(usage?.totalTokens),cacheReadTokens:count(usage?.cacheReadTokens),cacheWriteTokens:count(usage?.cacheWriteTokens)}
 // Some adapters synthesize all-zero usage when the upstream omitted it; do not report a false zero.
 const known=usage&&Object.values(raw).some(v=>v!==null&&v>0)
 if(!known)return {inputTokens:null,outputTokens:null,totalTokens:null,cacheReadTokens:null,cacheWriteTokens:null,quality:'unknown'}
 // DSH inputTokens are uncached input; exact total includes cache reads and writes.
 const input=raw.totalTokens!==null&&raw.outputTokens!==null?raw.totalTokens-raw.outputTokens:null
 return {...raw,inputTokens:input!==null&&input>=0?input:null,quality:'reported'}
}
export async function* meterStream(options,next,save,actor=null,clock=Date.now){
 const started=clock(),id=randomUUID();let usage,result='cancelled',finished=false
 try{
  for await(const chunk of next()){
   if(chunk.type==='usage')usage=chunk.usage
   if(chunk.type==='finish'){finished=true;result=chunk.reason?.kind==='error'?'error':chunk.reason?.kind==='aborted'?'cancelled':'success'}
   yield chunk
  }
  if(!finished)result=options.signal?.aborted?'cancelled':'success'
 }catch(error){result=options.signal?.aborted?'cancelled':'error';throw error}
 finally{try{await save({id,occurredAt:new Date(started).toISOString(),sessionId:options.sessionId||'',provider:options.provider||'unknown',model:options.model||'unknown',userId:actor?.userId||null,requestId:actor?.requestId||'',source:options.purpose||actor?.source||'unknown',...usageCounts(usage),durationMs:Math.max(0,clock()-started),result})}catch{}}
}
export function installUsage(ctx){
 const root=usageRoot(),pending=join(root,'pending');let stopped=false,busy=false
 const save=async event=>{try{await mkdir(pending,{recursive:true});const temp=join(pending,event.id+'.tmp');await writeFile(temp,JSON.stringify(event),{flag:'wx',mode:0o600});await rename(temp,join(pending,event.id+'.json'))}catch(error){ctx.logger?.warn('用量明细落盘失败，请检查空间存储');throw error}}
 ctx.on('llm/stream',(options,next)=>{
  let actor=null
  try{
   // Use this exact model request's provenance, not the last human in the
   // session: schedules and delegated work may run long after that prompt.
   const source=[...(options.messages||[])].reverse().find(m=>['user','schedule','agent-message','team-message','webhook'].includes(m.source?.kind))?.source
   if(source?.kind==='user'&&source.rpcId)actor={...JSON.parse(readFileSync(actorPath(options.sessionId,source.rpcId),'utf8')),requestId:source.rpcId}
   else actor={source:source?.kind==='schedule'?'schedule':source?.kind==='agent-message'?'subagent':'unknown'}
  }catch{}
  return meterStream(options,next,save,actor)
 },{global:true,prepend:true})
 const flush=async()=>{
  if(busy||stopped)return;busy=true
  try{
   await mkdir(pending,{recursive:true})
   const cutoff=new Date();cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1)
   const names=await readdir(pending)
   for(const name of names.filter(n=>n.endsWith('.tmp')||n.endsWith('.invalid'))){const path=join(pending,name);if((await stat(path)).mtime<cutoff)await unlink(path)}
   const files=names.filter(n=>/^[0-9a-f-]{36}\.json$/.test(n)).sort()
   const batch=[]
   for(const file of files){
    const path=join(pending,file);let event
    try{event=JSON.parse(await readFile(path,'utf8'))}catch{ctx.logger?.warn('发现损坏的用量文件，已隔离');await rename(path,path+'.invalid');continue}
    if(new Date(event.occurredAt)<cutoff){await unlink(path);continue}
    if(batch.length<100)batch.push({path,event})
   }
   if(batch.length&&process.env.GUANYIN_USAGE_URL&&process.env.DSH_EXT_TOKEN){
    const response=await fetch(process.env.GUANYIN_USAGE_URL,{method:'POST',headers:{'content-type':'application/json','x-guanyin-token':process.env.DSH_EXT_TOKEN},body:JSON.stringify({events:batch.map(x=>x.event)}),signal:AbortSignal.timeout(10000),redirect:'error'})
    if(response.ok&&(await response.json()).ok===true)for(const item of batch)await unlink(item.path)
   }
   const actors=join(root,'actors')
   for(const file of await readdir(actors).catch(()=>[])){const path=join(actors,file);if((await stat(path)).mtime<cutoff)await unlink(path)}
  }catch{ctx.logger?.warn('用量统计上报未完成，将自动重试')}finally{busy=false}
 }
 const timer=setInterval(()=>void flush(),15000);timer.unref();void flush()
 ctx.effect(()=>()=>{stopped=true;clearInterval(timer)})
}
