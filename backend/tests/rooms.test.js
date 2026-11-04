const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { createApplication } = require("../src/application");
const { MemoryRepository } = require("../src/memory-repository");

const origin = "http://localhost:5173";
const sessions = new Map([["test-session-a", "user_a"], ["test-session-b", "user_b"]]);

// Giả lập danh tính đã xác thực để test quyền phòng; chữ ký Clerk được test riêng trong auth.test.js.
async function verifyTestSession(token) {
  const userId = sessions.get(token);
  if (!userId) throw new Error("Invalid test session");
  return { userId, expiresAt: Date.now() + 60000 };
}

// Khởi tạo API thật với repository tạm mới cho mỗi test và tự đóng toàn bộ kết nối khi xong.
async function startApplication(context) {
  const application = createApplication({
    repository: new MemoryRepository(), verifyToken: verifyTestSession, origins: [origin],
  });
  context.after(() => application.close());
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  return "http://127.0.0.1:" + application.server.address().port;
}

// Gửi request như frontend nhưng chỉ dùng hai token giả cục bộ; không đọc khóa hay biến môi trường thật.
function request(baseUrl, path, token, body, method = body === undefined ? "GET" : "POST") {
  return fetch(baseUrl + path, {
    method,
    headers: { Origin: origin, Authorization: "Bearer " + token, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

// Luồng hai người dùng chứng minh owner lấy từ phiên đăng nhập và danh sách/metadata luôn cách ly.
test("HTTP create, list and metadata preserve ownership between two users", async (context) => {
  const baseUrl = await startApplication(context);
  const createdA = await request(baseUrl, "/api/rooms", "test-session-a", { title: "  Phòng A  " });
  const createdB = await request(baseUrl, "/api/rooms", "test-session-b", { title: "Phòng B" });
  assert.equal(createdA.status, 201);
  assert.equal(createdB.status, 201);
  const first = await createdA.json();
  const second = await createdB.json();
  assert.equal(first.room.ownerId, "user_a");
  assert.equal(second.room.ownerId, "user_b");
  assert.equal(first.room.title, "Phòng A");
  assert.deepEqual(Object.keys(first), ["room"]);
  assert.equal(first.room.sharingEnabled, false);
  assert.equal(second.room.sharingEnabled, false);
  const listA = await request(baseUrl, "/api/rooms", "test-session-a");
  const listB = await request(baseUrl, "/api/rooms", "test-session-b");
  assert.equal(listA.status, 200);
  assert.equal(listB.status, 200);
  assert.deepEqual(await listA.json(), { rooms: [first.room] });
  assert.deepEqual(await listB.json(), { rooms: [second.room] });
  const ownRoom = await request(baseUrl, "/api/rooms/" + first.room.id, "test-session-a");
  assert.equal(ownRoom.status, 200);
  assert.deepEqual(await ownRoom.json(), { room: first.room });
  const denied = await request(baseUrl, "/api/rooms/" + first.room.id, "test-session-b");
  const missing = await request(baseUrl, "/api/rooms/" + randomUUID(), "test-session-b");
  assert.equal(denied.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await denied.json(), await missing.json());
});

// Client không được tự chỉ định chủ hoặc chế độ chia sẻ khi tạo dự án Cá nhân.
test("HTTP refuses forged owner and sharing fields without creating a room", async (context) => {
  const baseUrl = await startApplication(context);
  for (const fields of [{ ownerId: "user_b" }, { sharingEnabled: true }, { sharing_version: 1 }]) {
    const response = await request(baseUrl, "/api/rooms", "test-session-a", { title: "Mạo danh", ...fields });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  const listed = await request(baseUrl, "/api/rooms", "test-session-a");
  assert.deepEqual(await listed.json(), { rooms: [] });
});

// Kiểm tra các dữ liệu tạo phòng không hợp lệ đều bị chặn trước khi ghi vào bộ nhớ.
test("HTTP rejects invalid room titles and malformed creation bodies", async (context) => {
  const baseUrl = await startApplication(context);
  for (const body of [{ title: "   " }, { title: "x".repeat(101) }, {}, { title: 123 }]) {
    const response = await request(baseUrl, "/api/rooms", "test-session-a", body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  const listed = await request(baseUrl, "/api/rooms", "test-session-a");
  assert.deepEqual(await listed.json(), { rooms: [] });
});

// Readiness của repository trong bộ nhớ phải hoạt động mà không có PostgreSQL hoặc migration.
test("HTTP readiness works with the in-memory repository", async (context) => {
  const baseUrl = await startApplication(context);
  const response = await fetch(baseUrl + "/readyz");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});

// Chủ đổi tên được, kể cả tên ở hai biên độ dài; tải metadata/danh sách sau đó phải thấy tên mới.
test("HTTP PATCH renames a private project without changing ownership or sharing", async (context) => {
  const baseUrl = await startApplication(context);
  const created = await request(baseUrl, "/api/rooms", "test-session-a", { title: "Original" });
  const { room } = await created.json();
  const path = "/api/rooms/" + room.id;
  for (const title of ["  Bản phác thảo mới  ", "Z", "x".repeat(100)]) {
    const response = await request(baseUrl, path, "test-session-a", { title }, "PATCH");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ["room"]);
    assert.deepEqual(result.room, { ...room, title: title.trim(), updatedAt: result.room.updatedAt });
    assert.ok(Date.parse(result.room.updatedAt) >= Date.parse(room.updatedAt));
    assert.deepEqual(await (await request(baseUrl, path, "test-session-a")).json(), result);
    assert.deepEqual(await (await request(baseUrl, "/api/rooms", "test-session-a")).json(), { rooms: [result.room] });
  }
});

// Chặn thiếu đăng nhập, ID/body sai và giả mạo trường khác; mọi lỗi giữ nguyên tên đã lưu.
test("HTTP PATCH validates authentication, room ID and a title-only body", async (context) => {
  const baseUrl = await startApplication(context);
  const { room } = await (await request(baseUrl, "/api/rooms", "test-session-a", { title: "Original" })).json();
  const path = "/api/rooms/" + room.id;
  const unsigned = await fetch(baseUrl + path, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "Changed" }) });
  assert.equal(unsigned.status, 401);
  for (const body of [{ title: "   " }, { title: "x".repeat(101) }, { title: 123 }, {}, [],
    { title: "Changed", ownerId: "user_b" }, { title: "Changed", sharingEnabled: true }]) {
    const response = await request(baseUrl, path, "test-session-a", body, "PATCH");
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_INPUT");
  }
  assert.equal((await request(baseUrl, "/api/rooms/not-a-uuid", "test-session-a", { title: "Changed" }, "PATCH")).status, 400);
  assert.deepEqual(await (await request(baseUrl, path, "test-session-a")).json(), { room });
});

// Người ngoài không được dò sự tồn tại hoặc sửa tên dự án chỉ nhờ biết UUID.
test("HTTP PATCH hides private projects from outsiders just like a missing project", async (context) => {
  const baseUrl = await startApplication(context);
  const { room } = await (await request(baseUrl, "/api/rooms", "test-session-a", { title: "Original" })).json();
  const denied = await request(baseUrl, "/api/rooms/" + room.id, "test-session-b", { title: "Changed" }, "PATCH");
  const missing = await request(baseUrl, "/api/rooms/" + randomUUID(), "test-session-b", { title: "Changed" }, "PATCH");
  assert.equal(denied.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await denied.json(), await missing.json());
  assert.deepEqual(await (await request(baseUrl, "/api/rooms/" + room.id, "test-session-a")).json(), { room });
});

// Trình duyệt phải được phép gửi PATCH từ origin tin cậy; origin khác vẫn bị chặn trước xác thực.
test("HTTP CORS permits PATCH preflight only from an allowed origin", async (context) => {
  const baseUrl = await startApplication(context);
  for (const allowed of [true, false]) {
    const response = await fetch(baseUrl + "/api/rooms/" + randomUUID(), {
      method: "OPTIONS", headers: { Origin: allowed ? origin : "https://untrusted.example", "Access-Control-Request-Method": "PATCH", "Access-Control-Request-Headers": "authorization,content-type" },
    });
    assert.equal(response.status, allowed ? 204 : 403);
    if (allowed) {
      assert.equal(response.headers.get("access-control-allow-origin"), origin);
      assert.ok(response.headers.get("access-control-allow-methods").split(",").includes("PATCH"));
    } else assert.equal(response.headers.get("access-control-allow-origin"), null);
  }
});
