const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const { once } = require("node:events");
const { test, before, after } = require("node:test");
const { WebSocket } = require("ws");
const { createTokenVerifier } = require("../src/auth");
const { createApplication } = require("../src/application");
const { AppError } = require("../src/errors");
const { emptyDocument } = require("../src/protocol");

// Khóa test chỉ tồn tại trong bộ nhớ; toàn bộ test dùng SDK thật mà không gọi dịch vụ Clerk.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const otherKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const domain = "drawing-test.clerk.accounts.dev";
const origin = "http://localhost:5173";
const config = {
  clerkPublishableKey: "pk_test_" + Buffer.from(domain + "$").toString("base64"),
  origins: [origin],
};
const offline = { jwtKey: keys.publicKey.export({ type: "spki", format: "pem" }) };
const verifyToken = createTokenVerifier(config, offline);

// Tạo JWT gần giống phiên Clerk; thay từng claim hoặc khóa ký để kiểm tra các đường từ chối.
function sessionToken(overrides = {}, privateKey = keys.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "auth-test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: "https://" + domain, azp: origin, sub: "user_test", sid: "sess_test",
    iat: now - 10, nbf: now - 10, exp: now + 300, v: 2, ...overrides,
  })).toString("base64url");
  const input = header + "." + payload;
  return input + "." + sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url");
}

// Kiểm tra kết quả trả về chỉ chứa ID và hạn phiên, không chuyển toàn bộ JWT cho ứng dụng.
test("valid signed session returns only user identity and expiry", async () => {
  const exp = Math.floor(Date.now() / 1000) + 300;
  assert.deepEqual(await verifyToken(sessionToken({ exp, privateClaim: "not-returned" })), {
    userId: "user_test", expiresAt: exp * 1000,
  });
});

const invalidTokens = [
  ["missing token", () => undefined],
  ["malformed token", () => "not-a-jwt"],
  ["wrong signature", () => sessionToken({}, otherKeys.privateKey)],
  ["expired session within SDK clock tolerance", () => sessionToken({ exp: Math.floor(Date.now() / 1000) - 1 })],
  ["wrong issuer", () => sessionToken({ iss: "https://another.clerk.accounts.dev" })],
  ["missing issuer", () => sessionToken({ iss: undefined })],
  ["wrong authorized origin", () => sessionToken({ azp: "https://untrusted.example" })],
  ["missing authorized origin", () => sessionToken({ azp: undefined })],
  ["future activation", () => sessionToken({ nbf: Math.floor(Date.now() / 1000) + 60 })],
  ["future issue time", () => sessionToken({ iat: Math.floor(Date.now() / 1000) + 60 })],
  ["missing user", () => sessionToken({ sub: undefined })],
  ["blank user", () => sessionToken({ sub: "   " })],
  ["missing session", () => sessionToken({ sid: undefined })],
  ["non-string session", () => sessionToken({ sid: 123 })],
  ["missing expiry", () => sessionToken({ exp: undefined })],
  ["non-numeric expiry", () => sessionToken({ exp: "9999999999" })],
  ["pending sign-in session", () => sessionToken({ sts: "pending" })],
];
for (const [name, token] of invalidTokens) {
  // Mỗi trường hợp phải bị từ chối kể cả khi payload vẫn được ký bằng khóa test tin cậy.
  test("rejects " + name, async () => {
    await assert.rejects(verifyToken(token()));
  });
}

// Không cho cấu hình lỗi vô tình tắt kiểm tra issuer hoặc danh sách origin.
test("invalid publishable key and empty origin allowlist fail before startup", () => {
  for (const key of [undefined, "pk_test_invalid", "pk_test_" + Buffer.from("untrusted.example/path$").toString("base64")]) {
    assert.throws(() => createTokenVerifier({ ...config, clerkPublishableKey: key }, offline), /CLERK_PUBLISHABLE_KEY/);
  }
  assert.throws(() => createTokenVerifier({ ...config, origins: [] }, offline), /ALLOWED_ORIGINS/);
});

let application;
let baseUrl;
const roomReads = [];
const stateReads = [];
const roomId = "00000000-0000-4000-8000-000000000001";
// Mở ứng dụng thật trên cổng local ngẫu nhiên với repository giả, không tạo kết nối PostgreSQL.
before(async () => {
  application = createApplication({
    origins: [origin], verifyToken,
    repository: {
      // Ghi nhận ID được chuyển xuống repository để phát hiện truy cập trước khi xác thực.
      listRooms: async (userId) => { roomReads.push(userId); return []; },
      // Chỉ phiên test được cấp quyền mới đọc trạng thái; ghi nhận ID do bộ xác thực truyền xuống.
      state: async (userId, id) => {
        stateReads.push({ userId, roomId: id });
        if (userId !== "user_test" || id !== roomId) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied.");
        return { room: { id, title: "Test room", ownerId: userId, sequence: 0 }, sequence: 0, document: emptyDocument() };
      },
    },
  });
  application.server.listen(0, "127.0.0.1");
  await once(application.server, "listening");
  baseUrl = "http://127.0.0.1:" + application.server.address().port;
});

// Đóng HTTP, WebSocket và timer sau suite để không để lại tiến trình hoặc cổng kiểm tra.
after(async () => {
  if (application) await application.close();
});

// Health check vẫn công khai; API có token hợp lệ chỉ nhận ID người dùng đã xác minh.
test("HTTP health is public and a valid Bearer session reaches the repository", async () => {
  assert.equal((await fetch(baseUrl + "/healthz")).status, 200);
  const readsBefore = roomReads.length;
  const response = await fetch(baseUrl + "/api/rooms", {
    headers: { Origin: origin, Authorization: "Bearer " + sessionToken() },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { rooms: [] });
  assert.deepEqual(roomReads.slice(readsBefore), ["user_test"]);
});

// Yêu cầu thiếu token không được chạm repository và nhận lỗi đăng nhập có cấu trúc.
test("HTTP missing token returns 401 without reading rooms", async () => {
  const readsBefore = roomReads.length;
  const response = await fetch(baseUrl + "/api/rooms", { headers: { Origin: origin } });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: "AUTH_REQUIRED", message: "Sign in to continue." } });
  assert.equal(roomReads.length, readsBefore);
});

for (const name of ["wrong signature", "expired session within SDK clock tolerance", "wrong issuer", "wrong authorized origin"]) {
  // Lỗi SDK phải được đổi thành phản hồi an toàn, không chứa JWT hoặc thông tin claim nội bộ.
  test("HTTP rejects " + name + " without reading rooms or exposing claims", async () => {
    const token = invalidTokens.find(([caseName]) => caseName === name)[1]();
    const readsBefore = roomReads.length;
    const response = await fetch(baseUrl + "/api/rooms", {
      headers: { Origin: origin, Authorization: "Bearer " + token },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: { code: "AUTH_EXPIRED", message: "Your session expired. Sign in again." } });
    assert.equal(roomReads.length, readsBefore);
  });
}

// Origin của request HTTP cũng phải nằm trong allowlist, dù token tự nó hợp lệ.
test("HTTP denies an untrusted request origin before repository access", async () => {
  const readsBefore = roomReads.length;
  const response = await fetch(baseUrl + "/api/rooms", {
    headers: { Origin: "https://untrusted.example", Authorization: "Bearer " + sessionToken() },
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "ORIGIN_DENIED");
  assert.equal(roomReads.length, readsBefore);
});

// Mở client WebSocket bằng origin hợp lệ và đăng ký dọn kết nối cho từng test.
async function connectSocket(context) {
  const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws", { origin });
  context.after(async () => {
    if (socket.readyState === WebSocket.CLOSED) return;
    const closed = once(socket, "close");
    socket.terminate();
    await closed;
  });
  await once(socket, "open");
  return socket;
}

// WebSocket phải dùng cùng bộ xác thực với HTTP trước khi cho phép thao tác phòng.
test("WebSocket accepts a valid session", { timeout: 5000 }, async (context) => {
  const socket = await connectSocket(context);
  const reply = once(socket, "message");
  const exp = Math.floor(Date.now() / 1000) + 300;
  socket.send(JSON.stringify({ v: 1, type: "auth", token: sessionToken({ exp }) }));
  const [raw] = await reply;
  const message = JSON.parse(raw.toString());
  assert.equal(message.type, "auth.ok");
  assert.equal(message.expiresAt, exp * 1000);
});

// Token sai chữ ký chỉ nhận thông báo an toàn và kết nối bị đóng bằng mã xác thực 4401.
test("WebSocket rejects an invalid session and closes with 4401", { timeout: 5000 }, async (context) => {
  const socket = await connectSocket(context);
  const reply = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ v: 1, type: "auth", token: sessionToken({}, otherKeys.privateKey) }));
  const [raw] = await reply;
  assert.deepEqual(JSON.parse(raw.toString()), {
    v: 1, type: "error", code: "AUTH_EXPIRED", message: "Authentication expired. Sign in again.",
  });
  const [code] = await closed;
  assert.equal(code, 4401);
});

// Chỉ tải trạng thái sau auth.ok; tài liệu đến từ repository của đúng thành viên, không nhận từ client.
test("WebSocket authenticates then loads authoritative state for a member", { timeout: 5000 }, async (context) => {
  const socket = await connectSocket(context);
  let reply = once(socket, "message");
  socket.send(JSON.stringify({ v: 1, type: "auth", token: sessionToken() }));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "auth.ok");
  const readsBefore = stateReads.length;
  reply = once(socket, "message");
  socket.send(JSON.stringify({ v: 1, type: "room.join", roomId }));
  const state = JSON.parse((await reply)[0].toString());
  assert.deepEqual(state, { v: 1, type: "room.state", room: { id: roomId, title: "Test room", ownerId: "user_test", sequence: 0 }, sequence: 0, document: emptyDocument() });
  assert.deepEqual(stateReads.slice(readsBefore), [{ userId: "user_test", roomId }]);
});

// Biết ID phòng không đủ: phiên hợp lệ nhưng chưa là thành viên vẫn không nhận tài liệu.
test("WebSocket denies a signed-in outsider without returning room state", { timeout: 5000 }, async (context) => {
  const socket = await connectSocket(context);
  let reply = once(socket, "message");
  socket.send(JSON.stringify({ v: 1, type: "auth", token: sessionToken({ sub: "user_outside" }) }));
  assert.equal(JSON.parse((await reply)[0].toString()).type, "auth.ok");
  const readsBefore = stateReads.length;
  reply = once(socket, "message");
  socket.send(JSON.stringify({ v: 1, type: "room.join", roomId }));
  assert.deepEqual(JSON.parse((await reply)[0].toString()), {
    v: 1, type: "error", code: "ROOM_NOT_FOUND", message: "Room not found or access denied.",
  });
  assert.deepEqual(stateReads.slice(readsBefore), [{ userId: "user_outside", roomId }]);
});

// Chặn subscribe trước xác thực ngay ở giao thức WebSocket, không gọi repository.
test("WebSocket rejects room join before authentication", { timeout: 5000 }, async (context) => {
  const socket = await connectSocket(context);
  const readsBefore = stateReads.length;
  const reply = once(socket, "message");
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ v: 1, type: "room.join", roomId }));
  assert.equal(JSON.parse((await reply)[0].toString()).code, "AUTH_REQUIRED");
  assert.equal((await closed)[0], 4401);
  assert.equal(stateReads.length, readsBefore);
});
