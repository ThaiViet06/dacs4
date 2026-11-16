const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { AppError } = require("./errors");
const { emptyDocument, checkSize, titleSchema, eventSchema, normalizeDocument } = require("./protocol");
const { sharingChange } = require("./sharing");
// Băm token lời mời để database không lưu token có thể dùng trực tiếp.
const hash = (token) => createHash("sha256").update(token).digest("hex");
// Tạo token lời mời ngẫu nhiên để chia sẻ liên kết vào phòng.
const token = () => randomBytes(32).toString("base64url");
// Chuyển tên cột PostgreSQL sang metadata; chỉ công bố trạng thái chia sẻ, không lộ hash/version nội bộ.
function metadata(row) {
  return { id: row.id, title: row.title, ownerId: row.owner_id, sequence: row.sequence,
    sharingEnabled: Boolean(row.sharing_enabled), hasCheckpoint: Boolean(row.checkpoint), updatedAt: row.updated_at };
}
class PostgresRepository {
  // Giữ pool và bộ sinh token từ cấu hình; thiếu khóa vẫn cho phép đọc/vẽ và tắt chia sẻ.
  constructor(pool, { shareToken } = {}) { this.pool = pool; this.shareToken = shareToken; }
  // Kiểm tra cả cột chế độ dự án để không phục vụ API với schema chưa chạy migration mới.
  async ready() { await this.pool.query("SELECT id,sharing_enabled,sharing_version FROM drawing.rooms LIMIT 0"); }
  // Chạy nhiều câu truy vấn trong một giao dịch; lỗi thì hoàn tác toàn bộ.
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      // Nếu hoàn tác cũng lỗi, vẫn giữ lỗi gốc để người gọi xử lý.
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  // Kiểm tra thành viên/chủ dự án Cá nhân, tùy chọn khóa hàng khi ghi; dùng chung cho HTTP và WebSocket.
  async member(client, userId, roomId, lock = true) {
    const { rows: [room] } = await client.query(`SELECT * FROM drawing.rooms WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [roomId]);
    const { rows } = await client.query("SELECT user_id FROM drawing.room_members WHERE room_id=$1 AND user_id=$2", [roomId, userId]);
    if (!room || !rows.length || (!room.sharing_enabled && room.owner_id !== userId)) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied. Join with an invitation first.");
    return room;
  }
  // Tạo dự án theo mặc định Cá nhân của database và thêm chủ làm thành viên trong cùng giao dịch.
  async createRoom(userId, title, document = emptyDocument()) {
    checkSize(document);
    const id = randomUUID();
    const inviteToken = token();
    // Chỉ công bố phòng sau khi cả phòng và tư cách thành viên đã lưu thành công.
    const room = await this.transaction(async (client) => {
      const { rows: [row] } = await client.query("INSERT INTO drawing.rooms(id,title,owner_id,invite_hash,initial_document) VALUES($1,$2,$3,$4,$5) RETURNING *", [id, title, userId, hash(inviteToken), JSON.stringify(document)]);
      await client.query("INSERT INTO drawing.room_members(room_id,user_id) VALUES($1,$2)", [id, userId]);
      return metadata(row);
    });
    return { room, inviteToken };
  }
  // Chỉ liệt kê dự án cá nhân của chủ hoặc dự án chung đã tham gia, tối đa 100 mục mới cập nhật trước.
  async listRooms(userId) {
    const { rows } = await this.pool.query("SELECT r.* FROM drawing.rooms r JOIN drawing.room_members m ON m.room_id=r.id WHERE m.user_id=$1 AND (r.owner_id=$1 OR r.sharing_enabled) ORDER BY r.updated_at DESC LIMIT 100", [userId]);
    return rows.map(metadata);
  }
  // Kiểm tra token và chế độ chia sẻ trước khi thêm thành viên; tham gia lại không tạo bản ghi trùng.
  async joinRoom(userId, inviteToken) {
    return this.transaction(async (client) => {
      const { rows: [row] } = await client.query("SELECT * FROM drawing.rooms WHERE invite_hash=$1 FOR UPDATE", [hash(inviteToken)]);
      if (!row || !row.sharing_enabled) throw new AppError(404, "INVITATION_INVALID", "This invitation is invalid or has been replaced.");
      await client.query("INSERT INTO drawing.room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [row.id, userId]);
      return metadata(row);
    });
  }
  // Chỉ trả thông tin phòng cho thành viên đã có quyền truy cập.
  async getRoom(userId, roomId) { return metadata(await this.member(this.pool, userId, roomId, false)); }
  // Chủ đọc chế độ và lấy lại token HMAC hiện tại; chỉ đọc, không xoay link cũ hoặc trả hash/version nội bộ.
  async getSharing(userId, roomId) {
    const room = await this.member(this.pool, userId, roomId, false);
    this.owner(room, userId);
    if (room.sharing_enabled && room.sharing_version > 0) {
      const { inviteToken } = sharingChange({ id: room.id, enabled: true,
        version: room.sharing_version, inviteHash: room.invite_hash }, true, this.shareToken);
      return { enabled: true, inviteToken };
    }
    return { enabled: Boolean(room.sharing_enabled) };
  }
  // Khóa dự án, đổi chế độ/hash và thu quyền trong cùng transaction; chỉ trả kết quả sau COMMIT.
  async setSharing(userId, roomId, enabled) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      const change = sharingChange({ id: room.id, enabled: room.sharing_enabled,
        version: room.sharing_version, inviteHash: room.invite_hash }, enabled, this.shareToken);
      let updated = room;
      if (room.sharing_enabled !== enabled) {
        const result = await client.query("UPDATE drawing.rooms SET sharing_enabled=$2,sharing_version=$3,invite_hash=$4,updated_at=now() WHERE id=$1 RETURNING *",
          [room.id, enabled, change.version, change.inviteHash]);
        updated = result.rows[0];
        if (!enabled) await client.query("DELETE FROM drawing.room_members WHERE room_id=$1 AND user_id<>$2", [room.id, room.owner_id]);
      }
      return { room: metadata(updated), enabled, ...(change.inviteToken ? { inviteToken: change.inviteToken } : {}) };
    });
  }
  // Chỉ nâng link cũ sau xác nhận của chủ; retry giữ token, không đổi nét/thành viên hoặc thời gian cập nhật.
  async upgradeInvitation(userId, roomId) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      if (!room.sharing_enabled) throw new AppError(409, "SHARING_DISABLED", "Enable sharing before updating the invitation.");
      const change = sharingChange({ id: room.id, enabled: true, version: room.sharing_version,
        inviteHash: room.invite_hash }, true, this.shareToken, { upgradeLegacy: true });
      let updated = room;
      if (room.sharing_version === 0) {
        const result = await client.query("UPDATE drawing.rooms SET sharing_version=$2,invite_hash=$3 WHERE id=$1 RETURNING *",
          [room.id, change.version, change.inviteHash]);
        updated = result.rows[0];
      }
      return { room: metadata(updated), enabled: true, inviteToken: change.inviteToken };
    });
  }
  // Chỉ chủ được đổi tên; khóa hàng và commit trước khi trả metadata, giữ nguyên nét và chế độ chia sẻ.
  async renameRoom(userId, roomId, title) {
    const roomTitle = titleSchema(title);
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      const { rows: [updated] } = await client.query("UPDATE drawing.rooms SET title=$2,updated_at=now() WHERE id=$1 RETURNING *", [roomId, roomTitle]);
      return metadata(updated);
    });
  }
  // Lấy lại nguyên link HMAC; chỉ dự án version 0 còn dùng hành vi phát link ngẫu nhiên của endpoint cũ.
  async invitation(userId, roomId) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      if (!room.sharing_enabled) throw new AppError(409, "SHARING_DISABLED", "Enable sharing before creating an invitation.");
      if (room.sharing_version > 0) {
        const change = sharingChange({ id: room.id, enabled: true, version: room.sharing_version,
          inviteHash: room.invite_hash }, true, this.shareToken);
        return { inviteToken: change.inviteToken };
      }
      const inviteToken = token();
      await client.query("UPDATE drawing.rooms SET invite_hash=$2 WHERE id=$1", [roomId, hash(inviteToken)]);
      return { inviteToken };
    });
  }
  // Từ chối thao tác dành riêng cho chủ phòng nếu ID không khớp.
  owner(room, userId) {
    if (room.owner_id !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
  }
  // Ghép lịch sử đến sequence cần đọc; giữ v1 cho nét cũ, trả v2 khi có sự kiện ẩn/hiện.
  async document(client, room, sequence = room.sequence) {
    if (sequence > room.sequence) throw new AppError(409, "SEQUENCE_AHEAD", "Wait for drawing synchronization before saving.");
    const { rows } = await client.query("SELECT payload FROM drawing.room_operations WHERE room_id=$1 AND sequence<=$2 ORDER BY sequence", [room.id, sequence]);
    const document = { ...room.initial_document, operations: [...room.initial_document.operations, ...rows.map((row) => row.payload)] };
    if (document.version === 1 && document.operations.some((event) => event.type === "visibility")) document.version = 2;
    return document.version === 1 ? document : normalizeDocument(document);
  }
  // Đọc trạng thái phòng nhất quán để gửi cho thành viên mới vào hoặc nối lại.
  async state(userId, roomId) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      return { room: metadata(room), sequence: room.sequence, document: await this.document(client, room) };
    });
  }
  // Ghi nét hoặc ẩn/hiện cùng sequence trong transaction; chỉ trả kết quả sau COMMIT, retry giữ UUID cũ.
  async commit(userId, roomId, operation) {
    eventSchema(operation);
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      if (operation.type === "visibility") this.owner(room, userId);
      const { rows: [existing] } = await client.query("SELECT sequence,payload,author_id FROM drawing.room_operations WHERE room_id=$1 AND operation_id=$2", [roomId, operation.id]);
      if (existing) {
        if (existing.author_id !== userId || JSON.stringify(existing.payload) !== JSON.stringify(operation)) {
          // JSONB có thể đổi thứ tự khóa; so sánh giá trị bằng PostgreSQL để retry không bị coi nhầm là xung đột.
          const { rows: [equal] } = await client.query("SELECT payload=$3::jsonb AS equal FROM drawing.room_operations WHERE room_id=$1 AND operation_id=$2", [roomId, operation.id, JSON.stringify(operation)]);
          if (existing.author_id !== userId || !equal.equal) throw new AppError(409, "OPERATION_CONFLICT", "An operation with that ID already exists.");
        }
        return { sequence: existing.sequence, operation: existing.payload, duplicate: true };
      }
      // Chủ vẫn được nhận lại xác nhận của sự kiện đã lưu sau khi bật chia sẻ; chỉ chặn sự kiện mới ở chế độ Chung.
      if (operation.type === "visibility" && room.sharing_enabled) throw new AppError(409, "PERSONAL_MODE_REQUIRED", "Switch to personal mode before undoing or redoing a stroke.");
      if (room.initial_document.operations.some((item) => item.id.toLowerCase() === operation.id.toLowerCase())) throw new AppError(409, "OPERATION_CONFLICT", "An operation with that ID already exists.");
      const document = await this.document(client, room);
      document.operations.push(operation);
      if (operation.type === "visibility") document.version = 2;
      if (document.version === 2) normalizeDocument(document);
      else checkSize(document);
      const sequence = room.sequence + 1;
      await client.query("INSERT INTO drawing.room_operations(room_id,operation_id,sequence,author_id,payload) VALUES($1,$2,$3,$4,$5)", [roomId, operation.id, sequence, userId, JSON.stringify(operation)]);
      await client.query("UPDATE drawing.rooms SET sequence=$2,updated_at=now() WHERE id=$1", [roomId, sequence]);
      return { sequence, operation, duplicate: false };
    });
  }
  // Lưu checkpoint của chủ phòng hoặc bản sao riêng từ thao tác đã có trong database.
  async save(userId, roomId, title, sequence, checkpoint) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      if (checkpoint) this.owner(room, userId);
      const document = await this.document(client, room, sequence);
      if (checkpoint) {
        const saved = { title, sequence, document, savedAt: new Date().toISOString() };
        await client.query("UPDATE drawing.rooms SET checkpoint=$2 WHERE id=$1", [roomId, JSON.stringify(saved)]);
        return { title, sequence, savedAt: saved.savedAt };
      }
      const { rows: [saved] } = await client.query("INSERT INTO drawing.saved_drawings(id,owner_id,title,document) VALUES($1,$2,$3,$4) RETURNING id,title,created_at", [randomUUID(), userId, title, JSON.stringify(document)]);
      return { id: saved.id, title: saved.title, createdAt: saved.created_at };
    });
  }
  // Liệt kê các bản vẽ riêng thuộc đúng tài khoản đăng nhập.
  async listDrawings(userId) {
    const { rows } = await this.pool.query("SELECT id,title,created_at,document FROM drawing.saved_drawings WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]);
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, document: row.document }));
  }
  // Mở bản sao riêng bằng cách tạo một phòng mới, giữ nguyên bản gốc.
  async openDrawing(userId, id) {
    const { rows: [row] } = await this.pool.query("SELECT * FROM drawing.saved_drawings WHERE id=$1 AND owner_id=$2", [id, userId]);
    if (!row) throw new AppError(404, "DRAWING_NOT_FOUND", "Saved drawing not found.");
    return this.createRoom(userId, `${row.title.slice(0, 90)} (copy)`, row.document);
  }
  // Chỉ cho chủ phòng mở checkpoint thành phòng mới độc lập.
  async openCheckpoint(userId, roomId) {
    const checkpoint = await this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      if (!room.checkpoint) throw new AppError(404, "NO_CHECKPOINT", "Save a room checkpoint first.");
      return room.checkpoint;
    });
    return this.createRoom(userId, `${checkpoint.title.slice(0, 90)} (copy)`, checkpoint.document);
  }
}
module.exports = { PostgresRepository };
