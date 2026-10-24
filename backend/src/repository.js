const { randomUUID, randomBytes, createHash } = require("node:crypto");
const { AppError } = require("./errors");
const { emptyDocument, checkSize } = require("./protocol");
const hash = (token) => createHash("sha256").update(token).digest("hex");
const token = () => randomBytes(32).toString("base64url");
function metadata(row) {
  return { id: row.id, title: row.title, ownerId: row.owner_id, sequence: row.sequence,
    hasCheckpoint: Boolean(row.checkpoint), updatedAt: row.updated_at };
}
class PostgresRepository {
  constructor(pool) { this.pool = pool; }
  async ready() { await this.pool.query("SELECT id FROM drawing.rooms LIMIT 0"); }
  async transaction(action) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
  async member(client, userId, roomId, lock = true) {
    const { rows: [room] } = await client.query(`SELECT * FROM drawing.rooms WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [roomId]);
    const { rows } = await client.query("SELECT user_id FROM drawing.room_members WHERE room_id=$1 AND user_id=$2", [roomId, userId]);
    if (!room || !rows.length) throw new AppError(404, "ROOM_NOT_FOUND", "Room not found or access denied. Join with an invitation first.");
    return room;
  }
  async createRoom(userId, title, document = emptyDocument()) {
    checkSize(document);
    const id = randomUUID();
    const inviteToken = token();
    const room = await this.transaction(async (client) => {
      const { rows: [row] } = await client.query("INSERT INTO drawing.rooms(id,title,owner_id,invite_hash,initial_document) VALUES($1,$2,$3,$4,$5) RETURNING *", [id, title, userId, hash(inviteToken), JSON.stringify(document)]);
      await client.query("INSERT INTO drawing.room_members(room_id,user_id) VALUES($1,$2)", [id, userId]);
      return metadata(row);
    });
    return { room, inviteToken };
  }
  async listRooms(userId) {
    const { rows } = await this.pool.query("SELECT r.* FROM drawing.rooms r JOIN drawing.room_members m ON m.room_id=r.id WHERE m.user_id=$1 ORDER BY r.updated_at DESC LIMIT 100", [userId]);
    return rows.map(metadata);
  }
  async joinRoom(userId, inviteToken) {
    return this.transaction(async (client) => {
      const { rows: [row] } = await client.query("SELECT * FROM drawing.rooms WHERE invite_hash=$1 FOR UPDATE", [hash(inviteToken)]);
      if (!row) throw new AppError(404, "INVITATION_INVALID", "This invitation is invalid or has been replaced.");
      await client.query("INSERT INTO drawing.room_members(room_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [row.id, userId]);
      return metadata(row);
    });
  }
  async getRoom(userId, roomId) { return metadata(await this.member(this.pool, userId, roomId, false)); }
  async invitation(userId, roomId) {
    const inviteToken = token();
    await this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      await client.query("UPDATE drawing.rooms SET invite_hash=$2 WHERE id=$1", [roomId, hash(inviteToken)]);
    });
    return { inviteToken };
  }
  owner(room, userId) {
    if (room.owner_id !== userId) throw new AppError(403, "OWNER_REQUIRED", "Only the room owner can do that.");
  }
  async document(client, room, sequence = room.sequence) {
    if (sequence > room.sequence) throw new AppError(409, "SEQUENCE_AHEAD", "Wait for drawing synchronization before saving.");
    const { rows } = await client.query("SELECT payload FROM drawing.room_operations WHERE room_id=$1 AND sequence<=$2 ORDER BY sequence", [room.id, sequence]);
    return { ...room.initial_document, operations: [...room.initial_document.operations, ...rows.map((row) => row.payload)] };
  }
  async state(userId, roomId) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      return { room: metadata(room), sequence: room.sequence, document: await this.document(client, room) };
    });
  }
  async commit(userId, roomId, operation) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      const { rows: [existing] } = await client.query("SELECT sequence,payload,author_id FROM drawing.room_operations WHERE room_id=$1 AND operation_id=$2", [roomId, operation.id]);
      if (existing) {
        if (existing.author_id !== userId || JSON.stringify(existing.payload) !== JSON.stringify(operation)) {
          // JSONB key ordering differs: compare semantically with PostgreSQL.
          const { rows: [equal] } = await client.query("SELECT payload=$3::jsonb AS equal FROM drawing.room_operations WHERE room_id=$1 AND operation_id=$2", [roomId, operation.id, JSON.stringify(operation)]);
          if (existing.author_id !== userId || !equal.equal) throw new AppError(409, "OPERATION_CONFLICT", "An operation with that ID already exists.");
        }
        return { sequence: existing.sequence, operation: existing.payload, duplicate: true };
      }
      if (room.initial_document.operations.some((item) => item.id === operation.id)) throw new AppError(409, "OPERATION_CONFLICT", "An operation with that ID already exists.");
      const document = await this.document(client, room);
      document.operations.push(operation);
      checkSize(document);
      const sequence = room.sequence + 1;
      await client.query("INSERT INTO drawing.room_operations(room_id,operation_id,sequence,author_id,payload) VALUES($1,$2,$3,$4,$5)", [roomId, operation.id, sequence, userId, JSON.stringify(operation)]);
      await client.query("UPDATE drawing.rooms SET sequence=$2,updated_at=now() WHERE id=$1", [roomId, sequence]);
      return { sequence, operation, duplicate: false };
    });
  }
  async save(userId, roomId, title, sequence, checkpoint) {
    return this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      if (checkpoint) this.owner(room, userId);
      const document = await this.document(client, room, sequence);
      if (checkpoint) {
        const saved = { title, sequence, document, savedAt: new Date().toISOString() };
        await client.query("UPDATE drawing.rooms SET checkpoint=$2 WHERE id=$1", [roomId, JSON.stringify(saved)]);
        return { title, sequence, savedAt: saved.savedAt };
      }
      const { rows: [saved] } = await client.query("INSERT INTO drawing.saved_drawings(id,owner_id,title,document) VALUES($1,$2,$3,$4) RETURNING id,title,created_at", [randomUUID(), userId, title, JSON.stringify(document)]);
      return { id: saved.id, title: saved.title, createdAt: saved.created_at };
    });
  }
  async listDrawings(userId) {
    const { rows } = await this.pool.query("SELECT id,title,created_at,document FROM drawing.saved_drawings WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100", [userId]);
    return rows.map((row) => ({ id: row.id, title: row.title, createdAt: row.created_at, document: row.document }));
  }
  async openDrawing(userId, id) {
    const { rows: [row] } = await this.pool.query("SELECT * FROM drawing.saved_drawings WHERE id=$1 AND owner_id=$2", [id, userId]);
    if (!row) throw new AppError(404, "DRAWING_NOT_FOUND", "Saved drawing not found.");
    return this.createRoom(userId, `${row.title.slice(0, 90)} (copy)`, row.document);
  }
  async openCheckpoint(userId, roomId) {
    const checkpoint = await this.transaction(async (client) => {
      const room = await this.member(client, userId, roomId);
      this.owner(room, userId);
      if (!room.checkpoint) throw new AppError(404, "NO_CHECKPOINT", "Save a room checkpoint first.");
      return room.checkpoint;
    });
    return this.createRoom(userId, `${checkpoint.title.slice(0, 90)} (copy)`, checkpoint.document);
  }
}
module.exports = { PostgresRepository };
