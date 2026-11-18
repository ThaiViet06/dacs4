const { createCipheriv, createDecipheriv, createSecretKey, randomBytes } = require("node:crypto");
const { AppError } = require("./errors");
const { uuidSchema } = require("./protocol");

// Chỉ nhận khóa AES 256-bit riêng cho chat; không dùng lại khóa Clerk hoặc khóa link mời.
function validateChatKey(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("Configure CHAT_ENCRYPTION_KEY with 32 random bytes encoded as 64 hex characters.");
  }
}

// Ràng buộc bản mã với dự án, tin nhắn và tác giả để không thể tráo sang bản ghi khác.
function associatedData(message) {
  return Buffer.from(JSON.stringify([1, message.roomId.toLowerCase(), message.id.toLowerCase(), message.authorId]));
}

// AES-GCM vừa mã hóa nội dung vừa phát hiện sửa dữ liệu; mỗi lần mã hóa có IV ngẫu nhiên mới.
function createChatCipher(value) {
  validateChatKey(value);
  const key = createSecretKey(Buffer.from(value, "hex"));
  return {
    // Gói phiên bản, IV, authentication tag và bản mã vào một cột; không lưu nội dung rõ.
    encrypt(text, message) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
      cipher.setAAD(associatedData(message));
      const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
      return "v1." + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
    },
    // Chỉ trả nội dung sau khi kiểm tra tag; sai khóa hoặc bản mã hỏng đều báo lỗi an toàn.
    decrypt(value, message) {
      try {
        if (typeof value !== "string" || !/^v1\.[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error();
        const packed = Buffer.from(value.slice(3), "base64");
        if (packed.length <= 28 || packed.length > 4028 || packed.toString("base64") !== value.slice(3)) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, packed.subarray(0, 12), { authTagLength: 16 });
        decipher.setAAD(associatedData(message));
        decipher.setAuthTag(packed.subarray(12, 28));
        return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
      } catch {
        throw new AppError(503, "CHAT_UNAVAILABLE", "Chat is temporarily unavailable.");
      }
    },
  };
}

// Chặn nội dung rỗng/quá dài và các trường giả mạo tác giả; danh tính luôn lấy từ Clerk.
function chatInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 2 || !Object.hasOwn(value, "id") || !Object.hasOwn(value, "text") ||
    typeof value.text !== "string" || !value.text.trim() || value.text.trim().length > 1000) {
    throw new AppError(400, "INVALID_INPUT", "A message must contain between 1 and 1000 characters.");
  }
  return { id: uuidSchema(value.id).toLowerCase(), text: value.text.trim() };
}

class ChatService {
  // Tái sử dụng transaction và kiểm tra thành viên của repository dự án, không tạo pool riêng.
  constructor(repository, cipher) { this.repository = repository; this.cipher = cipher; }

  // Chỉ yêu cầu bảng chat khi đã cấu hình khóa; ứng dụng vẽ cũ vẫn khởi động nếu chưa bật chat.
  async ready() {
    if (this.cipher) await this.repository.pool.query("SELECT id FROM drawing.room_messages LIMIT 0");
  }

  // Chat chỉ mở khi dự án đang chia sẻ và backend có khóa mã hóa hợp lệ.
  available(room) {
    if (!room.sharing_enabled) throw new AppError(409, "SHARING_DISABLED", "Chat requires a shared project.");
    if (!this.cipher) throw new AppError(503, "CHAT_UNAVAILABLE", "Chat is temporarily unavailable.");
  }

  // Chỉ trả metadata và nội dung đã giải mã cho thành viên; không đưa bản mã/IV/tag ra API.
  message(row) {
    const context = { id: row.id, roomId: row.room_id, authorId: row.author_id };
    return { ...context, sequence: row.sequence, text: this.cipher.decrypt(row.ciphertext, context),
      createdAt: new Date(row.created_at).toISOString() };
  }

  // Đọc tối đa 50 tin gần nhất trong cùng transaction kiểm tra quyền, rồi trả theo thứ tự cũ đến mới.
  async list(userId, roomId) {
    if (this.repository.performanceReady) return this.listFast(userId, roomId);
    return this.repository.transaction(async (client) => {
      const room = await this.repository.member(client, userId, roomId);
      this.available(room);
      const { rows } = await client.query("SELECT * FROM drawing.room_messages WHERE room_id=$1 ORDER BY sequence DESC LIMIT 50", [room.id]);
      return rows.reverse().map((row) => this.message(row));
    });
  }

  // Quyền và lịch sử dùng cùng một mốc MVCC, mở hai tab không giữ khóa chặn commit nét.
  async listFast(userId, roomId) {
    const { rows: [room] } = await this.repository.pool.query(
      `SELECT r.sharing_enabled, history.messages
        FROM drawing.rooms r JOIN drawing.room_members member ON member.room_id=r.id AND member.user_id=$2
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(to_jsonb(recent) ORDER BY recent.sequence) AS messages
          FROM (
            SELECT id,room_id,author_id,sequence,ciphertext,created_at
            FROM drawing.room_messages WHERE room_id=r.id ORDER BY sequence DESC LIMIT 50
          ) recent
        ) history ON r.sharing_enabled AND $3::boolean
        WHERE r.id=$1 AND (r.sharing_enabled OR r.owner_id=$2)`,
      [roomId, userId, Boolean(this.cipher)],
    );
    if (!room) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied.");
    this.available(room);
    return (room.messages || []).map((row) => this.message(row));
  }

  // Khóa dự án để cấp thứ tự chat riêng; chỉ trả thành công sau COMMIT, retry UUID cũ không gửi trùng.
  async send(userId, roomId, value) {
    const input = chatInput(value);
    if (this.repository.performanceReady) return this.sendFast(userId, roomId, input);
    return this.repository.transaction(async (client) => {
      const room = await this.repository.member(client, userId, roomId);
      this.available(room);
      const { rows: [existing] } = await client.query("SELECT * FROM drawing.room_messages WHERE room_id=$1 AND id=$2", [room.id, input.id]);
      if (existing) {
        if (existing.author_id !== userId || this.message(existing).text !== input.text) {
          throw new AppError(409, "MESSAGE_CONFLICT", "This message ID has already been used.");
        }
        return { message: this.message(existing), duplicate: true };
      }
      const { rows: [next] } = await client.query("SELECT COALESCE(MAX(sequence),0)+1 AS sequence FROM drawing.room_messages WHERE room_id=$1", [room.id]);
      const context = { id: input.id, roomId: room.id, authorId: userId };
      const ciphertext = this.cipher.encrypt(input.text, context);
      const { rows: [saved] } = await client.query("INSERT INTO drawing.room_messages(id,room_id,sequence,author_id,ciphertext) VALUES($1,$2,$3,$4,$5) RETURNING *",
        [input.id, room.id, next.sequence, userId, ciphertext]);
      return { message: this.message(saved), duplicate: false };
    });
  }
  // Một lượt SQL lưu bản mã, kể cả khi gửi lại UUID. Chỉ backend kiểm tra được nội dung đã giải mã.
  async sendFast(userId, roomId, input) {
    if (!this.cipher) {
      const room = await this.repository.getRoom(userId, roomId);
      this.available({ sharing_enabled: room.sharingEnabled });
    }
    const ciphertext = this.cipher.encrypt(input.text, { id: input.id, roomId, authorId: userId });
    const { rows: [{ result }] } = await this.repository.pool.query(
      "SELECT drawing.write_chat_message($1,$2,$3,$4) AS result",
      [roomId, userId, input.id, ciphertext],
    );
    if (result.error === "ROOM_NOT_FOUND") throw new AppError(404, result.error, "Room not found or access denied.");
    if (result.error === "SHARING_DISABLED") throw new AppError(409, result.error, "Chat requires a shared project.");
    if (result.error === "MESSAGE_CONFLICT") throw new AppError(409, result.error, "This message ID has already been used.");
    const message = this.message(result.message);
    if (message.text !== input.text) throw new AppError(409, "MESSAGE_CONFLICT", "This message ID has already been used.");
    return { message, duplicate: result.duplicate };
  }
}

module.exports = { ChatService, createChatCipher, validateChatKey };
