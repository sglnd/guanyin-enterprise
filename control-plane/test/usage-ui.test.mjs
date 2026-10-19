import test from 'node:test'
import assert from 'node:assert/strict'
import {usageNumber,usageCompact,usageCacheRate,usageCsv} from '../public/app-usage-utils.js'
test('usage display preserves unknown and large exact counts, and does not invent cache hit rates',()=>{
 assert.equal(usageNumber(null),'未知');assert.equal(usageNumber('9007199254740993'),'9,007,199,254,740,993');assert.equal(usageCompact('45000000'),'45 M');
 assert.equal(usageCacheRate({inputTokens:'100',cacheReadTokens:'40',unknownInput:0,unknownCacheRead:0}),'40.0%');
 assert.equal(usageCacheRate({inputTokens:'100',cacheReadTokens:'40',unknownCacheRead:1}),null);
 assert.equal(usageCacheRate({inputTokens:'100',cacheReadTokens:'140'}),null);
 assert.equal(usageCacheRate({inputTokens:'0',cacheReadTokens:'0'}),null);
 assert.equal(usageCacheRate({inputTokens:'100',cacheReadTokens:'0'}),'0.0%');
})
test('CSV exports raw exact values and unknowns, quotes fields and prevents spreadsheet formula execution',()=>{
 const csv=usageCsv([{name:'=HYPERLINK("evil")',tokens:'9007199254740993'},{name:'正常,用户',tokens:null}],[['name','用户'],['tokens','Token']]);
 assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes("'="));assert.ok(csv.includes('"正常,用户","未知"'));assert.ok(csv.includes('9007199254740993'));
})
