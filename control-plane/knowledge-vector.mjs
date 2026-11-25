// pgvector stays inside PostgreSQL. Never return stored embeddings to callers.
export const vectorIndexSpec = (dimensions) => {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192)
    throw Error("向量维度须为 1～8192");
  if (dimensions > 4000) return null; // preserve existing large models with SQL exact search
  const type = dimensions <= 2000 ? "vector" : "halfvec";
  return { name: `knowledge_chunks_hnsw_${dimensions}`, type, dimensions };
};
const indexedVector = (spec, prefix = "") =>
  spec.type === "halfvec"
    ? `public.l2_normalize(${prefix}embedding_vector)::public.halfvec(${spec.dimensions})`
    : `${prefix}embedding_vector::public.vector(${spec.dimensions})`;
export async function ensureVectorIndex(c, dimensions) {
  const spec = vectorIndexSpec(dimensions);
  if (!spec) return;
  await c.query(
    "SELECT pg_advisory_xact_lock(hashtext(current_schema() || ':knowledge-vector-index'))",
  );
  await c.query(
    `CREATE INDEX IF NOT EXISTS ${spec.name} ON knowledge_chunks USING hnsw ((${indexedVector(spec)}) public.${spec.type}_cosine_ops) WHERE embedding_dims=${dimensions}`,
  );
}
export async function initializeVectors(c) {
  const extension = (
    await c.query(
      "SELECT e.extversion,n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'",
    )
  ).rows[0];
  const version = extension?.extversion.split(".").map(Number);
  if (
    !extension ||
    extension.nspname !== "public" ||
    !(version[0] > 0 || version[1] >= 8)
  )
    throw Error(
      "知识库需要 public schema 中的 pgvector >= 0.8.0，请先升级数据库镜像并执行 CREATE EXTENSION vector WITH SCHEMA public；现有知识数据保留。",
    );
  await c.query(
    "CREATE TABLE IF NOT EXISTS knowledge_schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
  );
  if (
    (
      await c.query(
        "SELECT 1 FROM knowledge_schema_migrations WHERE version='pgvector-v1'",
      )
    ).rowCount
  )
    return;
  await c.query(`
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_vector public.vector;
    ALTER TABLE knowledge_chunks ADD COLUMN IF NOT EXISTS embedding_dims integer GENERATED ALWAYS AS (public.vector_dims(embedding_vector)) STORED;
    CREATE OR REPLACE FUNCTION knowledge_sync_vector() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.embedding_vector := NEW.embedding::text::public.vector;
      IF public.vector_dims(NEW.embedding_vector) NOT BETWEEN 1 AND 8192 OR public.vector_norm(NEW.embedding_vector)=0 THEN
        RAISE EXCEPTION 'knowledge embedding must be a nonzero vector with 1..8192 dimensions';
      END IF;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS knowledge_embedding_changed ON knowledge_chunks;
    CREATE TRIGGER knowledge_embedding_changed BEFORE INSERT OR UPDATE OF embedding ON knowledge_chunks FOR EACH ROW EXECUTE FUNCTION knowledge_sync_vector();
    UPDATE knowledge_chunks SET embedding=embedding WHERE embedding_vector IS NULL;
    ALTER TABLE knowledge_chunks ALTER COLUMN embedding_vector SET NOT NULL;
    CREATE INDEX IF NOT EXISTS knowledge_chunks_model_dimensions ON knowledge_chunks(model_key,embedding_dims,document_id);
  `);
  const dimensions = (
    await c.query("SELECT DISTINCT embedding_dims FROM knowledge_chunks")
  ).rows;
  for (const row of dimensions) await ensureVectorIndex(c, row.embedding_dims);
  await c.query(
    "INSERT INTO knowledge_schema_migrations(version) VALUES('pgvector-v1')",
  );
}
const columns =
  "c.document_id,c.version,c.position,c.content,c.model_key,d.library_id,d.title,k.name AS library_name";
const tables =
  "knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.published_version=c.version JOIN knowledge_libraries k ON k.id=d.library_id";
const authorized =
  "d.library_id=ANY($1::uuid[]) AND NOT d.deleted AND NOT k.deleted AND c.model_key=$2";
export async function vectorSearch(c, libraries, modelKey, query) {
  await c.query("SET LOCAL statement_timeout='15s'");
  const dimensions = query.length,
    spec = vectorIndexSpec(dimensions),
    params = [libraries, modelKey, JSON.stringify(query)];
  // Do not silently hide a model that changed dimensions under the same identity.
  const mismatch = (
    await c.query(
      `SELECT 1 FROM ${tables} WHERE ${authorized} AND c.embedding_dims<>$3 LIMIT 1`,
      [libraries, modelKey, dimensions],
    )
  ).rowCount;
  if (mismatch) {
    const e = Error("向量维度不一致，请重新发布索引");
    e.code = "KNOWLEDGE_DIMENSIONS";
    throw e;
  }
  const where = `${authorized} AND c.embedding_dims=${dimensions}`;
  let rows = [];
  if (spec) {
    await c.query("SET LOCAL hnsw.iterative_scan='strict_order'");
    await c.query("SET LOCAL hnsw.ef_search=100");
    await c.query("SET LOCAL hnsw.max_scan_tuples=20000");
    // Half precision is only an index candidate representation; rerank in full precision.
    rows = (
      await c.query(
        `WITH candidates AS MATERIALIZED (
      SELECT ${columns},1-(c.embedding_vector OPERATOR(public.<=>) $3::public.vector) AS score
      FROM ${tables} WHERE ${where}
      ORDER BY ${indexedVector(spec, "c.")} OPERATOR(public.<=>) ${spec.type === "halfvec" ? `public.l2_normalize($3::public.vector)::public.halfvec(${dimensions})` : `$3::public.vector(${dimensions})`} LIMIT 64
    ) SELECT * FROM candidates ORDER BY score DESC,document_id,position LIMIT 8`,
        params,
      )
    ).rows;
  }
  if (rows.length < 8) {
    // Restrictive ACL/model/version filters can exhaust ANN candidates. SQL exact fallback
    // materializes only authorized, published rows; no vectors leave the database.
    rows = (
      await c.query(
        `WITH allowed AS MATERIALIZED (
      SELECT ${columns},c.embedding_vector FROM ${tables} WHERE ${where}
    ) SELECT document_id,version,position,content,model_key,library_id,title,library_name,
      1-(embedding_vector OPERATOR(public.<=>) $3::public.vector) AS score
      FROM allowed ORDER BY embedding_vector OPERATOR(public.<=>) $3::public.vector,document_id,position LIMIT 8`,
        params,
      )
    ).rows;
  }
  return rows;
}
