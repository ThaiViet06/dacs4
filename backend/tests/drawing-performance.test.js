const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { test } = require("node:test");
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const { RoomQueue } = require("../src/queue");
const { packStroke, unpackWire } = require("../src/stroke-codec");
const { renderSnapshot } = require("../src/snapshot-worker");

test("compact freehand stroke preserves geometry, uses fewer bytes and rejects truncated frames", () => {
  const operation = { id: randomUUID(), type: "freehand", width: 4.25, color: "#123456",
    points: Array.from({ length: 180 }, (_, index) => ({ x: 160 + index / 4, y: 90 - index / 10 })) };
  const packed = packStroke(operation);
  assert.ok(packed.length < Buffer.byteLength(JSON.stringify(operation)) / 4);
  assert.deepEqual(unpackWire(operation.id, packed.toString("base64")), operation);
  assert.throws(() => unpackWire(operation.id, packed.subarray(0, -1).toString("base64")), {
    code: "INVALID_INPUT",
  });
  assert.equal(packStroke({ ...operation, color: "#AABBCC" }), null);
  assert.equal(packStroke({ ...operation, points: [{ x: 12.345, y: 0 }] }), null);
});

test("commit batches have bounded size and cannot cross a project action", async () => {
  const queue = new RoomQueue();
  const log = [];
  const roomId = randomUUID();
  const saved = (jobs) => log.push(jobs);
  const before = Array.from({ length: 9 }, (_, index) => queue.batch(roomId, index, 20, saved));
  const barrier = queue.run(roomId, () => log.push("access change"));
  const after = [queue.batch(roomId, 9, 160000, saved), queue.batch(roomId, 10, 160000, saved)];
  await Promise.all([...before, barrier, ...after]);
  assert.deepEqual(log, [[0, 1, 2, 3, 4, 5, 6, 7], [8], "access change", [9], [10]]);
});

test("transparent snapshot preserves draw order and excludes hidden strokes", async () => {
  const first = { id: randomUUID(), type: "freehand", width: 20, color: "#123456", points: [{ x: 20, y: 20 }] };
  const eraser = { ...first, id: randomUUID(), type: "eraser", width: 10 };
  const hidden = { ...first, id: randomUUID(), points: [{ x: 40, y: 40 }] };
  const event = { id: randomUUID(), type: "visibility", targetId: hidden.id, visible: false };
  const { png, visibleCount } = await renderSnapshot({ width: 1600, height: 900, operations: [first, eraser, hidden, event] });
  assert.equal(visibleCount, 2);
  const canvas = createCanvas(1600, 900);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(await loadImage(png), 0, 0);
  assert.equal(ctx.getImageData(20, 20, 1, 1).data[3], 0);
  assert.equal(ctx.getImageData(28, 20, 1, 1).data[3], 255);
  assert.equal(ctx.getImageData(40, 40, 1, 1).data[3], 0);
});
