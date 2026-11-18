const { AppError } = require("./errors");
const WIDTH = 1600;
const HEIGHT = 900;
const PROTOCOL_VERSION = 2;
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
// Kiểm tra sự kiện v2: nét dùng quy tắc cũ, còn ẩn/hiện chỉ nhận UUID đích và boolean rõ ràng.
function eventSchema(value) {
  if (value?.type !== "visibility") return operationSchema(value);
  object(value, ["id", "type", "targetId", "visible"]);
  uuidSchema(value.id); uuidSchema(value.targetId);
  ensure(typeof value.visible === "boolean" && value.id.toLowerCase() !== value.targetId.toLowerCase());
  return value;
}
// Đọc v1/v2 thành bản v2 độc lập; chặn ID trùng và chỉ cho ẩn/hiện nét đã xuất hiện trước đó.
function normalizeDocument(value) {
  object(value, ["version", "width", "height", "operations"]);
  ensure((value.version === 1 || value.version === 2) && value.width === WIDTH && value.height === HEIGHT);
  ensure(Array.isArray(value.operations));
  checkSize(value);
  const ids = new Set();
  const strokes = new Set();
  for (const event of value.operations) {
    if (value.version === 1) operationSchema(event);
    else eventSchema(event);
    const id = event.id.toLowerCase();
    ensure(!ids.has(id));
    ids.add(id);
    if (event.type === "visibility") ensure(strokes.has(event.targetId.toLowerCase()));
    else strokes.add(id);
  }
  return { version: 2, width: WIDTH, height: HEIGHT, operations: structuredClone(value.operations) };
}
// Loại khoảng trắng thừa và kiểm tra độ dài tên phòng hoặc bản lưu.
function titleSchema(value) {
  ensure(typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100);
  return value.trim();
}
// Dữ liệu tạo hoặc đổi tên dự án chỉ được có một trường title hợp lệ.
function createSchema(value) { object(value, ["title"]); return { title: titleSchema(value.title) }; }
// Chỉ nhận boolean bật/tắt; client không được tự chỉ định hash, version hoặc thành viên.
function sharingSchema(value) {
  object(value, ["enabled"]);
  ensure(typeof value.enabled === "boolean");
  return value;
}
// Thay link cũ cần xác nhận rõ ràng, không chấp nhận trường owner/hash/version từ client.
function upgradeInvitationSchema(value) {
  object(value, ["confirmed"]);
  ensure(value.confirmed === true);
  return value;
}
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
// Giao thức v2 nhận nét hoặc ẩn/hiện khi commit; preview chỉ được chứa nét vẽ.
function messageSchema(value) {
  ensure(value && value.v === PROTOCOL_VERSION);
  if (["auth", "auth.refresh"].includes(value.type)) {
    object(value, ["v", "type", "token"]);
    ensure(typeof value.token === "string" && value.token.length > 0 && value.token.length <= 8192);
  } else if (value.type === "room.join") {
    object(value, Object.hasOwn(value, "sync") ? ["v", "type", "roomId", "sync"] : ["v", "type", "roomId"]);
    uuidSchema(value.roomId);
    if (Object.hasOwn(value, "sync")) {
      const options = value.sync;
      ensure(options && typeof options === "object" && !Array.isArray(options));
      ensure(Object.keys(options).every((key) => ["lastSeq", "epoch", "snapshot", "vectorOnly"].includes(key)));
      for (const key of ["lastSeq", "epoch"])
        if (Object.hasOwn(options, key)) ensure(Number.isSafeInteger(options[key]) && options[key] >= 0 && options[key] <= 2147483647);
      for (const key of ["snapshot", "vectorOnly"])
        if (Object.hasOwn(options, key)) ensure(typeof options[key] === "boolean");
    }
  } else if (value.type === "operation.packed") {
    object(value, ["v", "type", "id", "packed"]);
    uuidSchema(value.id);
    ensure(typeof value.packed === "string" && value.packed.length > 0 && value.packed.length <= 16404);
  } else if (["operation.preview", "operation.commit"].includes(value.type)) {
    object(value, ["v", "type", "operation"]);
    if (value.type === "operation.commit") eventSchema(value.operation);
    else operationSchema(value.operation);
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
module.exports = { WIDTH, HEIGHT, PROTOCOL_VERSION, MAX_DOCUMENT_BYTES, operationSchema, eventSchema, normalizeDocument, messageSchema, titleSchema, createSchema, sharingSchema, upgradeInvitationSchema, joinSchema, uuidSchema, saveSchema, emptyDocument, parse, checkSize };
