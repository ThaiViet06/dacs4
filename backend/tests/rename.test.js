const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { test } = require("node:test");
const { createApplication } = require("../src/application");
const { PostgresRepository } = require("../src/repository");
const { emptyDocument } = require("../src/protocol");

// Chạy repository PostgreSQL thật với transaction giả, giữ dữ liệu riêng để kiểm tra quyền và rollback.
function fixture(sharingEnabled = true) {
  let stored = {
    id: randomUUID(), title: "Original", owner_id: "owner", sharing_enabled: sharingEnabled,
    sharing_version: 0, sequence: 7, invite_hash: "fixture-hash", initial_document: emptyDocument(),
    checkpoint: { title: "Saved checkpoint", sequence: 7 }, updated_at: "2026-11-04T00:00:00.000Z",
  };
  const control = { failAt: "", commits: 0, rollbacks: 0, releases: 0, updates: 0 };
  let draft;
  // Dữ liệu chỉ đổi sau COMMIT; lỗi ở UPDATE hoặc COMMIT phải giữ bản gốc.
  async function query(sql, values = []) {
    if (sql === "BEGIN") { draft = structuredClone(stored); return { rows: [] }; }
    if (sql === "ROLLBACK") { draft = undefined; control.rollbacks++; return { rows: [] }; }
    if (sql === "COMMIT") {
      if (control.failAt === "commit") throw Object.assign(new Error("Fixture commit failure"), { code: "08006" });
      stored = draft;
      control.commits++;
      return { rows: [] };
    }
    if (sql.startsWith("SELECT * FROM drawing.rooms WHERE id=")) {
      return { rows: values[0] === stored.id ? [draft] : [] };
    }
    if (sql.startsWith("SELECT user_id FROM drawing.room_members")) {
      return { rows: values[0] === stored.id && ["owner", "member"].includes(values[1]) ? [{ user_id: values[1] }] : [] };
    }
    if (sql === "UPDATE drawing.rooms SET title=$2,updated_at=now() WHERE id=$1 RETURNING *") {
      assert.equal(values[0], stored.id);
      if (control.failAt === "update") throw Object.assign(new Error("Fixture update failure"), { code: "08006" });
      draft.title = values[1];
      draft.updated_at = "2026-11-04T01:00:00.000Z";
      control.updates++;
      return { rows: [draft] };
    }
    throw new Error("Unexpected rename fixture query");
  }
  const repository = new PostgresRepository({ connect: async () => ({ query, release: () => { control.releases++; } }) });
  return { repository, control, snapshot: () => structuredClone(stored) };
}

for (const sharingEnabled of [false, true]) {
  // Đổi tên không được đổi owner, mode, token, sequence, bản vẽ hoặc checkpoint; dấu nháy vẫn là dữ liệu SQL.
  test(`owner can rename a ${sharingEnabled ? 'shared' : 'private'} project without changing drawing state`, async () => {
    const { repository, control, snapshot } = fixture(sharingEnabled);
    const before = snapshot();
    const title = "O'Reilly — bản phác thảo";
    const room = await repository.renameRoom("owner", before.id, "  " + title + "  ");
    assert.equal(room.title, title);
    assert.equal(room.sharingEnabled, sharingEnabled);
    assert.deepEqual(snapshot(), { ...before, title, updated_at: "2026-11-04T01:00:00.000Z" });
    assert.equal(control.commits, 1);
    assert.equal(control.releases, 1);
    assert.equal(control.rollbacks, 0);
  });
}

// Thành viên chung chỉ được vẽ; người ngoài/phòng thiếu nhận cùng lỗi an toàn và không chạy UPDATE.
test("members cannot rename and outsiders cannot discover a project by renaming", async () => {
  const { repository, control, snapshot } = fixture();
  const before = snapshot();
  await assert.rejects(repository.renameRoom("member", before.id, "Changed"), { status: 403, code: "OWNER_REQUIRED" });
  let message;
  for (const id of [before.id, randomUUID()]) {
    await assert.rejects(repository.renameRoom("outsider", id, "Changed"), (error) => {
      assert.equal(error.status, 404);
      assert.equal(error.code, "ROOM_NOT_FOUND");
      message ??= error.message;
      assert.equal(error.message, message);
      return true;
    });
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(control.updates, 0);
  assert.equal(control.commits, 0);
  assert.equal(control.rollbacks, 3);
  assert.equal(control.releases, 3);
});

// HTTP không được báo đổi tên thành công khi ghi/commit lỗi; dữ liệu cũ và thông báo an toàn phải được giữ.
test("HTTP rename rolls back update and commit failures without returning a false success", async (context) => {
  const errors = context.mock.method(console, "error", () => {});
  for (const failAt of ["update", "commit"]) {
    const { repository, control, snapshot } = fixture();
    const before = snapshot();
    control.failAt = failAt;
    const application = createApplication({ repository, origins: ["http://localhost:5173"],
      // Danh tính test cố định; kiểm tra chữ ký Clerk thật nằm trong auth.test.js.
      verifyToken: async (token) => {
        if (token !== "owner-session") throw new Error("Invalid fixture session");
        return { userId: "owner", expiresAt: Date.now() + 60000 };
      },
    });
    context.after(() => application.close());
    application.server.listen(0, "127.0.0.1");
    await once(application.server, "listening");
    const response = await fetch("http://127.0.0.1:" + application.server.address().port + "/api/rooms/" + before.id, {
      method: "PATCH", headers: { Authorization: "Bearer owner-session", "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Changed" }),
    });
    assert.equal(response.status, 503);
    const result = await response.json();
    assert.deepEqual(Object.keys(result), ["error"]);
    assert.equal(result.error.code, "SERVICE_UNAVAILABLE");
    assert.equal(errors.mock.calls.at(-1).arguments[1], "08006");
    assert.deepEqual(snapshot(), before);
    assert.equal(control.commits, 0);
    assert.equal(control.rollbacks, 1);
    assert.equal(control.releases, 1);
  }
});
