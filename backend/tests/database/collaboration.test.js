const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { Pool } = require("pg");
const { WebSocket } = require("ws");
const { readConfig } = require("../../src/config");
const { createApplication } = require("../../src/application");
const { PostgresRepository } = require("../../src/repository");
const { createShareTokenGenerator } = require("../../src/sharing");
const { packStroke, unpackWire } = require("../../src/stroke-codec");
const { renderSnapshot } = require("../../src/snapshot-worker");

// Ca opt-in dùng PostgreSQL thật và danh tính giả chỉ trên server test cổng tạm.
test("PostgreSQL preserves private and shared undo across access changes, restart and UUID retries", { timeout: 120000 }, async (context) => {
  const database = { ...readConfig().database, max: 2 };
  const caseId = randomUUID();
  const title = `[autotest] undo-sharing-${caseId}`;
  const ownerId = `autotest_owner_${caseId}`;
  const memberId = `autotest_member_${caseId}`;
  const ownerToken = randomUUID();
  const memberToken = randomUUID();
  const sessions = new Map([[ownerToken, ownerId], [memberToken, memberId]]);
  const shareToken = createShareTokenGenerator(randomBytes(32).toString("hex"));
  const clients = new Set();
  const origin = "http://localhost:5173";
  let application;
  let repository;
  let baseUrl;
  let roomId;

  // Giữ pool riêng, không log lỗi có thể chứa thông tin kết nối.
  function createPool() {
    const result = new Pool(database);
    result.on("error", () => {});
    return result;
  }
  let pool = createPool();

  // Khởi động mã API/ws thật, xác thực chỉ chấp nhận hai token ngẫu nhiên của ca thử này.
  async function startServer(optimized = false) {
    repository = new PostgresRepository(pool, { shareToken });
    await repository.ready();
    if (optimized) assert.equal(await repository.enablePerformance(), true);
    application = createApplication({ repository, origins: [origin],
      verifyToken: async (token) => {
        const userId = sessions.get(token);
        if (!userId) throw new Error("Invalid autotest session");
        return { userId, expiresAt: Date.now() + 300000 };
      },
    });
    application.server.listen(0, "127.0.0.1");
    await once(application.server, "listening");
    baseUrl = "http://127.0.0.1:" + application.server.address().port;
  }

  // Chỉ dừng server/socket do ca thử tạo, không sử dụng cổng backend đang chạy của người dùng.
  async function stopServer() {
    for (const client of clients) client.socket.terminate();
    clients.clear();
    if (application) {
      const current = application;
      application = undefined;
      await current.close();
    }
  }

  // Dọn chính dự án có chủ/tên UUID của ca thử, kể cả khi mất phản hồi lúc tạo dự án.
  context.after(async () => {
    try {
      await stopServer();
      const result = await pool.query("DELETE FROM drawing.rooms WHERE owner_id=$1 AND title=$2 AND ($3::uuid IS NULL OR id=$3) RETURNING id",
        [ownerId, title, roomId || null]);
      if (roomId) assert.equal(result.rowCount, 1, "The test project must be cleaned up");
      else assert.ok(result.rowCount <= 1, "Cleanup must be scoped to a single test project");
      if (roomId) {
        const { rows: [remaining] } = await pool.query("SELECT (SELECT count(*)::int FROM drawing.room_operations WHERE room_id=$1) AS operations, (SELECT count(*)::int FROM drawing.room_members WHERE room_id=$1) AS members", [roomId]);
        assert.deepEqual(remaining, { operations: 0, members: 0 });
      }
      console.log("Database check: temporary project and related records cleaned up.");
    } catch (error) {
      if (error.code === "ERR_ASSERTION") throw error;
      throw new Error(`Database test cleanup failed (${error.code || error.name}).`);
    } finally { await pool.end(); }
  });

  // Gọi HTTP với token test trong header, không ghi token vào URL hoặc output.
  async function request(path, token, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(baseUrl + path, {
      method, signal: AbortSignal.timeout(20000),
      headers: { Origin: origin, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }

  // Tạo client ws thật; mọi lần chờ có timeout và lỗi protocol làm test thất bại ngay.
  async function connect(token, sync) {
    const socket = new WebSocket(baseUrl.replace("http:", "ws:") + "/ws", { origin });
    const buffered = [];
    const waiting = new Set();
    const client = { socket };
    clients.add(client);
    socket.on("error", () => {});
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = [...waiting].find((item) => item.type === message.type || message.type === "error");
      if (waiter) waiter.finish(message);
      else buffered.push(message);
    });
    socket.on("close", () => {
      clients.delete(client);
      for (const waiter of waiting) waiter.finish({ type: "error", code: "TEST_SOCKET_CLOSED" });
    });
    // Nhận cả message đã tới trước khi await; tự hủy timer khi đã có phản hồi.
    function next(type) {
      return new Promise((resolve, reject) => {
        const waiter = { type,
          finish(message) {
            clearTimeout(timer);
            waiting.delete(waiter);
            if (message.type === "error" && type !== "error") reject(new Error("Test WebSocket error: " + message.code));
            else resolve(message);
          },
        };
        const timer = setTimeout(() => {
          waiting.delete(waiter);
          reject(new Error("Timed out waiting for test message: " + type));
        }, 20000);
        timer.unref();
        const index = buffered.findIndex((message) => message.type === type || message.type === "error");
        if (index >= 0) waiter.finish(buffered.splice(index, 1)[0]);
        else waiting.add(waiter);
      });
    }
    // Gửi theo giao thức v2 đang dùng trong frontend.
    function send(type, data) { socket.send(JSON.stringify({ v: 2, type, ...data })); }
    await once(socket, "open");
    send("auth", { token });
    await next("auth.ok");
    send("room.join", sync ? { roomId, sync } : { roomId });
    return { socket, next, send, state: await next(sync?.lastSeq != null ? "room.sync" : "room.state") };
  }

  // Tạo nét hợp lệ nằm tách nhau để có thể kiểm tra thứ tự, UUID và trạng thái ẩn/hiện rõ ràng.
  function stroke(offset) {
    return { id: randomUUID(), type: "line", width: 4, color: "#123456",
      start: { x: offset, y: 20 }, end: { x: offset + 30, y: 80 } };
  }
  // Hoàn tác/làm lại được gửi như một sự kiện riêng, không sửa nét đã lưu trước đó.
  function visibility(targetId, visible) { return { id: randomUUID(), type: "visibility", targetId, visible }; }

  try {
    await startServer();
    const created = await request("/api/rooms", ownerToken, { title });
    assert.equal(created.status, 201);
    roomId = created.body.room.id;
    assert.equal(created.body.room.ownerId, ownerId);
    assert.equal(created.body.room.sharingEnabled, false);
    assert.equal((await request(`/api/rooms/${roomId}`, memberToken)).status, 404);
    const owner = await connect(ownerToken);
    assert.equal(owner.state.sequence, 0);

    const first = stroke(20);
    const second = stroke(100);
    const third = stroke(180);
    const history = [first, second, visibility(second.id, false), visibility(second.id, true),
      visibility(second.id, false), third, visibility(third.id, false)];
    for (const [index, operation] of history.entries()) {
      owner.send("operation.commit", { operation });
      const saved = await owner.next("operation.committed");
      assert.equal(saved.sequence, index + 1);
      assert.equal(saved.operation.id, operation.id);
    }
    const { rows: original } = await pool.query("SELECT operation_id,sequence,author_id,payload FROM drawing.room_operations WHERE room_id=$1 ORDER BY sequence", [roomId]);
    assert.equal(original.length, 7);
    console.log("Database check: private drawing and undo history committed at sequence 7.");

    const shared = await request(`/api/rooms/${roomId}/sharing`, ownerToken, { enabled: true }, "PATCH");
    assert.equal(shared.status, 200);
    assert.equal(shared.body.room.sharingEnabled, true);
    const joined = await request("/api/rooms/join", memberToken, { token: shared.body.inviteToken });
    assert.equal(joined.status, 200);
    const member = await connect(memberToken);
    assert.equal(member.state.sequence, 7);
    assert.equal(member.state.document.version, 2);
    assert.deepEqual(member.state.document.operations, history);

    const memberStroke = stroke(260);
    member.send("operation.commit", { operation: memberStroke });
    const received = await Promise.all([member.next("operation.committed"), owner.next("operation.committed")]);
    for (const message of received) {
      assert.equal(message.sequence, 8);
      assert.deepEqual(message.operation, memberStroke);
    }
    const { rows: saved } = await pool.query("SELECT operation_id,sequence,author_id,payload FROM drawing.room_operations WHERE room_id=$1 ORDER BY sequence", [roomId]);
    assert.equal(saved.length, 8);
    assert.deepEqual(saved.slice(0, 7), original);
    assert.equal(saved[7].author_id, memberId);
    console.log("Database check: both clients received the member stroke; original seven records unchanged.");

    await stopServer();
    await pool.end();
    pool = createPool();
    await startServer(true);
    const restoredOwner = await connect(ownerToken);
    const restoredMember = await connect(memberToken);
    for (const client of [restoredOwner, restoredMember]) {
      assert.equal(client.state.sequence, 8);
      assert.deepEqual(client.state.document.operations, [...history, memberStroke]);
      const hidden = new Set([second.id, third.id]);
      assert.deepEqual(client.state.document.operations.filter((operation) => operation.type !== "visibility" && !hidden.has(operation.id)).map((operation) => operation.id), [first.id, memberStroke.id]);
    }
    restoredMember.send("operation.commit", { operation: memberStroke });
    const retry = await restoredMember.next("operation.committed");
    assert.equal(retry.sequence, 8);
    assert.equal(retry.duplicate, true);
    const { rows: [counts] } = await pool.query("SELECT count(*)::int AS total, count(*) FILTER (WHERE operation_id=$2)::int AS retries FROM drawing.room_operations WHERE room_id=$1", [roomId, memberStroke.id]);
    assert.deepEqual(counts, { total: 8, retries: 1 });
    console.log("Database check: fresh server/pool restored both clients; UUID retry did not duplicate the stroke.");

    const optimized = await connect(memberToken, { lastSeq: 7 });
    assert.equal(optimized.state.after, 7);
    assert.equal(optimized.state.sequence, 8);
    assert.deepEqual(unpackWire(memberStroke.id, optimized.state.events[0].packed), memberStroke);
    const compact = stroke(350);
    const secondCompact = stroke(400);
    const jobs = [compact, secondCompact].map((operation) => ({
      id: operation.id, packed: packStroke(operation).toString("base64"),
    }));
    for (const job of jobs) optimized.send("operation.packed", job);
    for (const [index, job] of jobs.entries()) {
      const ack = await optimized.next("operation.ack");
      const legacyBroadcast = await restoredOwner.next("operation.committed");
      assert.deepEqual(ack, { v: 2, type: "operation.ack", id: job.id, seq: 9 + index });
      assert.equal(legacyBroadcast.sequence, 9 + index);
      assert.equal(legacyBroadcast.operation.id, job.id);
    }
    // Dừng đọc socket gửi để mô phỏng mất ACK sau khi peer đã thấy nét được lưu.
    const lost = stroke(450);
    const lostJob = { id: lost.id, packed: packStroke(lost).toString("base64") };
    optimized.socket.pause();
    optimized.send("operation.packed", lostJob);
    assert.equal((await restoredOwner.next("operation.committed")).sequence, 11);
    jobs.push(lostJob);
    await stopServer();
    await pool.end();
    pool = createPool();
    await startServer(true);
    const recovered = await connect(memberToken, { lastSeq: 8 });
    assert.deepEqual(recovered.state.events.map(({ id, packed }) => ({ id, packed })), jobs);
    for (const job of jobs) recovered.send("operation.packed", job);
    for (const [index, job] of jobs.entries()) {
      assert.equal((await recovered.next("operation.ack")).seq, 9 + index);
      assert.equal((await pool.query(
        "SELECT count(*)::int AS total FROM drawing.room_operations WHERE room_id=$1 AND operation_id=$2 AND payload IS NULL AND packed IS NOT NULL",
        [roomId, job.id],
      )).rows[0].total, 1);
    }
    console.log("Database check: mixed JSONB/bytea, compact ACKs, replay after restart and UUID retry verified.");

    const finalVector = await connect(ownerToken);
    assert.deepEqual(finalVector.state.document.operations, [...history, memberStroke, compact, secondCompact, lost]);
    const { room, document, sequence } = finalVector.state;
    const input = { sequence, epoch: recovered.state.epoch };
    const { png, visibleCount } = await renderSnapshot(document);
    assert.equal(await repository.sync.publishSnapshot(roomId, input, png, visibleCount), true);
    assert.deepEqual(await repository.sync.snapshot(memberId, roomId, sequence), png);
    assert.equal((await request(`/api/rooms/${roomId}/sharing`, ownerToken, { enabled: false }, "PATCH")).status, 200);
    await assert.rejects(repository.sync.snapshot(memberId, roomId, sequence), { code: "SNAPSHOT_NOT_FOUND" });
    const hidden = visibility(compact.id, false);
    finalVector.send("operation.commit", { operation: hidden });
    assert.equal((await finalVector.next("operation.committed")).sequence, 12);
    await assert.rejects(repository.sync.snapshot(ownerId, roomId, sequence), { code: "SNAPSHOT_NOT_FOUND" });
    assert.equal(await repository.sync.publishSnapshot(roomId, input, png, visibleCount), false);
    assert.equal(await repository.sync.state(ownerId, room.id, { lastSeq: sequence, epoch: input.epoch, snapshot: true }), null);
    assert.deepEqual((await repository.state(ownerId, roomId)).document.operations.at(-1), hidden);
    console.log("Database check: snapshot authorization, invalidation and stale worker protection verified.");

    // Ép constraint thất bại ở thao tác thứ hai trên chính dự án test để kiểm tra rollback nguyên lô.
    const retryStroke = stroke(490);
    const invalid = stroke(530);
    const brokenBatch = [
      { id: retryStroke.id, author: ownerId, payload: retryStroke, bytes: Buffer.byteLength(JSON.stringify(retryStroke)) },
      { id: invalid.id, author: ownerId, packed: "AA==", bytes: Buffer.byteLength(JSON.stringify(invalid)) },
    ];
    await assert.rejects(pool.query("SELECT drawing.write_operation_batch_v3($1,$2::jsonb)", [roomId, JSON.stringify(brokenBatch)]), {
      code: "23514",
    });
    const unchanged = await repository.state(ownerId, roomId);
    assert.equal(unchanged.sequence, 12);
    assert.equal(unchanged.document.operations.some(({ id }) => id === retryStroke.id), false);
    finalVector.send("operation.commit", { operation: retryStroke });
    assert.equal((await finalVector.next("operation.committed")).sequence, 13);
    console.log("Database check: a constraint failure rolled back the entire batch; retry saved at the next sequence.");

    const reopened = await request(`/api/rooms/${roomId}/sharing`, ownerToken, { enabled: true }, "PATCH");
    assert.equal(reopened.status, 200);
    assert.equal((await request("/api/rooms/join", memberToken, { token: reopened.body.inviteToken })).status, 200);
    const collaborator = await connect(memberToken, { lastSeq: 13 });
    const fresh = stroke(560);
    collaborator.send("operation.packed", { id: fresh.id, packed: packStroke(fresh).toString("base64") });
    assert.equal((await collaborator.next("operation.ack")).seq, 14);
    assert.equal((await finalVector.next("operation.committed")).sequence, 14);

    const sharedUndo = visibility(retryStroke.id, false);
    collaborator.send("operation.commit", { operation: sharedUndo });
    assert.equal((await collaborator.next("operation.ack")).seq, 15);
    assert.deepEqual((await finalVector.next("operation.committed")).operation, sharedUndo);

    const duplicateUndo = visibility(retryStroke.id, false);
    finalVector.send("operation.commit", { operation: duplicateUndo });
    const redundant = await finalVector.next("error");
    assert.equal(redundant.operationId, duplicateUndo.id);
    assert.equal(redundant.code, "HISTORY_CHANGED");

    const sharedRedo = visibility(retryStroke.id, true);
    finalVector.send("operation.commit", { operation: sharedRedo });
    assert.deepEqual((await finalVector.next("operation.committed")).operation, sharedRedo);
    assert.equal((await collaborator.next("operation.committed")).sequence, 16);
    collaborator.send("operation.commit", { operation: sharedUndo });
    assert.equal((await collaborator.next("operation.ack")).seq, 15);
    const late = await connect(memberToken);
    assert.equal(late.state.sequence, 16);
    assert.deepEqual(late.state.document.operations.slice(-3), [fresh, sharedUndo, sharedRedo]);
    console.log("Database check: members change each other's strokes, redundant undo does not advance sequence, and retries remain idempotent.");

    const closedMembership = Promise.all([once(collaborator.socket, "close"), once(late.socket, "close")]);
    const left = await request(`/api/rooms/${roomId}/membership`, memberToken, undefined, "DELETE");
    assert.equal(left.status, 200);
    assert.deepEqual(left.body, { id: roomId });
    assert.deepEqual((await closedMembership).map(([code]) => code), [4405, 4405]);
    assert.equal(finalVector.socket.readyState, WebSocket.OPEN);
    assert.equal((await request(`/api/rooms/${roomId}`, memberToken)).status, 404);
    assert.deepEqual(await repository.listRooms(memberId), []);
    assert.deepEqual((await repository.state(ownerId, roomId)).document, late.state.document);
    assert.equal((await request("/api/rooms/join", memberToken, { token: reopened.body.inviteToken })).status, 200);
    assert.equal((await repository.state(memberId, roomId)).sequence, 16);
    console.log("Database check: leaving closes member tabs only, preserves drawing data and supports rejoining.");
  } catch (error) {
    if (error.code === "ERR_ASSERTION") throw error;
    throw new Error(`Live collaboration check failed (${error.code || error.name}).`);
  }
});
