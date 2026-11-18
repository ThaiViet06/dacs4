const { AppError } = require("./errors");
const { operationSchema } = require("./protocol");

const TOOLS = ["freehand", "eraser", "line", "rectangle", "circle"];
const HEADER = 15;
const MAX_BYTES = HEADER + 2048 * 6;

// Codec v1: phiên bản, loại, RGB, độ rộng Float64 LE, số điểm UInt16 LE rồi đến delta ZigZag varint.
function packStroke(operation) {
  if (operation.type === "visibility" || operation.color !== operation.color.toLowerCase() ||
    operation.id !== operation.id.toLowerCase()) return null;
  const points = operation.points || [operation.start, operation.end];
  const bytes = Buffer.allocUnsafe(HEADER + points.length * 6);
  bytes[0] = 1;
  bytes[1] = TOOLS.indexOf(operation.type);
  bytes.writeUIntBE(Number.parseInt(operation.color.slice(1), 16), 2, 3);
  bytes.writeDoubleLE(operation.width, 5);
  bytes.writeUInt16LE(points.length, 13);
  let cursor = HEADER;
  let previousX = 0;
  let previousY = 0;
  for (const { x, y } of points) {
    const px = Math.round(x * 100);
    const py = Math.round(y * 100);
    // Giữ nguyên dữ liệu cũ có độ chính xác cao hơn 0,01 px.
    if (px / 100 !== x || py / 100 !== y) return null;
    for (const delta of [px - previousX, py - previousY]) {
      let value = delta < 0 ? -2 * delta - 1 : 2 * delta;
      while (value >= 128) { bytes[cursor++] = (value & 127) | 128; value >>>= 7; }
      bytes[cursor++] = value;
    }
    previousX = px;
    previousY = py;
  }
  return bytes.subarray(0, cursor);
}

// Giới hạn kích thước trước khi giải mã và chạy lại bộ kiểm tra hình học hiện có.
function unpackStroke(id, bytes) {
  const invalid = () => new AppError(400, "INVALID_INPUT", "Invalid compact drawing stroke.");
  if (bytes.length < HEADER || bytes.length > MAX_BYTES || bytes[0] !== 1 || !TOOLS[bytes[1]]) throw invalid();
  const type = TOOLS[bytes[1]];
  const count = bytes.readUInt16LE(13);
  if (!count || count > 2048 || (bytes[1] >= 2 && count !== 2)) throw invalid();
  let cursor = HEADER;
  // Giới hạn mỗi delta trong 3 byte, đủ cho toàn bộ khung 1600 × 900.
  function delta() {
    let value = 0;
    for (let shift = 0; shift <= 14 && cursor < bytes.length; shift += 7) {
      const byte = bytes[cursor++];
      value |= (byte & 127) << shift;
      if (byte < 128) return value & 1 ? -(value + 1) / 2 : value / 2;
    }
    throw invalid();
  }
  const points = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += delta();
    y += delta();
    points.push({ x: x / 100, y: y / 100 });
  }
  if (cursor !== bytes.length) throw invalid();
  const base = { id, type, color: "#" + bytes.readUIntBE(2, 3).toString(16).padStart(6, "0"), width: bytes.readDoubleLE(5) };
  return operationSchema(bytes[1] < 2 ? { ...base, points } : { ...base, start: points[0], end: points[1] });
}

// Chỉ dùng định dạng base64 chuẩn khi giao tiếp với trình duyệt.
function unpackWire(id, value) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new AppError(400, "INVALID_INPUT", "Invalid compact drawing data.");
  return unpackStroke(id, bytes);
}

module.exports = { packStroke, unpackStroke, unpackWire };
