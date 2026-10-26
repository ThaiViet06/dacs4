class AppError extends Error {
  // Gói mã HTTP, mã nghiệp vụ và thông báo để API xử lý thống nhất.
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
// Chỉ trả lỗi nghiệp vụ an toàn cho client, che chi tiết lỗi nội bộ.
function publicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  return { code: "SERVICE_UNAVAILABLE", message: "The service is unavailable. Please retry." };
}
module.exports = { AppError, publicError };
