const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { MemoryRepository } = require("../src/memory-repository");
const { AppError } = require("../src/errors");
const { emptyDocument, uuidSchema, joinSchema } = require("../src/protocol");

// Phòng mới phải tương thích cấu trúc API hiện tại và token mời phải đúng định dạng giao thức.
test("creating a room returns its owner, initial metadata and a private invitation", async () => {
  const repository = new MemoryRepository();
  const { room, inviteToken } = await repository.createRoom("user_a", "  Phòng phác thảo  ");
  assert.equal(uuidSchema(room.id), room.id);
  assert.equal(room.title, "Phòng phác thảo");
  assert.equal(room.ownerId, "user_a");
  assert.equal(room.sequence, 0);
  assert.equal(room.sharingEnabled, false);
  assert.equal(room.hasCheckpoint, false);
  assert.ok(Number.isFinite(Date.parse(room.updatedAt)));
  assert.deepEqual(joinSchema({ token: inviteToken }), { token: inviteToken });
  assert.deepEqual(Object.keys(room).sort(), ["hasCheckpoint", "id", "ownerId", "sequence", "sharingEnabled", "title", "updatedAt"]);
  assert.deepEqual(await repository.getRoom("user_a", room.id), room);
});

// Hai tài khoản chỉ thấy phòng của mình; tài khoản chưa có phòng nhận danh sách rỗng.
test("room lists are isolated between two owners and do not expose invitations", async () => {
  const repository = new MemoryRepository();
  const first = await repository.createRoom("user_a", "Phòng A");
  const second = await repository.createRoom("user_b", "Phòng B");
  assert.notEqual(first.room.id, second.room.id);
  assert.notEqual(first.inviteToken, second.inviteToken);
  const roomsA = await repository.listRooms("user_a");
  const roomsB = await repository.listRooms("user_b");
  assert.deepEqual(roomsA, [first.room]);
  assert.deepEqual(roomsB, [second.room]);
  assert.deepEqual(await repository.listRooms("user_c"), []);
  assert.ok(!JSON.stringify(roomsA).includes(first.inviteToken));
});

// Biết UUID cũng không được đọc phòng người khác; lỗi không tiết lộ phòng có tồn tại hay không.
test("nonmembers and missing rooms return the same access-denied result", async () => {
  const repository = new MemoryRepository();
  const { room } = await repository.createRoom("user_a", "Phòng riêng");
  for (const id of [room.id, randomUUID()]) {
    await assert.rejects(repository.getRoom("user_b", id), {
      name: "Error", status: 404, code: "ROOM_NOT_FOUND",
      message: "Room not found or access denied. Join with an invitation first.",
    });
  }
});

// Sửa dữ liệu trả về không được đổi chủ phòng, tên hoặc các lần đọc sau trong repository.
test("returned metadata cannot mutate stored ownership or room state", async () => {
  const repository = new MemoryRepository();
  const { room } = await repository.createRoom("user_a", "Bản gốc");
  const original = { ...room };
  room.ownerId = "user_b";
  room.title = "Đã sửa bên ngoài";
  room.sequence = 99;
  const rooms = await repository.listRooms("user_a");
  assert.deepEqual(rooms, [original]);
  rooms[0].id = randomUUID();
  assert.deepEqual(await repository.getRoom("user_a", original.id), original);
  assert.deepEqual(await repository.listRooms("user_b"), []);
});

// Đồng hồ đứng yên vẫn phải ưu tiên phòng tạo sau và giới hạn danh sách ở 100 phòng.
test("newest rooms come first even with equal timestamps and lists are capped at 100", async (context) => {
  context.mock.method(Date, "now", () => Date.UTC(2026, 10, 2));
  const repository = new MemoryRepository();
  const created = [];
  for (let index = 0; index < 103; index++) {
    created.push((await repository.createRoom("user_a", "Phòng " + index)).room.id);
  }
  const listed = await repository.listRooms("user_a");
  assert.deepEqual(listed.map((room) => room.id), created.reverse().slice(0, 100));
});

// Tạo phòng lỗi không được để lại dữ liệu dở dang trong danh sách người dùng.
test("invalid titles and oversized documents do not leave partially created rooms", async () => {
  const repository = new MemoryRepository();
  await assert.rejects(repository.createRoom("user_a", "   "), { code: "INVALID_INPUT" });
  const oversized = { ...emptyDocument(), padding: "x".repeat(5 * 1024 * 1024) };
  await assert.rejects(repository.createRoom("user_a", "Quá lớn", oversized), (error) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.code, "DOCUMENT_FULL");
    return true;
  });
  assert.deepEqual(await repository.listRooms("user_a"), []);
});

// Không dùng biến toàn cục: một instance mới phải độc lập với dữ liệu của instance cũ.
test("separate repository instances do not share room data", async () => {
  const first = new MemoryRepository();
  const second = new MemoryRepository();
  await first.createRoom("user_a", "Phòng tạm");
  assert.equal((await first.listRooms("user_a")).length, 1);
  assert.deepEqual(await second.listRooms("user_a"), []);
});
