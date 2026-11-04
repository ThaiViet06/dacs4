const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createShareTokenGenerator } = require("../src/sharing");
const { readConfig } = require("../src/config");
const { joinSchema } = require("../src/protocol");

// Khóa/dự án fixture chỉ dành cho test; readConfig nhận object giả, không sử dụng cấu hình tài khoản thật.
const secret = "01".repeat(32);
const roomId = "00000000-0000-4000-8000-000000000abc";
const environment = {
  DATABASE_URL: "postgresql://fixture:fixture@localhost/drawing_test",
  DATABASE_SSL: "false", CLERK_PUBLISHABLE_KEY: "fixture-publishable",
  CLERK_SECRET_KEY: "fixture-secret", ALLOWED_ORIGINS: "http://localhost:5173",
};

// Khởi tạo lại bộ sinh không được đổi token; UUID viết hoa vẫn chỉ cùng một dự án.
test("share tokens remain stable across generator recreation and UUID casing", () => {
  const first = createShareTokenGenerator(secret)(roomId, 0);
  const recreated = createShareTokenGenerator(secret);
  assert.equal(recreated(roomId, 0), first);
  assert.equal(recreated(roomId.toUpperCase(), 0), first);
  assert.deepEqual(joinSchema({ token: first }), { token: first });
});

// Đổi version, dự án hoặc khóa phải cho token khác; không ghi dữ liệu hay phát lời mời ở bước này.
test("share tokens differ for another version, project or secret", () => {
  const generate = createShareTokenGenerator(secret);
  const tokens = [generate(roomId, 0), generate(roomId, 1),
    generate("00000000-0000-4000-8000-000000000def", 0),
    createShareTokenGenerator("02".repeat(32))(roomId, 0)];
  assert.equal(new Set(tokens).size, tokens.length);
  assert.ok(tokens.every((token) => /^[A-Za-z0-9_-]{43}$/.test(token)));
});

// Không dùng khóa yếu/sai định dạng hoặc tự lấy khóa dự phòng; thông báo không được chứa đầu vào.
test("share token generation requires a separate valid secret without exposing it in errors", () => {
  for (const invalid of [undefined, null, "", "short-fixture-secret", "x".repeat(64), "01".repeat(31), "01".repeat(33)]) {
    assert.throws(() => createShareTokenGenerator(invalid), (error) => {
      assert.equal(error.message, "Configure SHARE_LINK_SECRET as 64 hexadecimal characters (32 random bytes).");
      return true;
    });
  }
});

// Chặn ID/version không hợp lệ để tránh sinh link cho dữ liệu sai hoặc mất chính xác số nguyên.
test("share token generation rejects invalid project IDs and versions", () => {
  const generate = createShareTokenGenerator(secret);
  for (const invalid of [undefined, "", "not-a-uuid"]) {
    assert.throws(() => generate(invalid, 0), { code: "INVALID_INPUT" });
  }
  for (const invalid of [undefined, -1, 0.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => generate(roomId, invalid), /Invalid sharing version/);
  }
});

// Cấu hình trống giữ luồng hiện tại hoạt động; khóa hợp lệ được giữ chính xác để dùng ở API sau.
test("config allows an absent share secret and preserves a configured key", () => {
  assert.equal(readConfig(environment).shareLinkSecret, "");
  assert.equal(readConfig({ ...environment, SHARE_LINK_SECRET: "" }).shareLinkSecret, "");
  const config = readConfig({ ...environment, SHARE_LINK_SECRET: secret });
  assert.equal(config.shareLinkSecret, secret);
  assert.equal(createShareTokenGenerator(config.shareLinkSecret)(roomId, 0), createShareTokenGenerator(secret)(roomId, 0));
});

// Sai khóa chia sẻ báo lỗi cấu hình rõ ràng, không đưa khóa đã nhập vào log khởi động.
test("config rejects malformed share secrets without including the secret in the error", () => {
  for (const invalid of [" ", "REPLACE_ME", "wrong-fixture-value", "g".repeat(64)]) {
    assert.throws(() => readConfig({ ...environment, SHARE_LINK_SECRET: invalid }), (error) => {
      assert.equal(error.message, "Configure SHARE_LINK_SECRET as 64 hexadecimal characters (32 random bytes).");
      return true;
    });
  }
});
