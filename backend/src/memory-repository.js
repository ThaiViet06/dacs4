const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { AppError } = require("./errors");
const { emptyDocument, checkSize, titleSchema } = require("./protocol");
const { sharingChange } = require("./sharing");

// Repository tạm cho development/test; mỗi instance giữ dữ liệu riêng và mất dữ liệu khi khởi động lại.
class MemoryRepository {
  #rooms = new Map();

  // Inject cùng bộ sinh token như PostgreSQL, không tự sinh khóa bí mật trong repository tạm.
  constructor({ shareToken } = {}) { this.shareToken = shareToken; }

  // Cho phép health check hoạt động mà không mở kết nối PostgreSQL.
  async ready() {}

  // Tạo dự án mặc định Cá nhân như PostgreSQL và ghi nhận chủ là thành viên đầu tiên.
  async createRoom(userId, title, document = emptyDocument()) {
    const roomTitle = titleSchema(title);
    checkSize(document);
    const inviteToken = randomBytes(32).toString("base64url");
    const room = {
      id: randomUUID(), title: roomTitle, ownerId: userId,
      sharingEnabled: false, sharingVersion: 0,
      sequence: 0, checkpoint: null, updatedAt: new Date(Date.now()).toISOString(),
      inviteHash: createHash("sha256").update(inviteToken).digest("hex"),
      initialDocument: structuredClone(document), members: new Set([userId]),
    };
    this.#rooms.set(room.id, room);
    return { room: this.#metadata(room), inviteToken };
  }

  // Chỉ liệt kê phòng của thành viên, mới cập nhật trước; đảo thứ tự tạo để xử lý timestamp trùng nhau.
  async listRooms(userId) {
    return [...this.#rooms.values()].reverse()
      .filter((room) => room.members.has(userId))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 100)
      .map((room) => this.#metadata(room));
  }

  // Không để người ngoài dò ID phòng: thiếu quyền và không tồn tại đều trả cùng lỗi 404.
  async getRoom(userId, roomId) {
    const room = this.#rooms.get(roomId);
    if (!room || !room.members.has(userId)) {
      throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied. Join with an invitation first.");
    }
    return this.#metadata(room);
  }

  // Chủ đọc trạng thái và lấy lại token HMAC như PostgreSQL, không thay đổi dữ liệu trong bộ nhớ.
  async getSharing(userId, roomId) {
    const room = await this.getRoom(userId, roomId);
    if (room.ownerId !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
    const stored = this.#rooms.get(roomId);
    if (stored.sharingEnabled && stored.sharingVersion > 0) {
      const { inviteToken } = sharingChange({ id: stored.id, enabled: true,
        version: stored.sharingVersion, inviteHash: stored.inviteHash }, true, this.shareToken);
      return { enabled: true, inviteToken };
    }
    return { enabled: room.sharingEnabled };
  }

  // Mô phỏng đổi chế độ cho test/development, dùng chung quy tắc HMAC và giữ nguyên nét/sequence.
  async setSharing(userId, roomId, enabled) {
    const metadata = await this.getRoom(userId, roomId);
    if (metadata.ownerId !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
    const room = this.#rooms.get(roomId);
    const change = sharingChange({ id: room.id, enabled: room.sharingEnabled,
      version: room.sharingVersion, inviteHash: room.inviteHash }, enabled, this.shareToken);
    if (room.sharingEnabled !== enabled) {
      room.sharingEnabled = enabled;
      room.sharingVersion = change.version;
      room.inviteHash = change.inviteHash;
      room.updatedAt = new Date(Date.now()).toISOString();
      if (!enabled) room.members = new Set([room.ownerId]);
    }
    return { room: this.#metadata(room), enabled, ...(change.inviteToken ? { inviteToken: change.inviteToken } : {}) };
  }

  // Cùng quy tắc nâng link/idempotency như PostgreSQL; chỉ thay version/hash, giữ nguyên dữ liệu khác.
  async upgradeInvitation(userId, roomId) {
    const metadata = await this.getRoom(userId, roomId);
    if (metadata.ownerId !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
    const room = this.#rooms.get(roomId);
    if (!room.sharingEnabled) throw new AppError(409, "SHARING_DISABLED", "Enable sharing before updating the invitation.");
    const change = sharingChange({ id: room.id, enabled: true, version: room.sharingVersion,
      inviteHash: room.inviteHash }, true, this.shareToken, { upgradeLegacy: true });
    room.sharingVersion = change.version;
    room.inviteHash = change.inviteHash;
    return { room: this.#metadata(room), enabled: true, inviteToken: change.inviteToken };
  }

  // Mô phỏng quyền đổi tên của PostgreSQL cho development/test, chỉ cập nhật tên và thời gian.
  async renameRoom(userId, roomId, title) {
    const roomTitle = titleSchema(title);
    const room = this.#rooms.get(roomId);
    if (!room || !room.members.has(userId)) {
      throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied. Join with an invitation first.");
    }
    if (room.ownerId !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
    room.title = roomTitle;
    room.updatedAt = new Date(Date.now()).toISOString();
    return this.#metadata(room);
  }

  // Repository thử nghiệm áp dụng cùng quyền xóa như PostgreSQL.
  async deleteRoom(userId, roomId) {
    const room = await this.getRoom(userId, roomId);
    if (room.ownerId !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
    this.#rooms.delete(roomId);
  }

  // Bỏ đúng thành viên đang yêu cầu thoát, theo cùng quy tắc quyền với PostgreSQL.
  async leaveRoom(userId, roomId) {
    const room = await this.getRoom(userId, roomId);
    if (room.ownerId === userId) throw new AppError(403, "OWNER_CANNOT_LEAVE", "The project owner cannot leave their own project.");
    this.#rooms.get(roomId).members.delete(userId);
  }

  // Trả object mới chỉ có metadata công khai; không lộ token/hash, tài liệu hoặc tập thành viên nội bộ.
  #metadata(room) {
    return {
      id: room.id, title: room.title, ownerId: room.ownerId, sequence: room.sequence,
      sharingEnabled: room.sharingEnabled,
      hasCheckpoint: Boolean(room.checkpoint), updatedAt: room.updatedAt,
    };
  }
}

module.exports = { MemoryRepository };
