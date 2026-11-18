const { AppError } = require("./errors");
const { packStroke } = require("./stroke-codec");

const RENDERER_VERSION = 1;
const TAIL_LIMIT = 384;
const CACHE_BYTES = 256 * 1024;
const SNAPSHOT_BYTES = 512 * 1024;

// Khung thao tác dùng codec gọn khi có thể; dữ liệu JSONB cũ vẫn được đọc nguyên vẹn.
function wireOperation(operation, sequence, targetSequence) {
  const packed = packStroke(operation);
  return packed
    ? { sequence, id: operation.id, packed: packed.toString("base64") }
    : { sequence, operation, targetSequence };
}

class PerformanceSync {
  constructor(repository, metadata) {
    this.repository = repository;
    this.metadata = metadata;
    this.tails = new Map();
  }

  // Cache LRU chỉ chứa thao tác đã lưu. Cache thiếu hoặc bị đứt đoạn sẽ đọc lại DB.
  remember(roomId, outcomes) {
    const tail = this.tails.get(roomId) || { entries: [], bytes: 0 };
    for (const outcome of outcomes) {
      if (!outcome.sequence || outcome.duplicate) continue;
      if (tail.entries.length && outcome.sequence !== tail.entries.at(-1).frame.sequence + 1) {
        tail.entries.length = 0;
        tail.bytes = 0;
      }
      const frame = wireOperation(outcome.operation, outcome.sequence, outcome.targetSequence);
      const bytes = Buffer.byteLength(JSON.stringify(frame));
      tail.entries.push({ frame, bytes });
      tail.bytes += bytes;
      while (tail.entries.length > 256 || tail.bytes > CACHE_BYTES) tail.bytes -= tail.entries.shift().bytes;
    }
    if (!tail.entries.length) return;
    this.tails.delete(roomId);
    this.tails.set(roomId, tail);
    if (this.tails.size > 16) this.tails.delete(this.tails.keys().next().value);
  }

  // Chỉ dùng đoạn cache hoàn chỉnh. Truy vấn dự phòng dùng index (room_id, sequence).
  async events(roomId, after, through) {
    if (after === through) return [];
    const tail = this.tails.get(roomId);
    if (tail && tail.entries[0].frame.sequence <= after + 1 && tail.entries.at(-1).frame.sequence >= through) {
      this.tails.delete(roomId);
      this.tails.set(roomId, tail);
      return tail.entries.filter(({ frame }) => frame.sequence > after && frame.sequence <= through).map(({ frame }) => frame);
    }
    const { rows } = await this.repository.pool.query(
      "SELECT operation_id,sequence,payload,packed FROM drawing.room_operations WHERE room_id=$1 AND sequence>$2 AND sequence<=$3 ORDER BY sequence",
      [roomId, after, through],
    );
    return rows.map((row) => row.packed
      ? { sequence: row.sequence, id: row.operation_id, packed: row.packed.toString("base64") }
      : wireOperation(row.payload, row.sequence));
  }

  // Đọc quyền và mốc trong một câu SQL. Cùng hàng đợi với commit để không bỏ sót đoạn đuôi khi kết nối.
  async state(userId, roomId, options) {
    if (options.vectorOnly) return null;
    const { rows: [row] } = await this.repository.pool.query(
      `SELECT r.id,r.title,r.owner_id,r.sequence,r.sharing_enabled,r.updated_at,r.render_epoch,
        r.checkpoint IS NOT NULL AS checkpoint,s.sequence AS snapshot_seq,s.visible_count
      FROM drawing.rooms r JOIN drawing.room_members m ON m.room_id=r.id AND m.user_id=$2
      LEFT JOIN drawing.room_render_snapshots s ON s.room_id=r.id AND s.renderer_version=$3
      WHERE r.id=$1 AND (r.sharing_enabled OR r.owner_id=$2)`,
      [roomId, userId, RENDERER_VERSION],
    );
    if (!row) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied.");
    const delta = options.lastSeq !== undefined && options.lastSeq <= row.sequence &&
      (!options.snapshot || options.epoch === row.render_epoch);
    const after = delta ? options.lastSeq : row.snapshot_seq;
    if (after == null || row.sequence - after > TAIL_LIMIT) return null;
    const events = await this.events(roomId, after, row.sequence);
    if (events.length !== row.sequence - after || Buffer.byteLength(JSON.stringify(events)) > CACHE_BYTES) return null;
    return {
      room: this.metadata(row), sequence: row.sequence, after, epoch: row.render_epoch, events,
      snapshot: delta ? null : { sequence: after, visibleCount: row.visible_count },
    };
  }

  // PNG riêng tư chỉ được đọc khi vẫn còn quyền truy cập vào đúng dự án.
  async snapshot(userId, roomId, sequence) {
    const { rows: [row] } = await this.repository.pool.query(
      `SELECT s.png FROM drawing.room_render_snapshots s JOIN drawing.rooms r ON r.id=s.room_id
      JOIN drawing.room_members m ON m.room_id=r.id AND m.user_id=$2
      WHERE s.room_id=$1 AND s.sequence=$3 AND s.renderer_version=$4 AND (r.sharing_enabled OR r.owner_id=$2)`,
      [roomId, userId, sequence, RENDERER_VERSION],
    );
    if (!row) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "This snapshot is unavailable.");
    return row.png;
  }

  // Chụp mốc append-only và đọc vector ngoài hàng đợi ghi. Race visibility sẽ được chặn lúc publish.
  async snapshotInput(roomId) {
    const { rows: [room] } = await this.repository.pool.query(
      `SELECT r.id,r.sequence,r.initial_document,r.render_epoch,s.sequence AS previous
      FROM drawing.rooms r LEFT JOIN drawing.room_render_snapshots s ON s.room_id=r.id AND s.renderer_version=$2
      WHERE r.id=$1`, [roomId, RENDERER_VERSION],
    );
    if (!room) return null;
    const initialCount = room.initial_document.operations.length;
    const lastCheckpoint = room.previous == null ? 0 : Math.floor((room.previous + initialCount) / 300);
    if (Math.floor((room.sequence + initialCount) / 300) <= lastCheckpoint) return null;
    return { sequence: room.sequence, epoch: room.render_epoch, document: await this.repository.document(this.repository.pool, room) };
  }

  // Không ghi ảnh được dựng trước một lượt ẩn/hiện hoặc sau khi dự án đã bị xóa.
  async publishSnapshot(roomId, input, png, visibleCount) {
    if (!png.length || png.length > SNAPSHOT_BYTES) return false;
    const result = await this.repository.pool.query(
      `WITH current AS (SELECT id FROM drawing.rooms WHERE id=$1 AND render_epoch=$3 AND sequence >= $2 FOR UPDATE)
      INSERT INTO drawing.room_render_snapshots(room_id,sequence,renderer_version,png,visible_count)
      SELECT id,$2,$4,$5,$6 FROM current
      ON CONFLICT (room_id) DO UPDATE SET sequence=EXCLUDED.sequence,renderer_version=EXCLUDED.renderer_version,
        png=EXCLUDED.png,visible_count=EXCLUDED.visible_count
      WHERE drawing.room_render_snapshots.sequence <= EXCLUDED.sequence OR
        drawing.room_render_snapshots.renderer_version <> EXCLUDED.renderer_version`,
      [roomId, input.sequence, input.epoch, RENDERER_VERSION, png, visibleCount],
    );
    return Boolean(result.rowCount);
  }
}

module.exports = { PerformanceSync, wireOperation };
