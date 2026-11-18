const { workerData, parentPort } = require("node:worker_threads");
const { createCanvas } = require("@napi-rs/canvas");

// Dựng PNG trong suốt. Thứ tự, đường viền tròn, hình học và tẩy khớp renderer trên browser.
async function renderSnapshot(document) {
  const canvas = createCanvas(document.width, document.height);
  const ctx = canvas.getContext("2d");
  const visibility = new Map();
  for (const event of document.operations)
    if (event.type === "visibility") visibility.set(event.targetId.toLowerCase(), event.visible);
  let visibleCount = 0;
  for (const op of document.operations) {
    if (op.type === "visibility" || visibility.get(op.id.toLowerCase()) === false) continue;
    visibleCount++;
    ctx.globalCompositeOperation = op.type === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = ctx.fillStyle = op.color;
    ctx.lineWidth = op.width;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    if (op.points) {
      const [first, ...rest] = op.points;
      if (rest.length) {
        ctx.moveTo(first.x, first.y);
        for (const point of rest) ctx.lineTo(point.x, point.y);
      } else {
        ctx.arc(first.x, first.y, op.width / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
    } else {
      const { start, end } = op;
      if (op.type === "line") { ctx.moveTo(start.x, start.y); ctx.lineTo(end.x, end.y); }
      if (op.type === "rectangle") ctx.rect(start.x, start.y, end.x - start.x, end.y - start.y);
      if (op.type === "circle") ctx.arc(start.x, start.y, Math.hypot(end.x - start.x, end.y - start.y), 0, Math.PI * 2);
    }
    ctx.stroke();
  }
  return { png: await canvas.encode("png"), visibleCount };
}

if (parentPort) renderSnapshot(workerData).then((value) => parentPort.postMessage(value), (error) => { throw error; });
module.exports = { renderSnapshot };
