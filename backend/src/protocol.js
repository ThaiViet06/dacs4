const { AppError } = require("./errors");
const WIDTH = 1600;
const HEIGHT = 900;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
function ensure(condition) { if (!condition) throw new AppError(400, "INVALID_INPUT", "Invalid request. Check the drawing or form values."); }
function object(value, keys) {
  ensure(value && typeof value === "object" && !Array.isArray(value));
  ensure(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}
function uuidSchema(value) {
  ensure(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  return value;
}
function point(value) {
  object(value, ["x", "y"]);
  ensure(Number.isFinite(value.x) && value.x >= 0 && value.x <= WIDTH);
  ensure(Number.isFinite(value.y) && value.y >= 0 && value.y <= HEIGHT);
}
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
function titleSchema(value) {
  ensure(typeof value === "string" && value.trim().length > 0 && value.trim().length <= 100);
  return value.trim();
}
function createSchema(value) { object(value, ["title"]); return { title: titleSchema(value.title) }; }
function joinSchema(value) {
  object(value, ["token"]);
  ensure(typeof value.token === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.token));
  return value;
}
function saveSchema(value) {
  object(value, ["title", "sequence"]);
  ensure(Number.isSafeInteger(value.sequence) && value.sequence >= 0);
  return { title: titleSchema(value.title), sequence: value.sequence };
}
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
const emptyDocument = () => ({ version: 1, width: WIDTH, height: HEIGHT, operations: [] });
function parse(schema, value) {
  return schema(value);
}
function checkSize(document) {
  if (Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES) throw new AppError(413, "DOCUMENT_FULL", "This board reached its 5 MiB limit. Start a new room.");
}
module.exports = { WIDTH, HEIGHT, MAX_DOCUMENT_BYTES, operationSchema, messageSchema, titleSchema, createSchema, joinSchema, uuidSchema, saveSchema, emptyDocument, parse, checkSize };
