const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer, WebSocket } = require("ws");
const { AppError, publicError } = require("./errors");
const { parse, messageSchema, createSchema, sharingSchema, upgradeInvitationSchema, joinSchema, uuidSchema, saveSchema, PROTOCOL_VERSION } = require("./protocol");
const { RoomQueue } = require("./queue");
const { wireOperation } = require("./drawing-sync");
const { unpackWire } = require("./stroke-codec");

// Ghép HTTP/WebSocket với cùng repository; chat tùy chọn để giữ ứng dụng vẽ hoạt động khi chưa cấu hình.
function createApplication({ repository, chat, snapshots, verifyToken, origins, heartbeatMs = 30000 }) {
  const app = express();
  const queue = new RoomQueue();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const rooms = new Map();
  const requests = new Map();
  const accessChanges = new Map();
  let stopping = false;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin && !origins.includes(req.headers.origin)) return next(new AppError(403, "ORIGIN_DENIED", "This origin is not allowed."));
    next();
  });
  app.use(cors({ origin: origins, allowedHeaders: ["Content-Type", "Authorization"], methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }));
  app.use(express.json({ limit: "16kb" }));
  app.get("/healthz", (req, res) => res.status(stopping ? 503 : 200).json({ status: stopping ? "stopping" : "ok" }));
  app.get("/readyz", async (req, res, next) => {
    try { await repository.ready(); res.json({ status: "ready" }); } catch (error) { next(error); }
  });
  app.use("/api", async (req, res, next) => {
    try {
      const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) throw new AppError(401, "AUTH_REQUIRED", "Sign in to continue.");
      let identity;
      try { identity = await verifyToken(bearer); } catch { throw new AppError(401, "AUTH_EXPIRED", "Your session expired. Sign in again."); }
      if (!identity?.userId || identity.expiresAt <= Date.now()) throw new AppError(401, "AUTH_EXPIRED", "Your session expired. Sign in again.");
      req.userId = identity.userId;
      const now = Date.now();
      const budget = requests.get(identity.userId);
      const current = budget && now - budget.start < 60000 ? budget : { start: now, count: 0 };
      current.count++;
      requests.set(identity.userId, current);
      if (current.count > 120) throw new AppError(429, "RATE_LIMIT", "Too many requests. Retry in a minute.");
      next();
    } catch (error) { next(error); }
  });
  const route = (action) => async (req, res, next) => {
    try { await action(req, res); } catch (error) { next(error); }
  };
  // Chuẩn hóa UUID để HTTP và WebSocket dùng cùng khóa hàng đợi cho một dự án.
  const id = (req) => parse(uuidSchema, req.params.id).toLowerCase();
  app.get("/api/rooms", route(async (req, res) => res.json({ rooms: await repository.listRooms(req.userId) })));
  app.post("/api/rooms", route(async (req, res) => {
    const { title } = parse(createSchema, req.body);
    // Dự án mới riêng tư: trả metadata, link chỉ lấy qua luồng chia sẻ của chủ dự án.
    const { room } = await repository.createRoom(req.userId, title);
    res.status(201).json({ room });
  }));
  app.post("/api/rooms/join", route(async (req, res) => {
    const { token } = parse(joinSchema, req.body);
    res.json({ room: await repository.joinRoom(req.userId, token) });
  }));
  app.get("/api/rooms/:id", route(async (req, res) => res.json({ room: await repository.getRoom(req.userId, id(req)) })));
  // Ảnh được tải qua HTTP đã xác thực, tách khỏi khung WebSocket chứa các nét mới.
  app.get("/api/rooms/:id/render-snapshot/:sequence", route(async (req, res) => {
    const sequence = Number(req.params.sequence);
    if (!repository.sync || !Number.isSafeInteger(sequence) || sequence < 0 || sequence > 2147483647)
      throw new AppError(404, "SNAPSHOT_NOT_FOUND", "This snapshot is unavailable.");
    const png = await repository.sync.snapshot(req.userId, id(req), sequence);
    res.type("png").send(png);
  }));
  // Tải vector khi cần xuất dự án đang dùng ảnh nền. Kiểm tra quyền như lúc mở editor.
  app.get("/api/rooms/:id/render-document", route(async (req, res) => res.json(await repository.state(req.userId, id(req)))));
  // Lịch sử chat luôn kiểm tra lại thành viên/chế độ, không dùng quyền chỉ dựa trên client.
  app.get("/api/rooms/:id/messages", route(async (req, res) => {
    if (!chat) throw new AppError(503, "CHAT_UNAVAILABLE", "Chat is temporarily unavailable.");
    res.json({ messages: await chat.list(req.userId, id(req)) });
  }));
  // Lưu bản mã trước khi broadcast; xếp cùng hàng đợi với thu quyền để không lọt tin sau tắt chia sẻ.
  app.post("/api/rooms/:id/messages", route(async (req, res) => {
    if (!chat) throw new AppError(503, "CHAT_UNAVAILABLE", "Chat is temporarily unavailable.");
    const roomId = id(req);
    const result = await queue.run(roomId, async () => {
      const saved = await chat.send(req.userId, roomId, req.body);
      if (!saved.duplicate) {
        for (const socket of rooms.get(roomId) || []) {
          if (!socket.accessRevoked && socket.identity?.expiresAt > Date.now()) send(socket, "chat.message", { message: saved.message });
        }
      }
      return saved;
    });
    res.status(result.duplicate ? 200 : 201).json({ message: result.message });
  }));
  // Chỉ đọc trạng thái chia sẻ cho chủ đã xác thực; không tạo link hoặc thay đổi quyền thành viên.
  app.get("/api/rooms/:id/sharing", route(async (req, res) => res.json(await repository.getSharing(req.userId, id(req)))));
  // Xếp cùng hàng đợi với nét/join; chỉ ngắt cộng tác sau khi transaction thu quyền đã commit.
  app.patch("/api/rooms/:id/sharing", route(async (req, res) => {
    const roomId = id(req);
    const { enabled } = parse(sharingSchema, req.body);
    const result = await changingAccess(roomId, async () => {
      const saved = await repository.setSharing(req.userId, roomId, enabled);
      if (!enabled) revokeCollaborators(roomId, saved.room.ownerId);
      return saved;
    });
    res.json(result);
  }));
  // Đổi tên theo danh tính Clerk; dùng cùng hàng đợi với nét vẽ để giữ thứ tự cập nhật của dự án.
  app.patch("/api/rooms/:id", route(async (req, res) => {
    const roomId = id(req);
    const { title } = parse(createSchema, req.body);
    const room = await queue.run(roomId, () => repository.renameRoom(req.userId, roomId, title));
    res.json({ room });
  }));
  // Xếp yêu cầu xóa cùng các lượt vẽ/chia sẻ và ngắt kết nối khi database đã xác nhận xóa.
  app.delete("/api/rooms/:id", route(async (req, res) => {
    const roomId = id(req);
    await changingAccess(roomId, async () => {
      await repository.deleteRoom(req.userId, roomId);
      repository.sync?.tails.delete(roomId);
      disconnectDeletedRoom(roomId);
    });
    res.json({ id: roomId });
  }));
  app.post("/api/rooms/:id/invitation", route(async (req, res) => res.json(await repository.invitation(req.userId, id(req)))));
  // Chủ xác nhận đổi link theo cùng hàng đợi với nét/chế độ; nâng link không ngắt socket hoặc thu quyền.
  app.post("/api/rooms/:id/sharing/upgrade", route(async (req, res) => {
    const roomId = id(req);
    parse(upgradeInvitationSchema, req.body);
    res.json(await queue.run(roomId, () => repository.upgradeInvitation(req.userId, roomId)));
  }));
  for (const [path, checkpoint] of [["checkpoint", true], ["copies", false]]) {
    app[checkpoint ? "put" : "post"](`/api/rooms/:id/${path}`, route(async (req, res) => {
      const roomId = id(req);
      const { title, sequence } = parse(saveSchema, req.body);
      res.status(checkpoint ? 200 : 201).json(await queue.run(roomId, () => repository.save(req.userId, roomId, title, sequence, checkpoint)));
    }));
  }
  app.post("/api/rooms/:id/checkpoint/open", route(async (req, res) => res.status(201).json(await repository.openCheckpoint(req.userId, id(req)))));
  app.get("/api/drawings", route(async (req, res) => res.json({ drawings: await repository.listDrawings(req.userId) })));
  app.post("/api/drawings/:id/open", route(async (req, res) => res.status(201).json(await repository.openDrawing(req.userId, id(req)))));
  app.use((req, res, next) => next(new AppError(404, "NOT_FOUND", "Endpoint not found.")));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === "entity.parse.failed") error = new AppError(400, "INVALID_JSON", "Request must be valid JSON.");
    if (error.type === "entity.too.large") error = new AppError(413, "TOO_LARGE", "Request exceeds the size limit.");
    if (!(error instanceof AppError)) console.error("Request failed:", error.code || error.name);
    res.status(error.status || 503).json({ error: publicError(error) });
  });

  // Mọi phản hồi dùng v2, độc lập với phiên bản tài liệu v1/v2 được đọc từ database.
  function send(socket, type, data = {}) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "Connection too slow; reconnect"); return; }
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, ...data }));
  }
  function broadcast(roomId, type, data, except) {
    for (const socket of rooms.get(roomId) || []) if (socket !== except) send(socket, type, data);
  }
  // Chặn preview trong lúc hàng đợi còn đổi quyền, rồi mở lại sau khi hoàn tất hoặc rollback.
  async function changingAccess(roomId, action) {
    accessChanges.set(roomId, (accessChanges.get(roomId) || 0) + 1);
    try { return await queue.run(roomId, action); }
    finally {
      const remaining = accessChanges.get(roomId) - 1;
      if (remaining) accessChanges.set(roomId, remaining);
      else accessChanges.delete(roomId);
    }
  }
  // Preview là khung tạm. Bỏ qua client chậm và phiên đã bị thu quyền.
  function previewToRoom(socket, type, data) {
    const roomId = socket.roomId;
    if (socket.accessRevoked || accessChanges.has(roomId)) return;
    const now = Date.now();
    for (const viewer of rooms.get(roomId) || [])
      if (viewer !== socket && !viewer.accessRevoked && viewer.identity.expiresAt > now &&
        viewer.bufferedAmount < 64 * 1024) send(viewer, type, data);
  }
  // Gửi ACK ngắn cho người tạo đã chọn giao thức mới; các tab còn lại cần đủ dữ liệu để vẽ.
  function publishOperation(roomId, socket, committed) {
    const { sequence, operation, duplicate, targetSequence } = committed;
    const compatible = { sequence, operation, duplicate };
    if (socket.roomId === roomId && socket.identity.expiresAt > Date.now()) {
      if (socket.drawingSync) send(socket, "operation.ack", {
        id: operation.id, seq: sequence, ...(targetSequence != null ? { targetSequence } : {}),
      });
      else send(socket, "operation.committed", compatible);
    }
    if (duplicate) return;
    const frame = wireOperation(operation, sequence, targetSequence);
    for (const viewer of rooms.get(roomId) || []) {
      if (viewer !== socket && !viewer.accessRevoked && viewer.identity.expiresAt > Date.now())
        send(viewer, "operation.committed", viewer.drawingSync ? frame : compatible);
    }
    if (sequence % 300 === 0 || targetSequence != null) snapshots?.schedule(roomId);
  }
  // Lô được thực thi trong FIFO của phòng. Mọi phản hồi được phát trước tác vụ kế tiếp.
  async function flushOperations(roomId, entries) {
    const valid = entries.filter(({ socket }) => !socket.accessRevoked && socket.identity?.expiresAt > Date.now());
    if (!valid.length) return;
    const results = await repository.commitBatch(roomId, valid);
    for (let index = 0; index < valid.length; index++) {
      const { socket, operation } = valid[index];
      const result = results[index];
      if (result.error) {
        if (socket.roomId === roomId) send(socket, "error", { ...publicError(result.error), operationId: operation.id });
        if (operation.type !== "visibility" && socket.roomId === roomId)
          previewToRoom(socket, "preview.cancel", { clientId: socket.clientId, operationId: operation.id });
      } else publishOperation(roomId, socket, result);
    }
  }
  function presence(roomId) {
    const members = [...(rooms.get(roomId) || [])].map((socket) => ({ clientId: socket.clientId, userId: socket.identity.userId }));
    broadcast(roomId, "presence", { members });
  }
  function leave(socket) {
    if (!socket.roomId) return;
    const roomId = socket.roomId;
    rooms.get(roomId)?.delete(socket);
    if (!rooms.get(roomId)?.size) rooms.delete(roomId);
    socket.roomId = undefined;
    presence(roomId);
  }
  // Thu socket khỏi phòng ngay, bỏ frame đang chờ và báo 4403 cho các cộng tác viên; giữ kết nối của chủ.
  function revokeCollaborators(roomId, ownerId) {
    for (const socket of [...(rooms.get(roomId) || [])]) {
      if (socket.identity.userId === ownerId) continue;
      socket.accessRevoked = true;
      leave(socket);
      socket.close(4403, "Project sharing was disabled");
    }
  }
  // Đưa cả chủ lẫn thành viên ra khỏi dự án đã xóa và bỏ các frame đang chờ xử lý.
  function disconnectDeletedRoom(roomId) {
    const clients = rooms.get(roomId);
    rooms.delete(roomId);
    for (const socket of clients || []) {
      socket.accessRevoked = true;
      socket.roomId = undefined;
      socket.close(4404, "Project deleted");
    }
  }
  server.on("upgrade", (req, socket, head) => {
    if (stopping || req.url !== "/ws" || !origins.includes(req.headers.origin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (socket) => {
    socket.clientId = randomUUID();
    socket.alive = true;
    let chain = Promise.resolve();
    let scheduled = 0;
    let persisting = 0;
    const authTimer = setTimeout(() => socket.close(4401, "Authentication required"), 5000);
    let expiration;
    let rate = { start: Date.now(), messages: 0, previews: 0 };
    socket.on("pong", () => { socket.alive = true; });
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(authTimer); clearTimeout(expiration); leave(socket); });
    // Socket bị thu hồi không được xử lý tiếp các frame đã gửi nhưng còn nằm trong hàng đợi.
    async function handle(message, binary, parseError) {
      if (socket.accessRevoked || socket.readyState !== WebSocket.OPEN) return;
      try {
        if (binary) throw new AppError(400, "INVALID_MESSAGE", "Only JSON text messages are supported.");
        if (parseError) throw new AppError(400, "INVALID_JSON", "Message must be valid JSON.");
        parse(messageSchema, message);
        if (message.type === "auth" || message.type === "auth.refresh") {
          let identity;
          try { identity = await verifyToken(message.token); }
          catch { throw new AppError(401, "AUTH_EXPIRED", "Authentication expired. Sign in again."); }
          if (!identity?.userId || identity.expiresAt <= Date.now() || (socket.identity && socket.identity.userId !== identity.userId)) throw new AppError(401, "AUTH_EXPIRED", "Invalid session.");
          socket.identity = identity;
          clearTimeout(authTimer);
          clearTimeout(expiration);
          expiration = setTimeout(() => socket.close(4401, "Session expired"), Math.min(identity.expiresAt - Date.now(), 2147483647));
          send(socket, "auth.ok", { clientId: socket.clientId, expiresAt: identity.expiresAt,
            ...(repository.sync ? { drawingSync: true } : {}) });
          return;
        }
        if (!socket.identity || socket.identity.expiresAt <= Date.now()) throw new AppError(401, "AUTH_REQUIRED", "Authenticate first.");
        if (Date.now() - rate.start >= 1000) rate = { start: Date.now(), messages: 0, previews: 0 };
        if (++rate.messages > 100) throw new AppError(429, "RATE_LIMIT", "Slow down and retry.");
        if (message.type === "room.join") {
          const roomId = message.roomId.toLowerCase();
          await queue.run(roomId, async () => {
            const enhanced = Boolean(message.sync && repository.sync);
            const sync = enhanced ? await repository.sync.state(socket.identity.userId, roomId, message.sync) : null;
            const state = sync || await repository.state(socket.identity.userId, roomId);
            if (socket.readyState !== WebSocket.OPEN) return;
            const clients = rooms.get(roomId) || new Set();
            if (!clients.has(socket) && clients.size >= 10) throw new AppError(409, "ROOM_FULL", "This demo supports ten connections per room.");
            leave(socket);
            socket.roomId = roomId;
            socket.drawingSync = enhanced;
            const active = rooms.get(roomId) || new Set();
            active.add(socket);
            rooms.set(roomId, active);
            send(socket, sync ? "room.sync" : "room.state", state);
            presence(roomId);
            if (enhanced && !sync && state.document.operations.length >= 300) snapshots?.schedule(roomId);
          });
          return;
        }
        if (!socket.roomId) throw new AppError(409, "JOIN_REQUIRED", "Join a room first.");
        if (message.type === "operation.preview") {
          if (++rate.previews > 20) return;
          previewToRoom(socket, message.type, { clientId: socket.clientId, operation: message.operation });
        } else if (message.type === "preview.cancel") {
          previewToRoom(socket, message.type, { clientId: socket.clientId, operationId: message.operationId });
        } else if (message.type === "operation.commit" || message.type === "operation.packed") {
          const roomId = socket.roomId;
          const operation = message.type === "operation.packed" ? unpackWire(message.id, message.packed) : message.operation;
          if (repository.performanceReady) {
            persisting++;
            const entry = { socket, operation, userId: socket.identity.userId };
            queue.batch(roomId, entry, Buffer.byteLength(JSON.stringify(operation)), (entries) => flushOperations(roomId, entries))
              .catch((error) => {
                if (socket.roomId === roomId) send(socket, "error", { ...publicError(error), operationId: operation.id });
                if (operation.type !== "visibility" && socket.roomId === roomId)
                  previewToRoom(socket, "preview.cancel", { clientId: socket.clientId, operationId: operation.id });
              }).finally(() => { persisting--; });
            return;
          }
          await queue.run(roomId, async () => {
            if (socket.accessRevoked) return;
            const committed = await repository.commit(socket.identity.userId, roomId, operation);
            publishOperation(roomId, socket, committed);
          });
        }
      } catch (error) {
        send(socket, "error", { ...publicError(error), operationId: message?.operation?.id ?? message?.id });
        if (message?.operation && message.operation.type !== "visibility" && socket.roomId) broadcast(socket.roomId, "preview.cancel", { clientId: socket.clientId, operationId: message.operation.id }, socket);
        if (error.status === 401) socket.close(4401, "Authentication required");
      }
    }
    socket.on("message", (raw, binary) => {
      let message;
      let parseError;
      if (!binary) {
        try { message = JSON.parse(raw.toString()); } catch { parseError = true; }
      }
      // Nét tạm không chờ lệnh ghi phía trước của cùng socket.
      if (socket.roomId && ["operation.preview", "preview.cancel"].includes(message?.type)) {
        void handle(message, false, false);
        return;
      }
      if (++scheduled + persisting > 100) { socket.close(4429, "Too many queued messages"); scheduled--; return; }
      chain = chain.then(() => handle(message, binary, parseError)).catch(() => socket.close(1011, "Reconnect to recover")).finally(() => { scheduled--; });
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) socket.terminate();
      else { socket.alive = false; socket.ping(); }
    }
    for (const [key, value] of requests) if (Date.now() - value.start >= 60000) requests.delete(key);
  }, heartbeatMs);
  heartbeat.unref();
  async function close() {
    stopping = true;
    clearInterval(heartbeat);
    for (const socket of wss.clients) socket.close(1012, "Server restarting");
    const terminate = setTimeout(() => { for (const socket of wss.clients) socket.terminate(); }, 1000);
    terminate.unref();
    await Promise.all([...queue.pending.values()].map((pending) => pending.catch(() => {})));
    await new Promise((resolve) => wss.close(resolve));
    await new Promise((resolve) => server.close(resolve));
    clearTimeout(terminate);
  }
  return { app, server, close, queue };
}
module.exports = { createApplication };
