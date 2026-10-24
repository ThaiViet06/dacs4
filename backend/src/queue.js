class RoomQueue {
  constructor() { this.pending = new Map(); }
  run(id, action) {
    const previous = this.pending.get(id) || Promise.resolve();
    const next = previous.catch(() => {}).then(action);
    this.pending.set(id, next);
    const cleanup = () => { if (this.pending.get(id) === next) this.pending.delete(id); };
    next.then(cleanup, cleanup);
    return next;
  }
}
module.exports = { RoomQueue };
