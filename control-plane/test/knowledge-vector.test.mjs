import test from "node:test";
import assert from "node:assert/strict";
import {
  vectorIndexSpec,
  vectorSearch,
  initializeVectors,
} from "../knowledge-vector.mjs";
import { vector } from "../knowledge.mjs";
test("vector storage validates usable float32 vectors and selects dimension-compatible indexes", () => {
  assert.throws(() => vector([0, 0]));
  assert.throws(() => vector([1e50, 1]));
  assert.throws(() => vector([1e-100]));
  assert.equal(vectorIndexSpec(1024).type, "vector");
  assert.equal(vectorIndexSpec(3072).type, "halfvec");
  assert.equal(vectorIndexSpec(8192), null);
  assert.throws(() => vectorIndexSpec("1024"));
  assert.throws(() => vectorIndexSpec(8193));
});
test("missing pgvector is actionable and never falls back to JSON scanning", async () => {
  await assert.rejects(
    initializeVectors({ query: async () => ({ rows: [] }) }),
    /pgvector >= 0.8.0/,
  );
});
test("vector search keeps ACL and current published version in SQL and returns no embeddings", async () => {
  const calls = [];
  let selects = 0;
  const c = {
    query: async (sql, args) => {
      calls.push({ sql, args });
      if (sql.startsWith("SELECT 1")) return { rowCount: 0 };
      if (sql.startsWith("WITH")) {
        selects++;
        return {
          rows:
            selects === 1
              ? []
              : [{ document_id: "doc", content: "允许的内容", score: 1 }],
        };
      }
      return { rows: [] };
    },
  };
  const rows = await vectorSearch(c, ["authorized"], "provider/model", [1, 0]);
  assert.equal(rows[0].content, "允许的内容");
  assert.equal(selects, 2);
  for (const call of calls.filter((x) => x.sql.startsWith("WITH"))) {
    assert.match(call.sql, /published_version=c.version/);
    assert.match(call.sql, /d.library_id=ANY\(\$1::uuid\[\]\)/);
    assert.deepEqual(call.args[0], ["authorized"]);
    assert.match(call.sql, /LIMIT 8/);
    assert(!/SELECT c\.\*/.test(call.sql));
  }
});
