import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  initializeVectors,
  vectorSearch,
  ensureVectorIndex,
} from "../knowledge-vector.mjs";
test(
  "pgvector migrates legacy data, searches beyond 2000 chunks and isolates permissions, models and versions",
  { skip: !process.env.TEST_DATABASE_URL, timeout: 60000 },
  async () => {
    const admin = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
      schema = "vec_" + randomUUID().replaceAll("-", "");
    let c;
    try {
      await admin.query(
        "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
      );
      await admin.query(`CREATE SCHEMA ${schema}`);
      c = await admin.connect();
      await c.query(`SET search_path TO ${schema}`);
      await c.query(`CREATE TABLE knowledge_libraries(id uuid PRIMARY KEY,name text,deleted boolean DEFAULT false);
   CREATE TABLE knowledge_documents(id uuid PRIMARY KEY,library_id uuid REFERENCES knowledge_libraries(id),published_version integer,title text DEFAULT '测试资料',deleted boolean DEFAULT false);
   CREATE TABLE knowledge_chunks(document_id uuid REFERENCES knowledge_documents(id),version integer,position integer,content text,embedding jsonb NOT NULL,model_key text,PRIMARY KEY(document_id,version,position));`);
      const allowed = randomUUID(),
        denied = randomUUID(),
        doc = randomUUID(),
        secret = randomUUID(),
        other = randomUUID();
      await c.query(
        "INSERT INTO knowledge_libraries(id,name) VALUES($1,'allowed'),($2,'denied')",
        [allowed, denied],
      );
      await c.query(
        "INSERT INTO knowledge_documents(id,library_id,published_version) VALUES($1,$2,1),($3,$4,1),($5,$2,1)",
        [doc, allowed, secret, denied, other],
      );
      await c.query(
        `INSERT INTO knowledge_chunks SELECT $1,1,n,'allowed '||n,jsonb_build_array(1.0,n/3000.0),'model' FROM generate_series(1,3000)n`,
        [doc],
      );
      await c.query(
        `INSERT INTO knowledge_chunks SELECT $1,1,n,'SECRET', '[1,0]'::jsonb,'model' FROM generate_series(1,22000)n`,
        [secret],
      );
      await c.query(
        `INSERT INTO knowledge_chunks VALUES($1,2,0,'UNPUBLISHED','[1,0]','model'),($2,1,0,'OTHER MODEL','[1,0]','other')`,
        [doc, other],
      );
      const before = (
        await c.query(
          "SELECT md5(string_agg(embedding::text,',' ORDER BY document_id,version,position)) AS hash FROM knowledge_chunks",
        )
      ).rows[0].hash;
      for (let i = 0; i < 2; i++) {
        await c.query("BEGIN");
        await initializeVectors({
          query: async (sql, args) => {
            if (i === 1)
              assert(
                !sql.includes("UPDATE knowledge_chunks"),
                "completed migration must not rescan vectors on restart",
              );
            return c.query(sql, args);
          },
        });
        await c.query("COMMIT");
      }
      const after = (
        await c.query(
          "SELECT md5(string_agg(embedding::text,',' ORDER BY document_id,version,position)) AS hash FROM knowledge_chunks",
        )
      ).rows[0].hash;
      assert.equal(after, before);
      await c.query("ANALYZE knowledge_chunks");
      const search = async (libs = [allowed], v = [1, 0]) => {
        await c.query("BEGIN");
        try {
          const r = await vectorSearch(c, libs, "model", v);
          await c.query("COMMIT");
          return r;
        } catch (e) {
          await c.query("ROLLBACK");
          throw e;
        }
      };
      const rows = await search();
      assert.equal(rows.length, 8);
      assert(
        rows.every(
          (x) =>
            x.library_id === allowed &&
            x.version === 1 &&
            x.model_key === "model" &&
            x.content.startsWith("allowed"),
        ),
      );
      assert(
        rows.every((x) => !("embedding" in x) && !("embedding_vector" in x)),
      );
      // Compare scores and ordering against SQL exact authorized recall.
      const expected = (
        await c.query(
          `SELECT position,1-(embedding_vector OPERATOR(public.<=>) '[1,0]'::public.vector) AS score FROM knowledge_chunks WHERE document_id=$1 AND version=1 ORDER BY embedding_vector OPERATOR(public.<=>) '[1,0]'::public.vector LIMIT 8`,
          [doc],
        )
      ).rows;
      assert.deepEqual(
        rows.map((x) => x.position),
        expected.map((x) => x.position),
      );
      assert(
        rows.every((x, i) => Math.abs(x.score - expected[i].score) < 1e-6),
      );
      await assert.rejects(search([allowed], [1, 0, 0]), {
        code: "KNOWLEDGE_DIMENSIONS",
      });
      assert.deepEqual(await search([]), []);
      await c.query("BEGIN");
      await c.query("SET LOCAL enable_seqscan=off");
      const plan = (
        await c.query(
          `EXPLAIN SELECT position FROM knowledge_chunks WHERE embedding_dims=2 ORDER BY embedding_vector::public.vector(2) OPERATOR(public.<=>) '[1,0]'::public.vector(2) LIMIT 8`,
        )
      ).rows
        .map((x) => x["QUERY PLAN"])
        .join("\n");
      await c.query("COMMIT");
      assert.match(plan, /knowledge_chunks_hnsw_2/);
      // New publication writes keep both formats synchronized, including old-client inserts.
      await c.query(
        "UPDATE knowledge_chunks SET embedding='[0,1]' WHERE document_id=$1 AND version=1 AND position=1",
        [doc],
      );
      assert.equal(
        (
          await c.query(
            "SELECT embedding_vector::text AS v FROM knowledge_chunks WHERE document_id=$1 AND version=1 AND position=1",
            [doc],
          )
        ).rows[0].v,
        "[0,1]",
      );
      await c.query(
        "DELETE FROM knowledge_chunks WHERE document_id=$1 AND version=1 AND position>3",
        [doc],
      );
      assert.equal((await search()).length, 3);
      // 3072d half precision index reranks against stored full precision vectors.
      const high = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
      await c.query(
        "INSERT INTO knowledge_chunks VALUES($1,1,1,'HIGH',$2,'high',DEFAULT,DEFAULT)",
        [other, JSON.stringify(high)],
      );
      await c.query("BEGIN");
      await initializeVectors(c);
      await ensureVectorIndex(c, 3072);
      const highRows = await vectorSearch(c, [allowed], "high", high);
      await c.query("COMMIT");
      assert.equal(highRows[0].content, "HIGH");
      assert.equal(highRows[0].score, 1);
      const large = [1, ...Array(8191).fill(0)];
      await c.query(
        "INSERT INTO knowledge_chunks(document_id,version,position,content,embedding,model_key) VALUES($1,1,2,'LARGE',$2,'large')",
        [other, JSON.stringify(large)],
      );
      await c.query("BEGIN");
      const largeRows = await vectorSearch(c, [allowed], "large", large);
      await c.query("COMMIT");
      assert.equal(largeRows[0].content, "LARGE");
      console.log(
        "Verified real HNSW query plan; 25k legacy chunks; ACL fallback; unpublished/model isolation; float32 and halfvec retrieval.",
      );
    } finally {
      if (c) {
        await c.query("ROLLBACK").catch(() => {});
        c.release();
      }
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);

test(
  "invalid legacy embeddings roll back migration without deleting JSON data",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new pg.Pool({
        connectionString: process.env.TEST_DATABASE_URL,
      }),
      schema = "badvec_" + randomUUID().replaceAll("-", "");
    const c = await pool.connect();
    try {
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET search_path TO ${schema}`);
      await c.query(
        "CREATE TABLE knowledge_chunks(document_id uuid,model_key text,embedding jsonb)",
      );
      await c.query("INSERT INTO knowledge_chunks VALUES($1,'old','[0,0]')", [
        randomUUID(),
      ]);
      await c.query("BEGIN");
      await assert.rejects(initializeVectors(c), /nonzero vector/);
      await c.query("ROLLBACK");
      assert.deepEqual(
        (await c.query("SELECT embedding FROM knowledge_chunks")).rows[0]
          .embedding,
        [0, 0],
      );
      assert.equal(
        (
          await c.query(
            "SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='knowledge_chunks' AND column_name='embedding_vector'",
            [schema],
          )
        ).rowCount,
        0,
      );
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      c.release();
      await pool.end();
    }
  },
);
