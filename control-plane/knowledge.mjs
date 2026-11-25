import {
  initializeVectors,
  ensureVectorIndex,
  vectorSearch,
} from "./knowledge-vector.mjs";
import {
  processingOptions,
  savedOptions,
  splitContent,
  cleanContent,
  metadataFields,
  generationPolicy,
} from "./knowledge-processing.mjs";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
export class KnowledgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (s, m) => {
  throw new KnowledgeError(s, m);
};
export const uuid = (v) =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
export const chunks = (text, options) => splitContent(text, options);
export function vector(v) {
  if (
    !Array.isArray(v) ||
    !v.length ||
    v.length > 8192 ||
    v.some((x) => !Number.isFinite(x) || !Number.isFinite(Math.fround(x))) ||
    !v.some((x) => Math.fround(x) !== 0)
  )
    fail(502, "向量模型返回无效数据");
  return v;
}
export function cosine(a, b) {
  if (a.length !== b.length) fail(409, "向量维度不一致，请重新发布索引");
  let dot = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}
export class Knowledge {
  constructor(
    pool,
    { root = process.env.KNOWLEDGE_ROOT || "/data/knowledge" } = {},
  ) {
    this.pool = pool;
    this.root = root;
    this.busy = false;
  }
  async init() {
    await this.tx(async (c) => {
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':knowledge-schema'))",
      );
      await c.query(`
 CREATE TABLE IF NOT EXISTS knowledge_libraries(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id),owner_id uuid NOT NULL REFERENCES users(id),name text NOT NULL,kind text NOT NULL CHECK(kind IN ('personal','public')),deleted boolean NOT NULL DEFAULT false,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS knowledge_grants(library_id uuid REFERENCES knowledge_libraries(id),user_id uuid REFERENCES users(id),maintain boolean NOT NULL DEFAULT false,PRIMARY KEY(library_id,user_id));
 CREATE TABLE IF NOT EXISTS knowledge_documents(id uuid PRIMARY KEY,library_id uuid NOT NULL REFERENCES knowledge_libraries(id),title text NOT NULL,current_version integer NOT NULL DEFAULT 1,published_version integer,deleted boolean DEFAULT false,created_at timestamptz DEFAULT now());
 CREATE TABLE IF NOT EXISTS knowledge_versions(document_id uuid REFERENCES knowledge_documents(id),version integer,filename text NOT NULL,file_key uuid NOT NULL,sha256 text NOT NULL,source text,draft text,quotes jsonb NOT NULL DEFAULT '[]',edit_revision integer NOT NULL DEFAULT 0,state text NOT NULL DEFAULT 'queued',error text,stage text NOT NULL DEFAULT 'parse',lease uuid,locked_at timestamptz,model_info jsonb,PRIMARY KEY(document_id,version));
 ALTER TABLE knowledge_libraries ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS byte_size bigint;
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS updated_at timestamptz;
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS processing_options jsonb NOT NULL DEFAULT '{}';
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS summary text;
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS keywords jsonb NOT NULL DEFAULT '[]';
 ALTER TABLE knowledge_versions ADD COLUMN IF NOT EXISTS phase text;
 CREATE TABLE IF NOT EXISTS knowledge_upload_requests(id uuid PRIMARY KEY,actor uuid NOT NULL,library_id uuid NOT NULL,document_id uuid NOT NULL,version integer NOT NULL,fingerprint text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE OR REPLACE FUNCTION knowledge_version_timestamp() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
 DROP TRIGGER IF EXISTS knowledge_version_changed ON knowledge_versions;
 CREATE TRIGGER knowledge_version_changed BEFORE INSERT OR UPDATE OF draft,state ON knowledge_versions FOR EACH ROW EXECUTE FUNCTION knowledge_version_timestamp();
 CREATE TABLE IF NOT EXISTS knowledge_chunks(document_id uuid,version integer,position integer,content text NOT NULL,embedding jsonb NOT NULL,model_key text NOT NULL,PRIMARY KEY(document_id,version,position),FOREIGN KEY(document_id,version) REFERENCES knowledge_versions(document_id,version));
 CREATE TABLE IF NOT EXISTS knowledge_space_epochs(space_id uuid PRIMARY KEY REFERENCES instances(id),epoch bigint NOT NULL DEFAULT 0);
 CREATE OR REPLACE FUNCTION knowledge_member_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO knowledge_space_epochs(space_id,epoch) VALUES(NEW.instance_id,1) ON CONFLICT(space_id) DO UPDATE SET epoch=knowledge_space_epochs.epoch+1; RETURN NEW; END $$;
 DROP TRIGGER IF EXISTS knowledge_member_added ON instance_members;
 CREATE TRIGGER knowledge_member_added AFTER INSERT ON instance_members FOR EACH ROW EXECUTE FUNCTION knowledge_member_epoch();
 CREATE TABLE IF NOT EXISTS knowledge_bindings(library_id uuid REFERENCES knowledge_libraries(id),space_id uuid REFERENCES instances(id),confirmed_by uuid REFERENCES users(id),epoch bigint NOT NULL,created_at timestamptz DEFAULT now(),PRIMARY KEY(library_id,space_id));
 CREATE TABLE IF NOT EXISTS knowledge_settings(id integer PRIMARY KEY CHECK(id=1),value jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS knowledge_audit(id bigserial PRIMARY KEY,actor text,action text NOT NULL,library_id uuid,subject text,created_at timestamptz DEFAULT now());
 CREATE INDEX IF NOT EXISTS knowledge_documents_library ON knowledge_documents(library_id);
 CREATE INDEX IF NOT EXISTS knowledge_versions_pending ON knowledge_versions(state,locked_at);
 `);
      await initializeVectors(c);
    });
  }
  async tx(fn) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const v = await fn(c);
      await c.query("COMMIT");
      return v;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async audit(c, actor, action, lib, subject) {
    await c.query(
      "INSERT INTO knowledge_audit(actor,action,library_id,subject) VALUES($1,$2,$3,$4)",
      [actor, action, lib, subject],
    );
  }
  async library(user, id, write = false, c = this.pool) {
    if (!uuid(id)) fail(404, "知识库不存在");
    const r = (
      await c.query(
        `SELECT k.*,owner.display_name AS owner_name, (k.owner_id=$2 OR COALESCE(g.maintain,false) OR (k.kind='public' AND $4)) AS maintain FROM knowledge_libraries k JOIN users owner ON owner.id=k.owner_id AND owner.enabled AND owner.deleted_at IS NULL LEFT JOIN knowledge_grants g ON g.library_id=k.id AND g.user_id=$2 WHERE k.id=$1 AND k.tenant_id=$3 AND NOT k.deleted AND (k.owner_id=$2 OR g.user_id IS NOT NULL OR (k.kind='public' AND $4))`,
        [
          id,
          user.id,
          user.tenantId,
          user.role === "platform_admin" || user.knowledgeAdmin === true,
        ],
      )
    ).rows[0];
    if (!r || (write && !r.maintain)) fail(403, "无知识库权限");
    return r;
  }
  async list(user, page = 1, options = {}) {
    page = Math.max(1, Math.min(100000, Math.floor(Number(page) || 1)));
    const q = String(options.q || "")
        .trim()
        .slice(0, 120),
      kind = ["personal", "public"].includes(options.kind)
        ? options.kind
        : "all";
    const result = await this.pool.query(
      `WITH accessible AS (
      SELECT k.*, (k.owner_id=$1 OR COALESCE(g.maintain,false) OR (k.kind='public' AND $3)) AS maintain,
        (SELECT count(*)::int FROM knowledge_documents d WHERE d.library_id=k.id AND NOT d.deleted) AS document_count,
        COALESCE((SELECT max(COALESCE(v.updated_at,d.created_at)) FROM knowledge_documents d JOIN knowledge_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.library_id=k.id AND NOT d.deleted),k.created_at) AS updated_at,
        (SELECT count(*)::int FROM knowledge_documents d JOIN knowledge_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.library_id=k.id AND NOT d.deleted AND v.state IN ('queued','running')) AS processing_count,
        (SELECT count(*)::int FROM knowledge_documents d JOIN knowledge_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.library_id=k.id AND NOT d.deleted AND v.state='failed') AS failed_count
      FROM knowledge_libraries k JOIN users owner ON owner.id=k.owner_id AND owner.enabled AND owner.deleted_at IS NULL
      LEFT JOIN knowledge_grants g ON g.library_id=k.id AND g.user_id=$1
      WHERE k.tenant_id=$2 AND NOT k.deleted AND (k.owner_id=$1 OR g.user_id IS NOT NULL OR (k.kind='public' AND $3))
    ), filtered AS (SELECT * FROM accessible WHERE ($4='all' OR kind=$4) AND ($5='' OR strpos(lower(name || ' ' || description),lower($5))>0))
    SELECT (SELECT count(*)::int FROM filtered) AS total,
      (SELECT json_build_object('all',count(*),'personal',count(*) FILTER(WHERE kind='personal'),'public',count(*) FILTER(WHERE kind='public')) FROM accessible) AS summary,
      COALESCE((SELECT json_agg(r) FROM (SELECT * FROM filtered ORDER BY ${options.sort === "name" ? "name,id" : "updated_at DESC,id"} LIMIT 20 OFFSET $6) r),'[]'::json) AS rows`,
      [
        user.id,
        user.tenantId,
        user.role === "platform_admin" || user.knowledgeAdmin === true,
        kind,
        q,
        (page - 1) * 20,
      ],
    );
    return { ...result.rows[0], page };
  }
  async create(user, input) {
    const name = String(input.name || "").trim();
    if (!name || name.length > 120) fail(400, "库名称须为 1～120 字");
    const kind = input.kind === "public" ? "public" : "personal";
    if (
      kind === "public" &&
      user.role !== "platform_admin" &&
      !user.knowledgeAdmin
    )
      fail(403, "公共库由知识管理员或平台管理员创建");
    const id = randomUUID();
    await this.pool.query(
      "INSERT INTO knowledge_libraries(id,tenant_id,owner_id,name,kind,description) VALUES($1,$2,$3,$4,$5,$6)",
      [
        id,
        user.tenantId,
        user.id,
        name,
        kind,
        this.description(input.description),
      ],
    );
    return { id };
  }
  description(value) {
    const text = String(value || "").trim();
    if (text.length > 500) fail(400, "知识库描述最多 500 字");
    return text;
  }
  async updateLibrary(user, id, input) {
    await this.library(user, id, true);
    const name = String(input.name || "").trim();
    if (!name || name.length > 120) fail(400, "库名称须为 1～120 字");
    await this.tx(async (c) => {
      await c.query(
        "UPDATE knowledge_libraries SET name=$2,description=$3 WHERE id=$1",
        [id, name, this.description(input.description)],
      );
      await this.audit(c, user.id, "library_update", id, id);
    });
    return { ok: true };
  }
  async grant(user, lib, input) {
    await this.library(user, lib, true);
    const k = await this.library(user, lib);
    if (k.kind !== "public") fail(400, "个人库仅通过空间确认共享");
    const target = (
      await this.pool.query(
        "SELECT id FROM users WHERE id=$1 AND tenant_id=$2 AND enabled AND deleted_at IS NULL",
        [uuid(input.userId) ? input.userId : null, user.tenantId],
      )
    ).rows[0];
    if (!target) fail(400, "请选择同租户有效用户");
    await this.tx(async (c) => {
      if (input.remove)
        await c.query(
          "DELETE FROM knowledge_grants WHERE library_id=$1 AND user_id=$2",
          [lib, target.id],
        );
      else
        await c.query(
          "INSERT INTO knowledge_grants VALUES($1,$2,$3) ON CONFLICT(library_id,user_id) DO UPDATE SET maintain=$3",
          [lib, target.id, input.maintain === true],
        );
      await this.audit(
        c,
        user.id,
        input.remove ? "grant_revoke" : "grant_set",
        lib,
        target.id,
      );
    });
  }
  async bindingSpaces(user, lib) {
    const k = await this.library(user, lib, true);
    const rows = (
      await this.pool.query(
        `SELECT i.id,i.name,(i.deleted_at IS NOT NULL) AS "isDeleted",m.access_role AS "accessRole",
      (i.deleted_at IS NULL AND ($3 OR m.access_role IN ('owner','operator'))) IS TRUE AS "canConfigure",
      (b.library_id IS NOT NULL) AS bound,b.epoch,b.created_at AS "boundAt",COALESCE(e.epoch,0) AS "currentEpoch",
      (SELECT count(*)::int FROM instance_members im JOIN users u ON u.id=im.user_id WHERE im.instance_id=i.id AND u.deleted_at IS NULL) AS "memberCount"
      FROM instances i LEFT JOIN instance_members m ON m.instance_id=i.id AND m.user_id=$1
      LEFT JOIN knowledge_bindings b ON b.space_id=i.id AND b.library_id=$4
      LEFT JOIN knowledge_space_epochs e ON e.space_id=i.id
      WHERE i.tenant_id=$2 AND ((i.deleted_at IS NULL AND ($3 OR m.user_id IS NOT NULL)) OR b.library_id IS NOT NULL) ORDER BY i.name,i.id`,
        [user.id, user.tenantId, user.role === "platform_admin", lib],
      )
    ).rows;
    for (const r of rows) {
      r.needsConfirmation =
        r.bound &&
        !r.isDeleted &&
        k.kind === "personal" &&
        String(r.epoch) !== String(r.currentEpoch);
      r.bindingReason = !r.bound
        ? ""
        : r.isDeleted
          ? "空间已删除"
          : r.needsConfirmation
            ? "空间新增成员，需要所有者重新确认"
            : k.kind === "public" && !(await this.publicAllowed(k, r.id))
              ? "空间存在未授权成员"
              : "";
      r.canUnbind = r.bound && (k.kind === "public" || k.owner_id === user.id);
    }
    return rows;
  }
  async bindingScope(user, lib, space) {
    const k = await this.library(user, lib, true),
      s = await this.scope(user, space);
    const grants = new Set(
      (
        await this.pool.query(
          "SELECT user_id FROM knowledge_grants WHERE library_id=$1",
          [lib],
        )
      ).rows.map((x) => x.user_id),
    );
    return {
      ...s,
      members: s.members.map((m) => ({
        ...m,
        canRead:
          k.kind === "personal" ||
          (m.tenant_id === k.tenant_id &&
            (m.id === k.owner_id ||
              m.platform_role === "platform_admin" ||
              m.knowledge_admin ||
              grants.has(m.id))),
      })),
    };
  }
  async scope(user, space, c = this.pool) {
    if (!uuid(space)) fail(400, "空间无效");
    const r = (
      await c.query(
        `SELECT i.* FROM instances i WHERE i.id=$1 AND i.tenant_id=$2 AND i.deleted_at IS NULL AND ($3 OR EXISTS(SELECT 1 FROM instance_members m WHERE m.instance_id=i.id AND m.user_id=$4 AND m.access_role IN ('owner','operator')))`,
        [space, user.tenantId, user.role === "platform_admin", user.id],
      )
    ).rows[0];
    if (!r) fail(403, "无空间配置权限");
    const members = (
      await c.query(
        `SELECT u.id,u.username,u.display_name,u.tenant_id,u.enabled,u.role AS platform_role,u.knowledge_admin,m.access_role FROM instance_members m JOIN users u ON u.id=m.user_id WHERE m.instance_id=$1 AND u.deleted_at IS NULL ORDER BY CASE m.access_role WHEN 'owner' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,u.id`,
        [space],
      )
    ).rows;
    const epoch = String(
      (
        await c.query(
          "SELECT epoch FROM knowledge_space_epochs WHERE space_id=$1",
          [space],
        )
      ).rows[0]?.epoch || 0,
    );
    return {
      space: r.id,
      name: r.name,
      members,
      epoch,
      notice:
        "空间成员及平台管理员代入访问时可能接触回答中的知识；已生成的历史回答和工作副本不能通过撤权收回。验证版不支持访客或分享链接授权。",
    };
  }
  async bind(user, lib, input) {
    const k = await this.library(user, lib, true);
    if (k.kind === "personal" && k.owner_id !== user.id)
      fail(403, "个人库须由所有者确认");
    if (!uuid(input.spaceId)) fail(400, "空间无效");
    return this.tx(async (c) => {
      await c.query("SELECT id FROM instances WHERE id=$1 FOR UPDATE", [
        uuid(input.spaceId) ? input.spaceId : null,
      ]);
      if (input.remove) {
        const target = (
          await c.query(
            "SELECT id FROM instances WHERE id=$1 AND tenant_id=$2",
            [input.spaceId, user.tenantId],
          )
        ).rows[0];
        if (!target) fail(404, "空间不存在");
        const removed = await c.query(
          "DELETE FROM knowledge_bindings WHERE library_id=$1 AND space_id=$2",
          [lib, target.id],
        );
        if (removed.rowCount)
          await this.audit(c, user.id, "space_unbind", lib, target.id);
        return { space: target.id, removed: removed.rowCount > 0 };
      }
      const s = await this.scope(user, input.spaceId, c);
      if (input.confirm !== true || String(input.epoch) !== s.epoch)
        fail(409, "成员范围已变化，请刷新并重新确认");
      if (k.kind === "public" && !(await this.publicAllowed(k, s.space, c)))
        fail(403, "公共库尚未授权空间全部成员");
      const existing = (
        await c.query(
          "SELECT epoch FROM knowledge_bindings WHERE library_id=$1 AND space_id=$2",
          [lib, s.space],
        )
      ).rows[0];
      if (
        existing &&
        (k.kind === "public" || String(existing.epoch) === s.epoch)
      )
        return { ...s, alreadyBound: true };
      await c.query(
        "INSERT INTO knowledge_bindings VALUES($1,$2,$3,$4) ON CONFLICT(library_id,space_id) DO UPDATE SET confirmed_by=$3,epoch=$4,created_at=now()",
        [lib, s.space, user.id, s.epoch],
      );
      await this.audit(c, user.id, "space_bind", lib, JSON.stringify(s));
      return s;
    });
  }
  async publicAllowed(k, space, c = this.pool) {
    return !(
      await c.query(
        `SELECT 1 FROM instance_members m JOIN users u ON u.id=m.user_id WHERE m.instance_id=$1 AND u.deleted_at IS NULL AND (u.tenant_id<>$2 OR (u.id<>$3 AND NOT u.knowledge_admin AND u.role<>'platform_admin' AND NOT EXISTS(SELECT 1 FROM knowledge_grants g WHERE g.library_id=$4 AND g.user_id=u.id))) LIMIT 1`,
        [space, k.tenant_id, k.owner_id, k.id],
      )
    ).rowCount;
  }
  async spaceLibraries(space) {
    const rows = (
      await this.pool.query(
        `SELECT k.*,b.epoch,COALESCE(e.epoch,0) AS current_epoch FROM knowledge_bindings b JOIN knowledge_libraries k ON k.id=b.library_id JOIN instances i ON i.id=b.space_id JOIN users u ON u.id=k.owner_id LEFT JOIN knowledge_space_epochs e ON e.space_id=i.id WHERE b.space_id=$1 AND i.deleted_at IS NULL AND NOT k.deleted AND k.tenant_id=i.tenant_id AND u.enabled AND u.deleted_at IS NULL`,
        [space],
      )
    ).rows;
    for (const k of rows)
      k.reason =
        k.kind === "personal" && String(k.epoch) !== String(k.current_epoch)
          ? "空间新增成员，需要所有者重新确认"
          : k.kind === "public" && !(await this.publicAllowed(k, space))
            ? "空间存在未授权成员"
            : "";
    return rows;
  }
  async detail(user, lib) {
    const k = await this.library(user, lib);
    let documents = (
      await this.pool.query(
        `SELECT d.*,v.state,v.error,v.draft,v.quotes,v.edit_revision,v.filename,v.processing_options,v.summary,v.keywords,v.phase,v.stage,v.sha256,v.byte_size,v.updated_at,(SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id=d.id AND c.version=d.published_version) AS chunk_count,v.model_info FROM knowledge_documents d JOIN knowledge_versions v ON v.document_id=d.id AND v.version=d.current_version WHERE d.library_id=$1 AND NOT d.deleted ORDER BY d.created_at DESC LIMIT 100`,
        [lib],
      )
    ).rows;
    if (!k.maintain)
      documents = (
        await this.pool.query(
          `SELECT d.id,d.title,d.published_version AS current_version,v.draft,v.quotes,v.state,v.filename,v.processing_options,v.summary,v.keywords,v.phase,v.stage,v.sha256,v.byte_size,v.updated_at,(SELECT count(*)::int FROM knowledge_chunks c WHERE c.document_id=d.id AND c.version=d.published_version) AS chunk_count,v.model_info FROM knowledge_documents d JOIN knowledge_versions v ON v.document_id=d.id AND v.version=d.published_version WHERE d.library_id=$1 AND NOT d.deleted ORDER BY d.created_at DESC LIMIT 100`,
          [lib],
        )
      ).rows;
    return {
      library: k,
      documents,
      grants: k.maintain
        ? (
            await this.pool.query(
              "SELECT user_id,maintain FROM knowledge_grants WHERE library_id=$1",
              [lib],
            )
          ).rows
        : [],
      bindings: k.maintain
        ? (await this.bindingSpaces(user, lib)).filter((s) => s.bound)
        : [],
    };
  }
  async upload(
    user,
    lib,
    filename,
    bytes,
    documentId,
    inputOptions = {},
    requestId,
  ) {
    await this.library(user, lib, true);
    if (
      !filename ||
      filename.length > 120 ||
      /[\/\\\x00-\x1f]/.test(filename) ||
      bytes.length > 10 * 1024 * 1024 ||
      !bytes.length
    )
      fail(400, "文件名无效或文件超过 10MB");
    if (!/\.(docx|xlsx|pdf|txt|md)$/i.test(filename))
      fail(400, "验证版支持 DOCX、XLSX、文本 PDF、TXT、Markdown");
    let options;
    try {
      options = processingOptions(inputOptions);
    } catch (error) {
      fail(400, error.message);
    }
    if (requestId !== undefined && !uuid(requestId)) fail(400, "上传标识无效");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([filename, sha, documentId || null, options]))
      .digest("hex");
    const previous = async (c) => {
      if (!requestId) return null;
      const row = (
        await c.query(
          "SELECT r.*,d.deleted FROM knowledge_upload_requests r JOIN knowledge_documents d ON d.id=r.document_id WHERE r.id=$1",
          [requestId],
        )
      ).rows[0];
      if (!row) return null;
      if (
        row.actor !== user.id ||
        row.library_id !== lib ||
        row.fingerprint !== fingerprint
      )
        fail(409, "上传标识已用于其他内容，请重新选择文件");
      if (row.deleted) fail(409, "原上传记录已删除，请重新选择文件");
      return { id: row.document_id, version: row.version, reused: true };
    };
    const found = await previous(this.pool);
    if (found) return found;
    const key = randomUUID();
    await mkdir(this.root, { recursive: true });
    await writeFile(join(this.root, key), bytes, { flag: "wx", mode: 0o600 });
    try {
      const result = await this.tx(async (c) => {
        if (requestId)
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [requestId],
          );
        await c.query(
          "SELECT id FROM knowledge_libraries WHERE id=$1 FOR UPDATE",
          [lib],
        );
        await this.library(user, lib, true, c);
        const reused = await previous(c);
        if (reused) return reused;
        if (
          !documentId &&
          Number(
            (
              await c.query(
                "SELECT count(*) FROM knowledge_documents WHERE library_id=$1 AND NOT deleted",
                [lib],
              )
            ).rows[0].count,
          ) >= 100
        )
          fail(413, "验证版每个库最多 100 篇资料");
        let id = documentId || randomUUID(),
          version = 1;
        if (documentId) {
          const old = (
            await c.query(
              "SELECT * FROM knowledge_documents WHERE id=$1 AND library_id=$2 AND NOT deleted FOR UPDATE",
              [uuid(id) ? id : null, lib],
            )
          ).rows[0];
          if (!old) fail(404, "文档不存在");
          version = old.current_version + 1;
          await c.query(
            "UPDATE knowledge_versions SET state='superseded',lease=NULL WHERE document_id=$1 AND state IN ('queued','running','review','failed')",
            [id],
          );
          await c.query(
            "UPDATE knowledge_documents SET current_version=$2 WHERE id=$1",
            [id, version],
          );
        } else
          await c.query(
            "INSERT INTO knowledge_documents(id,library_id,title) VALUES($1,$2,$3)",
            [id, lib, filename],
          );
        await c.query(
          "INSERT INTO knowledge_versions(document_id,version,filename,file_key,sha256,byte_size,processing_options,phase) VALUES($1,$2,$3,$4,$5,$6,$7,'queued')",
          [
            id,
            version,
            filename,
            key,
            createHash("sha256").update(bytes).digest("hex"),
            bytes.length,
            JSON.stringify(options),
          ],
        );
        if (requestId)
          await c.query(
            "INSERT INTO knowledge_upload_requests(id,actor,library_id,document_id,version,fingerprint) VALUES($1,$2,$3,$4,$5,$6)",
            [requestId, user.id, lib, id, version, fingerprint],
          );
        await this.audit(c, user.id, "document_upload", lib, id);
        return { id, version };
      });
      if (result.reused) await rm(join(this.root, key), { force: true });
      return result;
    } catch (e) {
      await rm(join(this.root, key), { force: true });
      throw e;
    }
  }
  async modelStatus(user, lib, probe = false) {
    await this.library(user, lib, true);
    return this.models.status(await this.settings(), probe);
  }
  async settings() {
    const config =
      (await this.pool.query("SELECT value FROM knowledge_settings WHERE id=1"))
        .rows[0]?.value || {};
    return { ...config, ...generationPolicy(config) };
  }
  async saveSettings(user, input) {
    if (user.role !== "platform_admin") fail(403, "仅平台管理员可配置");
    for (const k of ["chatProvider", "embeddingProvider"])
      if (!uuid(input[k])) fail(400, "请选择模型提供方");
    for (const k of ["chatModel", "embeddingModel"])
      if (
        typeof input[k] !== "string" ||
        !input[k].trim() ||
        input[k].length > 200
      )
        fail(400, "模型名称无效");
    for (const kind of ["chat", "embedding"]) {
      const provider = (
        await this.pool.query(
          "SELECT enabled,config FROM model_providers WHERE id=$1",
          [input[`${kind}Provider`]],
        )
      ).rows[0];
      if (
        !provider?.enabled ||
        provider.config?.api !== "openai-completions" ||
        !provider.config.models?.some(
          (model) => model.id === input[`${kind}Model`],
        )
      )
        fail(400, "请选择模型管理中已启用的 OpenAI 兼容模型");
    }
    let policy;
    try {
      policy = generationPolicy(input);
    } catch (error) {
      fail(400, error.message);
    }
    const config = {
      ...Object.fromEntries(
        [
          "chatProvider",
          "embeddingProvider",
          "chatModel",
          "embeddingModel",
        ].map((k) => [k, input[k]]),
      ),
      ...policy,
    };
    await this.tx(async (c) => {
      await c.query(
        "INSERT INTO knowledge_settings VALUES(1,$1) ON CONFLICT(id) DO UPDATE SET value=$1",
        [config],
      );
      await this.audit(
        c,
        user.id,
        "settings_update",
        null,
        JSON.stringify(config),
      );
    });
    return config;
  }
  async edit(user, lib, id, input) {
    await this.library(user, lib, true);
    if (
      typeof input.content !== "string" ||
      !input.content.trim() ||
      input.content.length > 30000
    )
      fail(400, "Wiki 内容须为 1～30000 字");
    let metadata = null;
    if (input.summary !== undefined || input.keywords !== undefined) {
      try {
        metadata = metadataFields(input.summary, input.keywords);
      } catch (error) {
        fail(400, error.message);
      }
    }
    const r = await this.pool.query(
      `UPDATE knowledge_versions v SET draft=$4,summary=CASE WHEN $6::jsonb IS NULL THEN v.summary ELSE $6::jsonb->>'summary' END,keywords=CASE WHEN $6::jsonb IS NULL THEN v.keywords ELSE $6::jsonb->'keywords' END,edit_revision=edit_revision+1 FROM knowledge_documents d WHERE d.id=v.document_id AND d.id=$1 AND d.library_id=$2 AND NOT d.deleted AND d.current_version=v.version AND v.version=$3 AND v.edit_revision=$5 AND v.state='review' RETURNING v.edit_revision`,
      [
        id,
        lib,
        input.version,
        input.content,
        input.editRevision,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    if (!r.rowCount) fail(409, "草稿或原文已变化，请刷新");
    return r.rows[0];
  }
  async queue(user, lib, id, input) {
    await this.library(user, lib, true);
    const r = await this.pool.query(
      `UPDATE knowledge_versions v SET state='queued',phase='queued',stage=CASE WHEN $3 THEN 'publish' ELSE v.stage END,error=NULL,lease=NULL FROM knowledge_documents d WHERE d.id=v.document_id AND d.id=$1 AND d.library_id=$2 AND NOT d.deleted AND d.current_version=v.version AND (($3 AND v.state='review' AND v.edit_revision=$4) OR (NOT $3 AND v.state='failed')) RETURNING v.version`,
      [id, lib, input.publish === true, input.editRevision ?? -1],
    );
    if (!r.rowCount) fail(409, "状态已变化，无法处理");
    await this.audit(
      this.pool,
      user.id,
      input.publish ? "publish_requested" : "retry",
      lib,
      id,
    );
  }
  async remove(user, lib, id) {
    await this.library(user, lib, true);
    await this.tx(async (c) => {
      if (id)
        await c.query(
          "UPDATE knowledge_documents SET deleted=true,published_version=NULL WHERE id=$1 AND library_id=$2",
          [id, lib],
        );
      else {
        await c.query(
          "UPDATE knowledge_libraries SET deleted=true WHERE id=$1",
          [lib],
        );
        await c.query("DELETE FROM knowledge_bindings WHERE library_id=$1", [
          lib,
        ]);
      }
      await this.audit(c, user.id, "delete", lib, id || lib);
    });
  }
  async source(scope, lib, id, version, { readBytes = true } = {}) {
    if (!Number.isInteger(version) || version < 1) fail(400, "原文版本无效");
    let readDraft = false;
    if (scope.user) readDraft = (await this.library(scope.user, lib)).maintain;
    else if (
      !(await this.spaceLibraries(scope.space)).some(
        (k) => k.id === lib && !k.reason,
      )
    )
      fail(403, "知识授权已失效");
    const row = (
      await this.pool.query(
        `SELECT v.*,d.title FROM knowledge_versions v JOIN knowledge_documents d ON d.id=v.document_id WHERE d.id=$1 AND d.library_id=$2 AND v.version=$3 AND NOT d.deleted AND ($4::boolean OR v.state='published')`,
        [id, lib, version, readDraft],
      )
    ).rows[0];
    if (!row) fail(404, "来源不存在");
    await this.audit(
      this.pool,
      scope.user?.id || scope.space,
      "source_read",
      lib,
      `${id}/${version}`,
    );
    return {
      row,
      ...(readBytes
        ? { bytes: await readFile(join(this.root, row.file_key)) }
        : {}),
    };
  }
  async search(scope, query, lib) {
    if (typeof query !== "string" || !query.trim() || query.length > 500)
      fail(400, "请输入 1～500 字检索内容");
    let libs;
    if (scope.user) {
      if (!uuid(lib)) fail(400, "请选择知识库");
      await this.library(scope.user, lib);
      libs = [lib];
    } else
      libs = (await this.spaceLibraries(scope.space))
        .filter((k) => !k.reason && (!lib || lib === k.id))
        .map((k) => k.id);
    if (!libs.length) return { results: [], message: "当前空间无可用知识库" };
    const cfg = await this.settings(),
      key = `${cfg.embeddingProvider}/${cfg.embeddingModel}`;
    const q = vector(await this.models.embed(cfg, query));
    let results;
    try {
      results = await this.tx((c) => vectorSearch(c, libs, key, q));
    } catch (error) {
      if (error.code === "KNOWLEDGE_DIMENSIONS") fail(409, error.message);
      if (error.code === "57014")
        fail(
          503,
          "知识检索超时，请缩小范围重试，或联系管理员检查索引与数据库负载",
        );
      throw error;
    }
    if (scope.user) await this.library(scope.user, lib);
    else {
      const allowed = new Set(
        (await this.spaceLibraries(scope.space))
          .filter((k) => !k.reason)
          .map((k) => k.id),
      );
      results = results.filter((r) => allowed.has(r.library_id));
    }
    await this.audit(
      this.pool,
      scope.user?.id || scope.space,
      "search",
      lib || null,
      String(results.length),
    );
    return { results };
  }
  async tick() {
    if (this.busy || !this.models) return;
    this.busy = true;
    try {
      const job = await this.tx(async (c) => {
        const r = (
          await c.query(
            `SELECT v.*,d.library_id FROM knowledge_versions v JOIN knowledge_documents d ON d.id=v.document_id JOIN knowledge_libraries k ON k.id=d.library_id WHERE NOT d.deleted AND NOT k.deleted AND d.current_version=v.version AND (v.state='queued' OR (v.state='running' AND v.locked_at<now()-interval '10 minutes')) ORDER BY d.created_at FOR UPDATE OF v SKIP LOCKED LIMIT 1`,
          )
        ).rows[0];
        if (!r) return;
        const lease = randomUUID();
        await c.query(
          "UPDATE knowledge_versions SET state='running',lease=$3,locked_at=now() WHERE document_id=$1 AND version=$2",
          [r.document_id, r.version, lease],
        );
        return { ...r, lease };
      });
      if (!job) return;
      const heartbeat = setInterval(() => {
        void this.pool
          .query(
            "UPDATE knowledge_versions SET locked_at=now() WHERE document_id=$1 AND version=$2 AND lease=$3 AND state='running'",
            [job.document_id, job.version, job.lease],
          )
          .catch(() => {});
      }, 20000);
      heartbeat.unref();
      let draftDiagnostics = job.model_info?.draftDiagnostics || null;
      try {
        const cfg = await this.settings();
        const options = savedOptions(job.processing_options);
        const progress = async (phase) =>
          this.pool.query(
            "UPDATE knowledge_versions SET phase=$4 WHERE document_id=$1 AND version=$2 AND lease=$3 AND state='running'",
            [job.document_id, job.version, job.lease, phase],
          );
        let summary = job.summary,
          keywords = job.keywords || [],
          publishParts = [];
        let source = job.source,
          draft = job.draft,
          quotes = job.quotes,
          embeddings = [];
        if (job.stage === "parse") {
          await progress("parsing");
          const { parseFileIsolated } = await import(
            "./knowledge-isolated.mjs"
          );
          const parsed = await parseFileIsolated(
            job.filename,
            await readFile(join(this.root, job.file_key)),
          );
          source = parsed.content;
          await progress("drafting");
          const out = await this.models.draft(
            cfg,
            options.cleanText ? cleanContent(source) : source,
            options,
          );
          draftDiagnostics = out._diagnostics || null;
          draft = out.content;
          quotes = out.quotes;
          if (
            typeof draft !== "string" ||
            !draft.trim() ||
            draft.length > 30000 ||
            !Array.isArray(quotes) ||
            !quotes.length ||
            quotes.length > 5 ||
            quotes.some(
              (q) =>
                typeof q !== "string" ||
                !q ||
                q.length > 200 ||
                !source.includes(q),
            )
          )
            fail(502, "模型草稿或来源引用校验失败");
          if (options.generateMetadata) {
            try {
              const m = metadataFields(out.summary, out.keywords);
              summary = m.summary;
              keywords = m.keywords;
            } catch {
              fail(502, "模型摘要或关键词格式校验失败，请重试");
            }
          } else {
            summary = null;
            keywords = [];
          }
        } else {
          await progress("indexing");
          publishParts = chunks(draft, options);
          for (const part of publishParts)
            embeddings.push(vector(await this.models.embed(cfg, part)));
          if (embeddings.some((v) => v.length !== embeddings[0].length))
            fail(502, "索引向量维度不一致");
        }
        await this.tx(async (c) => {
          const active = (
            await c.query(
              `SELECT v.document_id FROM knowledge_versions v JOIN knowledge_documents d ON d.id=v.document_id JOIN knowledge_libraries k ON k.id=d.library_id WHERE v.document_id=$1 AND v.version=$2 AND v.lease=$3 AND v.state='running' AND d.current_version=v.version AND NOT d.deleted AND NOT k.deleted FOR UPDATE OF v,d`,
              [job.document_id, job.version, job.lease],
            )
          ).rowCount;
          if (!active) return;
          if (job.stage === "publish") {
            await ensureVectorIndex(c, embeddings[0].length);
            await c.query(
              "DELETE FROM knowledge_chunks WHERE document_id=$1 AND version=$2",
              [job.document_id, job.version],
            );
            const parts = publishParts;
            for (let i = 0; i < parts.length; i++)
              await c.query(
                "INSERT INTO knowledge_chunks(document_id,version,position,content,embedding,model_key) VALUES($1,$2,$3,$4,$5,$6)",
                [
                  job.document_id,
                  job.version,
                  i,
                  parts[i],
                  JSON.stringify(embeddings[i]),
                  `${cfg.embeddingProvider}/${cfg.embeddingModel}`,
                ],
              );
            await c.query(
              "UPDATE knowledge_documents SET published_version=$2 WHERE id=$1",
              [job.document_id, job.version],
            );
          }
          await c.query(
            "UPDATE knowledge_versions SET source=$4,draft=$5,quotes=$6,state=$7,phase=$7,error=NULL,model_info=$8,summary=$9,keywords=$10 WHERE document_id=$1 AND version=$2 AND lease=$3",
            [
              job.document_id,
              job.version,
              job.lease,
              source,
              draft,
              JSON.stringify(quotes),
              job.stage === "publish" ? "published" : "review",
              JSON.stringify({
                ...cfg,
                ruleVersion: 2,
                draftDiagnostics,
                processingOptions: options,
                embeddingDimensions: embeddings[0]?.length || null,
              }),
              summary,
              JSON.stringify(keywords),
            ],
          );
        });
      } catch (e) {
        await this.pool.query(
          "UPDATE knowledge_versions SET state='failed',error=$4,model_info=COALESCE(model_info,'{}'::jsonb)||jsonb_build_object('draftDiagnostics',$5::jsonb) WHERE document_id=$1 AND version=$2 AND lease=$3",
          [
            job.document_id,
            job.version,
            job.lease,
            e instanceof KnowledgeError
              ? e.message
              : "处理失败，请检查模型配置、格式及服务连接后重试",
            e.diagnostics || draftDiagnostics
              ? JSON.stringify(e.diagnostics || draftDiagnostics)
              : null,
          ],
        );
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.busy = false;
    }
  }
}
