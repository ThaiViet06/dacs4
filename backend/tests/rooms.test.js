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
function request(baseUrl, path, token, body) {
  return fetch(baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
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
  assert.match(first.inviteToken, /^[A-Za-z0-9_-]{43}$/);
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

// Client không được tự chỉ định chủ phòng bằng dữ liệu gửi lên để mạo danh tài khoản khác.
test("HTTP refuses a forged owner field without creating a room", async (context) => {
  const baseUrl = await startApplication(context);
  const response = await request(baseUrl, "/api/rooms", "test-session-a", { title: "Mạo danh", ownerId: "user_b" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_INPUT");
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
