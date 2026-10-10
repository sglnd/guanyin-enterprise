import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {runInNewContext} from 'node:vm'

test('member picker requests one searchable page and discards stale results',async()=>{
 const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8')
 const code=source.slice(source.indexOf('let memberUserPage=1'),source.indexOf("$('#member-user-search').oninput"))
 const nodes=Object.fromEntries(['#space-member-form select[name=userId]','#member-user-prev','#member-user-next','#space-member-form button[type=submit]','#member-user-message','#member-user-page','#member-user-search'].map(k=>[k,{}]))
 nodes['#member-user-search'].value='陈'
 const requests=[],context={$:s=>nodes[s],selectedSpace:{id:'space-a'},URLSearchParams,esc:s=>s,request:url=>new Promise(resolve=>requests.push({url,resolve}))}
 const load=runInNewContext(code+';loadMemberCandidates',context)
 const first=load()
 assert.match(requests[0].url,/member-candidates\?page=1&pageSize=20&q=/)
 const second=load()
 requests[1].resolve({users:[{id:'new',displayName:'陈甲',username:'new'}],page:1,total:21})
 await second
 assert.match(nodes['#space-member-form select[name=userId]'].innerHTML,/陈甲/)
 assert.equal(nodes['#member-user-next'].disabled,false)
 requests[0].resolve({users:[{id:'old',displayName:'旧结果',username:'old'}],page:1,total:1})
 await first
 assert.equal(nodes['#space-member-form select[name=userId]'].innerHTML.includes('旧结果'),false)
 const third=load();context.selectedSpace={id:'space-b'}
 requests[2].resolve({users:[{id:'wrong',displayName:'其他空间',username:'wrong'}],page:1,total:1});await third
 assert.equal(nodes['#space-member-form select[name=userId]'].innerHTML.includes('其他空间'),false)
 const empty=load();requests[3].resolve({users:[],page:1,total:0});await empty
 assert.equal(nodes['#space-member-form select[name=userId]'].disabled,true)
 assert.equal(nodes['#space-member-form button[type=submit]'].disabled,true)
 assert.match(nodes['#member-user-message'].textContent,/没有符合条件/)
})
