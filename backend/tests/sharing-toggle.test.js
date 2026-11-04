const assert = require("node:assert/strict");
const { randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createApplication } = require("../src/application");
const { PostgresRepository } = require("../src/repository");
const { MemoryRepository } = require("../src/memory-repository");
const { createShareTokenGenerator } = require("../src/sharing");
const { emptyDocument } = require("../src/protocol");

const origin = "http://localhost:5173";
const shareToken = createShareTokenGenerator("03".repeat(32));
const legacyToken = "L".repeat(43);
const hash = (value) => createHash("sha256").update(value).digest("hex");

// Tạo nét hợp lệ riêng cho mỗi test; không sử dụng ID hoặc tài khoản thật.
function stroke() {
  return { id: randomUUID(), type: "line", color: "#123456", width: 4,
    start: { x: 10, y: 20 }, end: { x: 30, y: 40 } };
}

// Mô phỏng transaction cho repository PostgreSQL thật: rollback giữ nguyên dữ liệu, COMMIT có thể chặn/làm lỗi.
async function setup(context, { enabled = false, generator = shareToken } = {}) {
  const roomId = randomUUID();
  const initialStroke = stroke();
  let stored = {
    room: { id: roomId, owner_id: "owner", title: "Toggle fixture", sharing_enabled: enabled,
      sharing_version: 0, invite_hash: hash(legacyToken), sequence: 1,
      initial_document: emptyDocument(), checkpoint: { title: "Kept checkpoint" }, updated_at: "2026-11-04T00:00:00Z" },
    members: enabled ? ["owner", "member"] : ["owner"],
    operations: [{ operation_id: initialStroke.id, sequence: 1, author_id: "owner", payload: initialStroke }],
  };
  const control = { failAt: "", writes: 0, pause: null, release: null };

  // Chỉ hỗ trợ các truy vấn thực tế của luồng chia sẻ/đồng bộ; ghi dữ liệu chỉ được thực hiện trong transaction.
  async function query(data, sql, values = []) {
    if (sql.startsWith("SELECT * FROM drawing.rooms WHERE id=")) return { rows: values[0] === roomId ? [structuredClone(data.room)] : [] };
    if (sql === "SELECT * FROM drawing.rooms WHERE invite_hash=$1 FOR UPDATE") return { rows: values[0] === data.room.invite_hash ? [structuredClone(data.room)] : [] };
    if (sql.startsWith("SELECT user_id FROM drawing.room_members")) return { rows: values[0] === roomId && data.members.includes(values[1]) ? [{ user_id: values[1] }] : [] };
    if (sql.startsWith("SELECT payload FROM drawing.room_operations")) return { rows: data.operations.filter((row) => row.sequence <= values[1]).map(({ payload }) => ({ payload })) };
    if (sql.startsWith("SELECT sequence,payload,author_id FROM drawing.room_operations")) return { rows: data.operations.filter((row) => row.operation_id === values[1]) };
    assert.notEqual(data, stored, "Writes must use a transaction");
    if (sql === "UPDATE drawing.rooms SET sharing_version=$2,invite_hash=$3 WHERE id=$1 RETURNING *") {
      if (control.failAt === "update") throw Object.assign(new Error("Private fixture upgrade failure"), { code: "08006" });
      assert.equal(values[0], roomId);
      data.room.sharing_version = values[1];
      data.room.invite_hash = values[2];
      control.writes++;
      return { rows: [structuredClone(data.room)] };
    }
    if (sql.startsWith("UPDATE drawing.rooms SET sharing_enabled=")) {
      if (control.failAt === "update") throw Object.assign(new Error("Private fixture write failure"), { code: "08006" });
      assert.equal(values[0], roomId);
      Object.assign(data.room, { sharing_enabled: values[1], sharing_version: values[2], invite_hash: values[3], updated_at: "2026-11-04T01:00:00Z" });
      control.writes++;
      return { rows: [structuredClone(data.room)] };
    }
    if (sql === "DELETE FROM drawing.room_members WHERE room_id=$1 AND user_id<>$2") {
      if (control.failAt === "delete") throw Object.assign(new Error("Private fixture delete failure"), { code: "08006" });
      assert.equal(values[0], roomId);
      assert.equal(values[1], "owner");
      data.members = data.members.filter((user) => user === values[1]);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO drawing.room_members")) {
      assert.equal(values[0], roomId);
      if (!data.members.includes(values[1])) data.members.push(values[1]);
      return { rows: [] };
    }
    if (sql.startsWith("INSERT INTO drawing.room_operations")) {
      data.operations.push({ operation_id: values[1], sequence: values[2], author_id: values[3], payload: JSON.parse(values[4]) });
      return { rows: [] };
    }
    if (sql.startsWith("UPDATE drawing.rooms SET sequence=")) {
      data.room.sequence = values[1];
      return { rows: [] };
    }
    throw new Error("Unexpected toggle fixture query");
  }
  const pool = {
    query: (sql, values) => query(stored, sql, values),
    // Mỗi client có bản nháp độc lập; hàng đợi ứng dụng giữ thứ tự các thao tác cùng dự án.
    async connect() {
      let draft;
      return { release() {}, async query(sql, values) {
        if (sql === "BEGIN") { draft = structuredClone(stored); return { rows: [] }; }
        if (sql === "ROLLBACK") { draft = undefined; return { rows: [] }; }
        if (sql === "COMMIT") {
          if (control.pause) {
            const gate = control.pause;
            control.pause = null;
            gate.reached();
            await gate.wait;
          }
          if (control.failAt === "commit") throw Object.assign(new Error("Private fixture commit failure"), { code: "08006" });
          stored = draft;
          return { rows: [] };
        }
        return query(draft, sql, values);
      } };
    },
  };
  const repository = new PostgresRepository(pool, { shareToken: generator });
  const application = createApplication({ repository, origins: [origin],
    // Danh tính giả chỉ dành cho test; chữ ký Clerk được kiểm tra riêng trong auth.test.js.
    verifyToken: async (token) => {
      if (!["owner", "member", "outsider"].includes(token)) throw new Error("Invalid fixture session");
      return { userId: token, expiresAt: Date.now() + 60000 };
    },
  });
  context.after(async () => { control.release?.(); await application.close(); });
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  const baseUrl = "http://127.0.0.1:" + application.server.address().port;
  // Gửi request HTTP thực với token fixture, không chạm Supabase hoặc .env.local.
  const request = (path, body, user = "owner", method = body === undefined ? "GET" : "POST") => fetch(baseUrl + path, {
    method, headers: { Origin: origin, "Content-Type": "application/json", ...(user ? { Authorization: "Bearer " + user } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const path = "/api/rooms/" + roomId;
  // Gửi thay đổi chế độ như frontend sẽ dùng ở bước sau.
  const toggle = (enabled, user = "owner") => request(path + "/sharing", { enabled }, user, "PATCH");
  return { roomId, path, pool, repository, application, control, request, toggle, stored: () => structuredClone(stored) };
}

// Chặn COMMIT tại điểm xác định để kiểm tra lúc chưa xác nhận hoặc có thao tác cạnh tranh.
function pauseCommit(control) {
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { control.release = resolve; });
  control.pause = { reached, wait };
  return atCommit;
}

// Đợi thao tác sau thực sự vào hàng đợi, có giới hạn thời gian để lỗi hồi quy không treo test.
async function waitForQueuedChange(application, roomId, previous) {
  const deadline = Date.now() + 2000;
  while (application.queue.pending.get(roomId) === previous) {
    if (Date.now() >= deadline) throw new Error("The next room action was not queued");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// Client ws thật, giữ các message đến trước lần await để test không phụ thuộc thứ tự event loop.
async function connect(context, application, user, roomId) {
  const socket = new WebSocket("ws://127.0.0.1:" + application.server.address().port + "/ws", { origin });
  const received = [];
  const messages = [];
  const waiting = [];
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    received.push(message);
    const index = waiting.findIndex((item) => item.type === message.type);
    if (index >= 0) waiting.splice(index, 1)[0].resolve(message);
    else messages.push(message);
  });
  // Lấy đúng loại phản hồi, kể cả message đã nhận trước đó.
  function next(type) {
    const index = messages.findIndex((message) => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
    return new Promise((resolve) => waiting.push({ type, resolve }));
  }
  // Gửi thông điệp theo protocol hiện tại của ứng dụng.
  function send(type, data) { socket.send(JSON.stringify({ v: 1, type, ...data })); }
  context.after(() => socket.terminate());
  await once(socket, "open");
  send("auth", { token: user });
  await next("auth.ok");
  send("room.join", { roomId });
  return { socket, send, next, received };
}

// Bật và retry không đổi link/thời gian hoặc bản vẽ; repository mới lấy lại đúng token sau restart.
test("sharing PATCH enables a private project with a durable idempotent invitation", async (context) => {
  const { toggle, stored, control, repository, pool, roomId, request, path } = await setup(context);
  const before = stored();
  const response = await toggle(true);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.enabled, true);
  assert.equal(result.room.sharingEnabled, true);
  assert.match(result.inviteToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(stored().room.invite_hash, hash(result.inviteToken));
  assert.equal(stored().room.sharing_version, 1);
  assert.deepEqual(await (await toggle(true)).json(), result);
  assert.equal(control.writes, 1);
  const recreated = new PostgresRepository(pool, { shareToken: createShareTokenGenerator("03".repeat(32)) });
  assert.deepEqual(await recreated.invitation("owner", roomId), { inviteToken: result.inviteToken });
  assert.deepEqual(await recreated.getSharing("owner", roomId), { enabled: true, inviteToken: result.inviteToken });
  assert.deepEqual(await (await request(path + "/sharing")).json(), { enabled: true, inviteToken: result.inviteToken });
  assert.deepEqual(await (await request(path + "/invitation", {}, "owner")).json(), { inviteToken: result.inviteToken });
  assert.equal(control.writes, 1);
  const after = stored();
  assert.deepEqual(after.operations, before.operations);
  for (const key of ["id", "title", "owner_id", "sequence", "initial_document", "checkpoint"]) assert.deepEqual(after.room[key], before.room[key]);
  assert.equal((await repository.joinRoom("member", result.inviteToken)).id, roomId);
});

// Tắt xóa quyền/link; bật lại không khôi phục thành viên cũ và token trước đó không join được nữa.
test("sharing PATCH revokes invitations and memberships without changing saved drawing data", async (context) => {
  const { toggle, stored, repository, roomId, control } = await setup(context, { enabled: true });
  const before = stored();
  const disabled = await (await toggle(false)).json();
  assert.equal(disabled.enabled, false);
  assert.ok(!Object.hasOwn(disabled, "inviteToken"));
  assert.deepEqual(stored().members, ["owner"]);
  assert.notEqual(stored().room.invite_hash, before.room.invite_hash);
  assert.deepEqual(await (await toggle(false)).json(), disabled);
  assert.equal(control.writes, 1);
  await assert.rejects(repository.joinRoom("member", legacyToken), { code: "INVITATION_INVALID" });
  const enabled = await (await toggle(true)).json();
  await assert.rejects(repository.getRoom("member", roomId), { code: "ROOM_NOT_FOUND" });
  await assert.rejects(repository.joinRoom("member", legacyToken), { code: "INVITATION_INVALID" });
  await repository.joinRoom("member", enabled.inviteToken);
  await toggle(false);
  const enabledAgain = await (await toggle(true)).json();
  assert.notEqual(enabledAgain.inviteToken, enabled.inviteToken);
  await assert.rejects(repository.joinRoom("member", enabled.inviteToken), { code: "INVITATION_INVALID" });
  assert.deepEqual(stored().operations, before.operations);
  assert.equal(stored().room.sequence, before.room.sequence);
});

// Đọc/bật lại dự án chung version 0 không được âm thầm thay lời mời cũ đã gửi cho người khác.
test("an unchanged legacy shared project keeps its existing invitation", async (context) => {
  const { toggle, stored, repository, roomId, control } = await setup(context, { enabled: true });
  const before = stored();
  const result = await (await toggle(true)).json();
  assert.equal(result.enabled, true);
  assert.ok(!Object.hasOwn(result, "inviteToken"));
  assert.deepEqual(stored(), before);
  assert.equal(control.writes, 0);
  await repository.joinRoom("outsider", legacyToken);
  assert.equal((await repository.getRoom("outsider", roomId)).id, roomId);
});

// Chặn sửa chế độ qua phiên sai, body giả mạo, ID sai hoặc tài khoản không phải chủ.
test("sharing PATCH validates authentication, ownership, ID and a boolean-only body", async (context) => {
  const { request, toggle, path, stored, control } = await setup(context, { enabled: true });
  const before = stored();
  for (const user of [null, "expired"]) assert.equal((await toggle(false, user)).status, 401);
  assert.equal((await toggle(false, "member")).status, 403);
  const denied = await toggle(false, "outsider");
  const missing = await request("/api/rooms/" + randomUUID() + "/sharing", { enabled: false }, "outsider", "PATCH");
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), await missing.json());
  for (const body of [{}, [], null, { enabled: "false" }, { enabled: 1 }, { enabled: false, version: 1 }, { enabled: false, ownerId: "member" }]) {
    assert.equal((await request(path + "/sharing", body, "owner", "PATCH")).status, 400);
  }
  assert.equal((await request("/api/rooms/not-a-uuid/sharing", { enabled: false }, "owner", "PATCH")).status, 400);
  assert.deepEqual(stored(), before);
  assert.equal(control.writes, 0);
});

for (const failAt of ["update", "delete", "commit"]) {
  // Transaction lỗi phải giữ cả quyền/link; không ngắt người đang vẽ hoặc trả thành công giả.
  test(`sharing PATCH rolls back ${failAt} failure without disconnecting collaborators`, { timeout: 5000 }, async (context) => {
    context.mock.method(console, "error", () => {});
    const { toggle, stored, control, application, roomId } = await setup(context, { enabled: true });
    const member = await connect(context, application, "member", roomId);
    await member.next("room.state");
    const before = stored();
    control.failAt = failAt;
    const response = await toggle(false);
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
    assert.deepEqual(stored(), before);
    assert.equal(member.socket.readyState, WebSocket.OPEN);
    control.failAt = "";
    member.send("operation.commit", { operation: stroke() });
    assert.equal((await member.next("operation.committed")).sequence, 2);
  });
}

// Thiếu/đổi nhầm khóa không được thay link âm thầm; chủ vẫn có thể tắt chia sẻ để thu quyền.
test("missing or mismatched sharing keys fail safely while disabling remains available", async (context) => {
  const first = await setup(context, { generator: null });
  const before = first.stored();
  assert.equal((await first.toggle(true)).status, 503);
  assert.deepEqual(first.stored(), before);
  const second = await setup(context, { enabled: true, generator: null });
  assert.equal((await second.toggle(false)).status, 200);
  assert.deepEqual(second.stored().members, ["owner"]);
  const third = await setup(context);
  await third.toggle(true);
  third.repository.shareToken = createShareTokenGenerator("04".repeat(32));
  const enabledState = third.stored();
  assert.equal((await third.toggle(true)).status, 503);
  assert.deepEqual(third.stored(), enabledState);
  assert.equal((await third.toggle(false)).status, 200);
});

// COMMIT tắt chưa xong thì thành viên còn kết nối; khi xong, frame xếp sau bị chặn và chủ vẫn vẽ được.
test("sharing revocation closes member sockets only after commit and blocks queued previews and strokes", { timeout: 5000 }, async (context) => {
  const { application, roomId, toggle, control, stored } = await setup(context, { enabled: true });
  const owner = await connect(context, application, "owner", roomId);
  await owner.next("room.state");
  const member = await connect(context, application, "member", roomId);
  await member.next("room.state");
  const atCommit = pauseCommit(control);
  const pending = toggle(false);
  await atCommit;
  assert.equal(stored().room.sharing_enabled, true);
  assert.equal(member.socket.readyState, WebSocket.OPEN);
  const closing = once(member.socket, "close");
  const blockedStroke = stroke();
  const previous = application.queue.pending.get(roomId);
  member.send("operation.preview", { operation: blockedStroke });
  member.send("operation.commit", { operation: blockedStroke });
  await waitForQueuedChange(application, roomId, previous);
  control.release();
  assert.equal((await pending).status, 200);
  assert.equal((await closing)[0], 4403);
  assert.equal(owner.socket.readyState, WebSocket.OPEN);
  owner.send("operation.commit", { operation: stroke() });
  assert.equal((await owner.next("operation.committed")).sequence, 2);
  assert.ok(!owner.received.some((message) => message.operation?.id === blockedStroke.id));
  assert.equal(stored().operations.length, 2);
  const returned = await connect(context, application, "member", roomId);
  assert.equal((await returned.next("error")).code, "ROOM_NOT_FOUND");
});

// Nét được xếp trước thao tác tắt phải lưu/ack trước; đổi chế độ không làm lùi sequence.
test("a stroke queued before sharing revocation commits before memberships are removed", { timeout: 5000 }, async (context) => {
  const { application, roomId, toggle, control, stored } = await setup(context, { enabled: true });
  const member = await connect(context, application, "member", roomId);
  await member.next("room.state");
  const atCommit = pauseCommit(control);
  const operation = stroke();
  member.send("operation.commit", { operation });
  await atCommit;
  const ack = member.next("operation.committed");
  const closing = once(member.socket, "close");
  const previous = application.queue.pending.get(roomId);
  const pending = toggle(false);
  await waitForQueuedChange(application, roomId, previous);
  control.release();
  assert.equal((await ack).sequence, 2);
  assert.equal((await pending).status, 200);
  assert.equal((await closing)[0], 4403);
  assert.equal(stored().room.sequence, 2);
  assert.deepEqual(stored().operations.at(-1).payload, operation);
});

// Repository tạm dùng chung chính sách token; bật/tắt không đổi ID, tên hoặc sequence đã có.
test("memory storage uses the same sharing policy and rejects nonowners", async () => {
  const repository = new MemoryRepository({ shareToken });
  const { room } = await repository.createRoom("owner", "Memory project");
  const enabled = await repository.setSharing("owner", room.id, true);
  assert.deepEqual(await repository.upgradeInvitation("owner", room.id), enabled);
  await assert.rejects(repository.upgradeInvitation("outsider", room.id), { code: "ROOM_NOT_FOUND" });
  assert.deepEqual(await repository.getSharing("owner", room.id), { enabled: true, inviteToken: enabled.inviteToken });
  assert.deepEqual(await repository.setSharing("owner", room.id, true), enabled);
  await assert.rejects(repository.setSharing("outsider", room.id, false), { code: "ROOM_NOT_FOUND" });
  repository.shareToken = null;
  const disabled = await repository.setSharing("owner", room.id, false);
  assert.equal(disabled.room.id, room.id);
  assert.equal(disabled.room.title, room.title);
  assert.equal(disabled.room.sequence, room.sequence);
  assert.equal(disabled.enabled, false);
  await assert.rejects(repository.upgradeInvitation("owner", room.id), { code: "SHARING_DISABLED" });
});

// Link cũ đổi sau COMMIT, thành viên/socket không bị ngắt và tiếp tục gửi nét; retry không xoay link lần nữa.
test("confirmed legacy upgrade preserves drawing and connected members and retries return the same link", { timeout: 5000 }, async (context) => {
  const { application, roomId, repository, pool, request, path, control, stored } = await setup(context, { enabled: true });
  const member = await connect(context, application, "member", roomId);
  await member.next("room.state");
  const before = stored();
  const atCommit = pauseCommit(control);
  const pending = request(path + "/sharing/upgrade", { confirmed: true });
  await atCommit;
  assert.deepEqual(stored(), before);
  assert.equal(member.socket.readyState, WebSocket.OPEN);
  const previous = application.queue.pending.get(roomId);
  const concurrent = request(path + "/sharing/upgrade", { confirmed: true });
  await waitForQueuedChange(application, roomId, previous);
  control.release();
  const response = await pending;
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(await (await concurrent).json(), result);
  assert.equal(result.enabled, true);
  assert.equal(result.room.id, roomId);
  assert.equal(result.inviteToken, shareToken(roomId, 1));
  assert.deepEqual(stored(), { ...before, room: { ...before.room, sharing_version: 1, invite_hash: hash(result.inviteToken) } });
  assert.deepEqual(await (await request(path + "/sharing/upgrade", { confirmed: true })).json(), result);
  assert.equal(control.writes, 1);
  const recreated = new PostgresRepository(pool, { shareToken: createShareTokenGenerator("03".repeat(32)) });
  assert.deepEqual(await recreated.getSharing("owner", roomId), { enabled: true, inviteToken: result.inviteToken });
  await assert.rejects(repository.joinRoom("outsider", legacyToken), { code: "INVITATION_INVALID" });
  await repository.joinRoom("outsider", result.inviteToken);
  assert.equal(member.socket.readyState, WebSocket.OPEN);
  member.send("operation.commit", { operation: stroke() });
  assert.equal((await member.next("operation.committed")).sequence, 2);
});

// Yêu cầu rõ ràng của chủ mới được thay link; dữ liệu giả mạo hoặc thiếu xác nhận bị chặn trước khi ghi.
test("invitation upgrade validates confirmation, authentication, ownership and project state", async (context) => {
  const { request, path, toggle, stored, control } = await setup(context, { enabled: true });
  const upgradePath = path + "/sharing/upgrade";
  const before = stored();
  for (const user of [null, "expired"]) assert.equal((await request(upgradePath, { confirmed: true }, user)).status, 401);
  assert.equal((await request(upgradePath, { confirmed: true }, "member")).status, 403);
  const denied = await request(upgradePath, { confirmed: true }, "outsider");
  const missing = await request("/api/rooms/" + randomUUID() + "/sharing/upgrade", { confirmed: true }, "outsider");
  assert.equal(denied.status, 404);
  assert.deepEqual(await denied.json(), await missing.json());
  for (const body of [{}, null, [], { confirmed: false }, { confirmed: "true" }, { confirmed: true, ownerId: "member" }, { confirmed: true, version: 4 }]) {
    assert.equal((await request(upgradePath, body)).status, 400);
  }
  assert.equal((await request("/api/rooms/not-a-uuid/sharing/upgrade", { confirmed: true })).status, 400);
  assert.equal(control.writes, 0);
  assert.deepEqual(stored(), before);
  await toggle(false);
  const disabled = stored();
  const response = await request(upgradePath, { confirmed: true });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "SHARING_DISABLED");
  assert.deepEqual(stored(), disabled);
});

for (const failAt of ["update", "commit"]) {
  // Lỗi nâng link phải giữ token cũ và toàn bộ thành viên; không trả link mới như thể đã lưu thành công.
  test(`legacy invitation upgrade rolls back ${failAt} failure without replacing the old link`, async (context) => {
    context.mock.method(console, "error", () => {});
    const { request, path, control, stored, repository } = await setup(context, { enabled: true });
    const before = stored();
    control.failAt = failAt;
    const response = await request(path + "/sharing/upgrade", { confirmed: true });
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(await response.json()), ["error"]);
    assert.deepEqual(stored(), before);
    control.failAt = "";
    await repository.joinRoom("outsider", legacyToken);
    assert.ok(stored().members.includes("outsider"));
  });
}

// Không âm thầm tạo khóa khác khi nâng link; thiếu khóa vẫn giữ nguyên link đang dùng.
test("legacy invitation upgrade with no sharing key preserves the current invitation", async (context) => {
  const { request, path, stored } = await setup(context, { enabled: true, generator: null });
  const before = stored();
  const response = await request(path + "/sharing/upgrade", { confirmed: true });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "SHARING_UNAVAILABLE");
  assert.deepEqual(stored(), before);
});
