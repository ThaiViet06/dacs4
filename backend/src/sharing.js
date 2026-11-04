const { createHmac, createHash, randomBytes } = require("node:crypto");
const { uuidSchema, sharingSchema } = require("./protocol");
const { AppError } = require("./errors");

// Khóa riêng gồm 32 byte ngẫu nhiên dạng hex; lỗi chỉ hướng dẫn cấu hình, không in giá trị đã nhập.
function validateShareLinkSecret(secret) {
  if (typeof secret !== "string" || !/^[a-f0-9]{64}$/i.test(secret)) {
    throw new Error("Configure SHARE_LINK_SECRET as 64 hexadecimal characters (32 random bytes).");
  }
}

// Giữ khóa trong backend để tạo lại cùng token qua restart, không sinh khóa ngẫu nhiên thay thế khi thiếu.
function createShareTokenGenerator(secret) {
  validateShareLinkSecret(secret);
  const key = Buffer.from(secret, "hex");

  // Mỗi ID/version có một token; version mới vô hiệu hóa link cũ khi được nối vào API chia sẻ sau này.
  return function shareToken(roomId, version) {
    const id = uuidSchema(roomId).toLowerCase();
    if (!Number.isSafeInteger(version) || version < 0) throw new Error("Invalid sharing version.");
    return createHmac("sha256", key).update(`drawing-share:v1:${id}:${version}`).digest("base64url");
  };
}

// Giữ link khi gửi lặp; chỉ tăng version khi đổi chế độ hoặc chủ xác nhận nâng link cũ lên HMAC.
function sharingChange(current, enabled, shareToken, { upgradeLegacy = false } = {}) {
  sharingSchema({ enabled });
  const changed = current.enabled !== enabled || (upgradeLegacy && current.enabled && enabled && current.version === 0);
  const version = current.version + (changed ? 1 : 0);
  if (!Number.isInteger(version) || version < 0 || version > 2147483647) {
    throw new AppError(409, "SHARING_VERSION_LIMIT", "This project's sharing version cannot be advanced.");
  }
  let inviteHash = current.inviteHash;
  let inviteToken;
  if (enabled && (changed || version > 0)) {
    if (!shareToken) throw new AppError(503, "SHARING_UNAVAILABLE", "Configure the sharing key before enabling sharing.");
    inviteToken = shareToken(current.id, version);
    const generatedHash = createHash("sha256").update(inviteToken).digest("hex");
    if (!changed && generatedHash !== current.inviteHash) {
      throw new AppError(503, "SHARING_UNAVAILABLE", "The sharing key does not match this link. Restore the configured key.");
    }
    inviteHash = generatedHash;
  } else if (changed) {
    // Thu hồi bằng hash mới không phát cho ai; tắt chia sẻ vẫn dùng được khi thiếu khóa HMAC.
    inviteHash = createHash("sha256").update(randomBytes(32)).digest("hex");
  }
  return { version, inviteHash, ...(inviteToken ? { inviteToken } : {}) };
}

module.exports = { createShareTokenGenerator, validateShareLinkSecret, sharingChange };
