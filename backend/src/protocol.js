const { AppError } = require("./errors");
const WIDTH = 1600;
const HEIGHT = 900;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
// Ném lỗi đầu vào có cấu trúc khi điều kiện kiểm tra không đạt.
function ensure(condition) { if (!condition) throw new AppError(400, "INVALID_INPUT", "Invalid request. Check the drawing or form values."); }
// Chỉ chấp nhận object có đúng các khóa được giao thức cho phép.
function object(value, keys) {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  ensure(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
// Kiểm tra ID thao tác/phòng có dạng UUID hợp lệ.
function uuidSchema(value) {
  ensure(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  return value;
}
// Kiểm tra điểm vẽ nằm trong kích thước logic của canvas.
function point(value) {
  object(value, ["x", "y"]);
  ensure(Number.isFinite(value.x) && value.x >= 0 && value.x <= WIDTH);
  ensure(Number.isFinite(value.y) && value.y >= 0 && value.y <= HEIGHT);
}
// Kiểm tra kiểu nét, hình học, màu, độ dày và giới hạn số điểm.
function operationSchema(value) {
  ensure(value && typeof value === "object");
  uuidSchema(value.id);
  ensure(Number.isFinite(value.width) && value.width >= 1 && value.width <= 50);
  ensure(typeof value.color === "string" && /^#[0-9a-fA-F]{6}$/.test(value.color));
  if (["freehand", "eraser"].includes(value.type)) {
    object(value, ["id", "type", "width", "color", "points"]);
    ensure(Array.isArray(value.points) && value.points.length >= 1 && value.points.length <= 2048);
    value.points.forEach(point);
  } else {
    ensure(["line", "rectangle", "circle"].includes(value.type));
    object(value, ["id", "type", "width", "color", "start", "end"]);
    point(value.start); point(value.end);
  }
  return value;
}
// Loại khoảng trắng thừa và kiểm tra độ dài tên phòng hoặc bản lưu.
function titleSchema(value) {
  ensure(typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100);
  return value.trim();
}
// Dữ liệu tạo hoặc đổi tên dự án chỉ được có một trường title hợp lệ.
function createSchema(value) { object(value, ["title"]); return { title: titleSchema(value.title) }; }
// Kiểm tra token trong yêu cầu tham gia phòng.
function joinSchema(value) {
  object(value, ["token"]);
  ensure(typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token));
  return value;
}
// Kiểm tra tiêu đề và số thứ tự thao tác mà người dùng muốn lưu đến.
function saveSchema(value) {
  object(value, ["title", "sequence"]);
  ensure(Number.isSafeInteger(value.sequence) && value.sequence >= 0);
  return { title: titleSchema(value.title), sequence: value.sequence };
}
// Kiểm tra phiên bản và cấu trúc của từng loại thông điệp WebSocket.
function messageSchema(value) {
  ensure(value && value.v === 1);
  if (["auth", "auth.refresh"].includes(value.type)) {
    object(value, ["v", "type", "token"]);
    ensure(typeof value.token === "string" && value.token.length > 0 && value.token.length <= 8192);
  } else if (value.type === "room.join") {
    object(value, ["v", "type", "roomId"]); uuidSchema(value.roomId);
  } else if (["operation.preview", "operation.commit"].includes(value.type)) {
    object(value, ["v", "type", "operation"]); operationSchema(value.operation);
  } else {
    ensure(value.type === "preview.cancel");
    object(value, ["v", "type", "operationId"]); uuidSchema(value.operationId);
  }
  return value;
}
// Tạo tài liệu vẽ trống theo chuẩn dùng chung của frontend và backend.
const emptyDocument = () => ({ version: 1, width: WIDTH, height: HEIGHT, operations: [] });
// Gọi hàm kiểm tra tương ứng cho dữ liệu đầu vào.
function parse(schema, value) {
  return schema(value);
}
// Từ chối bản vẽ vượt quá giới hạn 5 MiB sau khi mã hóa JSON.
function checkSize(document) {
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) throw new AppError(413, "DOCUMENT_FULL", "This board reached its 5 MiB limit. Start a new room.");
}
module.exports = { WIDTH, HEIGHT, MAX_DOCUMENT_BYTES, operationSchema, messageSchema, titleSchema, createSchema, joinSchema, uuidSchema, saveSchema, emptyDocument, parse, checkSize };
