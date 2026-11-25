import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { once } from "node:events";
import pg from "pg";
import { Knowledge } from "../knowledge.mjs";
import { knowledgeModels } from "../knowledge-models.mjs";
import { knowledgeTool } from "../knowledge-http.mjs";
test(
  "knowledge import, review, publication, multi-library scope and revocation",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30000 },
  async () => {
    const admin = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
      schema = "kb_" + randomUUID().replaceAll("-", ""),
      root = await mkdtemp(join(tmpdir(), "knowledge-"));
    let pool, model;
    try {
      await admin.query(
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
      );
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
        options: `-c search_path=${schema}`,
      });
      await pool.query(
        `CREATE TABLE tenants(id uuid PRIMARY KEY);CREATE TABLE users(id uuid PRIMARY KEY,tenant_id uuid,username text,display_name text,role text NOT NULL DEFAULT 'member',knowledge_admin boolean NOT NULL DEFAULT false,enabled boolean DEFAULT true,deleted_at timestamptz);CREATE TABLE instances(id uuid PRIMARY KEY,tenant_id uuid,name text,deleted_at timestamptz);CREATE TABLE instance_members(instance_id uuid REFERENCES instances(id),user_id uuid REFERENCES users(id),access_role text,PRIMARY KEY(instance_id,user_id))`,
      );
      const tenant = randomUUID(),
        other = randomUUID(),
        a = { id: randomUUID(), tenantId: tenant, role: "platform_admin" },
        b = { id: randomUUID(), tenantId: tenant, role: "member" },
        c = { id: randomUUID(), tenantId: other, role: "member" },
        manager = {
          id: randomUUID(),
          tenantId: tenant,
          role: "member",
          knowledgeAdmin: true,
        },
        space = randomUUID();
      await pool.query("INSERT INTO tenants VALUES($1),($2)", [tenant, other]);
      for (const u of [a, b, c, manager])
        await pool.query(
          "INSERT INTO users(id,tenant_id,username,display_name) VALUES($1,$2,$3,$3)",
          [u.id, u.tenantId, u.id],
        );
      await pool.query("INSERT INTO instances VALUES($1,$2,$3,NULL)", [
        space,
        tenant,
        "测试空间",
      ]);
      await pool.query("INSERT INTO instance_members VALUES($1,$2,'owner')", [
        space,
        a.id,
      ]);
      const k = new Knowledge(pool, { root });
      await k.init();
      await k.init();
      const personal = (await k.create(a, { name: "个人运维库" })).id,
        pub = (await k.create(a, { name: "公共运维库", kind: "public" })).id;
      await assert.rejects(k.detail(b, personal));
      await assert.rejects(k.detail(c, personal));
      await assert.rejects(k.create(b, { name: "越权公共", kind: "public" }));
      await assert.rejects(k.detail(manager, personal));
      await assert.rejects(k.detail({ ...c, knowledgeAdmin: true }, pub));
      assert.equal((await k.detail(manager, pub)).library.maintain, true);
      await assert.rejects(
        k.bind(manager, pub, { spaceId: space, confirm: true, epoch: "0" }),
        /空间配置权限/,
      );
      const managed = (
        await k.create(manager, {
          name: "知识管理员公共库",
          kind: "public",
          description: "用于演练",
        })
      ).id;
      await k.updateLibrary(manager, managed, {
        name: "知识管理员公共库",
        description: "用于权限验证",
      });
      const listed = await k.list(manager, 1, {
        q: "权限验证",
        kind: "public",
      });
      assert.equal(listed.total, 1);
      assert.equal(listed.rows[0].description, "用于权限验证");
      assert.equal(listed.summary.public, 2);
      assert.equal(listed.summary.personal, 0);
      await assert.rejects(
        k.detail({ ...manager, knowledgeAdmin: false }, pub),
      );
      await k.remove(manager, managed);
      const roleSpace = randomUUID();
      await pool.query("INSERT INTO instances VALUES($1,$2,$3,NULL)", [
        roleSpace,
        tenant,
        "知识管理员空间",
      ]);
      await pool.query("INSERT INTO instance_members VALUES($1,$2,'owner')", [
        roleSpace,
        b.id,
      ]);
      const publicLibrary = await k.library(a, pub);
      assert.equal(await k.publicAllowed(publicLibrary, roleSpace), false);
      await pool.query("UPDATE users SET knowledge_admin=true WHERE id=$1", [
        b.id,
      ]);
      assert.equal(await k.publicAllowed(publicLibrary, roleSpace), true);
      await pool.query("UPDATE users SET knowledge_admin=false WHERE id=$1", [
        b.id,
      ]);
      assert.equal(await k.publicAllowed(publicLibrary, roleSpace), false);

      await k.grant(a, pub, { userId: b.id });
      await k.detail(b, pub);
      await assert.rejects(k.grant(a, pub, { userId: c.id }));
      await assert.rejects(k.upload(b, pub, "x.txt", Buffer.from("内容")));
      model = http.createServer(async (req, res) => {
        let raw = "";
        for await (const x of req) raw += x;
        const body = JSON.parse(raw);
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            req.url === "/embeddings"
              ? {
                  data: [
                    {
                      embedding: body.input.includes("磁盘") ? [1, 0] : [0, 1],
                    },
                  ],
                }
              : {
                  choices: [
                    {
                      message: {
                        content: JSON.stringify({
                          content: "磁盘告警：检查磁盘空间，清理日志。",
                          summary: "磁盘空间异常的检查与处理",
                          keywords: ["磁盘", "日志"],
                          quotes: ["检查磁盘空间"],
                        }),
                      },
                    },
                  ],
                },
          ),
        );
      });
      model.listen(0, "127.0.0.1");
      await once(model, "listening");
      const provider = randomUUID();
      const registered = {
        api: "openai-completions",
        models: [{ id: "synthetic-chat" }, { id: "synthetic-embedding" }],
      };
      await pool.query(
        "CREATE TABLE model_providers(id uuid PRIMARY KEY,enabled boolean,config jsonb)",
      );
      await pool.query("INSERT INTO model_providers VALUES($1,true,$2)", [
        provider,
        registered,
      ]);
      k.models = knowledgeModels(async () => ({
        enabled: true,
        config: {
          api: "openai-completions",
          baseURL: `http://127.0.0.1:${model.address().port}`,
          models: registered.models,
        },
        apiKey: "synthetic-test-key",
      }));
      await k.saveSettings(a, {
        chatProvider: provider,
        embeddingProvider: provider,
        chatModel: "synthetic-chat",
        embeddingModel: "synthetic-embedding",
      });
      await assert.rejects(
        k.saveSettings(manager, await k.settings()),
        /平台管理员/,
      );
      let settings = await k.settings();
      assert.equal(settings.draftMaxTokens, 16000);
      await assert.rejects(
        k.saveSettings(a, {
          ...settings,
          draftMaxTokens: 32000,
          draftRetryMaxTokens: 16000,
        }),
        /重试预算/,
      );
      await k.saveSettings(a, {
        ...settings,
        draftMaxTokens: 12000,
        draftRetryMaxTokens: 24000,
      });
      settings = await k.settings();
      assert.equal(settings.draftMaxTokens, 12000);
      assert.equal(settings.draftRetryMaxTokens, 24000);
      await assert.rejects(
        k.saveSettings(a, { ...settings, chatModel: "not-registered" }),
        /模型管理/,
      );
      await pool.query("UPDATE model_providers SET enabled=false WHERE id=$1", [
        provider,
      ]);
      await assert.rejects(k.saveSettings(a, settings), /模型管理/);
      await pool.query("UPDATE model_providers SET enabled=true WHERE id=$1", [
        provider,
      ]);
      assert.equal((await k.modelStatus(a, personal)).chat.state, "configured");
      const readiness = await k.modelStatus(a, personal, true);
      assert.equal(readiness.chat.state, "available");
      assert.equal(readiness.embedding.dimensions, 2);
      await assert.rejects(k.modelStatus(b, pub, true), /权限/);
      const uploadId = randomUUID(),
        uploadOptions = {
          strategy: "fixed",
          chunkSize: 400,
          overlap: 40,
          cleanText: true,
          generateMetadata: true,
        };
      const beforeFiles = (await readdir(root)).length;
      const requests = await Promise.all(
        [1, 2].map(() =>
          k.upload(
            a,
            personal,
            "操作手册.md",
            Buffer.from("出现磁盘告警时，检查磁盘空间，清理日志。"),
            undefined,
            uploadOptions,
            uploadId,
          ),
        ),
      );
      const doc = requests[0];
      assert.equal(doc.id, requests[1].id);
      assert.equal(doc.version, requests[1].version);
      assert.equal((await readdir(root)).length, beforeFiles + 1);
      await assert.rejects(
        k.upload(
          a,
          personal,
          "操作手册.md",
          Buffer.from("不同的内容"),
          undefined,
          uploadOptions,
          uploadId,
        ),
        /上传标识/,
      );
      await assert.rejects(
        k.upload(a, personal, "不合法设置.md", Buffer.from("原文"), undefined, {
          chunkSize: 100,
        }),
        /分块长度/,
      );
      await k.tick();
      let d = (await k.detail(a, personal)).documents[0];
      assert.equal(d.state, "review");
      assert.equal(d.phase, "review");
      assert.equal(d.processing_options.chunkSize, 400);
      assert.match(d.summary, /磁盘/);
      assert.deepEqual(d.keywords, ["磁盘", "日志"]);
      assert.equal(
        (await k.search({ user: a }, "磁盘", personal)).results.length,
        0,
      );
      await assert.rejects(
        k.edit(a, personal, doc.id, {
          version: 1,
          editRevision: 9,
          content: "过期修订",
        }),
      );
      const saved = await k.edit(a, personal, doc.id, {
        version: 1,
        editRevision: 0,
        content: "磁盘告警：检查磁盘空间，清理日志。",
        summary: "经审核的磁盘巡检摘要",
        keywords: ["磁盘", "巡检"],
      });
      await k.queue(a, personal, doc.id, {
        publish: true,
        editRevision: saved.edit_revision,
      });
      await k.tick();
      const published = (await k.detail(a, personal)).documents[0];
      assert.equal(published.summary, "经审核的磁盘巡检摘要");
      assert.deepEqual(published.keywords, ["磁盘", "巡检"]);
      assert.equal(published.model_info.processingOptions.chunkSize, 400);
      assert.equal(
        (await k.search({ user: a }, "磁盘", personal)).results.length,
        1,
      );
      const pubdoc = await k.upload(
        a,
        pub,
        "公共.md",
        Buffer.from("检查磁盘空间，并保留变更记录。"),
      );
      await k.tick();
      assert.equal((await k.detail(b, pub)).documents.length, 0);
      await assert.rejects(
        k.source({ user: b }, pub, pubdoc.id, 1),
        /来源不存在/,
      );
      const pubdraft = (await k.detail(a, pub)).documents[0];
      await k.queue(a, pub, pubdoc.id, {
        publish: true,
        editRevision: pubdraft.edit_revision,
      });
      await k.tick();
      assert.equal((await k.detail(b, pub)).documents[0].state, "published");
      let scope = await k.scope(a, space);
      await k.bind(a, personal, {
        spaceId: space,
        epoch: scope.epoch,
        confirm: true,
      });
      await k.bind(a, pub, {
        spaceId: space,
        epoch: scope.epoch,
        confirm: true,
      });
      assert.equal(
        (await knowledgeTool(k, space, "knowledge_search", { query: "磁盘" }))
          .results.length,
        2,
      );
      const source = await k.source({ space }, personal, doc.id, 1);
      assert.match(source.bytes.toString(), /磁盘/);
      await pool.query("INSERT INTO instance_members VALUES($1,$2,'member')", [
        space,
        b.id,
      ]);
      await k.grant(a, pub, { userId: b.id, maintain: true });
      const candidates = await k.bindingSpaces(b, pub);
      assert.equal(candidates.find((x) => x.id === space).canConfigure, false);
      assert.equal(
        candidates.find((x) => x.id === roleSpace).canConfigure,
        true,
      );
      await assert.rejects(k.scope(b, space), /无空间配置权限/);
      assert.equal((await k.scope(b, roleSpace)).space, roleSpace);
      assert.equal(
        (await k.bindingSpaces(a, pub)).find((x) => x.id === roleSpace)
          .canConfigure,
        true,
      );
      const managerConnections = await k.bindingSpaces(manager, pub);
      assert.equal(managerConnections.find((x) => x.id === space).bound, true);
      assert.equal(
        managerConnections.find((x) => x.id === space).canConfigure,
        false,
      );
      assert.equal(
        managerConnections.find((x) => x.id === space).canUnbind,
        true,
      );
      await assert.rejects(k.bindingSpaces(c, pub), /无知识库权限/);
      await assert.rejects(k.bindingSpaces(b, personal), /无知识库权限/);
      await pool.query(
        "UPDATE instance_members SET access_role='operator' WHERE instance_id=$1 AND user_id=$2",
        [roleSpace, b.id],
      );
      assert.equal(
        (await k.bindingSpaces(b, pub)).find((x) => x.id === roleSpace)
          .canConfigure,
        true,
      );
      assert.equal((await k.scope(b, roleSpace)).space, roleSpace);
      await pool.query(
        "UPDATE instance_members SET access_role='owner' WHERE instance_id=$1 AND user_id=$2",
        [roleSpace, b.id],
      );
      await k.grant(a, pub, { userId: b.id });
      await assert.rejects(k.bindingSpaces(b, pub), /无知识库权限/);
      assert.equal(
        (await k.spaceLibraries(space))
          .find((x) => x.id === personal)
          .reason.includes("新增成员"),
        true,
      );
      await assert.rejects(
        k.bind(a, personal, {
          spaceId: space,
          epoch: scope.epoch,
          confirm: true,
        }),
      );
      await assert.rejects(k.source({ space }, personal, doc.id, 1));
      scope = await k.scope(a, space);
      await k.bind(a, personal, {
        spaceId: space,
        epoch: scope.epoch,
        confirm: true,
      });
      await k.grant(a, pub, { userId: b.id, remove: true });
      assert.ok(
        (await k.spaceLibraries(space)).find((x) => x.id === pub).reason,
      );
      assert.equal((await k.search({ space }, "磁盘")).results.length, 1);
      await k.bind(a, personal, { spaceId: space, remove: true });
      assert.equal((await k.search({ space }, "磁盘")).results.length, 0);
      await k.grant(a, pub, { userId: b.id });
      assert.equal((await k.detail(b, pub)).documents.length, 1);
      const updateRequestId = randomUUID();
      const updated = await k.upload(
        a,
        personal,
        "新版.md",
        Buffer.from("新版说明，没有旧操作。"),
        doc.id,
        {},
        updateRequestId,
      );
      assert.equal(updated.version, 2);
      const updateRetry = await k.upload(
        a,
        personal,
        "新版.md",
        Buffer.from("新版说明，没有旧操作。"),
        doc.id,
        {},
        updateRequestId,
      );
      assert.equal(updateRetry.version, 2);
      assert.equal(
        (await k.detail(a, personal)).documents[0].current_version,
        2,
      );
      await k.tick();
      assert.equal((await k.detail(a, personal)).documents[0].state, "failed");
      await k.queue(a, personal, doc.id, {});
      assert.equal(
        (await k.search({ user: a }, "磁盘", personal)).results[0].version,
        1,
      );
      const draftFn = k.models.draft;
      let release, started;
      const began = new Promise((r) => {
        started = r;
      });
      const gate = new Promise((r) => {
        release = r;
      });
      k.models.draft = async () => {
        started();
        await gate;
        return { content: "新版正文", quotes: ["新版说明"] };
      };
      const running = k.tick();
      await began;
      await k.upload(
        a,
        personal,
        "第三版.md",
        Buffer.from("第三版原文"),
        doc.id,
      );
      release();
      await running;
      k.models.draft = draftFn;
      const current = (await k.detail(a, personal)).documents[0];
      assert.equal(current.current_version, 3);
      assert.equal(current.draft, null);
      assert.equal(current.published_version, 1);
      await k.remove(a, personal, doc.id);
      assert.equal(
        (await k.search({ user: a }, "磁盘", personal)).results.length,
        0,
      );
      await assert.rejects(k.source({ user: a }, personal, doc.id, 1));
      const nextPublic = await k.upload(
        a,
        pub,
        "公共新原文.md",
        Buffer.from("未审核的新原文"),
        pubdoc.id,
      );
      assert.equal(nextPublic.version, 2);
      const parsed = await k.source({ user: a }, pub, pubdoc.id, 2, {
        readBytes: false,
      });
      assert.equal(parsed.row.version, 2);
      assert.equal("bytes" in parsed, false);
      await assert.rejects(
        k.source({ user: a }, pub, pubdoc.id, 0, { readBytes: false }),
        /原文版本无效/,
      );
      await assert.rejects(
        k.source({ user: b }, pub, pubdoc.id, 2, { readBytes: false }),
        /来源不存在/,
      );
      await assert.rejects(
        k.source({ user: b }, pub, pubdoc.id, 2),
        /来源不存在/,
      );
      await assert.rejects(
        k.source({ space }, pub, pubdoc.id, 2),
        /来源不存在/,
      );
      assert((await k.source({ user: b }, pub, pubdoc.id, 1)).bytes.length > 0);
      const currentScope = await k.scope(a, space);
      const originalBinding = (await k.bindingSpaces(a, pub)).find(
        (x) => x.id === space,
      );
      const duplicate = await k.bind(a, pub, {
        spaceId: space,
        epoch: currentScope.epoch,
        confirm: true,
      });
      assert.equal(duplicate.alreadyBound, true);
      assert.equal(
        (await k.bindingSpaces(a, pub))
          .find((x) => x.id === space)
          .boundAt.getTime(),
        originalBinding.boundAt.getTime(),
      );
      const preview = await k.bindingScope(a, pub, space);
      assert(
        preview.members.every((m) =>
          ["owner", "operator", "member"].includes(m.access_role),
        ),
      );
      assert(preview.members.every((m) => m.canRead === true));
      await assert.rejects(
        k.bindingScope(manager, pub, space),
        /无空间配置权限/,
      );
      const roleScope = await k.scope(a, roleSpace);
      await k.bind(a, pub, {
        spaceId: roleSpace,
        epoch: roleScope.epoch,
        confirm: true,
      });
      await k.bind(manager, pub, { spaceId: roleSpace, remove: true });
      assert(
        !(await k.bindingSpaces(manager, pub)).some((x) => x.id === roleSpace),
      );
      const personalB = (await k.create(b, { name: "可撤回的个人库" })).id;
      const ownerScope = await k.scope(b, roleSpace);
      await k.bind(b, personalB, {
        spaceId: roleSpace,
        epoch: ownerScope.epoch,
        confirm: true,
      });
      await pool.query(
        "UPDATE instance_members SET access_role='member' WHERE instance_id=$1 AND user_id=$2",
        [roleSpace, b.id],
      );
      await assert.rejects(
        k.bindingScope(b, personalB, roleSpace),
        /无空间配置权限/,
      );
      assert.equal(
        (await k.bindingSpaces(b, personalB)).find((x) => x.id === roleSpace)
          .canUnbind,
        true,
      );
      await k.bind(b, personalB, { spaceId: roleSpace, remove: true });
      assert.equal((await k.detail(b, personalB)).bindings.length, 0);
      await assert.rejects(
        k.bind(c, personalB, { spaceId: roleSpace, remove: true }),
        /无知识库权限/,
      );
      await assert.rejects(
        k.bind(a, pub, { spaceId: "invalid", remove: true }),
        /空间无效/,
      );
      assert.ok(
        Number(
          (await pool.query("SELECT count(*) FROM knowledge_audit")).rows[0]
            .count,
        ) > 5,
      );
    } finally {
      if (model) await new Promise((r) => model.close(r));
      if (pool) await pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      await rm(root, { recursive: true, force: true });
    }
  },
);
