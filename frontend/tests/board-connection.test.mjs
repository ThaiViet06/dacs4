import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as model from '../src/drawing/model.ts'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/stores/board.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const roomId = '00000000-0000-4000-8000-000000000001'
const otherRoomId = '00000000-0000-4000-8000-000000000002'

// Chạy store thật với socket/token/timer giả để kiểm tra thứ tự và phản hồi trễ mà không gọi dịch vụ.
function setup(context, getToken = async () => 'test-session') {
  const sockets = []
  const timers = new Map()
  // Giữ lại timer để từng test chủ động kích hoạt refresh hoặc reconnect, không phải chờ thời gian thật.
  const schedule = (callback, delay) => {
    const id = Symbol()
    timers.set(id, { callback, delay })
    return id
  }
  // Mô phỏng API trình duyệt; chỉ dữ liệu đã gửi mới được ghi nhận, không mở cổng mạng.
  class Socket {
    static OPEN = 1
    readyState = 0
    sent = []
    constructor(url) {
      assert.equal(url, 'ws://test.invalid/ws')
      sockets.push(this)
    }
    // Mở kết nối rồi cho store gửi thông điệp xác thực.
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    // Ghi thông điệp để kiểm tra token không bị gửi trong URL hoặc trước khi socket mở.
    send(raw) {
      this.sent.push(JSON.parse(raw))
    }
    // Giao phản hồi giả qua đúng handler mà store đã đăng ký.
    receive(message) {
      this.onmessage?.({ data: JSON.stringify({ v: 1, ...message }) })
    }
    // Mô phỏng đóng kết nối; handler bị tháo thì không được tự nối lại.
    close(code = 1000) {
      this.readyState = 3
      this.onclose?.({ code })
    }
  }
  const dependencies = {
    '../drawing/model': model,
    '../services/auth': { getToken },
    '../services/api': { WS_URL: 'ws://test.invalid/ws' },
  }
  const module = { exports: {} }
  new Function(
    'require',
    'module',
    'exports',
    'WebSocket',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    compiled,
  )(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
    Socket,
    schedule,
    (id) => timers.delete(id),
    schedule,
    (id) => timers.delete(id),
  )
  setActivePinia(createPinia())
  const board = module.exports.useBoardStore()
  context.after(() => board.local())
  return { board, sockets, timers }
}

// Tạo phản hồi trạng thái thống nhất; sequence không bằng số nét khi phòng mở từ bản sao có sẵn.
function roomState(id = roomId) {
  const operation = {
    id: crypto.randomUUID(),
    type: 'line',
    width: 2,
    color: '#123456',
    start: { x: 10, y: 20 },
    end: { x: 30, y: 40 },
  }
  return {
    type: 'room.state',
    room: { id, title: 'Test room', ownerId: 'test-owner', sequence: 0 },
    sequence: 0,
    document: { ...model.emptyDocument(), operations: [operation] },
  }
}

test('auth precedes room join and only authoritative state marks the board connected', async (context) => {
  const { board, sockets, timers } = setup(context)
  await board.connect(roomId)
  const socket = sockets[0]
  assert.equal(board.status, 'connecting')
  assert.equal(socket.sent.length, 0)
  socket.open()
  assert.deepEqual(socket.sent, [{ v: 1, type: 'auth', token: 'test-session' }])
  socket.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'room.join', roomId })
  assert.equal(board.status, 'connecting')
  socket.receive(roomState())
  assert.equal(board.status, 'connected')
  assert.equal(board.room.id, roomId)
  assert.equal(board.sequence, 0)
  assert.equal(board.document.operations.length, 1)
  assert.ok(![...timers.values()].some((timer) => timer.delay === 75000))
})

test('a token failure from a previous room cannot overwrite the new connection', async (context) => {
  let rejectOld
  let calls = 0
  const { board, sockets } = setup(context, () =>
    ++calls === 1
      ? new Promise((_, reject) => {
          rejectOld = reject
        })
      : Promise.resolve('new-session'),
  )
  const oldRequest = board.connect(roomId)
  await board.connect(otherRoomId)
  rejectOld(new Error('old session ended'))
  await oldRequest
  assert.equal(board.status, 'connecting')
  assert.equal(board.error, '')
  assert.equal(sockets.length, 1)
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.equal(sockets[0].sent.at(-1).roomId, otherRoomId)
})

test('switching rooms ignores callbacks from the old socket and clears its state', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  const oldSocket = sockets[0]
  oldSocket.open()
  oldSocket.receive(roomState())
  const lateOpen = oldSocket.onopen
  const lateMessage = oldSocket.onmessage
  const lateClose = oldSocket.onclose
  await board.connect(otherRoomId)
  lateOpen()
  lateMessage({ data: JSON.stringify({ v: 1, ...roomState() }) })
  lateClose({ code: 4401 })
  assert.equal(sockets[1].sent.length, 0)
  assert.equal(board.status, 'connecting')
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
})

for (const code of ['ROOM_NOT_FOUND', 'ROOM_FULL']) {
  test(code + ' stops automatic retries and clears authentication timers', async (context) => {
    const { board, sockets, timers } = setup(context)
    await board.connect(roomId)
    sockets[0].open()
    sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
    sockets[0].receive({ type: 'error', code, message: 'server error' })
    assert.equal(board.status, 'error')
    assert.notEqual(board.error, '')
    assert.equal(timers.size, 0)
    assert.equal(board.room, null)
    await board.connect(roomId)
    assert.equal(board.status, 'connecting')
    assert.equal(sockets.length, 2)
  })
}

test('sign-out cleanup closes the socket and discards room data and pending token callbacks', async (context) => {
  const { board, sockets, timers } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[0].receive(roomState())
  board.local()
  assert.equal(sockets[0].readyState, 3)
  assert.equal(timers.size, 0)
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
  assert.equal(board.status, 'local')
})

test('state for another room is rejected and cannot enable drawing', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive(roomState(otherRoomId))
  assert.notEqual(board.status, 'connected')
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
})

test('refreshing a connected session does not request room state again', async (context) => {
  let calls = 0
  const { board, sockets, timers } = setup(context, async () => `session-${++calls}`)
  await board.connect(roomId)
  const socket = sockets[0]
  socket.open()
  socket.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  socket.receive(roomState())
  const refresh = [...timers.values()].find(({ delay }) => delay > 40000 && delay < 50000)
  await refresh.callback()
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'auth.refresh', token: 'session-2' })
  socket.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.equal(socket.sent.filter(({ type }) => type === 'room.join').length, 1)
  assert.equal(board.status, 'connected')
})

test('an old refresh failure cannot close a socket opened by automatic retry', async (context) => {
  let calls = 0
  let rejectRefresh
  const { board, sockets, timers } = setup(context, () =>
    ++calls === 2
      ? new Promise((_, reject) => {
          rejectRefresh = reject
        })
      : Promise.resolve('test-session'),
  )
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[0].receive(roomState())
  const refresh = [...timers.values()].find(({ delay }) => delay > 40000 && delay < 50000)
  const refreshing = refresh.callback()
  sockets[0].close(1006)
  const retry = [...timers.values()].find(({ delay }) => delay >= 800 && delay < 1000)
  await retry.callback()
  sockets[1].open()
  rejectRefresh(new Error('old token refresh failed'))
  await refreshing
  assert.equal(board.status, 'reconnecting')
  assert.equal(sockets[1].readyState, 1)
  assert.equal(sockets[1].sent[0].type, 'auth')
})

// Nét mới phải chờ server xác nhận; acknowledgement lặp không được nhân đôi nét trên canvas.
test('a stroke stays pending until acknowledged and duplicate acknowledgements are ignored', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  const socket = sockets[0]
  socket.open()
  socket.receive(roomState())
  const operation = { ...roomState().document.operations[0], id: crypto.randomUUID() }
  board.commit(operation)
  assert.equal(board.pendingCount, 1)
  assert.equal(board.document.operations.length, 1)
  assert.equal(board.operations.length, 2)
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'operation.commit', operation })
  socket.receive({ type: 'operation.committed', sequence: 1, operation })
  socket.receive({ type: 'operation.committed', sequence: 1, operation, duplicate: true })
  assert.equal(board.pendingCount, 0)
  assert.equal(board.sequence, 1)
  assert.equal(board.document.operations.length, 2)
  assert.equal(board.operations.length, 2)
})

// Dù nét của người khác được xác nhận trước nét mình, mọi client vẫn dùng thứ tự server cấp.
test('remote and local strokes converge in server order including erasing', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  const socket = sockets[0]
  socket.open()
  socket.receive({ ...roomState(), document: model.emptyDocument() })
  const local = roomState().document.operations[0]
  const remote = {
    id: crypto.randomUUID(),
    type: 'freehand',
    color: '#abcdef',
    width: 3,
    points: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
  }
  const eraser = { ...remote, id: crypto.randomUUID(), type: 'eraser', width: 24 }
  board.commit(local)
  socket.receive({ type: 'operation.committed', sequence: 1, operation: remote })
  socket.receive({ type: 'operation.committed', sequence: 2, operation: local })
  socket.receive({ type: 'operation.committed', sequence: 3, operation: eraser })
  assert.deepEqual(board.document.operations, [remote, local, eraser])
  assert.equal(board.sequence, 3)
  assert.equal(board.pendingCount, 0)
})

// Khóa việc gửi nét trong lúc mất kết nối, giữ nét đã có cho đến khi tải lại trạng thái phòng.
test('drawing while disconnected cannot send or add a new operation', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  const socket = sockets[0]
  socket.open()
  socket.receive(roomState())
  socket.close(1006)
  const sentBefore = socket.sent.length
  board.commit(roomState().document.operations[0])
  assert.equal(board.status, 'reconnecting')
  assert.equal(board.pendingCount, 0)
  assert.equal(board.document.operations.length, 1)
  assert.equal(socket.sent.length, sentBefore)
})
