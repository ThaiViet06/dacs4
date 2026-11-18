class RoomQueue {
  // Lưu Promise cuối cùng của mỗi phòng để xếp hàng độc lập.
  constructor() { this.pending = new Map(); this.batches = new Map(); }
  // Chạy các thao tác cùng phòng lần lượt, kể cả khi thao tác trước bị lỗi.
  run(id, action) {
    this.batches.delete(id);
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.pending.set(id, next);
    // Xóa hàng đợi sau khi thao tác cuối hoàn tất hoặc thất bại.
    const cleanup = () => { if (this.pending.get(id) === next) this.pending.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }

  // Gom các commit đứng liền nhau. Bất kỳ tác vụ thường nào cũng đóng lô đang chờ.
  batch(id, entry, bytes, save) {
    let batch = this.batches.get(id);
    if (!batch || batch.entries.length >= 8 || batch.bytes + bytes > 256 * 1024) {
      batch = { entries: [], bytes: 0 };
      const current = batch;
      batch.done = this.run(id, () => {
        if (this.batches.get(id) === current) this.batches.delete(id);
        return save(current.entries);
      });
      this.batches.set(id, batch);
    }
    batch.entries.push(entry);
    batch.bytes += bytes;
    return batch.done;
  }
}
module.exports = { RoomQueue };
