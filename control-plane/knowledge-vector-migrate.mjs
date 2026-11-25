// Run in a maintenance window, after a database + source PVC backup.
import pg from "pg";
import { Knowledge } from "./knowledge.mjs";
if (!process.env.DATABASE_URL) throw Error("DATABASE_URL is required");
if (process.argv.slice(2).some((x) => x !== "--install-extension"))
  throw Error(
    "Supported flag: --install-extension (requires database administrator)",
  );
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
});
try {
  if (process.argv.includes("--install-extension"))
    await pool.query(
      "CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public",
    );
  await new Knowledge(pool).init();
  const counts = (
    await pool.query(
      "SELECT count(*)::int AS chunks,count(embedding_vector)::int AS migrated FROM knowledge_chunks",
    )
  ).rows[0];
  const indexes = (
    await pool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='knowledge_chunks' ORDER BY indexname",
    )
  ).rows.map((x) => x.indexname);
  console.log(JSON.stringify({ ok: true, ...counts, indexes }));
} catch (error) {
  console.error(
    "pgvector migration failed; transaction rolled back. Verify extension, legacy vector dimensions and nonzero finite values before retry.",
  );
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
