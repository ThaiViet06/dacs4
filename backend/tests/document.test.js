const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { emptyDocument, eventSchema, normalizeDocument, messageSchema, MAX_DOCUMENT_BYTES } = require("../src/protocol");

// Tạo dữ liệu năm công cụ hợp lệ, không cần database hoặc tài khoản thật.
function legacyDocument() {
  return { ...emptyDocument(), operations: ["freehand", "line", "rectangle", "circle", "eraser"].map((type) => ({
    id: randomUUID(), type, color: "#263b53", width: 8,
    ...(["freehand", "eraser"].includes(type)
      ? { points: [{ x: 10.25, y: 20.5 }, { x: 30, y: 40 }] }
      : { start: { x: 100, y: 150 }, end: { x: 50, y: 75 } }),
  })) };
}

// Mỗi lần ẩn/hiện có UUID riêng để bước lưu sau này có thể retry mà không tạo sự kiện trùng.
function visibility(targetId, visible) {
  return { id: randomUUID(), type: "visibility", targetId, visible };
}

test("v1 documents normalize to v2 without changing geometry, UUIDs, order or the source", () => {
  const source = legacyDocument();
  const before = structuredClone(source);
  const normalized = normalizeDocument(source);
  assert.deepEqual(normalized, { ...before, version: 2 });
  normalized.operations[0].points[0].x = 700;
  normalized.operations[1].start.x = 800;
  assert.deepEqual(source, before);
  assert.deepEqual(normalizeDocument(emptyDocument()), { ...emptyDocument(), version: 2 });
});

test("v2 normalization preserves hidden strokes and ordered visibility history through JSON replay", () => {
  const document = normalizeDocument(legacyDocument());
  document.operations.push(visibility(document.operations[0].id.toUpperCase(), false));
  document.operations.push(visibility(document.operations[0].id, true));
  const before = structuredClone(document);
  const normalized = normalizeDocument(JSON.parse(JSON.stringify(document)));
  assert.deepEqual(normalized, before);
  assert.deepEqual(normalizeDocument(normalized), before);
  normalized.operations.at(-1).visible = false;
  assert.deepEqual(document, before);
});

test("visibility events require exact fields, valid distinct UUIDs and a boolean", () => {
  const event = visibility(randomUUID(), false);
  assert.deepEqual(eventSchema(event), event);
  for (const invalid of [
    { ...event, id: "invalid" }, { ...event, targetId: "invalid" },
    { ...event, id: event.targetId }, { ...event, visible: "false" },
    { ...event, visible: 0 }, { ...event, visible: null },
    { ...event, targetId: undefined }, { ...event, ownerId: "forged-owner" },
    { ...event, type: "delete" },
  ]) assert.throws(() => eventSchema(invalid), { status: 400, code: "INVALID_INPUT" });
});

test("document validation rejects unknown formats and visibility inside legacy documents", () => {
  const source = legacyDocument();
  for (const invalid of [
    null, [], {}, { ...source, version: 0 }, { ...source, version: 3 },
    { ...source, width: 800 }, { ...source, height: 450 }, { ...source, operations: null },
    { ...source, sequence: 1 },
    { ...source, operations: [...source.operations, visibility(source.operations[0].id, false)] },
  ]) assert.throws(() => normalizeDocument(invalid), { status: 400, code: "INVALID_INPUT" });
});

test("a document cannot reuse stroke or event IDs, including UUID casing differences", () => {
  const document = normalizeDocument(legacyDocument());
  document.operations[0].id = "00000000-0000-4000-8000-000000000abc";
  const stroke = document.operations[0];
  const hidden = visibility(stroke.id, false);
  for (const operations of [
    [stroke, { ...stroke }], [stroke, { ...stroke, id: stroke.id.toUpperCase() }],
    [stroke, { ...hidden, id: stroke.id }], [stroke, hidden, { ...hidden, visible: true }],
  ]) assert.throws(() => normalizeDocument({ ...document, operations }), { status: 400, code: "INVALID_INPUT" });
});

test("visibility must target an earlier stroke rather than a missing, future or visibility event", () => {
  const document = normalizeDocument(legacyDocument());
  const stroke = document.operations[0];
  const hidden = visibility(stroke.id, false);
  for (const operations of [
    [visibility(stroke.id, false), stroke],
    [stroke, visibility(randomUUID(), false)],
    [stroke, hidden, visibility(hidden.id, true)],
  ]) assert.throws(() => normalizeDocument({ ...document, operations }), { status: 400, code: "INVALID_INPUT" });
});

test("both document versions retain stroke geometry, color, width and point limits", () => {
  const document = legacyDocument();
  const stroke = document.operations[0];
  for (const fields of [
    { width: 0 }, { width: 51 }, { color: "red" }, { points: [] },
    { points: [{ x: -1, y: 0 }] }, { points: [{ x: 1601, y: 0 }] },
    { points: [{ x: 0, y: 901 }] }, { points: [{ x: NaN, y: 0 }] },
    { points: Array.from({ length: 2049 }, () => ({ x: 0, y: 0 })) },
  ]) for (const version of [1, 2]) {
    assert.throws(() => normalizeDocument({ ...document, version, operations: [{ ...stroke, ...fields }] }),
      { status: 400, code: "INVALID_INPUT" });
  }
});

test("v2 documents retain the serialized 5 MiB limit", () => {
  const points = Array.from({ length: 2048 }, () => ({ x: 1599.9999999, y: 899.9999999 }));
  const document = { ...emptyDocument(), version: 2, operations: Array.from({ length: 80 }, () => ({
    id: randomUUID(), type: "freehand", width: 8, color: "#263b53", points,
  })) };
  assert.ok(Buffer.byteLength(JSON.stringify(document)) > MAX_DOCUMENT_BYTES);
  assert.throws(() => normalizeDocument(document), { status: 413, code: "DOCUMENT_FULL" });
});

test("v2 accepts visibility commits but rejects visibility previews and unsupported protocol versions", () => {
  const event = visibility(randomUUID(), false);
  assert.deepEqual(messageSchema({ v: 2, type: "operation.commit", operation: event }).operation, event);
  assert.throws(() => messageSchema({ v: 2, type: "operation.preview", operation: event }),
    { status: 400, code: "INVALID_INPUT" });
  for (const v of [1, 3]) {
    assert.throws(() => messageSchema({ v, type: "operation.commit", operation: event }),
      { status: 400, code: "INVALID_INPUT" });
  }
  const stroke = legacyDocument().operations[0];
  assert.deepEqual(messageSchema({ v: 2, type: "operation.commit", operation: stroke }).operation, stroke);
});
