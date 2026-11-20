const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { isDeepStrictEqual } = require("node:util");
const { test } = require("node:test");
const { PostgresRepository } = require("../src/repository");
const { emptyDocument, normalizeDocument } = require("../src/protocol");
const { createShareTokenGenerator } = require("../src/sharing");

// Dùng repository thật với SQL giả; mô phỏng khóa hàng và chỉ công bố dữ liệu sau COMMIT, không kết nối Supabase.
function fixture(context, { sharingEnabled = false, initialDocument = emptyDocument() } = {}) {
  const roomId = randomUUID();
  let stored = { room: {
    id: roomId, owner_id: "owner", title: "Visibility fixture", sequence: 0,
    sharing_enabled: sharingEnabled, sharing_version: 0, invite_hash: "fixture-hash",
    initial_document: structuredClone(initialDocument), checkpoint: null,
    updated_at: "2026-11-16T00:00:00Z",
  }, members: ["owner", "member"], operations: [] };
  const control = { failAt: "", pause: null, release: null };
  let lock = Promise.resolve();
  const pool = {
    // Mỗi client chờ khóa dự án trước khi đọc bản mới nhất, tương ứng SELECT FOR UPDATE trong PostgreSQL.
    async connect() {
      let draft;
      let unlock;
      // Trả khóa khi COMMIT, ROLLBACK hoặc release để một lỗi không làm các transaction sau bị treo.
      function release() { unlock?.(); unlock = undefined; }
      return {
        release,
        // Chỉ hỗ trợ truy vấn được kiểm tra; câu lệnh lạ làm test thất bại thay vì giả vờ đã ghi thành công.
        async query(sql, values = []) {
          if (sql === "BEGIN") return { rows: [] };
          if (sql === "ROLLBACK") { draft = undefined; release(); return { rows: [] }; }
          if (sql.startsWith("SELECT * FROM drawing.rooms WHERE id=")) {
            assert.ok(sql.endsWith(" FOR UPDATE"));
            const previous = lock;
            lock = new Promise((resolve) => { unlock = resolve; });
            await previous;
            draft = structuredClone(stored);
            return { rows: values[0] === roomId ? [draft.room] : [] };
          }
          if (sql === "COMMIT") {
            if (control.pause) {
              const gate = control.pause;
              control.pause = null;
              gate.reached();
              await gate.wait;
            }
            if (control.failAt === "commit") throw Object.assign(new Error("Fixture failure"), { code: "08006" });
            stored = draft;
            release();
            return { rows: [] };
          }
          if (sql.startsWith("SELECT user_id FROM drawing.room_members")) {
            return { rows: values[0] === roomId && draft.members.includes(values[1]) ? [{ user_id: values[1] }] : [] };
          }
          if (sql.startsWith("SELECT sequence,payload,author_id FROM drawing.room_operations")) {
            return { rows: draft.operations.filter((row) => row.operation_id === values[1].toLowerCase()) };
          }
          if (sql.startsWith("SELECT payload=$3::jsonb AS equal")) {
            const row = draft.operations.find((item) => item.operation_id === values[1].toLowerCase());
            return { rows: [{ equal: isDeepStrictEqual(row.payload, JSON.parse(values[2])) }] };
          }
          if (sql.startsWith("SELECT payload FROM drawing.room_operations")) {
            return { rows: draft.operations.filter((row) => row.sequence <= values[1])
              .sort((a, b) => a.sequence - b.sequence).map(({ payload }) => ({ payload })) };
          }
          if (sql.startsWith("INSERT INTO drawing.room_operations")) {
            if (control.failAt === "insert") throw Object.assign(new Error("Fixture failure"), { code: "08006" });
            const id = values[1].toLowerCase();
            assert.ok(!draft.operations.some((row) => row.operation_id === id || row.sequence === values[2]));
            draft.operations.push({ operation_id: id, sequence: values[2], author_id: values[3], payload: JSON.parse(values[4]) });
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE drawing.rooms SET sequence=")) {
            if (control.failAt === "sequence") throw Object.assign(new Error("Fixture failure"), { code: "08006" });
            draft.room.sequence = values[1];
            return { rows: [] };
          }
          if (sql.startsWith("UPDATE drawing.rooms SET sharing_enabled=")) {
            Object.assign(draft.room, { sharing_enabled: values[1], sharing_version: values[2], invite_hash: values[3] });
            return { rows: [draft.room] };
          }
          if (sql.startsWith("DELETE FROM drawing.room_members")) {
            draft.members = draft.members.filter((user) => user === values[1]);
            return { rows: [] };
          }
          throw new Error("Unexpected visibility fixture query");
        },
      };
    },
  };
  const repository = new PostgresRepository(pool, { shareToken: createShareTokenGenerator("05".repeat(32)) });
  context.after(() => control.release?.());
  // Dừng có kiểm soát ngay trước COMMIT để kiểm tra xác nhận trễ và thứ tự với thao tác đổi chế độ.
  function pauseCommit() {
    let reached;
    const atCommit = new Promise((resolve) => { reached = resolve; });
    const wait = new Promise((resolve) => { control.release = resolve; });
    control.pause = { reached, wait };
    return { reached: atCommit, release: control.release };
  }
  // Đọc một mốc sequence dưới cùng khóa hàng như state/save thực tế.
  async function readAt(sequence) {
    return repository.transaction(async (client) => {
      const room = await repository.member(client, "owner", roomId);
      return repository.document(client, room, sequence);
    });
  }
  return { repository, pool, roomId, control, pauseCommit, readAt, snapshot: () => structuredClone(stored) };
}

// Nét fixture có UUID hợp lệ; nét tẩy cũng được giữ nguyên trong lịch sử khi bị ẩn hoặc hiện lại.
function stroke(type = "line") {
  return { id: randomUUID(), type, width: 4, color: "#123456",
    ...(type === "eraser" ? { points: [{ x: 30, y: 40 }] }
      : { start: { x: 10, y: 20 }, end: { x: 30, y: 40 } }) };
}

// Tách UUID sự kiện khỏi UUID nét để retry không tạo thêm lần ẩn/hiện.
function visibility(targetId, visible = false) {
  return { id: randomUUID(), type: "visibility", targetId, visible };
}

for (const sharingEnabled of [false, true]) {
  test(`ordinary strokes retain the v1 document in ${sharingEnabled ? "shared" : "personal"} mode`, async (context) => {
    const { repository, roomId } = fixture(context, { sharingEnabled });
    const operation = stroke();
    await repository.commit("owner", roomId, operation);
    const state = await repository.state("owner", roomId);
    assert.equal(state.sequence, 1);
    assert.deepEqual(state.document, { ...emptyDocument(), operations: [operation] });
  });
}

test("hidden strokes and ordered visibility events reload from a recreated repository", async (context) => {
  const { repository, pool, roomId, snapshot } = fixture(context);
  const original = stroke("eraser");
  const hidden = visibility(original.id);
  const shown = visibility(original.id, true);
  const next = stroke();
  for (const operation of [original, hidden, shown, next]) await repository.commit("owner", roomId, operation);
  const reloaded = await new PostgresRepository(pool).state("owner", roomId);
  assert.equal(reloaded.sequence, 4);
  assert.deepEqual(reloaded.document, { ...emptyDocument(), version: 2, operations: [original, hidden, shown, next] });
  assert.deepEqual(snapshot().operations.map(({ sequence }) => sequence), [1, 2, 3, 4]);
  assert.ok(snapshot().operations.every(({ author_id }) => author_id === "owner"));
  assert.deepEqual(snapshot().room.initial_document, emptyDocument());
});

for (const version of [1, 2]) {
  test(`visibility may reference an initial v${version} stroke without changing its UUID or geometry`, async (context) => {
    const original = stroke();
    const initialDocument = { ...emptyDocument(), operations: [original] };
    if (version === 2) Object.assign(initialDocument, normalizeDocument(initialDocument));
    const { repository, roomId, snapshot } = fixture(context, { initialDocument });
    const hidden = visibility(original.id);
    await repository.commit("owner", roomId, hidden);
    assert.deepEqual((await repository.state("owner", roomId)).document.operations, [original, hidden]);
    assert.deepEqual(snapshot().room.initial_document, initialDocument);
  });
}

test("only the personal project owner may create visibility events", async (context) => {
  for (const sharingEnabled of [false, true]) {
    const { repository, roomId, snapshot } = fixture(context, { sharingEnabled });
    const original = stroke();
    await repository.commit("owner", roomId, original);
    const before = snapshot();
    const event = visibility(original.id);
    await assert.rejects(repository.commit("outsider", roomId, event), { code: "ROOM_NOT_FOUND" });
    await assert.rejects(repository.commit("owner", randomUUID(), event), { code: "ROOM_NOT_FOUND" });
    if (sharingEnabled)
      await assert.rejects(repository.commit("member", roomId, visibility(randomUUID())), { code: "INVALID_INPUT" });
    else await assert.rejects(repository.commit("member", roomId, event), { code: "ROOM_NOT_FOUND" });
    assert.deepEqual(snapshot(), before);
  }
});

test("invalid visibility payloads and missing or event targets leave persisted state untouched", async (context) => {
  const { repository, roomId, snapshot } = fixture(context);
  const original = stroke();
  const hidden = visibility(original.id);
  await repository.commit("owner", roomId, original);
  await repository.commit("owner", roomId, hidden);
  const before = snapshot();
  for (const event of [visibility(randomUUID()), visibility(hidden.id, true),
    { ...visibility(original.id), visible: "false" }, { ...visibility(original.id), width: 4 }]) {
    await assert.rejects(repository.commit("owner", roomId, event), { code: "INVALID_INPUT" });
    assert.deepEqual(snapshot(), before);
  }
});

test("lost-ack retries retain the original sequence across JSONB key order and reject changed payloads", async (context) => {
  const { repository, pool, roomId, snapshot } = fixture(context);
  const original = stroke();
  const event = visibility(original.id);
  await repository.commit("owner", roomId, original);
  const saved = await repository.commit("owner", roomId, event);
  const before = snapshot();
  const reordered = { visible: event.visible, targetId: event.targetId, type: event.type, id: event.id };
  const retry = await new PostgresRepository(pool).commit("owner", roomId, reordered);
  assert.deepEqual(retry, { ...saved, duplicate: true });
  await assert.rejects(repository.commit("owner", roomId, { ...event, visible: true }), { code: "OPERATION_CONFLICT" });
  assert.deepEqual(snapshot(), before);
});

test("a saved visibility retry remains confirmable after sharing is enabled", async (context) => {
  const { repository, roomId, snapshot } = fixture(context);
  const original = stroke();
  const event = visibility(original.id);
  await repository.commit("owner", roomId, original);
  const saved = await repository.commit("owner", roomId, event);
  await repository.setSharing("owner", roomId, true);
  const before = snapshot();
  assert.deepEqual(await repository.commit("owner", roomId, event), { ...saved, duplicate: true });
  assert.deepEqual((await repository.state("member", roomId)).document.operations, [original, event]);
  assert.deepEqual(snapshot(), before);
});

test("visibility resolves only after COMMIT and concurrent retries share one sequence", { timeout: 5000 }, async (context) => {
  const { repository, roomId, snapshot, pauseCommit } = fixture(context);
  const original = stroke();
  const event = visibility(original.id);
  await repository.commit("owner", roomId, original);
  const gate = pauseCommit();
  let resolved = false;
  const first = repository.commit("owner", roomId, event).then((result) => { resolved = true; return result; });
  await gate.reached;
  const second = repository.commit("owner", roomId, event);
  try {
    assert.equal(resolved, false);
    assert.equal(snapshot().operations.length, 1);
    assert.equal(snapshot().room.sequence, 1);
  } finally { gate.release(); }
  const [saved, retry] = await Promise.all([first, second]);
  assert.equal(saved.duplicate, false);
  assert.deepEqual(retry, { ...saved, duplicate: true });
  assert.equal(saved.sequence, 2);
  assert.equal(snapshot().operations.length, 2);
});

test("new event IDs cannot collide with an initial drawing UUID in different casing", async (context) => {
  const original = { ...stroke(), id: "00000000-0000-4000-8000-000000000abc" };
  const { repository, roomId, snapshot } = fixture(context, { initialDocument: { ...emptyDocument(), operations: [original] } });
  const before = snapshot();
  await assert.rejects(repository.commit("owner", roomId, { ...stroke(), id: original.id.toUpperCase() }), { code: "OPERATION_CONFLICT" });
  assert.deepEqual(snapshot(), before);
});

test("sequence-bounded loading keeps exactly the drawing and visibility history at that point", async (context) => {
  const { repository, roomId, readAt } = fixture(context);
  const original = stroke();
  const events = [original, visibility(original.id), visibility(original.id, true)];
  for (const event of events) await repository.commit("owner", roomId, event);
  for (const sequence of [0, 1, 2, 3]) {
    assert.deepEqual(await readAt(sequence), {
      ...emptyDocument(), version: sequence < 2 ? 1 : 2, operations: events.slice(0, sequence),
    });
  }
  await assert.rejects(readAt(4), { code: "SEQUENCE_AHEAD" });
});

for (const failAt of ["insert", "sequence", "commit"]) {
  test(`visibility ${failAt} failure rolls back both event and sequence and can retry the same UUID`, async (context) => {
    const { repository, roomId, snapshot, control } = fixture(context);
    const original = stroke();
    const event = visibility(original.id);
    await repository.commit("owner", roomId, original);
    const before = snapshot();
    control.failAt = failAt;
    await assert.rejects(repository.commit("owner", roomId, event), { code: "08006" });
    assert.deepEqual(snapshot(), before);
    control.failAt = "";
    assert.equal((await repository.commit("owner", roomId, event)).duplicate, false);
    assert.equal((await repository.commit("owner", roomId, event)).duplicate, true);
    assert.equal(snapshot().operations.length, 2);
    assert.equal(snapshot().room.sequence, 2);
  });
}

test("visibility locked before a sharing change commits first and remains in the shared drawing", { timeout: 5000 }, async (context) => {
  const { repository, roomId, pauseCommit } = fixture(context);
  const original = stroke();
  const event = visibility(original.id);
  await repository.commit("owner", roomId, original);
  const gate = pauseCommit();
  const committing = repository.commit("owner", roomId, event);
  await gate.reached;
  const sharing = repository.setSharing("owner", roomId, true);
  gate.release();
  await Promise.all([committing, sharing]);
  const state = await repository.state("member", roomId);
  assert.equal(state.room.sharingEnabled, true);
  assert.equal(state.sequence, 2);
  assert.deepEqual(state.document.operations, [original, event]);
});

test("a member undo queued after access is revoked cannot write", { timeout: 5000 }, async (context) => {
  const { repository, roomId, snapshot, pauseCommit } = fixture(context, { sharingEnabled: true });
  const original = stroke();
  await repository.commit("member", roomId, original);
  const gate = pauseCommit();
  const sharing = repository.setSharing("owner", roomId, false);
  await gate.reached;
  const committing = assert.rejects(repository.commit("member", roomId, visibility(original.id)), { code: "ROOM_NOT_FOUND" });
  gate.release();
  await Promise.all([sharing, committing]);
  assert.equal(snapshot().operations.length, 1);
  assert.equal(snapshot().room.sequence, 1);
});
