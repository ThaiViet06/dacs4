const assert = require("node:assert/strict");
const { randomBytes, randomUUID, createHash } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { WebSocket } = require("ws");
const { createChatProfileLookup } = require("../src/auth");
const { ChatService, createChatCipher, validateChatKey } = require("../src/chat");
const { PostgresRepository } = require("../src/repository");
const { createApplication } = require("../src/application");
const { createShareTokenGenerator } = require("../src/sharing");
const { emptyDocument } = require("../src/protocol");

const origin = "http://localhost:5173";

// SQL giả giữ bản mã sau COMMIT; chạy service/repository, HTTP và ws thật mà không dùng tài khoản ngoài.
async function setup(context, { configured = true, lookupProfiles } = {}) {
  const roomId = randomUUID();
  const otherRoomId = randomUUID();
  const key = randomBytes(32).toString("hex");
  const shareToken = createShareTokenGenerator(randomBytes(32).toString("hex"));
  // Tạo metadata dự án đúng chuẩn để dùng cả luồng join và thu quyền hiện có.
  function room(id, owner) {
    return { id, owner_id: owner, title: "Chat test", sharing_enabled: true, sharing_version: 1,
      invite_hash: createHash("sha256").update(shareToken(id, 1)).digest("hex"),
      sequence: 0, initial_document: emptyDocument(), updated_at: new Date(), checkpoint: null };
  }
  let stored = { rooms: new Map([[roomId, room(roomId, "owner")], [otherRoomId, room(otherRoomId, "other-owner")]]),
    members: new Map([[roomId, new Set(["owner", "member"])], [otherRoomId, new Set(["other-owner"])]]), messages: [] };
  const control = { failCommit: false, gate: null };
  const identities = new Map();
  const pool = {
    // Đọc hồ sơ theo quyền dự án và tác giả gần nhất, tách khỏi transaction gửi tin.
    async query(sql, values = []) {
      if (sql.startsWith("SELECT r.sharing_enabled, ARRAY")) {
        const [id, user] = values;
        const project = stored.rooms.get(id);
        if (!project || !stored.members.get(id)?.has(user) || (!project.sharing_enabled && project.owner_id !== user))
          return { rows: [] };
        const authors = stored.messages.filter((message) => message.room_id === id).slice(-50).map((message) => message.author_id);
        return { rows: [{ sharing_enabled: project.sharing_enabled, authors: [...new Set(authors)] }] };
      }
      assert.match(sql, /^SELECT id/);
      return { rows: [] };
    },
    // Mô phỏng rollback và điểm dừng COMMIT để kiểm tra không broadcast sớm.
    async connect() {
      let draft;
      return {
        release() {},
        async query(sql, values = []) {
          if (sql === "BEGIN") { draft = structuredClone(stored); return { rows: [] }; }
          if (sql === "ROLLBACK") { draft = undefined; return { rows: [] }; }
          if (sql === "COMMIT") {
            if (control.gate) {
              const gate = control.gate;
              control.gate = null;
              gate.reached();
              await gate.wait;
            }
            if (control.failCommit) throw Object.assign(new Error("Simulated chat outage"), { code: "08006" });
            stored = draft;
            return { rows: [] };
          }
          if (sql.startsWith("SELECT * FROM drawing.rooms WHERE id=")) return { rows: draft.rooms.has(values[0]) ? [draft.rooms.get(values[0])] : [] };
          if (sql.startsWith("SELECT user_id FROM drawing.room_members")) return { rows: draft.members.get(values[0])?.has(values[1]) ? [{ user_id: values[1] }] : [] };
          if (sql.startsWith("SELECT payload FROM drawing.room_operations")) return { rows: [] };
          if (sql.startsWith("SELECT * FROM drawing.room_messages")) {
            const rows = draft.messages.filter((message) => message.room_id === values[0]);
            return { rows: sql.includes("AND id=") ? rows.filter((message) => message.id === values[1]) : rows.sort((a, b) => b.sequence - a.sequence).slice(0, 50) };
          }
          if (sql.startsWith("SELECT COALESCE(MAX(sequence)")) return { rows: [{ sequence: Math.max(0, ...draft.messages.filter((message) => message.room_id === values[0]).map((message) => message.sequence)) + 1 }] };
          if (sql.startsWith("INSERT INTO drawing.room_messages")) {
            const saved = { id: values[0], room_id: values[1], sequence: values[2], author_id: values[3], ciphertext: values[4], created_at: new Date() };
            assert.ok(!draft.messages.some((message) => message.room_id === saved.room_id && (message.id === saved.id || message.sequence === saved.sequence)));
            draft.messages.push(saved);
            return { rows: [saved] };
          }
          if (sql.startsWith("UPDATE drawing.rooms SET sharing_enabled=")) {
            const saved = { ...draft.rooms.get(values[0]), sharing_enabled: values[1], sharing_version: values[2], invite_hash: values[3], updated_at: new Date() };
            draft.rooms.set(values[0], saved);
            return { rows: [saved] };
          }
          if (sql.startsWith("DELETE FROM drawing.room_members")) { draft.members.set(values[0], new Set([values[1]])); return { rows: [] }; }
          throw new Error("Unexpected chat fixture query: " + sql);
        },
      };
    },
  };
  const repository = new PostgresRepository(pool, { shareToken });
  const chat = new ChatService(repository, configured ? createChatCipher(key) : undefined, lookupProfiles);
  const application = createApplication({ repository, chat, origins: [origin],
    // Danh tính giả chỉ dùng trong test; không đọc token hay khóa Clerk thật.
    verifyToken: async (token) => {
      if (!["owner", "member", "outsider", "other-owner"].includes(token)) throw new Error("Invalid test token");
      const identity = { userId: token, expiresAt: Date.now() + 60000 };
      identities.set(token, identity);
      return identity;
    },
  });
  let release;
  context.after(async () => { release?.(); await application.close(); });
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  const base = "http://127.0.0.1:" + application.server.address().port;

  // Gửi HTTP thật với danh tính test, cho phép kiểm tra cả trường hợp thiếu xác thực.
  function request(user, id = roomId, body, path = "messages") {
    return fetch(base + `/api/rooms/${id}/${path}`, {
      method: body === undefined ? "GET" : path === "sharing" ? "PATCH" : "POST",
      headers: { Origin: origin, ...(user ? { Authorization: "Bearer " + user } : {}), "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  // Nhận thông điệp theo loại để kiểm chứng room isolation mà không dùng sleep đoán thời gian.
  async function join(user, id = roomId) {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws", { origin });
    const received = [];
    const buffered = [];
    const waiting = [];
    socket.on("message", (raw) => {
      const message = JSON.parse(raw);
      received.push(message);
      const index = waiting.findIndex((item) => item.type === message.type);
      if (index >= 0) waiting.splice(index, 1)[0].resolve(message);
      else buffered.push(message);
    });
    // Gửi theo giao thức v2 đang dùng cho nét vẽ.
    function send(type, data) { socket.send(JSON.stringify({ v: 2, type, ...data })); }
    // Ưu tiên phản hồi đã tới trước khi đăng ký chờ.
    function next(type) {
      const index = buffered.findIndex((message) => message.type === type);
      return index >= 0 ? Promise.resolve(buffered.splice(index, 1)[0]) : new Promise((resolve) => waiting.push({ type, resolve }));
    }
    await once(socket, "open");
    send("auth", { token: user });
    await next("auth.ok");
    send("room.join", { roomId: id });
    await next("room.state");
    return { socket, send, next, received };
  }
  // Giữ COMMIT ở một điểm xác định để test hàng đợi chat/chuyển chế độ.
  function pauseCommit() {
    let reached;
    const arrived = new Promise((resolve) => { reached = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    control.gate = { reached, wait };
    return { arrived, release: () => release() };
  }
  return { roomId, otherRoomId, chat, repository, key, control, identities, base, request, join, pauseCommit, stored: () => stored };
}

test("chat profiles expose display fields only to shared project members and cache Clerk lookups", async (context) => {
  const batches = [];
  const lookupProfiles = createChatProfileLookup({}, { users: {
    // Trả cả hồ sơ ngoài dự án và email để kiểm tra lọc dữ liệu trước khi trả HTTP.
    async getUserList(query) {
      batches.push(query);
      return { data: [
        { id: "owner", fullName: null, username: "chu-du-an", hasImage: false },
        { id: "member", fullName: "Mai Nguyễn", hasImage: true, imageUrl: "https://img.clerk.com/avatar",
          emailAddresses: [{ emailAddress: "private@example.invalid" }] },
        { id: "other-owner", fullName: "Outside the project" },
      ] };
    },
  } });
  const fixture = await setup(context, { lookupProfiles });
  await fixture.chat.send("member", fixture.roomId, { id: randomUUID(), text: "Xin chào" });
  await fixture.chat.send("other-owner", fixture.otherRoomId, { id: randomUUID(), text: "Another room" });
  const path = "messages/profiles";
  assert.equal((await fixture.request(undefined, fixture.roomId, undefined, path)).status, 401);
  assert.equal((await fixture.request("outsider", fixture.roomId, undefined, path)).status, 404);
  assert.equal(batches.length, 0);
  const result = await fixture.request("owner", fixture.roomId, undefined, path + "?userId=other-owner");
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { profiles: [
    { userId: "owner", name: "chu-du-an", avatarUrl: null },
    { userId: "member", name: "Mai Nguyễn", avatarUrl: "https://img.clerk.com/avatar" },
  ] });
  assert.equal((await fixture.request("member", fixture.roomId, undefined, path)).status, 200);
  assert.deepEqual(batches, [{ userId: ["owner", "member"], limit: 2 }]);

  assert.equal((await fixture.request("owner", fixture.roomId, { enabled: false }, "sharing")).status, 200);
  assert.equal((await fixture.request("owner", fixture.roomId, undefined, path)).status, 409);
  assert.equal((await fixture.request("member", fixture.roomId, undefined, path)).status, 404);
  assert.equal(batches.length, 1);
});

test("AES-GCM uses fresh IVs, restores Unicode and authenticates both contents and record identity", () => {
  const key = randomBytes(32).toString("hex");
  const cipher = createChatCipher(key);
  const context = { roomId: randomUUID(), id: randomUUID(), authorId: "owner" };
  const text = "Nội dung bí mật 🎨\nChào bạn";
  const first = cipher.encrypt(text, context);
  assert.notEqual(first, cipher.encrypt(text, context));
  assert.ok(!first.includes(text));
  assert.equal(createChatCipher(key).decrypt(first, context), text);
  const packed = Buffer.from(first.slice(3), "base64");
  packed[packed.length - 1] ^= 1;
  const cases = [
    ["v1." + packed.toString("base64"), context, cipher],
    [first, { ...context, roomId: randomUUID() }, cipher],
    [first, { ...context, id: randomUUID() }, cipher],
    [first, { ...context, authorId: "member" }, cipher],
    [first, context, createChatCipher(randomBytes(32).toString("hex"))],
    ["v1.invalid", context, cipher],
  ];
  for (const [encrypted, identity, decoder] of cases) assert.throws(() => decoder.decrypt(encrypted, identity), { code: "CHAT_UNAVAILABLE" });
  for (const invalid of ["", "x".repeat(64), "ab", undefined]) assert.throws(() => validateChatKey(invalid), /Configure CHAT_ENCRYPTION_KEY/);
});

test("chat persists ciphertext only, survives service restart and never changes drawing state", async (context) => {
  const fixture = await setup(context);
  const text = "Nội dung chỉ lưu dạng mã hóa";
  const saved = await fixture.chat.send("owner", fixture.roomId, { id: randomUUID(), text });
  const stored = fixture.stored();
  assert.ok(!JSON.stringify(stored.messages).includes(text));
  assert.equal(stored.messages.length, 1);
  assert.deepEqual(Object.keys(stored.messages[0]).sort(), ["id", "room_id", "sequence", "author_id", "ciphertext", "created_at"].sort());
  assert.equal(stored.rooms.get(fixture.roomId).sequence, 0);
  assert.deepEqual(stored.rooms.get(fixture.roomId).initial_document, emptyDocument());
  const restarted = new ChatService(fixture.repository, createChatCipher(fixture.key));
  assert.deepEqual(await restarted.list("member", fixture.roomId), [saved.message]);
  await assert.rejects(new ChatService(fixture.repository, createChatCipher(randomBytes(32).toString("hex"))).list("owner", fixture.roomId), { code: "CHAT_UNAVAILABLE" });
});

test("HTTP/WS shares a committed message with two members and keeps the other project isolated", { timeout: 5000 }, async (context) => {
  const fixture = await setup(context);
  const owner = await fixture.join("owner");
  const member = await fixture.join("member");
  const other = await fixture.join("other-owner", fixture.otherRoomId);
  const gate = fixture.pauseCommit();
  const input = { id: randomUUID(), text: "Chào cả nhóm" };
  const pending = fixture.request("owner", fixture.roomId, input);
  await gate.arrived;
  assert.equal(fixture.stored().messages.length, 0);
  assert.ok(!owner.received.some((message) => message.type === "chat.message"));
  gate.release();
  const response = await pending;
  assert.equal(response.status, 201);
  const saved = (await response.json()).message;
  assert.deepEqual((await owner.next("chat.message")).message, saved);
  assert.deepEqual((await member.next("chat.message")).message, saved);
  other.send("room.join", { roomId: fixture.otherRoomId });
  await other.next("room.state");
  assert.ok(!other.received.some((message) => message.type === "chat.message"));
  assert.deepEqual(await (await fixture.request("member")).json(), { messages: [saved] });
});

test("retrying the same message UUID returns the saved result without another row or broadcast", { timeout: 5000 }, async (context) => {
  const fixture = await setup(context);
  const owner = await fixture.join("owner");
  const input = { id: randomUUID(), text: "Gửi một lần" };
  const first = await fixture.request("owner", fixture.roomId, input);
  const saved = await first.json();
  await owner.next("chat.message");
  const retry = await fixture.request("owner", fixture.roomId.toUpperCase(), input);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), saved);
  owner.send("room.join", { roomId: fixture.roomId });
  await owner.next("room.state");
  assert.equal(owner.received.filter((message) => message.type === "chat.message").length, 1);
  assert.equal(fixture.stored().messages.length, 1);
  for (const [author, text] of [["member", input.text], ["owner", "Nội dung khác"]]) {
    const conflict = await fixture.request(author, fixture.roomId, { id: input.id, text });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, "MESSAGE_CONFLICT");
  }
});

test("HTTP checks authentication, membership, origin and private mode on both reading and writing", async (context) => {
  const fixture = await setup(context);
  const badOrigin = await fetch(fixture.base + `/api/rooms/${fixture.roomId}/messages`, {
    headers: { Origin: "https://untrusted.invalid", Authorization: "Bearer owner" },
  });
  assert.equal(badOrigin.status, 403);
  for (const body of [undefined, { id: randomUUID(), text: "Không được lưu" }]) {
    assert.equal((await fixture.request(null, fixture.roomId, body)).status, 401);
    assert.equal((await fixture.request("outsider", fixture.roomId, body)).status, 404);
  }
  const saved = await fixture.chat.send("member", fixture.roomId, { id: randomUUID(), text: "Lịch sử vẫn được mã hóa" });
  const response = await fixture.request("owner", fixture.roomId, { enabled: false }, "sharing");
  assert.equal(response.status, 200);
  assert.equal((await fixture.request("owner")).status, 409);
  assert.equal((await fixture.request("member")).status, 404);
  assert.equal((await fixture.request("owner", fixture.roomId, { id: randomUUID(), text: "Cá nhân không chat" })).status, 409);
  assert.equal(fixture.stored().messages.length, 1);
  await fixture.request("owner", fixture.roomId, { enabled: true }, "sharing");
  assert.deepEqual(await fixture.chat.list("owner", fixture.roomId), [saved.message]);
  assert.equal((await fixture.request("member")).status, 404);
});

test("chat input refuses empty, oversized and forged-author payloads", async (context) => {
  const fixture = await setup(context);
  for (const body of [{}, { id: "bad", text: "test" }, { id: randomUUID(), text: "  " },
    { id: randomUUID(), text: "x".repeat(1001) }, { id: randomUUID(), text: "test", authorId: "member" }]) {
    assert.equal((await fixture.request("owner", fixture.roomId, body)).status, 400);
  }
  const response = await fixture.request("owner", fixture.roomId, { id: randomUUID(), text: "  " + "🎨".repeat(500) + "  " });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).message.text, "🎨".repeat(500));
  assert.equal(fixture.stored().messages.length, 1);
});

test("failed COMMIT rolls back without broadcast and the same UUID succeeds after recovery", { timeout: 5000 }, async (context) => {
  const fixture = await setup(context);
  const owner = await fixture.join("owner");
  const input = { id: randomUUID(), text: "Giữ UUID khi lỗi ghi" };
  fixture.control.failCommit = true;
  assert.equal((await fixture.request("owner", fixture.roomId, input)).status, 503);
  assert.equal(fixture.stored().messages.length, 0);
  fixture.control.failCommit = false;
  owner.send("room.join", { roomId: fixture.roomId });
  await owner.next("room.state");
  assert.ok(!owner.received.some((message) => message.type === "chat.message"));
  assert.equal((await fixture.request("owner", fixture.roomId, input)).status, 201);
  await owner.next("chat.message");
  assert.equal(fixture.stored().messages.length, 1);
});

test("sharing shutdown waits for a pending chat commit and blocks every later member message", { timeout: 5000 }, async (context) => {
  const fixture = await setup(context);
  const member = await fixture.join("member");
  const gate = fixture.pauseCommit();
  const pending = fixture.request("member", fixture.roomId, { id: randomUUID(), text: "Xếp trước thu quyền" });
  await gate.arrived;
  const disabling = fixture.request("owner", fixture.roomId, { enabled: false }, "sharing");
  gate.release();
  assert.equal((await pending).status, 201);
  assert.equal((await disabling).status, 200);
  assert.equal((await member.next("chat.message")).message.text, "Xếp trước thu quyền");
  assert.equal((await fixture.request("member", fixture.roomId, { id: randomUUID(), text: "Xếp sau thu quyền" })).status, 404);
  assert.equal(fixture.stored().messages.length, 1);
});

test("history is ordered and limited to the latest 50 messages", async (context) => {
  const fixture = await setup(context);
  for (let index = 1; index <= 55; index++) await fixture.chat.send("owner", fixture.roomId, { id: randomUUID(), text: "Tin " + index });
  const history = await fixture.chat.list("member", fixture.roomId);
  assert.equal(history.length, 50);
  assert.deepEqual(history.map((message) => message.sequence), Array.from({ length: 50 }, (_, index) => index + 6));
  assert.equal(history.at(-1).text, "Tin 55");
});

test("missing encryption key disables chat without storing plaintext or breaking drawing state", async (context) => {
  const fixture = await setup(context, { configured: false });
  assert.equal((await fixture.request("owner")).status, 503);
  assert.equal((await fixture.request("member", fixture.roomId, { id: randomUUID(), text: "Không lưu rõ" })).status, 503);
  const owner = await fixture.join("owner");
  assert.ok(owner.received.some((message) => message.type === "room.state"));
  assert.equal(fixture.stored().messages.length, 0);
});

test("expired WebSocket authentication cannot receive new chat contents", { timeout: 5000 }, async (context) => {
  const fixture = await setup(context);
  const member = await fixture.join("member");
  fixture.identities.get("member").expiresAt = Date.now() - 1;
  assert.equal((await fixture.request("owner", fixture.roomId, { id: randomUUID(), text: "Chỉ gửi cho phiên còn hạn" })).status, 201);
  const pong = once(member.socket, "pong");
  member.socket.ping();
  await pong;
  assert.ok(!member.received.some((message) => message.type === "chat.message"));
});
