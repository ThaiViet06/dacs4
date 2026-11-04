const http = require("node:http");
const { randomUUID } = require("node:crypto");
const express = require("express");
const cors = require("cors");
const { WebSocketServer, WebSocket } = require("ws");
const { AppError, publicError } = require("./errors");
const { parse, messageSchema, createSchema, sharingSchema, upgradeInvitationSchema, joinSchema, uuidSchema, saveSchema } = require("./protocol");
const { RoomQueue } = require("./queue");

function createApplication({ repository, verifyToken, origins, heartbeatMs = 30000 }) {
  const app = express();
  const queue = new RoomQueue();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const rooms = new Map();
  const requests = new Map();
  let stopping = false;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.headers.origin && !origins.includes(req.headers.origin)) return next(new AppError(403, "ORIGIN_DENIED", "This origin is not allowed."));
    next();
  });
  app.use(cors({ origin: origins, allowedHeaders: ["Content-Type", "Authorization"], methods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"] }));
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
  const id = (req) => parse(uuidSchema, req.params.id);
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
  // Chỉ đọc trạng thái chia sẻ cho chủ đã xác thực; không tạo link hoặc thay đổi quyền thành viên.
  app.get("/api/rooms/:id/sharing", route(async (req, res) => res.json(await repository.getSharing(req.userId, id(req)))));
  // Xếp cùng hàng đợi với nét/join; chỉ ngắt cộng tác sau khi transaction thu quyền đã commit.
  app.patch("/api/rooms/:id/sharing", route(async (req, res) => {
    const roomId = id(req);
    const { enabled } = parse(sharingSchema, req.body);
    const result = await queue.run(roomId, async () => {
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

  function send(socket, type, data = {}) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "Connection too slow; reconnect"); return; }
    socket.send(JSON.stringify({ v: 1, type, ...data }));
  }
  function broadcast(roomId, type, data, except) {
    for (const socket of rooms.get(roomId) || []) if (socket !== except) send(socket, type, data);
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
    const authTimer = setTimeout(() => socket.close(4401, "Authentication required"), 5000);
    let expiration;
    let rate = { start: Date.now(), messages: 0, previews: 0 };
    socket.on("pong", () => { socket.alive = true; });
    socket.on("error", () => {});
    socket.on("close", () => { clearTimeout(authTimer); clearTimeout(expiration); leave(socket); });
    // Socket bị thu hồi không được xử lý tiếp các frame đã gửi nhưng còn nằm trong hàng đợi.
    async function handle(raw, binary) {
      if (socket.accessRevoked || socket.readyState !== WebSocket.OPEN) return;
      let message;
      try {
        if (binary) throw new AppError(400, "INVALID_MESSAGE", "Only JSON text messages are supported.");
        try { message = parse(messageSchema, JSON.parse(raw.toString())); }
        catch (error) { if (error instanceof SyntaxError) throw new AppError(400, "INVALID_JSON", "Message must be valid JSON."); throw error; }
        if (message.type === "auth" || message.type === "auth.refresh") {
          let identity;
          try { identity = await verifyToken(message.token); }
          catch { throw new AppError(401, "AUTH_EXPIRED", "Authentication expired. Sign in again."); }
          if (!identity?.userId || identity.expiresAt <= Date.now() || (socket.identity && socket.identity.userId !== identity.userId)) throw new AppError(401, "AUTH_EXPIRED", "Invalid session.");
          socket.identity = identity;
          clearTimeout(authTimer);
          clearTimeout(expiration);
          expiration = setTimeout(() => socket.close(4401, "Session expired"), Math.min(identity.expiresAt - Date.now(), 2147483647));
          send(socket, "auth.ok", { clientId: socket.clientId, expiresAt: identity.expiresAt });
          return;
        }
        if (!socket.identity || socket.identity.expiresAt <= Date.now()) throw new AppError(401, "AUTH_REQUIRED", "Authenticate first.");
        if (Date.now() - rate.start >= 1000) rate = { start: Date.now(), messages: 0, previews: 0 };
        if (++rate.messages > 100) throw new AppError(429, "RATE_LIMIT", "Slow down and retry.");
        if (message.type === "room.join") {
          await queue.run(message.roomId, async () => {
            const state = await repository.state(socket.identity.userId, message.roomId);
            if (socket.readyState !== WebSocket.OPEN) return;
            const clients = rooms.get(message.roomId) || new Set();
            if (!clients.has(socket) && clients.size >= 10) throw new AppError(409, "ROOM_FULL", "This demo supports ten connections per room.");
            leave(socket);
            socket.roomId = message.roomId;
            const active = rooms.get(message.roomId) || new Set();
            active.add(socket);
            rooms.set(message.roomId, active);
            send(socket, "room.state", state);
            presence(message.roomId);
          });
          return;
        }
        if (!socket.roomId) throw new AppError(409, "JOIN_REQUIRED", "Join a room first.");
        if (message.type === "operation.preview") {
          if (++rate.previews > 20) return;
          const roomId = socket.roomId;
          await queue.run(roomId, () => {
            if (!socket.accessRevoked && socket.roomId === roomId)
              broadcast(roomId, message.type, { clientId: socket.clientId, operation: message.operation }, socket);
          });
        } else if (message.type === "preview.cancel") {
          const roomId = socket.roomId;
          await queue.run(roomId, () => {
            if (!socket.accessRevoked && socket.roomId === roomId)
              broadcast(roomId, message.type, { clientId: socket.clientId, operationId: message.operationId }, socket);
          });
        } else if (message.type === "operation.commit") {
          const roomId = socket.roomId;
          await queue.run(roomId, async () => {
            if (socket.accessRevoked) return;
            const committed = await repository.commit(socket.identity.userId, roomId, message.operation);
            if (committed.duplicate) send(socket, "operation.committed", committed);
            else broadcast(roomId, "operation.committed", committed);
          });
        }
      } catch (error) {
        send(socket, "error", { ...publicError(error), operationId: message?.operation?.id });
        if (message?.operation && socket.roomId) broadcast(socket.roomId, "preview.cancel", { clientId: socket.clientId, operationId: message.operation.id }, socket);
        if (error.status === 401) socket.close(4401, "Authentication required");
      }
    }
    socket.on("message", (raw, binary) => {
      if (++scheduled > 100) { socket.close(4429, "Too many queued messages"); scheduled--; return; }
      chain = chain.then(() => handle(raw, binary)).catch(() => socket.close(1011, "Reconnect to recover")).finally(() => { scheduled--; });
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
