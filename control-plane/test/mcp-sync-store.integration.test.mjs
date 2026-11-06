import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

test('MCP sync jobs persist pending and final results and prune old jobs', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  const store = await import('../store.mjs')
  const db = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL })
  const id = randomUUID(), expired = randomUUID()
  try {
    await store.initialize({ adminUsername: `mcp-admin-${randomUUID()}`, adminPasswordHash: 'test-only' })
    await db.query("INSERT INTO mcp_sync_jobs(id,result,created_at) VALUES($1,'{}',now()-interval '2 days')", [expired])
    const pending = { id, status: 'pending', name: '测试 MCP', failedSpaces: [], pendingSpaces: 0 }
    await store.createMcpSyncJob(pending)
    assert.deepEqual(await store.mcpSyncJob(id), pending)
    assert.equal(await store.mcpSyncJob(expired), undefined)
    const completed = { ...pending, status: 'error', failedSpaces: ['故障空间'], pendingSpaces: 1 }
    await store.finishMcpSyncJob(completed)
    assert.deepEqual(await store.mcpSyncJob(id), completed)
  } finally {
    await db.query('DELETE FROM mcp_sync_jobs WHERE id IN ($1,$2)', [id, expired])
    await db.end()
    await store.close()
  }
})
