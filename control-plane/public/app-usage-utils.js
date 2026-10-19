export const usageNumber=value=>value===null||value===undefined?'未知':BigInt(value).toLocaleString('zh-CN');
export function usageCompact(value){
 if(value===null||value===undefined)return '未知';const n=BigInt(value);
 for(const [unit,scale] of [['B',1000000000n],['M',1000000n],['K',1000n]])if(n>=scale)return `${Number(n*100n/scale)/100} ${unit}`;
 return n.toLocaleString('zh-CN');
}
export function usageCacheRate(summary){
 if(summary.unknownInput||summary.unknownCacheRead||summary.inputTokens==null||summary.cacheReadTokens==null)return null;
 const input=BigInt(summary.inputTokens),cache=BigInt(summary.cacheReadTokens);
 if(input<=0n||cache>input)return null;
 return (Number(cache*1000n/input)/10).toFixed(1)+'%';
}
export function usageCsv(rows,columns){
 const cell=value=>{let s=value==null?'未知':String(value);if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"'};
 return '\uFEFF'+[columns.map(c=>cell(c[1])).join(','),...rows.map(r=>columns.map(c=>cell(r[c[0]])).join(','))].join('\r\n');
}
