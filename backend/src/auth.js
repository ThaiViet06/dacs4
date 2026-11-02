const { verifyToken: verifyClerkToken } = require("@clerk/backend");

// Lấy issuer cố định từ publishable key cấu hình; không tin issuer do token gửi lên tự khai báo.
function issuerFromKey(publishableKey) {
  const match = typeof publishableKey === "string" && /^pk_(test|live)_([A-Za-z0-9+/]+={0,2})$/.exec(publishableKey);
  const decoded = match ? Buffer.from(match[2], "base64").toString("utf8") : "";
  const domain = decoded.slice(0, -1);
  let issuer;
  try { issuer = new URL(`https://${domain}`); } catch {}
  if (!decoded.endsWith("$") || !issuer || issuer.hostname !== domain || issuer.port) {
    throw new Error("Configure a valid CLERK_PUBLISHABLE_KEY.");
  }
  return issuer.origin;
}

// Tạo bộ xác thực dùng chung cho API/WebSocket; jwtKey cho phép kiểm tra offline bằng public key trong test.
function createTokenVerifier({ clerkPublishableKey, clerkSecretKey, origins }, { jwtKey } = {}) {
  const issuer = issuerFromKey(clerkPublishableKey);
  if (!Array.isArray(origins) || origins.length === 0) {
    throw new Error("Configure ALLOWED_ORIGINS before verifying sessions.");
  }
  const options = { secretKey: clerkSecretKey, issuer, authorizedParties: [...origins], ...(jwtKey ? { jwtKey } : {}) };

  // Chỉ trả danh tính tối thiểu sau khi SDK xác minh chữ ký, issuer, origin và các mốc thời gian.
  return async function verifySessionToken(token) {
    if (typeof token !== "string" || !token.trim() || token.length > 8192) throw new Error("Invalid Clerk session.");
    const payload = await verifyClerkToken(token, options);
    const expiresAt = payload.exp * 1000;
    // SDK có độ lệch đồng hồ cho phép; ứng dụng vẫn từ chối phiên đã hết hạn và phiên chưa hoàn tất đăng nhập.
    if (typeof payload.sub !== "string" || !payload.sub.trim() ||
        typeof payload.sid !== "string" || !payload.sid.trim() ||
        !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() || payload.sts === "pending") {
      throw new Error("Invalid Clerk session.");
    }
    return { userId: payload.sub, expiresAt };
  };
}

module.exports = { createTokenVerifier };
