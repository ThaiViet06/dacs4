const { Pool } = require("pg");
const { verifyToken } = require("@clerk/backend");
const { readConfig } = require("./src/config");
const { PostgresRepository } = require("./src/repository");
const { createApplication } = require("./src/application");

// Đọc cấu hình, kiểm tra database rồi khởi động API và WebSocket.
async function main() {
  const config = readConfig();
  const pool = new Pool(config.database);
  // Ghi mã lỗi của kết nối PostgreSQL nhàn rỗi mà không in thông tin bí mật.
  pool.on("error", (error) => console.error("Database pool error:", error.code || error.name));
  const repository = new PostgresRepository(pool);
  try { await repository.ready(); } catch (error) { await pool.end(); throw error; }
  const domain = Buffer.from(config.clerkPublishableKey.replace(/^pk_(test|live)_/, ""), "base64").toString().replace(/\$$/, "");
  const application = createApplication({
    repository, origins: config.origins,
    // Xác minh token Clerk và chỉ chuyển ID, thời hạn phiên cho ứng dụng.
    verifyToken: async (token) => {
      const payload = await verifyToken(token, { secretKey: config.clerkSecretKey, authorizedParties: config.origins, issuer: `https://${domain}` });
      if (!payload.sub || !payload.sid || !payload.exp) throw new Error("Invalid Clerk session");
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    },
  });
  // Báo cổng đang lắng nghe sau khi máy chủ khởi động.
  application.server.listen(config.port, "0.0.0.0", () => console.log(`Drawing API listening on port ${config.port}`));
  let shuttingDown = false;
  // Dừng nhận kết nối, đóng WebSocket và trả kết nối database khi thoát tiến trình.
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
// Nếu chạy trực tiếp, khởi động máy chủ và báo lỗi khởi động đã được rút gọn.
if (require.main === module) main().catch((error) => { console.error("Startup failed:", error.message?.startsWith("Configure") ? error.message : error.code || error.name); process.exitCode = 1; });
module.exports = { main };
