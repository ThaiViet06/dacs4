const { Pool } = require("pg");
const { readConfig } = require("./src/config");
const { createTokenVerifier } = require("./src/auth");
const { PostgresRepository } = require("./src/repository");
const { createApplication } = require("./src/application");
const { createShareTokenGenerator } = require("./src/sharing");
const { ChatService, createChatCipher } = require("./src/chat");
const { Snapshots } = require("./src/snapshots");

// Đọc cấu hình, kiểm tra database rồi khởi động API và WebSocket.
async function main() {
  const config = readConfig();
  // Kiểm tra cấu hình xác thực trước khi mở kết nối database; API và WebSocket dùng cùng bộ xác thực.
  const verifyToken = createTokenVerifier(config);
  const pool = new Pool(config.database);
  // Ghi mã lỗi của kết nối PostgreSQL nhàn rỗi mà không in thông tin bí mật.
  pool.on("error", (error) => console.error("Database pool error:", error.code || error.name));
  // Cấp bộ sinh token từ khóa cấu hình; thiếu khóa thì API bật chia sẻ báo lỗi, các luồng cũ vẫn dùng được.
  const shareToken = config.shareLinkSecret ? createShareTokenGenerator(config.shareLinkSecret) : undefined;
  const repository = new PostgresRepository(pool, { shareToken });
  // Chat dùng khóa riêng; kiểm tra migration trước khi phục vụ nếu đã bật tính năng.
  const chat = new ChatService(repository, config.chatEncryptionKey ? createChatCipher(config.chatEncryptionKey) : undefined);
  try {
    await repository.ready();
    await chat.ready();
    await repository.enablePerformance({ packed: config.packedDrawing });
  } catch (error) { await pool.end(); throw error; }
  const snapshots = repository.sync ? new Snapshots(repository.sync) : undefined;
  const application = createApplication({
    repository, chat, snapshots, origins: config.origins, verifyToken,
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
    await snapshots?.close();
    await pool.end();
    clearTimeout(deadline);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
// Nếu chạy trực tiếp, khởi động máy chủ và báo lỗi khởi động đã được rút gọn.
if (require.main === module) main().catch((error) => { console.error("Startup failed:", error.message?.startsWith("Configure") ? error.message : error.code || error.name); process.exitCode = 1; });
module.exports = { main };
