const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function auditLogOptions({limit=50,offset=0,userId,user='',space=''}={}){
 const pageSize=Number(limit||50),pageOffset=Number(offset||0)
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!Number.isSafeInteger(pageOffset)||pageOffset<0)throw Error('审计日志分页参数无效')
 if(userId&&!uuid.test(userId))throw Error('用户标识无效')
 for(const value of [user,space])if(typeof value!=='string'||value.length>200)throw Error('筛选条件最多 200 个字符')
 return {limit:pageSize,offset:pageOffset,userId,user:user.trim(),space:space.trim()}
}
export async function queryAuditLogs(pool,options={}){
 const q=auditLogOptions(options),values=[],conditions=["a.created_at >= now()-interval '1 year'"]
 const parameter=value=>{values.push(value);return '$'+values.length}
 const literal=value=>'%'+value.replace(/[\\%_]/g,'\\$&')+'%'
 if(q.userId){const p=parameter(q.userId);conditions.push(`(a.actor_user_id=${p} OR a.target_user_id=${p})`)}
 if(q.user){const p=parameter(uuid.test(q.user)?q.user:literal(q.user));conditions.push(uuid.test(q.user)?`(a.actor_user_id=${p} OR a.target_user_id=${p})`:`(actor.display_name ILIKE ${p} OR actor.username ILIKE ${p} OR target.display_name ILIKE ${p} OR target.username ILIKE ${p})`)}
 if(q.space){const p=parameter(uuid.test(q.space)?q.space:literal(q.space));conditions.push(uuid.test(q.space)?`a.target_instance_id=${p}`:`i.name ILIKE ${p}`)}
 const joins='FROM audit_logs a LEFT JOIN users actor ON actor.id=a.actor_user_id LEFT JOIN users target ON target.id=a.target_user_id LEFT JOIN instances i ON i.id=a.target_instance_id'
 const where='WHERE '+conditions.join(' AND ')
 const total=Number((await pool.query(`SELECT count(*)::int AS total ${joins} ${where}`,values)).rows[0].total)
 const offset=Math.min(q.offset,Math.max(0,(Math.ceil(total/q.limit)-1)*q.limit))
 const rows=await pool.query(`SELECT a.id,a.action,a.details,a.created_at AS "createdAt",a.actor_user_id AS "actorUserId",a.target_user_id AS "targetUserId",actor.display_name AS actor,target.display_name AS "targetUser",i.name AS "targetInstance",a.target_instance_id AS "targetInstanceId" ${joins} ${where} ORDER BY a.created_at DESC,a.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,q.limit,offset])
 return {logs:rows.rows,total,limit:q.limit,offset}
}
export async function pruneAuditLogs(pool){return (await pool.query("DELETE FROM audit_logs WHERE created_at < now()-interval '1 year'")).rowCount}
