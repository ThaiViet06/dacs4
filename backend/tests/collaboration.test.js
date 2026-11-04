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
async function setup(context) {
  const roomId = randomUUID();
  let stored = { room: { id: roomId, title: "Collaboration test", owner_id: "owner", sequence: 0,
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

  // Mở client thật qua ws, xác thực rồi subscribe; hàng đợi không bỏ sót message đến giữa hai lần await.
  async function join(user) {
    const socket = new WebSocket(url, { origin });
    const received = [];
    const waiting = [];
    const messages = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      received.push(message);
      const index = waiting.findIndex((item) => item.type === message.type);
      if (index >= 0) waiting.splice(index, 1)[0].resolve(message);
      else messages.push(message);
    });
    // Lấy phản hồi đúng loại kể cả khi nó đã đến trước khi test bắt đầu chờ.
    function next(type) {
      const index = messages.findIndex((message) => message.type === type);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve) => waiting.push({ type, resolve }));
    }
    // Gửi thông điệp đúng phiên bản giao thức cho server thật.
    function send(type, data) { socket.send(JSON.stringify({ v: 1, type, ...data })); }
    await once(socket, "open");
    send("auth", { token: user });
    await next("auth.ok");
    send("room.join", { roomId });
    const state = await next("room.state");
    return { socket, next, send, state, received };
  }
  return { join, control, stored: () => stored };
}

// Tạo nét có UUID mới; hình và tẩy dùng cùng giao thức operation.commit.
function stroke(type = "line") {
  const base = { id: randomUUID(), type, color: "#123456", width: 4 };
  return type === "eraser" ? { ...base, points: [{ x: 30, y: 40 }] }
    : { ...base, start: { x: 10, y: 20 }, end: { x: 30, y: 40 } };
}

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
