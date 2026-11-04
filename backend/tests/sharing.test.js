const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { createApplication } = require("../src/application");
const { PostgresRepository } = require("../src/repository");
const { MemoryRepository } = require("../src/memory-repository");

const origin = "http://localhost:5173";

// Chạy repository PostgreSQL thật với pool chỉ cho SELECT, không kết nối database hay dùng khóa thật.
function fixture(enabled) {
  const room = {
    id: randomUUID(), owner_id: "owner", title: "Sharing fixture", sharing_enabled: enabled,
    sharing_version: 0, invite_hash: "private-fixture-hash", sequence: 8,
    updated_at: "2026-11-04T00:00:00Z", initial_document: { operations: [{ id: "kept-stroke" }] },
  };
  const members = ["owner", "member"];
  const queries = [];
  // Truy vấn ghi, khóa hàng hoặc đọc tài liệu nét vẽ đều làm test thất bại.
  async function query(sql, values) {
    queries.push({ sql, values });
    if (sql === "SELECT * FROM drawing.rooms WHERE id=$1") {
      return { rows: values[0] === room.id ? [structuredClone(room)] : [] };
    }
    if (sql === "SELECT user_id FROM drawing.room_members WHERE room_id=$1 AND user_id=$2") {
      return { rows: values[0] === room.id && members.includes(values[1]) ? [{ user_id: values[1] }] : [] };
    }
    throw new Error("Unexpected sharing query");
  }
  return { repository: new PostgresRepository({ query }), room, members, queries };
}

// Khởi tạo HTTP trên cổng tạm với danh tính giả; chữ ký Clerk thật đã có bộ test xác thực riêng.
async function start(context, repository) {
  const application = createApplication({ repository, origins: [origin],
    verifyToken: async (token) => {
      if (!["owner", "member", "outsider"].includes(token)) throw new Error("Invalid fixture session");
      return { userId: token, expiresAt: Date.now() + 60000 };
    },
  });
  context.after(() => application.close());
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  return "http://127.0.0.1:" + application.server.address().port;
}

// Gửi GET như frontend; không đọc env hoặc sử dụng token tài khoản thật.
function readSharing(baseUrl, roomId, user = "owner", requestOrigin = origin) {
  return fetch(baseUrl + "/api/rooms/" + roomId + "/sharing", {
    headers: { Origin: requestOrigin, ...(user ? { Authorization: "Bearer " + user } : {}) },
  });
}

for (const enabled of [false, true]) {
  // Cả hai chế độ đều đọc được bởi chủ; gọi lặp không đổi link, version, thành viên hoặc nét vẽ.
  test(`owner reads ${enabled ? "shared" : "private"} sharing status without changing project data`, async (context) => {
    const { repository, room, members, queries } = fixture(enabled);
    const before = structuredClone({ room, members });
    const baseUrl = await start(context, repository);
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await readSharing(baseUrl, room.id);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { enabled });
    }
    assert.deepEqual({ room, members }, before);
    assert.equal(queries.length, 4);
    assert.ok(queries.every(({ values }) => values[0] === room.id));
  });
}

// Chặn thiếu/hết phiên, origin lạ và UUID sai trước khi repository nhận bất kỳ truy vấn nào.
test("sharing GET requires valid authentication, origin and project ID", async (context) => {
  const { repository, room, queries } = fixture(true);
  const baseUrl = await start(context, repository);
  for (const [user, expected] of [[null, "AUTH_REQUIRED"], ["expired", "AUTH_EXPIRED"]]) {
    const response = await readSharing(baseUrl, room.id, user);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, expected);
  }
  const deniedOrigin = await readSharing(baseUrl, room.id, "owner", "https://untrusted.example");
  assert.equal(deniedOrigin.status, 403);
  assert.equal((await deniedOrigin.json()).error.code, "ORIGIN_DENIED");
  const invalidId = await readSharing(baseUrl, "not-a-uuid");
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).error.code, "INVALID_INPUT");
  assert.equal(queries.length, 0);
});

// Thành viên chung không có quyền quản lý; người ngoài/phòng thiếu và thành viên cũ của dự án riêng nhận 404.
test("sharing GET rejects members and hides inaccessible projects like missing projects", async (context) => {
  for (const enabled of [false, true]) {
    const { repository, room } = fixture(enabled);
    const baseUrl = await start(context, repository);
    const member = await readSharing(baseUrl, room.id, "member");
    assert.equal(member.status, enabled ? 403 : 404);
    assert.equal((await member.json()).error.code, enabled ? "OWNER_REQUIRED" : "ROOM_NOT_FOUND");
    const denied = await readSharing(baseUrl, room.id, "outsider");
    const missing = await readSharing(baseUrl, randomUUID(), "outsider");
    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await denied.json(), await missing.json());
  }
});

// Lỗi database không được biến thành enabled=false hoặc trả chi tiết kết nối cho client.
test("sharing GET returns a safe service error if the database is unavailable", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  const repository = new PostgresRepository({
    query: async () => { throw Object.assign(new Error("Private database detail"), { code: "08006" }); },
  });
  const baseUrl = await start(context, repository);
  const response = await readSharing(baseUrl, randomUUID());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: { code: "SERVICE_UNAVAILABLE", message: "The service is unavailable. Please retry." },
  });
  assert.equal(errors.mock.calls.length, 1);
});

// Repository development cũng hỗ trợ endpoint; đọc không được đổi metadata hay lộ dự án cho người ngoài.
test("sharing GET works with memory storage and preserves private project metadata", async (context) => {
  const repository = new MemoryRepository();
  const { room } = await repository.createRoom("owner", "Private draft");
  const baseUrl = await start(context, repository);
  const response = await readSharing(baseUrl, room.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { enabled: false });
  assert.deepEqual(await repository.getRoom("owner", room.id), room);
  assert.equal((await readSharing(baseUrl, room.id, "outsider")).status, 404);
});
