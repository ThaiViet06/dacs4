const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createApplication } = require("../src/application");
const { PostgresRepository } = require("../src/repository");
const { emptyDocument } = require("../src/protocol");

const origin = "http://localhost:5173";

// Mô phỏng giao dịch SQL cho repository thật: dữ liệu chỉ tồn tại bền sau COMMIT, có thể chặn/làm lỗi bước này.
async function setup(context, { sharingEnabled = true } = {}) {
  const roomId = randomUUID();
  let stored = { room: { id: roomId, title: "Collaboration test", owner_id: "owner", sequence: 0,
    sharing_enabled: sharingEnabled, sharing_version: 0,
    initial_document: emptyDocument(), checkpoint: null }, operations: [] };
  const control = { failCommit: false, pause: null, release: null };
  const pool = {
    // Mỗi transaction có bản dữ liệu riêng; rollback không làm thay đổi dữ liệu đã lưu.
    async connect() {
      let draft;
      return {
        release() {},
        // Chỉ hỗ trợ đúng các truy vấn state/commit cần kiểm chứng; truy vấn ngoài phạm vi sẽ làm test thất bại.
        async query(sql, values = []) {
          if (sql === "BEGIN") { draft = structuredClone(stored); return { rows: [] }; }
          if (sql === "ROLLBACK") { draft = undefined; return { rows: [] }; }
          if (sql === "COMMIT") {
            if (control.pause) {
              const gate = control.pause;
              control.pause = null;
              gate.reached();
              await gate.wait;
            }
            if (control.failCommit) throw Object.assign(new Error("Fixture commit failure"), { code: "08006" });
            stored = draft;
            return { rows: [] };
          }
          if (sql.startsWith("SELECT * FROM drawing.rooms WHERE id=")) {
            return { rows: values[0] === roomId ? [draft.room] : [] };
          }
          if (sql.startsWith("SELECT user_id FROM drawing.room_members")) {
            return { rows: values[0] === roomId && ["owner", "member"].includes(values[1]) ? [{ user_id: values[1] }] : [] };
          }
          if (sql.startsWith("SELECT sequence,payload,author_id FROM drawing.room_operations")) {
            return { rows: draft.operations.filter((row) => row.operation_id === values[1]) };
          }
          if (sql.startsWith("SELECT payload FROM drawing.room_operations")) {
            return { rows: draft.operations.filter((row) => row.sequence <= values[1])
              .sort((a, b) => a.sequence - b.sequence).map(({ payload }) => ({ payload })) };
          }
          if (sql.startsWith("INSERT INTO drawing.room_operations")) {
            assert.ok(!draft.operations.some((row) => row.operation_id === values[1] || row.sequence === values[2]));
            draft.operations.push({ operation_id: values[1], sequence: values[2], author_id: values[3], payload: JSON.parse(values[4]) });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE drawing.rooms SET sequence=")) {
            draft.room.sequence = values[1];
            return { rows: [] };
          }
          throw new Error("Unexpected collaboration fixture query");
        },
      };
    },
  };
  const application = createApplication({ repository: new PostgresRepository(pool), origins: [origin],
    // Dùng hai phiên giả; kiểm chứng chữ ký Clerk thật đã có trong auth.test.js.
    verifyToken: async (token) => {
      if (!["owner", "member"].includes(token)) throw new Error("Invalid fixture session");
      return { userId: token, expiresAt: Date.now() + 60000 };
    },
  });
  context.after(async () => { control.release?.(); await application.close(); });
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  const url = "ws://127.0.0.1:" + application.server.address().port + "/ws";

  // Mở client ws thật và xác thực riêng để test cả trường hợp chưa thể tham gia vì hết chỗ.
  async function connect(user) {
    const socket = new WebSocket(url, { origin });
    const received = [];
    const waiting = [];
    const messages = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      const index = waiting.findIndex((item) => item.types.includes(message.type));
      if (index >= 0) waiting.splice(index, 1)[0].resolve(message);
      else messages.push(message);
    });
    // Chờ một trong các loại phản hồi, kể cả khi message đã tới trước lúc test bắt đầu chờ.
    function next(...types) {
      const index = messages.findIndex((message) => types.includes(message.type));
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve) => waiting.push({ types, resolve }));
    }
    // Gửi thông điệp đúng phiên bản giao thức cho server thật.
    function send(type, data) { socket.send(JSON.stringify({ v: 2, type, ...data })); }
    await once(socket, "open");
    send("auth", { token: user });
    await next("auth.ok");
    return { socket, next, send, received };
  }
  // Các test vẽ vẫn dùng bước tham gia hoàn chỉnh và nhận trạng thái trước khi gửi nét.
  async function join(user) {
    const client = await connect(user);
    client.send("room.join", { roomId });
    return { ...client, state: await client.next("room.state") };
  }
  return { join, connect, roomId, control, stored: () => stored };
}

// Tạo nét có UUID mới; hình và tẩy dùng cùng giao thức operation.commit.
function stroke(type = "line") {
  const base = { id: randomUUID(), type, color: "#123456", width: 4 };
  return type === "eraser" ? { ...base, points: [{ x: 30, y: 40 }] }
    : { ...base, start: { x: 10, y: 20 }, end: { x: 30, y: 40 } };
}

// Tạo sự kiện lịch sử riêng với nét gốc; chỉ gửi qua operation.commit ở giao thức v2.
function visibility(targetId, visible = false) {
  return { id: randomUUID(), type: "visibility", targetId, visible };
}

// Mười socket có thể thuộc cùng hai tài khoản; socket thứ 11 không được nhận Canvas hoặc ghi nét.
test("a full project rejects the eleventh connection without leaking state or saving its strokes", { timeout: 10000 }, async (context) => {
  const { join, connect, roomId, stored } = await setup(context);
  const clients = [];
  for (let index = 0; index < 10; index++) clients.push(await join(index % 2 ? "member" : "owner"));
  const observer = clients.at(-1);
  const presence = await observer.next("presence");
  assert.equal(presence.members.length, 10);
  assert.equal(new Set(presence.members.map(({ userId }) => userId)).size, 2);
  const blocked = await connect("member");
  blocked.send("room.join", { roomId });
  assert.equal((await blocked.next("error")).code, "ROOM_FULL");
  const rejected = stroke();
  blocked.send("operation.commit", { operation: rejected });
  const error = await blocked.next("error");
  assert.equal(error.code, "JOIN_REQUIRED");
  assert.equal(error.operationId, rejected.id);
  assert.equal(stored().room.sequence, 0);
  assert.equal(stored().operations.length, 0);
  // Người đang ở trong dự án vẫn vẽ được; socket bị chặn không nhận bản vẽ hoặc presence.
  clients[0].send("operation.commit", { operation: stroke() });
  const saved = await clients[0].next("operation.committed");
  assert.equal(saved.sequence, 1);
  assert.deepEqual(await observer.next("operation.committed"), saved);
  assert.ok(!blocked.received.some(({ type }) => ["room.state", "presence", "operation.committed"].includes(type)));
});

// Hàng đợi phải cấp chỗ cuối đúng một lần; tham gia lại trên socket đang có không chiếm thêm chỗ.
test("simultaneous joins cannot exceed capacity and an existing socket keeps its single slot", { timeout: 10000 }, async (context) => {
  const { join, connect, roomId } = await setup(context);
  for (let index = 0; index < 9; index++) await join("owner");
  const contenders = await Promise.all([connect("owner"), connect("member")]);
  for (const client of contenders) client.send("room.join", { roomId });
  const results = await Promise.all(contenders.map((client) => client.next("room.state", "error")));
  assert.equal(results.filter(({ type }) => type === "room.state").length, 1);
  assert.equal(results.filter(({ code }) => code === "ROOM_FULL").length, 1);
  const admitted = contenders[results.findIndex(({ type }) => type === "room.state")];
  const blocked = contenders.find((client) => client !== admitted);
  assert.equal((await admitted.next("presence")).members.length, 10);
  admitted.send("room.join", { roomId });
  assert.equal((await admitted.next("room.state")).room.id, roomId);
  const presence = await admitted.next("presence");
  assert.equal(presence.members.length, 10);
  assert.equal(new Set(presence.members.map(({ clientId }) => clientId)).size, 10);
  blocked.send("room.join", { roomId });
  assert.equal((await blocked.next("error")).code, "ROOM_FULL");
});

// Rời dự án giải phóng đúng một chỗ; client nối lại phải nhận đủ nét cũ rồi mới vẽ tiếp.
test("closing a member socket frees a slot and a new connection restores the saved drawing", { timeout: 10000 }, async (context) => {
  const { join, connect, roomId, stored } = await setup(context);
  const clients = [];
  for (let index = 0; index < 10; index++) clients.push(await join(index % 2 ? "member" : "owner"));
  const observer = clients.at(-1);
  assert.equal((await observer.next("presence")).members.length, 10);
  const original = stroke();
  clients[0].send("operation.commit", { operation: original });
  await clients[0].next("operation.committed");
  await observer.next("operation.committed");
  const blocked = await connect("member");
  blocked.send("room.join", { roomId });
  assert.equal((await blocked.next("error")).code, "ROOM_FULL");
  const rejectedClosed = once(blocked.socket, "close");
  blocked.socket.close();
  await rejectedClosed;
  const closed = once(clients[0].socket, "close");
  clients[0].socket.close();
  await closed;
  assert.equal((await observer.next("presence")).members.length, 9);
  const returned = await join("member");
  assert.equal(returned.state.sequence, 1);
  assert.deepEqual(returned.state.document.operations, [original]);
  assert.equal((await returned.next("presence")).members.length, 10);
  returned.send("operation.commit", { operation: stroke() });
  const saved = await returned.next("operation.committed");
  assert.equal(saved.sequence, 2);
  assert.deepEqual(await observer.next("operation.committed"), saved);
  assert.equal(stored().operations.length, 2);
});

test("v2 visibility broadcasts after COMMIT, retries once and reloads the complete history", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context, { sharingEnabled: false });
  const owner = await join("owner");
  const mirror = await join("owner");
  assert.equal(owner.state.v, 2);
  assert.equal(owner.state.document.version, 1);
  const original = stroke("eraser");
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await mirror.next("operation.committed");
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { control.release = resolve; });
  control.pause = { reached, wait };
  const hidden = visibility(original.id);
  owner.send("operation.commit", { operation: hidden });
  await atCommit;
  try {
    assert.equal(stored().operations.length, 1);
    assert.ok(!mirror.received.some((message) => message.operation?.id === hidden.id));
  } finally { control.release(); }
  const committed = await owner.next("operation.committed");
  assert.deepEqual(await mirror.next("operation.committed"), committed);
  assert.equal(committed.v, 2);
  assert.equal(committed.sequence, 2);
  owner.send("operation.commit", { operation: hidden });
  assert.equal((await owner.next("operation.committed")).duplicate, true);
  assert.equal(stored().operations.length, 2);
  const returned = await join("owner");
  assert.deepEqual(returned.state.document, { ...emptyDocument(), version: 2, operations: [original, hidden] });
  const shown = visibility(original.id, true);
  owner.send("operation.commit", { operation: shown });
  assert.equal((await mirror.next("operation.committed")).sequence, 3);
  assert.deepEqual((await join("owner")).state.document.operations, [original, hidden, shown]);
});

test("v2 visibility rollback sends an error and the same UUID can retry without a false acknowledgement", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context, { sharingEnabled: false });
  const owner = await join("owner");
  const mirror = await join("owner");
  const original = stroke();
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await mirror.next("operation.committed");
  control.failCommit = true;
  const hidden = visibility(original.id);
  owner.send("operation.commit", { operation: hidden });
  const error = await owner.next("error");
  assert.equal(error.operationId, hidden.id);
  assert.equal(error.code, "SERVICE_UNAVAILABLE");
  assert.equal(stored().room.sequence, 1);
  control.failCommit = false;
  owner.send("operation.commit", { operation: hidden });
  assert.equal((await owner.next("operation.committed")).sequence, 2);
  assert.equal((await mirror.next("operation.committed")).sequence, 2);
  assert.equal(stored().operations.length, 2);
  assert.equal(mirror.received.filter((message) => message.type === "operation.committed" && message.operation.id === hidden.id).length, 1);
});

test("a lost visibility acknowledgement reloads hidden stroke IDs and retry returns the original sequence", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context, { sharingEnabled: false });
  const owner = await join("owner");
  const mirror = await join("owner");
  const original = stroke();
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await mirror.next("operation.committed");
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { control.release = resolve; });
  control.pause = { reached, wait };
  const hidden = visibility(original.id);
  owner.send("operation.commit", { operation: hidden });
  await atCommit;
  try {
    const closed = once(owner.socket, "close");
    owner.socket.terminate();
    await closed;
  } finally { control.release(); }
  assert.equal((await mirror.next("operation.committed")).sequence, 2);
  const returned = await join("owner");
  assert.deepEqual(returned.state.document.operations, [original, hidden]);
  returned.send("operation.commit", { operation: hidden });
  const retry = await returned.next("operation.committed");
  assert.equal(retry.sequence, 2);
  assert.equal(retry.duplicate, true);
  assert.equal(stored().operations.length, 2);
});

test("shared project owners and members cannot create visibility through v2", { timeout: 5000 }, async (context) => {
  const { join, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  const original = stroke();
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await member.next("operation.committed");
  for (const [client, code] of [[owner, "PERSONAL_MODE_REQUIRED"], [member, "OWNER_REQUIRED"]]) {
    const hidden = visibility(original.id);
    client.send("operation.commit", { operation: hidden });
    const error = await client.next("error");
    assert.equal(error.code, code);
    assert.equal(error.operationId, hidden.id);
  }
  assert.equal(stored().operations.length, 1);
  assert.equal(stored().room.sequence, 1);
});

test("v2 schema failures identify pending events and visibility is never broadcast as a preview", { timeout: 5000 }, async (context) => {
  const { join } = await setup(context, { sharingEnabled: false });
  const owner = await join("owner");
  const mirror = await join("owner");
  const original = stroke();
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await mirror.next("operation.committed");
  const hidden = visibility(original.id);
  owner.send("operation.preview", { operation: hidden });
  const previewError = await owner.next("error");
  assert.equal(previewError.operationId, hidden.id);
  assert.equal(previewError.code, "INVALID_INPUT");
  owner.send("operation.commit", { operation: { ...hidden, visible: "false" } });
  assert.equal((await owner.next("error")).operationId, hidden.id);
  owner.send("operation.commit", { operation: hidden });
  await mirror.next("operation.committed");
  assert.ok(!mirror.received.some((message) => message.type === "operation.preview" || message.type === "preview.cancel"));
});

// Server chỉ xác nhận/phát sau COMMIT; gửi trùng ID không tạo thêm nét và client mới nhận lại bản vẽ đã lưu.
test("persisted strokes reach both clients, retry once, and reload from room state", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { control.release = resolve; });
  control.pause = { reached, wait };
  const operation = stroke();
  owner.send("operation.commit", { operation });
  await atCommit;
  try {
    assert.equal(stored().operations.length, 0);
    for (const client of [owner, member]) assert.ok(!client.received.some((message) => message.type === "operation.committed"));
  } finally { control.release(); }
  const saved = await owner.next("operation.committed");
  assert.deepEqual(await member.next("operation.committed"), saved);
  assert.equal(saved.sequence, 1);
  assert.deepEqual(saved.operation, operation);
  assert.equal(stored().operations.length, 1);
  owner.send("operation.commit", { operation });
  assert.equal((await owner.next("operation.committed")).duplicate, true);
  assert.equal(stored().operations.length, 1);
  const reloaded = await join("member");
  assert.equal(reloaded.state.sequence, 1);
  assert.deepEqual(reloaded.state.document.operations, [operation]);
});

// Hai client vẽ/tẩy cùng lúc vẫn nhận cùng sequence và thứ tự đã lưu trong repository.
test("concurrent drawing and erasing converge to the same server order", { timeout: 5000 }, async (context) => {
  const { join, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  owner.send("operation.commit", { operation: stroke() });
  member.send("operation.commit", { operation: stroke("eraser") });
  const first = [await owner.next("operation.committed"), await owner.next("operation.committed")];
  const second = [await member.next("operation.committed"), await member.next("operation.committed")];
  assert.deepEqual(first, second);
  assert.deepEqual(first.map(({ sequence }) => sequence), [1, 2]);
  assert.deepEqual(first.map(({ operation }) => operation), stored().operations.map(({ payload }) => payload));
});

// Database lỗi không được phát operation.committed hoặc để lại nét/sequence chưa lưu.
test("a failed transaction returns an error without acknowledging or broadcasting a stroke", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  control.failCommit = true;
  const operation = stroke();
  owner.send("operation.commit", { operation });
  const error = await owner.next("error");
  assert.equal(error.code, "SERVICE_UNAVAILABLE");
  assert.equal(error.operationId, operation.id);
  assert.equal(stored().room.sequence, 0);
  assert.equal(stored().operations.length, 0);
  for (const client of [owner, member]) assert.ok(!client.received.some((message) => message.type === "operation.committed"));
  // Retry cùng UUID sau rollback phải lưu được đúng một lần, không coi nét chưa lưu là duplicate.
  control.failCommit = false;
  const closed = once(owner.socket, "close");
  owner.socket.terminate();
  await closed;
  const returned = await join("owner");
  assert.equal(returned.state.sequence, 0);
  returned.send("operation.commit", { operation });
  const saved = await returned.next("operation.committed");
  assert.equal(saved.sequence, 1);
  assert.equal(saved.duplicate, false);
  assert.deepEqual(await member.next("operation.committed"), saved);
  assert.equal(stored().operations.length, 1);
});

// Nhiều nét lỗi trong một đợt phải rollback, giữ nét cũ và retry từng UUID đúng một lần sau phục hồi.
test("a write outage preserves the last saved drawing and retries queued strokes without duplicates", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  const original = stroke();
  owner.send("operation.commit", { operation: original });
  await owner.next("operation.committed");
  await member.next("operation.committed");
  const pending = [stroke(), stroke("eraser")];
  control.failCommit = true;
  for (const operation of pending) {
    owner.send("operation.commit", { operation });
    const error = await owner.next("error");
    assert.equal(error.code, "SERVICE_UNAVAILABLE");
    assert.equal(error.operationId, operation.id);
  }
  assert.equal(stored().room.sequence, 1);
  assert.deepEqual(stored().operations.map(({ payload }) => payload), [original]);
  assert.ok(!member.received.some((message) => pending.some((operation) => message.operation?.id === operation.id)));
  control.failCommit = false;
  const closed = once(owner.socket, "close");
  owner.socket.close();
  await closed;
  const returned = await join("owner");
  assert.equal(returned.state.sequence, 1);
  assert.deepEqual(returned.state.document.operations, [original]);
  for (const [index, operation] of pending.entries()) {
    returned.send("operation.commit", { operation });
    const saved = await returned.next("operation.committed");
    assert.equal(saved.sequence, index + 2);
    assert.equal(saved.duplicate, false);
    assert.deepEqual(await member.next("operation.committed"), saved);
  }
  returned.send("operation.commit", { operation: pending[0] });
  const duplicate = await returned.next("operation.committed");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, 2);
  assert.equal(stored().room.sequence, 3);
  assert.equal(stored().operations.length, 3);
  assert.equal(new Set(stored().operations.map(({ operation_id }) => operation_id)).size, 3);
});

// Một client mất kết nối không cản client còn lại vẽ; khi trở lại phải nhận đủ nét đã lưu theo sequence.
test("a disconnected member catches up and receives new strokes after rejoining", { timeout: 5000 }, async (context) => {
  const { join } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  const closed = once(member.socket, "close");
  member.socket.terminate();
  await closed;
  const operations = [stroke(), stroke("eraser")];
  for (const operation of operations) {
    owner.send("operation.commit", { operation });
    await owner.next("operation.committed");
  }
  const returned = await join("member");
  assert.equal(returned.state.sequence, 2);
  assert.deepEqual(returned.state.document.operations, operations);
  const operation = stroke();
  owner.send("operation.commit", { operation });
  const saved = await returned.next("operation.committed");
  assert.equal(saved.sequence, 3);
  assert.deepEqual(saved.operation, operation);
});

// Client mất kết nối khi transaction chưa trả ack; sau COMMIT, nối lại/retry vẫn chỉ có một nét và một sequence.
test("disconnect before acknowledgement preserves a committed stroke and retry keeps its sequence", { timeout: 5000 }, async (context) => {
  const { join, control, stored } = await setup(context);
  const owner = await join("owner");
  const member = await join("member");
  let reached;
  const atCommit = new Promise((resolve) => { reached = resolve; });
  const wait = new Promise((resolve) => { control.release = resolve; });
  control.pause = { reached, wait };
  const operation = stroke();
  owner.send("operation.commit", { operation });
  await atCommit;
  try {
    const closed = once(owner.socket, "close");
    owner.socket.terminate();
    await closed;
    assert.ok(!owner.received.some((message) => message.type === "operation.committed"));
  } finally { control.release(); }
  const saved = await member.next("operation.committed");
  assert.equal(saved.sequence, 1);
  const returned = await join("owner");
  assert.equal(returned.state.sequence, 1);
  assert.deepEqual(returned.state.document.operations, [operation]);
  returned.send("operation.commit", { operation });
  const duplicate = await returned.next("operation.committed");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.sequence, 1);
  assert.equal(stored().room.sequence, 1);
  assert.equal(stored().operations.length, 1);
});
