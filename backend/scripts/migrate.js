const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { Pool } = require("pg");
const { readConfig } = require("../src/config");

// Áp dụng các file SQL theo thứ tự, ghi checksum và khóa để tránh chạy song song.
async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(730041)");
    await client.query("CREATE SCHEMA IF NOT EXISTS drawing");
    await client.query("CREATE TABLE IF NOT EXISTS drawing.schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const directory = path.join(__dirname, "../migrations");
    const files = (await fs.readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = await fs.readFile(path.join(directory, name), "utf8");
      const checksum = createHash("sha256").update(sql).digest("hex");
      const { rows: [applied] } = await client.query("SELECT checksum FROM drawing.schema_migrations WHERE name=$1", [name]);
      if (applied) {
        if (applied.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO drawing.schema_migrations(name,checksum) VALUES($1,$2)", [name, checksum]);
        await client.query("COMMIT");
        console.log(`Applied ${name}`);
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    }
  } finally { await client.query("SELECT pg_advisory_unlock(730041)").catch(() => {}); client.release(); }
}
// Khi chạy script trực tiếp, tạo pool và đóng nó sau khi migration kết thúc.
if (require.main === module) {
  (async () => {
    const pool = new Pool(readConfig().database);
    try { await migrate(pool); } finally { await pool.end(); }
  })().catch((error) => { console.error("Migration failed:", error.message?.startsWith("Configure") ? error.message : error.code || error.name); process.exitCode = 1; });
}
module.exports = { migrate };
