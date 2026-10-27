const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function usageEvent(input, now=Date.now()) {
  const text=(value,max=200)=>typeof value==='string'&&value.length<=max?value:''
  const count=value=>value===null||value===undefined?null:Number.isSafeInteger(value)&&value>=0?value:NaN
  const occurredAt=new Date(input.occurredAt)
  if(!uuid.test(input.id)||!Number.isFinite(occurredAt.getTime())||occurredAt.getTime()>now+300000)throw Error('用量事件标识或时间无效')
  const value={requestId:text(input.requestId),source:['web','api','schedule','subagent','compaction','session-title'].includes(input.source)?input.source:'unknown',id:input.id,occurredAt:occurredAt.toISOString(),sessionId:text(input.sessionId),provider:text(input.provider),model:text(input.model),userId:uuid.test(input.userId)?input.userId:null,
    inputTokens:count(input.inputTokens),outputTokens:count(input.outputTokens),totalTokens:count(input.totalTokens),cacheReadTokens:count(input.cacheReadTokens),cacheWriteTokens:count(input.cacheWriteTokens),durationMs:count(input.durationMs),result:input.result,quality:input.quality}
  if(!value.provider||!value.model||!['success','error','cancelled'].includes(value.result)||!['reported','estimated','unknown'].includes(value.quality)||Object.values(value).some(v=>typeof v==='number'&&Number.isNaN(v)))throw Error('用量事件字段无效')
  if(value.quality==='unknown'){for(const k of ['inputTokens','outputTokens','totalTokens','cacheReadTokens','cacheWriteTokens'])value[k]=null}
  return value
}
export function usageQuery(params, now=new Date()) {
  const from=new Date(params.get('from')||new Date(now.getTime()-30*86400000)),to=new Date(params.get('to')||now)
  const cutoff=new Date(now);cutoff.setUTCFullYear(cutoff.getUTCFullYear()-1)
  if(!Number.isFinite(+from)||!Number.isFinite(+to)||from>to)throw Error('查询时间范围无效')
  const group=params.get('group')||'user';if(!['user','space','model','tenant','detail'].includes(group))throw Error('统计维度无效')
  const page=Number(params.get('page')||1),pageSize=Number(params.get('pageSize')||20)
  if(!Number.isInteger(page)||page<1||page>1000000||![20,50,100].includes(pageSize))throw Error('分页参数无效')
  const filters={};for(const k of ['userId','spaceId','tenantId']){const v=params.get(k);if(v){if(v!=='unattributed'&&!uuid.test(v))throw Error('筛选标识无效');if(v==='unattributed'&&k!=='userId')throw Error('筛选标识无效');filters[k]=v}}
  return {from:new Date(Math.max(+from,+cutoff)),to,group,page,pageSize,filters,model:(params.get('model')||'').trim().slice(0,200),provider:(params.get('provider')||'').trim().slice(0,200),search:(params.get('q')||'').trim().slice(0,200)}
}
export async function initializeUsage(pool){await pool.query(`CREATE TABLE IF NOT EXISTS model_usage_events (
 id uuid NOT NULL, space_id uuid NOT NULL, tenant_id uuid NOT NULL, user_id uuid,
 space_name text NOT NULL,tenant_name text NOT NULL,user_name text,session_id text NOT NULL,
 provider text NOT NULL,model text NOT NULL,occurred_at timestamptz NOT NULL,
 input_tokens bigint,output_tokens bigint,total_tokens bigint,cache_read_tokens bigint,cache_write_tokens bigint,
 duration_ms bigint,result text NOT NULL CHECK(result IN ('success','error','cancelled')),
 quality text NOT NULL CHECK(quality IN ('reported','estimated','unknown')),received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(space_id,id));
 ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS space_version text NOT NULL DEFAULT '';
 ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS request_id text NOT NULL DEFAULT '';
 ALTER TABLE model_usage_events ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'unknown';
 CREATE INDEX IF NOT EXISTS usage_time_idx ON model_usage_events(occurred_at);
 CREATE INDEX IF NOT EXISTS usage_user_time_idx ON model_usage_events(user_id,occurred_at);
 CREATE INDEX IF NOT EXISTS usage_space_time_idx ON model_usage_events(space_id,occurred_at);
 CREATE INDEX IF NOT EXISTS usage_tenant_time_idx ON model_usage_events(tenant_id,occurred_at);`)}
export async function ingestUsage(pool,instance,events){
 if(!Array.isArray(events)||events.length>100)throw Error('每批最多 100 条用量事件')
 const rows=events.map(e=>usageEvent(e)),client=await pool.connect();let accepted=0
 try{await client.query('BEGIN')
  for(const e of rows){
   const user=e.userId?(await client.query('SELECT id,display_name,username FROM users WHERE id=$1 AND tenant_id=$2',[e.userId,instance.tenantId])).rows[0]:null
   const result=await client.query(`INSERT INTO model_usage_events(id,space_id,tenant_id,user_id,space_name,tenant_name,user_name,session_id,provider,model,occurred_at,input_tokens,output_tokens,total_tokens,cache_read_tokens,cache_write_tokens,duration_ms,result,quality,space_version,request_id,source)
     SELECT $1,$2,$3,$4,$5,t.name,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21 FROM tenants t WHERE t.id=$3 AND $10::timestamptz>=now()-interval '1 year'
     ON CONFLICT(space_id,id) DO NOTHING`,[e.id,instance.id,instance.tenantId,user?.id||null,instance.name,user?`${user.display_name} (${user.username})`:null,e.sessionId,e.provider,e.model,e.occurredAt,e.inputTokens,e.outputTokens,e.totalTokens,e.cacheReadTokens,e.cacheWriteTokens,e.durationMs,e.result,e.quality,instance.version||'',e.requestId,e.source]);accepted+=result.rowCount
  }await client.query('COMMIT');return accepted
 }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
}
const aggregate=`count(*)::int AS calls,count(*) FILTER(WHERE result='error')::int AS errors,count(*) FILTER(WHERE result='cancelled')::int AS cancelled,
 count(*) FILTER(WHERE quality='unknown' OR total_tokens IS NULL)::int AS unknown,
 count(*) FILTER(WHERE quality='estimated')::int AS estimated,
 sum(input_tokens)::text AS "inputTokens",sum(output_tokens)::text AS "outputTokens",sum(total_tokens)::text AS "totalTokens",
 sum(cache_read_tokens)::text AS "cacheReadTokens",sum(cache_write_tokens)::text AS "cacheWriteTokens",
 count(*) FILTER(WHERE input_tokens IS NULL)::int AS "unknownInput",count(*) FILTER(WHERE output_tokens IS NULL)::int AS "unknownOutput",
 count(*) FILTER(WHERE cache_read_tokens IS NULL)::int AS "unknownCacheRead",count(*) FILTER(WHERE cache_write_tokens IS NULL)::int AS "unknownCacheWrite",
 count(*) FILTER(WHERE duration_ms IS NULL)::int AS "unknownDuration",
 round(avg(duration_ms))::text AS "avgDurationMs",
 round(percentile_cont(0.5) WITHIN GROUP(ORDER BY duration_ms))::text AS "p50DurationMs",
 round(percentile_cont(0.95) WITHIN GROUP(ORDER BY duration_ms))::text AS "p95DurationMs",
 round(percentile_cont(0.99) WITHIN GROUP(ORDER BY duration_ms))::text AS "p99DurationMs"`
export async function queryUsage(pool,params){
 const q=usageQuery(params),values=[q.from,q.to],conditions=['occurred_at >= $1','occurred_at <= $2',"occurred_at >= now()-interval '1 year'"]
 for(const [key,column] of [['userId','user_id'],['spaceId','space_id'],['tenantId','tenant_id']])if(q.filters[key]){if(q.filters[key]==='unattributed')conditions.push('user_id IS NULL');else{values.push(q.filters[key]);conditions.push(`${column}=$${values.length}`)}}
 if(q.model){values.push(q.model);conditions.push(`model=$${values.length}`)}
 if(q.provider){values.push(q.provider);conditions.push(`provider=$${values.length}`)}
 if(q.search){values.push('%'+q.search.replace(/[\\%_]/g,'\\$&')+'%');conditions.push(`(user_name ILIKE $${values.length} OR space_name ILIKE $${values.length} OR tenant_name ILIKE $${values.length} OR model ILIKE $${values.length} OR session_id ILIKE $${values.length})`)}
 const where='WHERE '+conditions.join(' AND ')
 const dimensions={user:["COALESCE(user_id::text,'unattributed')","COALESCE(max(user_name),'未归属')"],space:['space_id::text','max(space_name)'],tenant:['tenant_id::text','max(tenant_name)'],model:["provider || '/' || model","provider || '/' || model"]}
 const summary=(await pool.query(`SELECT ${aggregate} FROM model_usage_events ${where}`,values)).rows[0]
 const group=q.group==='detail'?'':`GROUP BY ${dimensions[q.group][0]}`
 const total=Number((await pool.query(`SELECT count(*)::int AS total FROM (SELECT 1 FROM model_usage_events ${where} ${group}) x`,values)).rows[0].total)
 const page=Math.min(q.page,Math.max(1,Math.ceil(total/q.pageSize)))
 const select=q.group==='detail'?`id,space_version AS "spaceVersion",request_id AS "requestId",source,space_id AS "spaceId",tenant_id AS "tenantId",user_id AS "userId",space_name AS "spaceName",tenant_name AS "tenantName",user_name AS "userName",session_id AS "sessionId",provider,model,occurred_at AS "occurredAt",input_tokens::text AS "inputTokens",output_tokens::text AS "outputTokens",total_tokens::text AS "totalTokens",cache_read_tokens::text AS "cacheReadTokens",cache_write_tokens::text AS "cacheWriteTokens",duration_ms::text AS "durationMs",result,quality`:`${dimensions[q.group][0]} AS id,${dimensions[q.group][1]} AS name,${aggregate}`
 const rows=(await pool.query(`SELECT ${select} FROM model_usage_events ${where} ${group} ORDER BY ${q.group==='detail'?'occurred_at DESC,id':'calls DESC,id'} LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,q.pageSize,(page-1)*q.pageSize])).rows
 const trend=(await pool.query(`SELECT to_char(occurred_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,${aggregate} FROM model_usage_events ${where} GROUP BY day ORDER BY day`,values)).rows
 const providers=(await pool.query("SELECT DISTINCT provider FROM model_usage_events WHERE occurred_at>=now()-interval '1 year' ORDER BY provider LIMIT 1000")).rows.map(r=>r.provider)
 return {rows,summary,trend,providers,total,page,pageSize:q.pageSize,from:q.from,to:q.to}
}
export async function pruneUsage(pool){return (await pool.query("DELETE FROM model_usage_events WHERE occurred_at < now()-interval '1 year'")).rowCount}
