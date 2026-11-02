const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { AppError } = require("./errors");
const { emptyDocument, checkSize, titleSchema } = require("./protocol");

// Repository tạm cho development/test; mỗi instance giữ dữ liệu riêng và mất dữ liệu khi khởi động lại.
class MemoryRepository {
  #rooms = new Map();

  // Cho phép health check hoạt động mà không mở kết nối PostgreSQL.
  async ready() {}

  // Tạo phòng đúng cấu trúc PostgreSQL và ghi nhận người tạo là thành viên đầu tiên.
  async createRoom(userId, title, document = emptyDocument()) {
    const roomTitle = titleSchema(title);
    checkSize(document);
    const inviteToken = randomBytes(32).toString("base64url");
    const room = {
      id: randomUUID(), title: roomTitle, ownerId: userId,
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

  // Trả object mới chỉ có metadata công khai; không lộ token/hash, tài liệu hoặc tập thành viên nội bộ.
  #metadata(room) {
    return {
      id: room.id, title: room.title, ownerId: room.ownerId, sequence: room.sequence,
      hasCheckpoint: Boolean(room.checkpoint), updatedAt: room.updatedAt,
    };
  }
}

module.exports = { MemoryRepository };
