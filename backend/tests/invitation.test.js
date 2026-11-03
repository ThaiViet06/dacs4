const assert = require("node:assert/strict");
const { createHash, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { createApplication } = require("../src/application");
const { PostgresRepository } = require("../src/repository");

// Mô phỏng kết quả SQL để test repository thật; không kết nối hay sửa database của người dùng.
function fixture(inviteToken) {
  const roomId = randomUUID();
  const room = { id: roomId, title: "Fixture room", owner_id: "owner", sequence: 0, checkpoint: null, updated_at: "2026-11-03T00:00:00Z" };
  const members = new Set(["owner", "member"]);
  const state = { hash: "original-hash", commits: 0, rollbacks: 0, releases: 0, failWrite: false };
  if (inviteToken) state.hash = createHash("sha256").update(inviteToken).digest("hex");

  // Chỉ hỗ trợ các truy vấn của luồng lời mời; truy vấn ngoài dự kiến làm test thất bại.
  async function query(sql, values = []) {
    if (sql === "BEGIN") return { rows: [] };
    if (sql === "COMMIT") { state.commits++; return { rows: [] }; }
    if (sql === "ROLLBACK") { state.rollbacks++; return { rows: [] }; }
    if (sql.startsWith("SELECT * FROM drawing.rooms")) {
      const found = sql.includes("WHERE invite_hash=") ? values[0] === state.hash : values[0] === roomId;
      return { rows: found ? [room] : [] };
    }
    if (sql.startsWith("SELECT user_id FROM drawing.room_members")) {
      return { rows: values[0] === roomId && members.has(values[1]) ? [{ user_id: values[1] }] : [] };
    }
    if (sql.startsWith("UPDATE drawing.rooms SET invite_hash=")) {
      if (state.failWrite) throw Object.assign(new Error("Fixture database failure"), { code: "08006" });
      assert.equal(values[0], roomId);
      state.hash = values[1];
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO drawing.room_members")) {
      if (state.failWrite) throw Object.assign(new Error("Fixture database failure"), { code: "08006" });
      assert.equal(values[0], roomId);
      if (members.has(values[1]) && !sql.includes("ON CONFLICT DO NOTHING")) {
        throw Object.assign(new Error("Fixture duplicate membership"), { code: "23505" });
      }
      members.add(values[1]);
      return { rows: [] };
    }
    throw new Error("Unexpected fixture query");
  }

  const client = { query, release: () => { state.releases++; } };
  const repository = new PostgresRepository({ query, connect: async () => client });
  return { repository, roomId, members, state };
}

// Chỉ trả token cho chủ phòng; database lưu hash và phát link mới không xóa thành viên hiện tại.
test("owner can issue a hashed invitation and replace the previous link", async () => {
  const { repository, roomId, members, state } = fixture();
  const first = await repository.invitation("owner", roomId);
  assert.deepEqual(Object.keys(first), ["inviteToken"]);
  assert.match(first.inviteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(state.hash, createHash("sha256").update(first.inviteToken).digest("hex"));
  const previousHash = state.hash;
  const second = await repository.invitation("owner", roomId);
  assert.notEqual(first.inviteToken, second.inviteToken);
  assert.notEqual(previousHash, state.hash);
  assert.equal(state.hash, createHash("sha256").update(second.inviteToken).digest("hex"));
  assert.deepEqual([...members], ["owner", "member"]);
  assert.equal(state.commits, 2);
  assert.equal(state.releases, 2);
});

// Có tư cách thành viên vẫn không được thay lời mời nếu không phải chủ phòng.
test("a regular member cannot issue or replace an invitation", async () => {
  const { repository, roomId, state } = fixture();
  await assert.rejects(repository.invitation("member", roomId), { status: 403, code: "OWNER_REQUIRED" });
  assert.equal(state.hash, "original-hash");
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.releases, 1);
});

// Phòng không tồn tại và phòng không có quyền trả cùng lỗi, tránh dò ID phòng của người khác.
test("an outsider and a missing room receive the same safe invitation error", async () => {
  const { repository, roomId, state } = fixture();
  let deniedMessage;
  for (const id of [roomId, randomUUID()]) {
    await assert.rejects(repository.invitation("outsider", id), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "ROOM_NOT_FOUND");
      deniedMessage ??= error.message;
      assert.equal(error.message, deniedMessage);
      return true;
    });
  }
  assert.equal(state.hash, "original-hash");
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 2);
  assert.equal(state.releases, 2);
});

// Database lỗi phải hủy giao dịch và truyền lỗi, không trả token như thể link đã lưu thành công.
test("a failed invitation write is rolled back instead of acknowledged", async () => {
  const { repository, roomId, state } = fixture();
  state.failWrite = true;
  await assert.rejects(repository.invitation("owner", roomId), { code: "08006" });
  assert.equal(state.hash, "original-hash");
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.releases, 1);
});

// Test HTTP dùng danh tính giả cố định; xác minh chữ ký Clerk thật đã có bộ test xác thực riêng.
async function verifyJoiningSession(token) {
  if (token !== "joining-session") throw new Error("Invalid test session");
  return { userId: "joining-user", expiresAt: Date.now() + 60000 };
}

// Kiểm tra route thật với repository PostgreSQL: chặn dữ liệu sai, sau khi join mới đọc được phòng.
test("HTTP invitation joining requires authentication and grants membership only after a valid join", async (context) => {
  const token = "a".repeat(43);
  const { repository, roomId, members } = fixture(token);
  const application = createApplication({ repository, verifyToken: verifyJoiningSession, origins: ["http://localhost:5173"] });
  context.after(() => application.close());
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  const baseUrl = "http://127.0.0.1:" + application.server.address().port;
  const headers = { Authorization: "Bearer joining-session", "Content-Type": "application/json" };

  const unsigned = await fetch(baseUrl + "/api/rooms/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
  assert.equal(unsigned.status, 401);
  const denied = await fetch(baseUrl + "/api/rooms/" + roomId, { headers });
  assert.equal(denied.status, 404);
  for (const body of [{ token: "short" }, { token, ownerId: "joining-user" }]) {
    const invalid = await fetch(baseUrl + "/api/rooms/join", { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(invalid.status, 400);
  }
  assert.equal(members.size, 2);
  for (let attempt = 0; attempt < 2; attempt++) {
    const joined = await fetch(baseUrl + "/api/rooms/join", { method: "POST", headers, body: JSON.stringify({ token }) });
    assert.equal(joined.status, 200);
    const { room } = await joined.json();
    assert.equal(room.id, roomId);
    assert.equal(room.ownerId, "owner");
    assert.equal(room.title, "Fixture room");
  }
  assert.equal(members.size, 3);
  assert.ok(members.has("joining-user"));
  const metadata = await fetch(baseUrl + "/api/rooms/" + roomId, { headers });
  assert.equal(metadata.status, 200);
  const invitation = await fetch(baseUrl + "/api/rooms/" + roomId + "/invitation", { method: "POST", headers });
  assert.equal(invitation.status, 403);
});

// Token đúng định dạng nhưng không trùng hash phải bị từ chối trước khi thêm thành viên.
test("an unknown invitation does not create membership", async () => {
  const { repository, members, state } = fixture("a".repeat(43));
  await assert.rejects(repository.joinRoom("outsider", "b".repeat(43)), { status: 404, code: "INVITATION_INVALID" });
  assert.equal(members.size, 2);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
});

// Phát link mới làm link cũ hết hiệu lực; chỉ link hiện hành thêm được thành viên và không đổi chủ phòng.
test("a replaced invitation cannot be used while the current invitation still works", async () => {
  const previousToken = "a".repeat(43);
  const { repository, roomId, members } = fixture(previousToken);
  const current = await repository.invitation("owner", roomId);
  await assert.rejects(repository.joinRoom("outsider", previousToken), { code: "INVITATION_INVALID" });
  assert.equal(members.size, 2);
  const joined = await repository.joinRoom("outsider", current.inviteToken);
  assert.equal(joined.id, roomId);
  assert.equal(joined.ownerId, "owner");
  assert.ok(members.has("outsider"));
});

// Ghi thành viên lỗi thì không trả thành công và không làm thay đổi các thành viên đang có.
test("a failed membership write rejects invitation joining and rolls back", async () => {
  const token = "a".repeat(43);
  const { repository, members, state } = fixture(token);
  state.failWrite = true;
  await assert.rejects(repository.joinRoom("outsider", token), { code: "08006" });
  assert.equal(members.size, 2);
  assert.equal(state.commits, 0);
  assert.equal(state.rollbacks, 1);
  assert.equal(state.releases, 1);
});
