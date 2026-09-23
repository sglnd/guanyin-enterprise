import { createHash } from 'node:crypto'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DB_POOL_SIZE || 10) })

const userColumns = `u.id, u.username, u.display_name AS "displayName", u.role,
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

export async function initialize({ adminUsername, adminPasswordHash }) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
  await pool.query(`
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
    CREATE TABLE IF NOT EXISTS instances (
      id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
      version text NOT NULL, image text NOT NULL, tenant_id uuid NOT NULL REFERENCES tenants(id),
      user_id uuid NOT NULL REFERENCES users(id), status text NOT NULL, error text,
      last_active_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE instances ALTER COLUMN user_id DROP NOT NULL;
    ALTER TABLE instances ADD COLUMN IF NOT EXISTS idle_timeout_minutes integer;
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
    CREATE INDEX IF NOT EXISTS instances_user_idx ON instances(user_id);
    CREATE INDEX IF NOT EXISTS instance_members_user_idx ON instance_members(user_id,instance_id);
    CREATE UNIQUE INDEX IF NOT EXISTS instance_members_one_owner_idx ON instance_members(instance_id) WHERE access_role='owner';
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_target_user_created_idx ON audit_logs(target_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_actor_created_idx ON audit_logs(actor_user_id, created_at DESC);
  `)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const tenant = await client.query(`INSERT INTO tenants(id,name,code) VALUES(gen_random_uuid(),'默认租户','default') ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name RETURNING id`)
    await client.query(`INSERT INTO users(id,username,display_name,role,tenant_id,password_hash,enabled)
      VALUES(gen_random_uuid(),$1,'平台管理员','platform_admin',$2,$3,true)
      ON CONFLICT(username) DO NOTHING`, [adminUsername, tenant.rows[0].id, adminPasswordHash])
    await client.query('DELETE FROM sessions WHERE expires_at < now()')
    await client.query('COMMIT')
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function userByUsername(username) {
  const result = await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.username=$1`, [username])
  return result.rows[0]
}

export async function userBySession(token) {
  if (!token) return undefined
  const result = await pool.query(`SELECT ${userColumns} FROM sessions s JOIN users u ON u.id=s.user_id JOIN tenants t ON t.id=u.tenant_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.enabled=true`, [sessionHash(token)])
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
    WHERE access.user_id=$1 ORDER BY i.created_at DESC`, [user.id])
  return result.rows
}

export async function listAllInstances() {
  const result = await pool.query(`SELECT ${instanceColumns} FROM instances i ${instanceJoins} ORDER BY i.created_at DESC`)
  return result.rows
}

export async function instanceOwnedByUser(id, userId) {
  const result = await pool.query(`SELECT ${instanceColumns}, access.access_role AS "accessRole"
    FROM instances i ${instanceJoins} JOIN instance_members access ON access.instance_id=i.id
    WHERE i.id=$1 AND access.user_id=$2`, [id, userId])
  return result.rows[0]
}

export async function instanceById(id) {
  const result = await pool.query(`SELECT ${instanceColumns} FROM instances i ${instanceJoins} WHERE i.id=$1`, [id])
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
  await pool.query(`UPDATE instances SET ${fields.join(',')} WHERE id=$${params.length}`, params)
}

export async function touchInstance(id) {
  await pool.query(`UPDATE instances SET last_active_at=now() WHERE id=$1
    AND (last_active_at IS NULL OR last_active_at < now() - interval '1 minute')`, [id])
}

export async function claimIdleInstances() {
  const result = await pool.query(`UPDATE instances SET status='stopping'
    WHERE id IN (SELECT id FROM instances WHERE status='running' AND last_active_at IS NOT NULL
      AND idle_timeout_minutes IS NOT NULL
      AND last_active_at < now() - (idle_timeout_minutes::text || ' minutes')::interval FOR UPDATE SKIP LOCKED)
    RETURNING id,name,slug,version,image,tenant_id AS "tenantId",user_id AS "userId",status`)
  return result.rows
}

export async function overview() {
  const [tenants, users] = await Promise.all([
    pool.query('SELECT id,name,code,created_at AS "createdAt" FROM tenants ORDER BY created_at'),
    pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id ORDER BY u.created_at`),
  ])
  return { tenants: tenants.rows, users: users.rows }
}

export async function createTenant({ id, name, code, createdAt }) {
  const result = await pool.query('INSERT INTO tenants(id,name,code,created_at) VALUES($1,$2,$3,$4) RETURNING id,name,code,created_at AS "createdAt"', [id, name, code, createdAt])
  return result.rows[0]
}

export async function tenantExists(id) {
  return (await pool.query('SELECT 1 FROM tenants WHERE id=$1', [id])).rowCount > 0
}

export async function createUser(user) {
  const result = await pool.query(`INSERT INTO users(id,username,display_name,role,tenant_id,password_hash,enabled,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, [user.id,user.username,user.displayName,user.role,user.tenantId,user.passwordHash,user.enabled,user.createdAt])
  return (await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [result.rows[0].id])).rows[0]
}

export async function userById(id) {
  return (await pool.query(`SELECT ${userColumns} FROM users u JOIN tenants t ON t.id=u.tenant_id WHERE u.id=$1`, [id])).rows[0]
}

export async function updateUser(id, { displayName, role, tenantId, enabled }) {
  await pool.query(`UPDATE users SET display_name=$2,role=$3,tenant_id=$4,enabled=$5 WHERE id=$1`, [id, displayName, role, tenantId, enabled])
  return userById(id)
}

export async function resetUserPassword(id, passwordHash) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING id', [id, passwordHash])
    if (!result.rowCount) { await client.query('ROLLBACK'); return false }
    await client.query('DELETE FROM sessions WHERE user_id=$1', [id])
    await client.query('COMMIT')
    return true
  } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
}

export async function createInstance(instance) {
  await pool.query(`INSERT INTO instances(id,name,slug,version,image,tenant_id,user_id,status,idle_timeout_minutes,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [instance.id,instance.name,instance.slug,instance.version,instance.image,instance.tenantId,null,instance.status,instance.idleTimeoutMinutes,instance.createdAt])
  return instance
}

export async function updateInstanceSettings(id, { name, idleTimeoutMinutes }) {
  await pool.query('UPDATE instances SET name=$2,idle_timeout_minutes=$3 WHERE id=$1', [id, name, idleTimeoutMinutes])
  return instanceById(id)
}

export async function listInstanceMembers(instanceId) {
  return (await pool.query(`SELECT u.id,u.username,u.display_name AS "displayName",u.tenant_id AS "tenantId",
    t.name AS "tenantName",im.access_role AS "accessRole",im.created_at AS "createdAt"
    FROM instance_members im JOIN users u ON u.id=im.user_id JOIN tenants t ON t.id=u.tenant_id
    WHERE im.instance_id=$1 ORDER BY CASE im.access_role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,u.display_name`, [instanceId])).rows
}

export async function setInstanceMember(instanceId, userId, accessRole) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
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

export async function health() { await pool.query('SELECT 1') }

export async function close() { await pool.end() }
