class RoomQueue {
  // Lưu Promise cuối cùng của mỗi phòng để xếp hàng độc lập.
  constructor() { this.pending = new Map(); }
  // Chạy các thao tác cùng phòng lần lượt, kể cả khi thao tác trước bị lỗi.
  run(id, action) {
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.pending.set(id, next);
    // Xóa hàng đợi sau khi thao tác cuối hoàn tất hoặc thất bại.
    const cleanup = () => { if (this.pending.get(id) === next) this.pending.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }
}
module.exports = { RoomQueue };
