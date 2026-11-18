const path = require("node:path");
const { Worker } = require("node:worker_threads");

class Snapshots {
  constructor(sync) {
    this.sync = sync;
    this.pending = new Set();
  }

  // Một worker và tối đa 16 job gộp theo dự án. Lỗi snapshot không làm chậm xác nhận nét.
  schedule(roomId) {
    if (this.stopping) return;
    this.pending.add(roomId);
    if (this.pending.size > 16) this.pending.delete(this.pending.values().next().value);
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null;
        if (this.pending.size) this.schedule(this.pending.values().next().value);
      });
    }
  }

  // Lấy vector qua pool, render trong worker và kiểm tra mốc một lần nữa trước khi ghi.
  async drain() {
    while (this.pending.size && !this.stopping) {
      const roomId = this.pending.values().next().value;
      this.pending.delete(roomId);
      try {
        const input = await this.sync.snapshotInput(roomId);
        if (!input || this.stopping) continue;
        const result = await new Promise((resolve, reject) => {
          this.worker = new Worker(path.join(__dirname, "snapshot-worker.js"), { workerData: input.document });
          this.worker.once("message", resolve);
          this.worker.once("error", reject);
          this.worker.once("exit", () => reject(new Error("Snapshot worker stopped")));
        });
        this.worker = null;
        if (!this.stopping) await this.sync.publishSnapshot(roomId, input, Buffer.from(result.png), result.visibleCount);
      } catch (error) {
        this.worker = null;
        if (!this.stopping) console.error("Snapshot failed:", error.code || error.name);
      }
    }
  }

  // Dừng worker trước khi đóng pool để không ghi vào dịch vụ đang tắt.
  async close() {
    this.stopping = true;
    this.pending.clear();
    await this.worker?.terminate();
    await this.running;
  }
}

module.exports = { Snapshots };
