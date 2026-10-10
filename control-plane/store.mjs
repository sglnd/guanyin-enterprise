import { createHash } from 'node:crypto'
import pg from 'pg'
import { spaceListOptions, userListOptions } from './space-admin.mjs'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 10) })

const userColumns = `u.id, u.username, u.display_name AS "displayName", u.role, u.mcp_admin AS "mcpAdmin", u.api_admin AS "apiAdmin",
  u.tenant_id AS "tenantId", u.password_hash AS "passwordHash", u.enabled,
  u.created_at AS "createdAt", t.name AS "tenantName"`
const instanceColumns = `i.id, i.name, i.slug, i.version, i.image,
  i.tenant_id AS "tenantId", i.user_id AS "userId", i.status, i.error,
  i.idle_timeout_minutes AS "idleTimeoutMinutes", i.last_active_at AS "lastActiveAt",
  i.created_at AS "createdAt", t.name AS "tenant",
  owner.display_name AS "user", owner.id AS "ownerUserId",
  COALESCE(member_stats.member_count,0)::int AS "memberCount"`

const instanceJoins = `JOIN tenants t ON t.id=i.tenant_id
  LEFT JOIN LATERAL (
    SELECT u.id,u.display_name FROM instance_members im JOIN users u ON u.id=im.user_id
    WHERE im.instance_id=i.id AND im.access_role='owner' ORDER BY im.created_at LIMIT 1
  ) owner ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS member_count FROM instance_members im WHERE im.instance_id=i.id
  ) member_stats ON true`

export function sessionHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function apiKeyHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

export async function initialize({ adminUsername, adminPasswordHash }) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Multiple control-plane replicas can boot together. Serialize schema
    // initialization so PostgreSQL does not race while creating table types.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('guanyin-control-plane-schema'))")
    await client.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id uuid PRIMARY KEY, name text NOT NULL, code text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY, username text NOT NULL UNIQUE, display_name text NOT NULL,
      role text NOT NULL CHECK (role IN ('platform_admin','tenant_admin','member')),
      tenant_id uuid NOT NULL REFERENCES tenants(id), password_hash text NOT NULL,
      enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS mcp_admin boolean NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS api_admin boolean NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS instances (
      id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
      version text NOT NULL, image text NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL, error text,
      last_active_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE instances ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
    CREATE INDEX IF NOT EXISTS instances_live_created_idx ON instances(created_at DESC,id DESC) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS users_created_idx ON users(created_at DESC,id DESC);
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS idle_timeout_minutes integer;
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS api_max_concurrency integer NOT NULL DEFAULT 4;
    CREATE TABLE IF NOT EXISTS instance_members (
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_role text NOT NULL CHECK (access_role IN ('owner','operator','member')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(instance_id,user_id)
    );
    UPDATE instances i SET idle_timeout_minutes=60
      WHERE i.idle_timeout_minutes IS NULL AND i.user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM instance_members im WHERE im.instance_id=i.id);
    INSERT INTO instance_members(instance_id,user_id,access_role)
      SELECT id,user_id,'owner' FROM instances WHERE user_id IS NOT NULL
      ON CONFLICT(instance_id,user_id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS enterprise_license (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      customer_name text NOT NULL, token text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id uuid PRIMARY KEY, actor_user_id uuid NOT NULL REFERENCES users(id),
      action text NOT NULL, target_instance_id uuid REFERENCES instances(id),
      target_user_id uuid REFERENCES users(id), details jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS admin_access_grants (
      session_token_hash text NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      expires_at timestamptz NOT NULL,
      PRIMARY KEY(session_token_hash, instance_id)
    );
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id uuid PRIMARY KEY, name text NOT NULL, server_name text NOT NULL UNIQUE,
      description text NOT NULL DEFAULT '', transport text NOT NULL DEFAULT 'streamable-http',
      url text NOT NULL, headers jsonb NOT NULL DEFAULT '{}'::jsonb,
      enabled boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS space_mcp_bindings (
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      mcp_server_id uuid NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
      created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(instance_id,mcp_server_id)
    );
    CREATE TABLE IF NOT EXISTS api_definitions (
      id uuid PRIMARY KEY, slug text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL DEFAULT '',
      instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      owner_user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('proposal','draft','validated','published','retired')),
      draft_manifest jsonb NOT NULL DEFAULT '{}'::jsonb, created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS api_releases (
      id uuid PRIMARY KEY, api_definition_id uuid NOT NULL REFERENCES api_definitions(id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0), contract jsonb NOT NULL, documentation jsonb NOT NULL,
      published_by uuid NOT NULL REFERENCES users(id), published_at timestamptz NOT NULL DEFAULT now(),
      retired_at timestamptz, UNIQUE(api_definition_id,version)
    );
    CREATE TABLE IF NOT EXISTS api_credentials (
      id uuid PRIMARY KEY, instance_id uuid NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
      name text NOT NULL, key_prefix text NOT NULL UNIQUE, secret_hash text NOT NULL UNIQUE,
      max_concurrency integer NOT NULL DEFAULT 1 CHECK (max_concurrency > 0), enabled boolean NOT NULL DEFAULT true,
      expires_at timestamptz, last_used_at timestamptz, created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS api_credential_grants (
      credential_id uuid NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
      api_release_id uuid NOT NULL REFERENCES api_releases(id) ON DELETE CASCADE,
      created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(credential_id,api_release_id)
    );
    CREATE TABLE IF NOT EXISTS api_runs (
      id uuid PRIMARY KEY, api_release_id uuid NOT NULL REFERENCES api_releases(id),
      credential_id uuid NOT NULL REFERENCES api_credentials(id), instance_id uuid NOT NULL REFERENCES instances(id),
      request_id text NOT NULL UNIQUE, conversation_key text, status text NOT NULL
        CHECK (status IN ('queued','starting','running','succeeded','failed','cancelled','timed_out')),
      input jsonb NOT NULL, output jsonb, error_code text, error_message text,
      queued_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, completed_at timestamptz
    );
    ALTER TABLE api_runs ADD COLUMN IF NOT EXISTS dsh_session_id text;
    CREATE TABLE IF NOT EXISTS api_run_events (
      run_id uuid NOT NULL REFERENCES api_runs(id) ON DELETE CASCADE, sequence bigint NOT NULL,
      event_type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(run_id,sequence)
    );
    CREATE TABLE IF NOT EXISTS api_conversations (
      credential_id uuid NOT NULL REFERENCES api_credentials(id) ON DELETE CASCADE,
      api_release_id uuid NOT NULL REFERENCES api_releases(id) ON DELETE CASCADE,
      conversation_key text NOT NULL, dsh_session_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(credential_id,api_release_id,conversation_key)
    );
    CREATE TABLE IF NOT EXISTS model_providers (
      id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, config jsonb NOT NULL,
      enabled boolean NOT NULL DEFAULT true, created_by uuid NOT NULL REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS space_model_configs (
      instance_id uuid PRIMARY KEY REFERENCES instances(id), provider_ids uuid[] NOT NULL DEFAULT '{}',
      default_provider_id uuid REFERENCES model_providers(id), default_model text,
      revision integer NOT NULL DEFAULT 1, sync_status text NOT NULL DEFAULT 'pending', synced_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS instances_user_idx ON instances(user_id);
    CREATE INDEX IF NOT EXISTS instance_members_user_idx ON instance_members(user_id,instance_id);
    CREATE UNIQUE INDEX IF NOT EXISTS instance_members_one_owner_idx ON instance_members(instance_id) WHERE access_role='owner';
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_target_user_created_idx ON audit_logs(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs(actor_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS api_definitions_instance_status_idx ON api_definitions(instance_id,status);
    CREATE INDEX IF NOT EXISTS api_runs_status_queued_idx ON api_runs(status,queued_at);
    CREATE INDEX IF NOT EXISTS api_runs_credential_status_idx ON api_runs(credential_id,status);
    CREATE INDEX IF NOT EXISTS api_runs_instance_status_idx ON api_runs(instance_id,status);
    `)
    const tenant = await client.query(`INSERT INTO tenants(id,name,code) VALUES(gen_random_uuid(),'默认租户','default') ON CONFLICT(code) DO UPDATE SET code=tenants.code RETURNING id`)
    await client.query(`INSERT INTO users(id,username,display_name,role,tenant_id,password_hash,enabled)
      VALUES(gen_random_uuid(),$1,'平台管理员','platform_admin',$2,$3,true)
      ON CONFLICT(username) DO NOTHING`, [adminUsername, tenant.rows[0].id, adminPasswordHash])
    await client.query('DELETE FROM sessions WHERE expires_at < now()')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function userByUsername(username) {
  const result = await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.username=$1 AND u.deleted_at IS NULL`, [username])
  return result.rows[0]
}

export async function userBySession(token) {
  if (!token) return undefined
  const result = await pool.query(`SELECT ${userColumns} FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=u.tenant_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled=true AND u.deleted_at IS NULL`, [sessionHash(token)])
  return result.rows[0]
}

export async function createSession(token, userId, expiresAt) {
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)', [sessionHash(token), userId, new Date(expiresAt)])
}

export async function deleteSession(token) {
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [sessionHash(token)])
}

export async function listInstances(user) {
  const result = await pool.query(`SELECT ${instanceColumns}, access.access_role AS "accessRole"
    FROM instances i ${instanceJoins} JOIN instance_members access ON access.instance_id=i.id
    WHERE access.user_id=$1 AND i.deleted_at IS NULL AND i.status<>'deleting' ORDER BY i.created_at DESC`, [user.id])
  return result.rows
}

export async function listAllInstances() {
  const result = await pool.query(`SELECT ${instanceColumns} FROM instances i ${instanceJoins} WHERE i.deleted_at IS NULL ORDER BY i.created_at DESC`)
  return result.rows
}

export async function instanceOwnedByUser(id, userId) {
  const result = await pool.query(`SELECT ${instanceColumns}, access.access_role AS "accessRole"
    FROM instances i ${instanceJoins} JOIN instance_members access ON access.instance_id=i.id
    WHERE i.id=$1 AND access.user_id=$2 AND i.deleted_at IS NULL AND i.status<>'deleting'`, [id, userId])
  return result.rows[0]
}

export async function instanceById(id, includeDeleting = false) {
  const result = await pool.query(`SELECT ${instanceColumns} FROM instances i ${instanceJoins} WHERE i.id=$1 AND i.deleted_at IS NULL ${includeDeleting ? '' : "AND i.status<>'deleting'"}`, [id])
  return result.rows[0]
}

export async function createAuditLog({ id, actorUserId, action, targetInstanceId, targetUserId, details = {} }) {
  await pool.query(`INSERT INTO audit_logs(id,actor_user_id,action,target_instance_id,target_user_id,details)
    VALUES($1,$2,$3,$4,$5,$6)`, [id, actorUserId, action, targetInstanceId || null, targetUserId || null, details])
}

export async function listAuditLogs({ limit = 50, offset = 0, userId } = {}) {
  const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 100)
  const pageOffset = Math.max(Number(offset) || 0, 0)
  const where = userId ? 'WHERE a.actor_user_id=$1 OR a.target_user_id=$1' : ''
  const params = userId ? [userId, pageSize, pageOffset] : [pageSize, pageOffset]
  const limitParam = userId ? '$2' : '$1'; const offsetParam = userId ? '$3' : '$2'
  const [rows, count] = await Promise.all([
    pool.query(`SELECT a.id,a.action,a.details,a.created_at AS "createdAt",
    a.actor_user_id AS "actorUserId", a.target_user_id AS "targetUserId",
    actor.display_name AS "actor", target.display_name AS "targetUser",
    i.name AS "targetInstance", i.id AS "targetInstanceId"
    FROM audit_logs a JOIN users actor ON actor.id=a.actor_user_id
    LEFT JOIN users target ON target.id=a.target_user_id
    LEFT JOIN instances i ON i.id=a.target_instance_id
    ${where} ORDER BY a.created_at DESC LIMIT ${limitParam} OFFSET ${offsetParam}`, params),
    pool.query(`SELECT count(*)::int AS total FROM audit_logs a ${where}`, userId ? [userId] : []),
  ])
  return { logs: rows.rows, total: count.rows[0].total, limit: pageSize, offset: pageOffset }
}

export async function grantAdminAccess(token, instanceId, expiresAt) {
  await pool.query(`INSERT INTO admin_access_grants(session_token_hash,instance_id,expires_at)
    VALUES($1,$2,$3) ON CONFLICT(session_token_hash,instance_id)
    DO UPDATE SET expires_at=EXCLUDED.expires_at`, [sessionHash(token), instanceId, new Date(expiresAt)])
}

export async function hasAdminAccess(token, instanceId) {
  if (!token) return false
  const result = await pool.query(`SELECT 1 FROM admin_access_grants
    WHERE session_token_hash=$1 AND instance_id=$2 AND expires_at>now()`, [sessionHash(token), instanceId])
  return result.rowCount > 0
}

export async function updateInstance(id, values) {
  const fields = []; const params = []
  for (const [key, value] of Object.entries(values)) { params.push(value); fields.push(`${key}=$${params.length}`) }
  params.push(id)
  await pool.query(`UPDATE instances SET ${fields.join(',')} WHERE id=$${params.length} AND deleted_at IS NULL AND status<>'deleting'`, params)
}

export async function touchInstance(id) {
  await pool.query(`UPDATE instances SET last_active_at=now() WHERE id=$1
    AND (last_active_at IS NULL OR last_active_at < now() - interval '1 minute')`, [id])
}

export async function claimIdleInstances() {
  const result = await pool.query(`UPDATE instances SET status='stopping'
    WHERE id IN (SELECT id FROM instances WHERE deleted_at IS NULL AND status='running' AND last_active_at IS NOT NULL
      AND idle_timeout_minutes IS NOT NULL
      AND last_active_at < now() - (idle_timeout_minutes::text || ' minutes')::interval FOR UPDATE SKIP LOCKED)
    RETURNING id,name,slug,version,image,tenant_id AS "tenantId",user_id AS "userId",status`)
  return result.rows
}

export async function overview(metadataOnly = false) {
  const [tenants, users] = await Promise.all([
    pool.query('SELECT t.id,t.name,t.code,t.created_at AS "createdAt",(SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id AND u.deleted_at IS NULL) AS "memberCount",(SELECT count(*)::int FROM instances i WHERE i.tenant_id=t.id AND i.deleted_at IS NULL) AS "spaceCount" FROM tenants t WHERE t.deleted_at IS NULL ORDER BY t.created_at'),
    metadataOnly ? Promise.resolve({ rows: [] }) : pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.deleted_at IS NULL ORDER BY u.created_at`),
  ])
  const summary = (await pool.query("SELECT count(*)::int AS total,count(*) FILTER (WHERE enabled)::int AS enabled,count(*) FILTER (WHERE role<>'member')::int AS admins FROM users WHERE deleted_at IS NULL")).rows[0]
  return { tenants: tenants.rows, users: users.rows, summary }
}

export async function createTenant({ id, name, code, createdAt }) {
  const result = await pool.query('INSERT INTO tenants(id,name,code,created_at) VALUES($1,$2,$3,$4) RETURNING id,name,code,created_at AS "createdAt"', [id, name, code, createdAt])
  return result.rows[0]
}

export async function tenantExists(id) {
  return (await pool.query('SELECT 1 FROM tenants WHERE id=$1 AND deleted_at IS NULL', [id])).rowCount > 0
}

async function inLiveTenant(tenantId, operation) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await client.query('SELECT id FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [tenantId])).rowCount) throw new Error('租户不存在或已删除')
    const result = await operation(client)
    await client.query('COMMIT')
    return result
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function createUser(user) {
  return inLiveTenant(user.tenantId, async client => {
    await client.query(`INSERT INTO users(id,username,display_name,role,tenant_id,password_hash,enabled,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [user.id,user.username,user.displayName,user.role,user.tenantId,user.passwordHash,user.enabled,user.createdAt])
    return (await client.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [user.id])).rows[0]
  })
}

export async function userById(id) {
  return (await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1 AND u.deleted_at IS NULL`, [id])).rows[0]
}

export async function updateUser(id, { displayName, role, tenantId, enabled, mcpAdmin = false, apiAdmin = false }) {
  return inLiveTenant(tenantId, async client => {
    const result = await client.query(`UPDATE users SET display_name=$2,role=$3,tenant_id=$4,enabled=$5,mcp_admin=$6,api_admin=$7 WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [id, displayName, role, tenantId, enabled, mcpAdmin, apiAdmin])
    if (!result.rowCount) throw new Error('用户不存在或已删除')
    return (await client.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [id])).rows[0]
  })
}

export async function resetUserPassword(id, passwordHash) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 AND deleted_at IS NULL RETURNING id', [id, passwordHash])
    if (!result.rowCount) { await client.query('ROLLBACK'); return false }
    await client.query('DELETE FROM sessions WHERE user_id=$1', [id])
    await client.query('COMMIT')
    return true
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function createInstance(instance) {
  return inLiveTenant(instance.tenantId, async client => {
    await client.query(`INSERT INTO instances(id,name,slug,version,image,tenant_id,user_id,status,idle_timeout_minutes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [instance.id,instance.name,instance.slug,instance.version,instance.image,instance.tenantId,null,instance.status,instance.idleTimeoutMinutes,instance.createdAt])
    return instance
  })
}

export async function updateInstanceSettings(id, { name, idleTimeoutMinutes }) {
  await pool.query('UPDATE instances SET name=$2,idle_timeout_minutes=$3 WHERE id=$1', [id, name, idleTimeoutMinutes])
  return instanceById(id)
}

export async function listInstanceMembers(instanceId) {
  return (await pool.query(`SELECT u.id,u.username,u.display_name AS "displayName",u.tenant_id AS "tenantId",
    t.name AS "tenantName",im.access_role AS "accessRole",im.created_at AS "createdAt"
    FROM instance_members im JOIN users u ON u.id=im.user_id JOIN tenants t ON t.id=u.tenant_id
    WHERE im.instance_id=$1 AND u.deleted_at IS NULL ORDER BY CASE im.access_role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,u.display_name`, [instanceId])).rows
}

export async function setInstanceMember(instanceId, userId, accessRole) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    if (!(await client.query('SELECT id FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [userId])).rowCount) throw new Error('用户不存在或已删除')
    if (accessRole === 'owner') await client.query("UPDATE instance_members SET access_role='operator' WHERE instance_id=$1 AND access_role='owner' AND user_id<>$2", [instanceId, userId])
    await client.query(`INSERT INTO instance_members(instance_id,user_id,access_role) VALUES($1,$2,$3)
      ON CONFLICT(instance_id,user_id) DO UPDATE SET access_role=EXCLUDED.access_role`, [instanceId, userId, accessRole])
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function removeInstanceMember(instanceId, userId) {
  const result = await pool.query("DELETE FROM instance_members WHERE instance_id=$1 AND user_id=$2 AND access_role<>'owner'", [instanceId, userId])
  return result.rowCount > 0
}

export async function listMcpServers() {
  return (await pool.query(`SELECT m.id,m.name,m.server_name AS "serverName",m.description,m.transport,m.url,
    m.enabled,m.created_at AS "createdAt",m.updated_at AS "updatedAt",count(b.instance_id)::int AS "spaceCount",
    (m.headers <> '{}'::jsonb) AS "hasHeaders"
    FROM mcp_servers m LEFT JOIN space_mcp_bindings b ON b.mcp_server_id=m.id AND EXISTS (SELECT 1 FROM instances i WHERE i.id=b.instance_id AND i.deleted_at IS NULL AND i.status<>'deleting')
    GROUP BY m.id ORDER BY m.updated_at DESC`)).rows
}

export async function mcpServerById(id, includeHeaders = false) {
  const headers = includeHeaders ? ',m.headers' : `,(m.headers <> '{}'::jsonb) AS "hasHeaders"`
  return (await pool.query(`SELECT m.id,m.name,m.server_name AS "serverName",m.description,m.transport,m.url,m.enabled,
    m.created_at AS "createdAt",m.updated_at AS "updatedAt"${headers} FROM mcp_servers m WHERE m.id=$1`, [id])).rows[0]
}

export async function createMcpServer(value) {
  return (await pool.query(`INSERT INTO mcp_servers(id,name,server_name,description,transport,url,headers,enabled,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [value.id,value.name,value.serverName,value.description,value.transport,value.url,value.headers,value.enabled,value.createdBy])).rows[0]
}

export async function updateMcpServer(id, value) {
  await pool.query(`UPDATE mcp_servers SET name=$2,server_name=$3,description=$4,transport=$5,url=$6,
    headers=COALESCE($7,headers),enabled=$8,updated_at=now() WHERE id=$1`, [id,value.name,value.serverName,value.description,value.transport,value.url,value.headers,value.enabled])
  return mcpServerById(id)
}

export async function deleteMcpServer(id) {
  return (await pool.query('DELETE FROM mcp_servers WHERE id=$1 RETURNING id', [id])).rowCount > 0
}

export async function listMcpSpaces(mcpServerId) {
  return (await pool.query(`SELECT i.id,i.name,i.slug,i.version,i.status,t.name AS tenant,b.created_at AS "connectedAt"
    FROM space_mcp_bindings b JOIN instances i ON i.id=b.instance_id JOIN tenants t ON t.id=i.tenant_id
    WHERE i.deleted_at IS NULL AND i.status<>'deleting' AND b.mcp_server_id=$1 ORDER BY b.created_at DESC`, [mcpServerId])).rows
}

export async function listSpaceMcpBindings(instanceId, includeHeaders = false) {
  const headers = includeHeaders ? ',m.headers' : `,(m.headers <> '{}'::jsonb) AS "hasHeaders"`
  return (await pool.query(`SELECT m.id,m.name,m.server_name AS "serverName",m.description,m.transport,m.url,m.enabled,
    b.created_at AS "connectedAt"${headers} FROM space_mcp_bindings b JOIN mcp_servers m ON m.id=b.mcp_server_id
    WHERE b.instance_id=$1 ORDER BY m.name`, [instanceId])).rows
}

export async function setSpaceMcpBinding(instanceId, mcpServerId, userId) {
  await pool.query(`INSERT INTO space_mcp_bindings(instance_id,mcp_server_id,created_by) VALUES($1,$2,$3)
    ON CONFLICT(instance_id,mcp_server_id) DO NOTHING`, [instanceId,mcpServerId,userId])
}

export async function removeSpaceMcpBinding(instanceId, mcpServerId) {
  return (await pool.query('DELETE FROM space_mcp_bindings WHERE instance_id=$1 AND mcp_server_id=$2', [instanceId,mcpServerId])).rowCount > 0
}

const apiRunColumns = `r.id,r.request_id AS "requestId",r.conversation_key AS "conversationKey",r.status,
  r.input,r.output,r.error_code AS "errorCode",r.error_message AS "errorMessage",
  r.dsh_session_id AS "dshSessionId",r.queued_at AS "queuedAt",r.started_at AS "startedAt",r.completed_at AS "completedAt",
  r.api_release_id AS "apiReleaseId",r.credential_id AS "credentialId",r.instance_id AS "instanceId"`
const apiRunReturning = `id,request_id AS "requestId",conversation_key AS "conversationKey",status,input,output,
  error_code AS "errorCode",error_message AS "errorMessage",dsh_session_id AS "dshSessionId",
  queued_at AS "queuedAt",started_at AS "startedAt",completed_at AS "completedAt",
  api_release_id AS "apiReleaseId",credential_id AS "credentialId",instance_id AS "instanceId"`

export async function resolveApiInvocation(slug, secret) {
  const result = await pool.query(`SELECT c.id AS "credentialId",c.max_concurrency AS "credentialMaxConcurrency",
    r.id AS "apiReleaseId",r.version,r.contract,d.id AS "apiDefinitionId",d.slug,d.name,
    d.owner_user_id AS "ownerUserId",i.id AS "instanceId",i.slug AS "instanceSlug",i.status AS "instanceStatus"
    FROM api_credentials c
    JOIN api_credential_grants g ON g.credential_id=c.id
    JOIN api_releases r ON r.id=g.api_release_id AND r.retired_at IS NULL
    JOIN api_definitions d ON d.id=r.api_definition_id
    JOIN instances i ON i.id=d.instance_id AND i.id=c.instance_id
    WHERE i.deleted_at IS NULL AND i.status<>'deleting' AND c.secret_hash=$1 AND c.enabled=true AND (c.expires_at IS NULL OR c.expires_at>now()) AND d.slug=$2
    ORDER BY r.version DESC LIMIT 1`, [apiKeyHash(secret), slug])
  if (result.rowCount) await pool.query('UPDATE api_credentials SET last_used_at=now() WHERE id=$1', [result.rows[0].credentialId])
  return result.rows[0]
}

export async function apiCredentialBySecret(secret) {
  return (await pool.query(`SELECT id,instance_id AS "instanceId" FROM api_credentials
    WHERE secret_hash=$1 AND enabled=true AND (expires_at IS NULL OR expires_at>now())`, [apiKeyHash(secret)])).rows[0]
}

export async function createApiRun(value) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const available = await client.query("SELECT id FROM instances WHERE id=$1 AND deleted_at IS NULL AND status<>'deleting' FOR UPDATE", [value.instanceId])
    if (!available.rowCount) { await client.query('COMMIT'); return { unavailable: true } }
    const existing = await client.query(`SELECT ${apiRunColumns} FROM api_runs r WHERE r.request_id=$1`, [value.requestId])
    if (existing.rowCount) {
      await client.query('COMMIT')
      return { run: existing.rows[0].credentialId === value.credentialId ? existing.rows[0] : undefined, created: false }
    }
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [value.apiReleaseId])
    const queued = Number((await client.query(`SELECT count(*)::int AS count FROM api_runs WHERE api_release_id=$1 AND status='queued'`, [value.apiReleaseId])).rows[0].count)
    if (queued >= value.maxQueueSize) { await client.query('COMMIT'); return { queueFull: true } }
    const result = await client.query(`INSERT INTO api_runs(id,api_release_id,credential_id,instance_id,request_id,conversation_key,status,input)
      VALUES($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING ${apiRunReturning}`,
      [value.id,value.apiReleaseId,value.credentialId,value.instanceId,value.requestId,value.conversationKey || null,value.input])
    await client.query('COMMIT')
    return { run: result.rows[0], created: true }
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function apiRunById(id, credentialId) {
  const params = credentialId ? [id, credentialId] : [id]
  const where = credentialId ? 'r.id=$1 AND r.credential_id=$2' : 'r.id=$1'
  return (await pool.query(`SELECT ${apiRunColumns} FROM api_runs r WHERE ${where}`, params)).rows[0]
}

export async function claimApiRun() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const candidate = await client.query(`SELECT r.id FROM api_runs r
      JOIN api_credentials c ON c.id=r.credential_id
      JOIN api_releases rel ON rel.id=r.api_release_id
      WHERE r.status='queued'
        AND (rel.contract->>'queueTimeoutSeconds' IS NULL OR r.queued_at > now() - make_interval(secs => (rel.contract->>'queueTimeoutSeconds')::int))
        AND (SELECT count(*) FROM api_runs active WHERE active.credential_id=r.credential_id AND active.status IN ('starting','running')) < c.max_concurrency
        AND (SELECT count(*) FROM api_runs active WHERE active.api_release_id=r.api_release_id AND active.status IN ('starting','running')) < COALESCE((rel.contract->>'maxConcurrency')::int,1)
        AND (SELECT count(*) FROM api_runs active WHERE active.instance_id=r.instance_id AND active.status IN ('starting','running'))
          < (SELECT api_max_concurrency FROM instances WHERE id=r.instance_id)
        AND (r.conversation_key IS NULL OR NOT EXISTS (SELECT 1 FROM api_runs active WHERE active.credential_id=r.credential_id
          AND active.api_release_id=r.api_release_id AND active.conversation_key=r.conversation_key AND active.status IN ('starting','running')))
      ORDER BY r.queued_at FOR UPDATE SKIP LOCKED LIMIT 1`)
    if (!candidate.rowCount) { await client.query('COMMIT'); return undefined }
    const claimed = await client.query(`UPDATE api_runs SET status='starting',started_at=now() WHERE id=$1 AND status='queued'
      RETURNING ${apiRunReturning}`, [candidate.rows[0].id])
    await client.query('COMMIT')
    return claimed.rows[0]
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function expireQueuedApiRuns() {
  const expired = await pool.query(`UPDATE api_runs r SET status='timed_out',completed_at=now(),
    error_code='QUEUE_TIMEOUT',error_message='排队等待超时'
    FROM api_releases rel WHERE rel.id=r.api_release_id AND r.status='queued'
      AND rel.contract->>'queueTimeoutSeconds' IS NOT NULL
      AND r.queued_at <= now() - make_interval(secs => (rel.contract->>'queueTimeoutSeconds')::int)
    RETURNING r.id`)
  for (const row of expired.rows) await appendApiRunEvent(row.id, 'run.failed', { code: 'QUEUE_TIMEOUT', message: '排队等待超时' })
  return expired.rowCount
}

export async function apiRunExecutionContext(id) {
  return (await pool.query(`SELECT ${apiRunColumns},rel.contract,d.slug AS "apiSlug",d.owner_user_id AS "ownerUserId",
    i.slug AS "instanceSlug",i.status AS "instanceStatus"
    FROM api_runs r JOIN api_releases rel ON rel.id=r.api_release_id
    JOIN api_definitions d ON d.id=rel.api_definition_id JOIN instances i ON i.id=r.instance_id WHERE r.id=$1`, [id])).rows[0]
}

export async function setApiRunSession(id, sessionId) {
  await pool.query(`UPDATE api_runs SET dsh_session_id=$2,status='running' WHERE id=$1 AND status='starting'`, [id, sessionId])
}

export async function finishApiRun(id, { status, output, errorCode, errorMessage }) {
  await pool.query(`UPDATE api_runs SET status=$2,output=$3,error_code=$4,error_message=$5,completed_at=now()
    WHERE id=$1 AND status IN ('starting','running')`, [id,status,output || null,errorCode || null,errorMessage || null])
}

export async function cancelApiRun(id, credentialId) {
  return (await pool.query(`UPDATE api_runs SET status='cancelled',completed_at=now(),error_code='CANCELLED',error_message='调用方已取消'
    WHERE id=$1 AND credential_id=$2 AND status IN ('queued','starting','running') RETURNING ${apiRunReturning}`, [id,credentialId])).rows[0]
}

export async function appendApiRunEvent(runId, eventType, data = {}) {
  return (await pool.query(`WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1::text)))
    INSERT INTO api_run_events(run_id,sequence,event_type,data)
    SELECT $1::uuid,COALESCE((SELECT max(sequence)+1 FROM api_run_events WHERE run_id=$1::uuid),1),$2,$3 FROM locked
    RETURNING sequence,event_type AS "eventType",data,created_at AS "createdAt"`, [runId,eventType,data])).rows[0]
}

export async function listApiRunEvents(runId, afterSequence = 0, limit = 200) {
  return (await pool.query(`SELECT sequence,event_type AS "eventType",data,created_at AS "createdAt"
    FROM api_run_events WHERE run_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, [runId,afterSequence,Math.min(Math.max(limit,1),500)])).rows
}

export async function getApiConversation(credentialId, apiReleaseId, conversationKey) {
  if (!conversationKey) return undefined
  return (await pool.query(`SELECT dsh_session_id AS "dshSessionId" FROM api_conversations
    WHERE credential_id=$1 AND api_release_id=$2 AND conversation_key=$3`, [credentialId,apiReleaseId,conversationKey])).rows[0]
}

export async function setApiConversation(credentialId, apiReleaseId, conversationKey, sessionId) {
  if (!conversationKey) return
  await pool.query(`INSERT INTO api_conversations(credential_id,api_release_id,conversation_key,dsh_session_id)
    VALUES($1,$2,$3,$4) ON CONFLICT(credential_id,api_release_id,conversation_key)
    DO UPDATE SET dsh_session_id=EXCLUDED.dsh_session_id,updated_at=now()`, [credentialId,apiReleaseId,conversationKey,sessionId])
}

export async function listApiDefinitions(user, globalAccess = false) {
  const params = globalAccess ? [] : [user.id]
  const access = globalAccess ? '' : `JOIN instance_members access ON access.instance_id=d.instance_id AND access.user_id=$1 AND access.access_role IN ('owner','operator')`
  return (await pool.query(`SELECT d.id,d.slug,d.name,d.description,d.status,d.draft_manifest AS "draftManifest",
    d.instance_id AS "instanceId",i.name AS "instanceName",d.owner_user_id AS "ownerUserId",u.display_name AS "ownerName",
    d.created_at AS "createdAt",d.updated_at AS "updatedAt",latest.id AS "releaseId",latest.version AS "releaseVersion",
    (latest.id IS NOT NULL AND latest.retired_at IS NULL) AS "releaseActive",
    COALESCE(stats.run_count,0)::int AS "runCount",COALESCE(stats.failed_count,0)::int AS "failedCount"
    FROM api_definitions d JOIN instances i ON i.id=d.instance_id JOIN users u ON u.id=d.owner_user_id ${access}
    LEFT JOIN LATERAL (SELECT id,version,retired_at FROM api_releases WHERE api_definition_id=d.id ORDER BY version DESC LIMIT 1) latest ON true
    LEFT JOIN LATERAL (SELECT count(*) run_count,count(*) FILTER (WHERE status='failed') failed_count FROM api_runs WHERE api_release_id=latest.id) stats ON true
    WHERE i.deleted_at IS NULL AND i.status<>'deleting' ORDER BY d.updated_at DESC`, params)).rows
}

export async function apiDefinitionById(id) {
  return (await pool.query(`SELECT d.id,d.slug,d.name,d.description,d.status,d.draft_manifest AS "draftManifest",
    d.instance_id AS "instanceId",i.name AS "instanceName",i.tenant_id AS "tenantId",
    d.owner_user_id AS "ownerUserId",u.display_name AS "ownerName",d.created_at AS "createdAt",d.updated_at AS "updatedAt"
    FROM api_definitions d JOIN instances i ON i.id=d.instance_id JOIN users u ON u.id=d.owner_user_id WHERE d.id=$1 AND i.deleted_at IS NULL AND i.status<>'deleting'`, [id])).rows[0]
}

export async function listApiDefinitionsByInstance(instanceId) {
  return (await pool.query(`SELECT d.id,d.slug,d.name,d.description,d.status,d.draft_manifest AS "draftManifest",
    d.instance_id AS "instanceId",d.owner_user_id AS "ownerUserId",u.display_name AS "ownerName",
    d.created_at AS "createdAt",d.updated_at AS "updatedAt"
    FROM api_definitions d JOIN users u ON u.id=d.owner_user_id
    WHERE d.instance_id=$1 ORDER BY d.updated_at DESC LIMIT 100`, [instanceId])).rows
}

export async function createApiDefinition(value) {
  await pool.query(`INSERT INTO api_definitions(id,slug,name,description,instance_id,owner_user_id,status,draft_manifest,created_by)
    VALUES($1,$2,$3,$4,$5,$6,'draft',$7,$8)`, [value.id,value.slug,value.name,value.description,value.instanceId,value.ownerUserId,value.manifest,value.createdBy])
  return apiDefinitionById(value.id)
}

export async function updateApiDefinition(id, value) {
  await pool.query(`UPDATE api_definitions SET slug=$2,name=$3,description=$4,instance_id=$5,owner_user_id=$6,
    draft_manifest=$7,status='draft',updated_at=now() WHERE id=$1`, [id,value.slug,value.name,value.description,value.instanceId,value.ownerUserId,value.manifest])
  return apiDefinitionById(id)
}

export async function setApiDefinitionValidated(id) {
  return (await pool.query(`UPDATE api_definitions SET status='validated',updated_at=now() WHERE id=$1 AND status IN ('draft','validated') RETURNING id`, [id])).rowCount > 0
}

export async function publishApiDefinition(id, documentationFor, userId) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const definition = await client.query(`SELECT * FROM api_definitions WHERE id=$1 AND status='validated' FOR UPDATE`, [id])
    if (!definition.rowCount) { await client.query('ROLLBACK'); return undefined }
    const version = Number((await client.query('SELECT COALESCE(max(version),0)+1 version FROM api_releases WHERE api_definition_id=$1', [id])).rows[0].version)
    const documentation = documentationFor({ ...definition.rows[0], version, contract: definition.rows[0].draft_manifest })
    const release = await client.query(`INSERT INTO api_releases(id,api_definition_id,version,contract,documentation,published_by)
      VALUES(gen_random_uuid(),$1,$2,$3,$4,$5) RETURNING id,version,contract,documentation,published_at AS "publishedAt"`,
      [id,version,definition.rows[0].draft_manifest,documentation,userId])
    await client.query(`UPDATE api_definitions SET status='published',updated_at=now() WHERE id=$1`, [id])
    await client.query('COMMIT')
    return release.rows[0]
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function apiReleaseByDefinition(id) {
  return (await pool.query(`SELECT r.id,r.version,r.contract,r.documentation,r.published_at AS "publishedAt",r.retired_at AS "retiredAt"
    FROM api_releases r WHERE r.api_definition_id=$1 ORDER BY version DESC LIMIT 1`, [id])).rows[0]
}

export async function retireApiDefinition(id) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('UPDATE api_releases SET retired_at=COALESCE(retired_at,now()) WHERE api_definition_id=$1 AND retired_at IS NULL', [id])
    const result = await client.query(`UPDATE api_definitions SET status='retired',updated_at=now() WHERE id=$1 RETURNING id,instance_id AS "instanceId"`, [id])
    await client.query('COMMIT')
    return result.rows[0]
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function listApiRunsByDefinition(definitionId, limit = 50) {
  return (await pool.query(`SELECT ${apiRunColumns},c.name AS "credentialName",c.key_prefix AS "keyPrefix"
    FROM api_runs r JOIN api_releases rel ON rel.id=r.api_release_id JOIN api_credentials c ON c.id=r.credential_id
    WHERE rel.api_definition_id=$1 ORDER BY r.queued_at DESC LIMIT $2`, [definitionId,Math.min(Math.max(Number(limit)||50,1),100)])).rows
}

export async function listApiCredentials(instanceId) {
  return (await pool.query(`SELECT c.id,c.name,c.key_prefix AS "keyPrefix",c.max_concurrency AS "maxConcurrency",c.enabled,
    c.expires_at AS "expiresAt",c.last_used_at AS "lastUsedAt",c.created_at AS "createdAt",
    COALESCE(json_agg(json_build_object('releaseId',g.api_release_id,'definitionId',d.id,'name',d.name,'version',r.version))
      FILTER (WHERE g.api_release_id IS NOT NULL),'[]') AS grants
    FROM api_credentials c LEFT JOIN api_credential_grants g ON g.credential_id=c.id
    LEFT JOIN api_releases r ON r.id=g.api_release_id LEFT JOIN api_definitions d ON d.id=r.api_definition_id
    WHERE c.instance_id=$1 GROUP BY c.id ORDER BY c.created_at DESC`, [instanceId])).rows
}

export async function createApiCredential(value) {
  await pool.query(`INSERT INTO api_credentials(id,instance_id,name,key_prefix,secret_hash,max_concurrency,enabled,expires_at,created_by)
    VALUES($1,$2,$3,$4,$5,$6,true,$7,$8)`, [value.id,value.instanceId,value.name,value.keyPrefix,value.secretHash,value.maxConcurrency,value.expiresAt || null,value.createdBy])
}

export async function setApiCredentialGrant(credentialId, releaseId, userId, enabled) {
  if (enabled) await pool.query(`INSERT INTO api_credential_grants(credential_id,api_release_id,created_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, [credentialId,releaseId,userId])
  else await pool.query('DELETE FROM api_credential_grants WHERE credential_id=$1 AND api_release_id=$2', [credentialId,releaseId])
}

export async function apiCredentialById(id) {
  return (await pool.query(`SELECT id,instance_id AS "instanceId",name,enabled FROM api_credentials WHERE id=$1`, [id])).rows[0]
}

export async function updateApiCredential(id, instanceId, { enabled, maxConcurrency }) {
  return (await pool.query(`UPDATE api_credentials SET enabled=$3,max_concurrency=$4 WHERE id=$1 AND instance_id=$2
    RETURNING id,instance_id AS "instanceId",name,enabled,max_concurrency AS "maxConcurrency"`, [id,instanceId,enabled,maxConcurrency])).rows[0]
}

export async function health() { await pool.query('SELECT 1') }

export async function enterpriseLicense() {
  return (await pool.query('SELECT customer_name AS "customerName",token,updated_at AS "updatedAt" FROM enterprise_license WHERE singleton=true')).rows[0]
}

export async function saveEnterpriseLicense(customerName, token) {
  return (await pool.query(`INSERT INTO enterprise_license(singleton,customer_name,token,updated_at)
    VALUES(true,$1,$2,now()) ON CONFLICT(singleton) DO UPDATE
    SET customer_name=EXCLUDED.customer_name,token=EXCLUDED.token,updated_at=now()
    RETURNING customer_name AS "customerName",updated_at AS "updatedAt"`, [customerName, token])).rows[0]
}

export async function close() { await pool.end() }


export async function listAdminInstances(params) {
  const options = spaceListOptions(params)
  const values = []
  const conditions = ['i.deleted_at IS NULL']
  if (options.search) {
    values.push(`%${options.search.replace(/[\\%_]/g, '\\$&')}%`)
    conditions.push(`(i.name ILIKE $${values.length} OR t.name ILIKE $${values.length} OR i.version ILIKE $${values.length}
      OR EXISTS (SELECT 1 FROM instance_members im JOIN users u ON u.id=im.user_id WHERE im.instance_id=i.id
        AND (u.username ILIKE $${values.length} OR u.display_name ILIKE $${values.length})))`)
  }
  if (options.status !== 'all') { values.push(options.status); conditions.push(`i.status=$${values.length}`) }
  const where = conditions.join(' AND ')
  const total = Number((await pool.query(`SELECT count(*)::int AS total FROM instances i JOIN tenants t ON t.id=i.tenant_id WHERE ${where}`, values)).rows[0].total)
  const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize)))
  const rows = await pool.query(`SELECT ${instanceColumns} FROM instances i ${instanceJoins} WHERE ${where}
    ORDER BY i.created_at DESC,i.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, options.pageSize, (page - 1) * options.pageSize])
  const stats = (await pool.query(`SELECT count(*)::int AS total,
    count(*) FILTER (WHERE status='running')::int AS running, count(*) FILTER (WHERE status='stopped')::int AS stopped,
    (SELECT count(*)::int FROM instance_members im JOIN instances active ON active.id=im.instance_id WHERE active.deleted_at IS NULL) AS members
    FROM instances WHERE deleted_at IS NULL`)).rows[0]
  return { instances: rows.rows, total, page, pageSize: options.pageSize, summary: stats }
}

export async function beginSpaceDeletion(id) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const row = (await client.query('SELECT status FROM instances WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
    if (!row) { await client.query('COMMIT'); return false }
    if (['provisioning','starting','stopping'].includes(row.status)) throw new Error('空间正在变更状态，请待操作完成后再删除')
    const runs = await client.query("SELECT id FROM api_runs WHERE instance_id=$1 AND status IN ('queued','starting','running') LIMIT 1", [id])
    if (runs.rowCount) throw new Error('空间仍有排队或执行中的 API 任务，请完成或取消后再删除')
    await client.query("UPDATE instances SET status='deleting',error=NULL WHERE id=$1", [id])
    await client.query('UPDATE api_credentials SET enabled=false WHERE instance_id=$1', [id])
    await client.query("UPDATE api_definitions SET status='retired' WHERE instance_id=$1", [id])
    await client.query('UPDATE api_releases SET retired_at=COALESCE(retired_at,now()) WHERE api_definition_id IN (SELECT id FROM api_definitions WHERE instance_id=$1)', [id])
    await client.query('DELETE FROM admin_access_grants WHERE instance_id=$1', [id])
    await client.query('COMMIT')
    return true
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function finishSpaceDeletion(id) {
  await pool.query("UPDATE instances SET deleted_at=now(),status='deleted',error=NULL WHERE id=$1 AND status='deleting'", [id])
}


export async function listAdminUsers(params, { memberCandidates = false } = {}) {
  const options = userListOptions(params), values = [], conditions = ['u.deleted_at IS NULL']
  if (memberCandidates) conditions.push("u.role<>'platform_admin'")
  if (options.search) {
    values.push(`%${options.search.replace(/[\\%_]/g, '\\$&')}%`)
    conditions.push(`(u.username ILIKE $${values.length} OR u.display_name ILIKE $${values.length} OR t.name ILIKE $${values.length})`)
  }
  if (options.tenantId !== 'all') { values.push(options.tenantId); conditions.push(`u.tenant_id=$${values.length}`) }
  if (options.role !== 'all') { values.push(options.role); conditions.push(`u.role=$${values.length}`) }
  if (options.status !== 'all') { values.push(options.status === 'true'); conditions.push(`u.enabled=$${values.length}`) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const total = Number((await pool.query(`SELECT count(*)::int AS total FROM users u JOIN tenants t ON t.id=u.tenant_id ${where}`, values)).rows[0].total)
  const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.pageSize)))
  const users = (await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id ${where}
    ORDER BY u.created_at DESC,u.id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values,options.pageSize,(page - 1)*options.pageSize])).rows
  return { users, total, page, pageSize: options.pageSize }
}

export async function tenantById(id) {
  return (await pool.query('SELECT id,name,code FROM tenants WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0]
}

export async function updateTenant(id, { name, code }) {
  return (await pool.query('UPDATE tenants SET name=$2,code=$3 WHERE id=$1 AND deleted_at IS NULL RETURNING id,name,code', [id,name,code])).rows[0]
}

export async function deleteTenant(id, confirmName) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenant = (await client.query('SELECT id,name,code FROM tenants WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
    if (!tenant) throw new Error('租户不存在或已删除')
    if (tenant.name !== confirmName) throw new Error('请输入完整租户名称确认')
    if (tenant.code === 'default') throw new Error('默认租户不能删除')
    const counts = (await client.query(`SELECT (SELECT count(*)::int FROM users WHERE tenant_id=$1 AND deleted_at IS NULL) AS users,
      (SELECT count(*)::int FROM instances WHERE tenant_id=$1 AND deleted_at IS NULL) AS spaces`, [id])).rows[0]
    if (counts.users || counts.spaces) throw new Error(`租户仍有 ${counts.users} 位用户、${counts.spaces} 个空间，请先迁移或删除后再操作`)
    await client.query('UPDATE tenants SET deleted_at=now() WHERE id=$1', [id])
    await client.query('COMMIT')
    return tenant
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function deleteUser(id, confirmName) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const target = (await client.query('SELECT id,username,role FROM users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0]
    if (!target) throw new Error('用户不存在或已删除')
    if (target.role === 'platform_admin') throw new Error('平台管理员不能删除')
    if (target.username !== confirmName) throw new Error('请输入完整用户名确认')
    const owned = await client.query(`SELECT i.name FROM instance_members im JOIN instances i ON i.id=im.instance_id
      WHERE im.user_id=$1 AND im.access_role='owner' AND i.deleted_at IS NULL`, [id])
    if (owned.rowCount) throw new Error(`用户仍是 ${owned.rowCount} 个空间的负责人，请先移交负责人或删除空间`)
    await client.query('UPDATE users SET deleted_at=now(),enabled=false,mcp_admin=false,api_admin=false WHERE id=$1', [id])
    await client.query('DELETE FROM sessions WHERE user_id=$1', [id])
    await client.query('DELETE FROM instance_members WHERE user_id=$1', [id])
    await client.query('UPDATE api_credentials SET enabled=false WHERE created_by=$1', [id])
    await client.query('COMMIT')
    return target
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

const modelProviderColumns = `p.id,p.code,p.name,p.config,p.enabled,p.created_at AS "createdAt",p.updated_at AS "updatedAt"`
export async function listModelProviders() {
  return (await pool.query(`SELECT ${modelProviderColumns},(SELECT count(*)::int FROM space_model_configs c JOIN instances i ON i.id=c.instance_id
    WHERE p.id=ANY(c.provider_ids) AND i.deleted_at IS NULL AND i.status<>'deleting') AS "spaceCount" FROM model_providers p ORDER BY p.updated_at DESC`)).rows
}
export async function modelProviderById(id) {
  return (await pool.query(`SELECT ${modelProviderColumns} FROM model_providers p WHERE p.id=$1`,[id])).rows[0]
}
export async function saveModelProvider(id, value, actorId) {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const existing=(await client.query('SELECT code FROM model_providers WHERE id=$1 FOR UPDATE',[id])).rows[0]
    if(existing && existing.code!==value.code) throw new Error('提供方编码创建后不可修改')
    await client.query(`INSERT INTO model_providers(id,code,name,config,enabled,created_by) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,config=EXCLUDED.config,enabled=EXCLUDED.enabled,updated_at=now()`,[id,value.code,value.name,value.config,value.enabled,actorId])
    await client.query("UPDATE space_model_configs SET revision=revision+1,sync_status='pending' WHERE $1=ANY(provider_ids)",[id])
    await client.query('COMMIT')
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
  return modelProviderById(id)
}
export async function modelProviderSpaces(id) {
  return (await pool.query(`SELECT i.id,i.name,i.slug,i.version,i.status,c.sync_status AS "syncStatus",c.revision
    FROM space_model_configs c JOIN instances i ON i.id=c.instance_id WHERE $1=ANY(c.provider_ids) AND i.deleted_at IS NULL AND i.status<>'deleting' ORDER BY i.created_at DESC`,[id])).rows
}
export async function deleteModelProvider(id, confirmName, removeCredential = async () => {}) {
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    const provider=(await client.query('SELECT id,name FROM model_providers WHERE id=$1 FOR UPDATE',[id])).rows[0]
    if(!provider){await removeCredential();await client.query('COMMIT');return}
    if(provider.name!==confirmName)throw new Error('提供方不存在或确认名称不匹配')
    const spaces=await client.query(`SELECT 1 FROM space_model_configs c JOIN instances i ON i.id=c.instance_id
      WHERE $1=ANY(c.provider_ids) AND i.deleted_at IS NULL`,[id])
    if(spaces.rowCount)throw new Error('请先从所有空间取消接入，再删除提供方')
    await removeCredential()
    await client.query('UPDATE space_model_configs SET default_provider_id=NULL,default_model=NULL WHERE default_provider_id=$1',[id])
    await client.query('DELETE FROM model_providers WHERE id=$1',[id])
    await client.query('COMMIT')
  } catch(error) {await client.query('ROLLBACK');throw error} finally {client.release()}
}
export async function spaceModelConfig(instanceId) {
  const config=(await pool.query(`SELECT provider_ids AS "providerIds",default_provider_id AS "defaultProviderId",default_model AS "defaultModel",revision,sync_status AS "syncStatus",synced_at AS "syncedAt" FROM space_model_configs WHERE instance_id=$1`,[instanceId])).rows[0]
  return config || {providerIds:[],defaultProviderId:null,defaultModel:null,revision:0,syncStatus:'unmanaged',syncedAt:null}
}
export async function saveSpaceModelConfig(instanceId, input) {
  if(!Array.isArray(input.providerIds)||input.providerIds.length>100||new Set(input.providerIds).size!==input.providerIds.length||input.providerIds.some(id=>!isUuid(id)))throw new Error('模型提供方列表无效')
  if(!Number.isInteger(input.revision)||input.revision<0)throw new Error('配置版本无效，请刷新后重试')
  if(input.defaultProviderId && !input.providerIds.includes(input.defaultProviderId))throw new Error('默认模型必须属于已接入的提供方')
  const client=await pool.connect()
  try {
    await client.query('BEGIN')
    if(!(await client.query("SELECT id FROM instances WHERE id=$1 AND deleted_at IS NULL AND status<>'deleting' FOR UPDATE",[instanceId])).rowCount)throw new Error('空间不存在或正在删除')
    const providers=(await client.query('SELECT id,enabled,config FROM model_providers WHERE id=ANY($1::uuid[]) FOR SHARE',[input.providerIds])).rows
    const current=(await client.query('SELECT revision FROM space_model_configs WHERE instance_id=$1 FOR UPDATE',[instanceId])).rows[0]
    if((current?.revision||0)!==input.revision)throw new Error('模型配置已变化，请刷新后重新保存')
    if(providers.length!==input.providerIds.length)throw new Error('提供方不存在')
    if(input.defaultProviderId){const p=providers.find(p=>p.id===input.defaultProviderId);if(!p?.enabled||!p.config.models.some(m=>m.id===input.defaultModel))throw new Error('默认模型不存在或提供方已停用')}
    await client.query(`INSERT INTO space_model_configs(instance_id,provider_ids,default_provider_id,default_model) VALUES($1,$2,$3,$4)
      ON CONFLICT(instance_id) DO UPDATE SET provider_ids=EXCLUDED.provider_ids,default_provider_id=EXCLUDED.default_provider_id,default_model=EXCLUDED.default_model,revision=space_model_configs.revision+1,sync_status='pending'`,[instanceId,input.providerIds,input.defaultProviderId||null,input.defaultProviderId?input.defaultModel:null])
    await client.query('COMMIT')
  } catch(error){await client.query('ROLLBACK');throw error} finally {client.release()}
  return spaceModelConfig(instanceId)
}
export async function markModelSync(instanceId,revision,status) {
  const result=await pool.query("UPDATE space_model_configs SET sync_status=$3,synced_at=CASE WHEN $3='synced' THEN now() ELSE synced_at END WHERE instance_id=$1 AND revision=$2",[instanceId,revision,status])
  return result.rowCount > 0
}

function isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) }

export async function listPendingModelSyncInstances() {
  return (await pool.query(`SELECT i.id,i.slug FROM instances i
    JOIN space_model_configs c ON c.instance_id=i.id
    WHERE i.deleted_at IS NULL AND i.status<>'deleting' AND c.revision>0
      AND c.sync_status IN ('pending','error') ORDER BY i.created_at`)).rows
}
