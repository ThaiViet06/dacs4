const { Pool } = require("pg");
const { verifyToken } = require("@clerk/backend");
const { readConfig } = require("./src/config");
const { PostgresRepository } = require("./src/repository");
const { createApplication } = require("./src/application");

async function main() {
  const config = readConfig();
  const pool = new Pool(config.database);
  pool.on("error", (error) => console.error("Database pool error:", error.code || error.name));
  const repository = new PostgresRepository(pool);
  try { await repository.ready(); } catch (error) { await pool.end(); throw error; }
  const domain = Buffer.from(config.clerkPublishableKey.replace(/^pk_(test|live)_/, ""), "base64").toString().replace(/\$$/, "");
  const application = createApplication({
    repository, origins: config.origins,
    verifyToken: async (token) => {
      const payload = await verifyToken(token, { secretKey: config.clerkSecretKey, authorizedParties: config.origins, issuer: `https://${domain}` });
      if (!payload.sub || !payload.sid || !payload.exp) throw new Error("Invalid Clerk session");
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    },
  });
  application.server.listen(config.port, "0.0.0.0", () => console.log(`Drawing API listening on port ${config.port}`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const deadline = setTimeout(() => process.exit(1), 20000);
    deadline.unref();
    await application.close();
    await pool.end();
    clearTimeout(deadline);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
if (require.main === module) main().catch((error) => { console.error("Startup failed:", error.message?.startsWith("Configure") ? error.message : error.code || error.name); process.exitCode = 1; });
module.exports = { main };
