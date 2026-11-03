import test from 'node:test'
import assert from 'node:assert/strict'
import {networkRulesInput} from '../network-policy.mjs'
test('network origins normalize schemes, default/custom ports and exact private addresses',()=>{
 assert.deepEqual(networkRulesInput('https://OA.company.com:8443\nhttp://192.168.10.20:8080，http://monitor.internal:3000、https://oa.company.com:8443'),['https://oa.company.com:8443','http://192.168.10.20:8080','http://monitor.internal:3000'])
 assert.deepEqual(networkRulesInput('http://example.com https://example.com'),['http://example.com:80','https://example.com:443'])
 for(const bad of ['https://a/path','https://a?x=1','ftp://a','https://user:pass@a','https://*.a','http://127.0.0.1:80','http://169.254.169.254','http://a:99999'])assert.throws(()=>networkRulesInput(bad))
})
