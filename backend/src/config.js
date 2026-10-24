const fs = require("node:fs");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, "../.env"), quiet: true });

function readConfig(env = process.env) {
  const missing = ["DATABASE_URL", "CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY", "ALLOWED_ORIGINS"]
    .filter((name) => !env[name] || /REPLACE_ME|PASSWORD|PROJECT/.test(env[name]));
  if (missing.length) throw new Error(`Configure these variables in backend/.env: ${missing.join(", ")}`);
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  const origins = env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("ALLOWED_ORIGINS must contain exact HTTP(S) origins.");
  }
  const ssl = env.DATABASE_SSL !== "false";
  if (env.NODE_ENV === "production" && !ssl) throw new Error("Database TLS is required in production.");
  return {
    port, origins, nodeEnv: env.NODE_ENV || "development",
    clerkPublishableKey: env.CLERK_PUBLISHABLE_KEY,
    clerkSecretKey: env.CLERK_SECRET_KEY,
    database: {
      connectionString: env.DATABASE_URL,
      max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
      ssl: ssl ? { rejectUnauthorized: true, ...(env.DATABASE_CA_FILE ? { ca: fs.readFileSync(env.DATABASE_CA_FILE, "utf8") } : {}) } : false,
    },
  };
}
module.exports = { readConfig };
