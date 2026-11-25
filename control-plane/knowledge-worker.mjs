import pg from "pg";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { Knowledge } from "./knowledge.mjs";
import { knowledgeModels } from "./knowledge-models.mjs";
const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
  }),
  k = new Knowledge(pool);
let stopping = false;
async function provider(id) {
  const p = (
    await pool.query(
      "SELECT id,config,enabled FROM model_providers WHERE id=$1",
      [id],
    )
  ).rows[0];
  if (!p?.enabled) return null;
  if (p.config.authMode === "none") return { ...p, apiKey: undefined };
  const base = "/var/run/secrets/kubernetes.io/serviceaccount/",
    token = (await readFile(base + "token", "utf8")).trim(),
    ca = await readFile(base + "ca.crt"),
    namespace = process.env.DSH_NAMESPACE || "guanyin-enterprise-instances";
  const secret = await new Promise((resolve, reject) => {
    const req = https.get(
      {
        hostname: process.env.KUBERNETES_SERVICE_HOST,
        port: process.env.KUBERNETES_SERVICE_PORT_HTTPS || 443,
        path: `/api/v1/namespaces/${namespace}/secrets/guanyin-model-${p.id}`,
        ca,
        headers: { authorization: `Bearer ${token}` },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (b) => {
          data += b;
          if (data.length > 65536) req.destroy(Error("secret too large"));
        });
        res.on("end", () => {
          if (res.statusCode !== 200)
            return reject(Error("model credential unavailable"));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(Error("credential timeout")));
    req.on("error", reject);
  });
  return {
    ...p,
    apiKey: Buffer.from(secret.data?.apiKey || "", "base64").toString("utf8"),
  };
}
k.models = knowledgeModels(provider);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
  });
console.log("Knowledge worker started; one concurrent task");
while (!stopping) {
  try {
    await k.tick();
  } catch {
    console.error("Knowledge worker unavailable; will retry");
  }
  if (!stopping) await new Promise((r) => setTimeout(r, 3000));
}
await pool.end();
