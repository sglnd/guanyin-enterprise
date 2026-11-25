// Real inference sanity check; prints dimensions/similarity, never full vectors.
const base=process.argv[2]||'http://127.0.0.1:28785/v1',model=process.argv[3]||'bge-m3'
const texts=['服务器磁盘空间不足，需要清理日志。','磁盘容量告警该如何处理？','香蕉是一种水果。'],vectors=[]
for(const input of texts){const r=await fetch(base+'/embeddings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,input}),signal:AbortSignal.timeout(120000)});if(!r.ok)throw Error('embedding HTTP '+r.status);const v=(await r.json()).data?.[0]?.embedding;if(!v?.length||v.some(x=>!Number.isFinite(x)))throw Error('Invalid embedding');vectors.push(v)}
const cosine=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0)/Math.sqrt(a.reduce((s,x)=>s+x*x,0)*b.reduce((s,x)=>s+x*x,0));const related=cosine(vectors[0],vectors[1]),unrelated=cosine(vectors[0],vectors[2]);if(related<=unrelated)throw Error('Semantic sanity check failed');console.log(JSON.stringify({model,dimensions:vectors[0].length,related,unrelated}))
