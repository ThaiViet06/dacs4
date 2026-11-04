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
  const network = new EventTarget()
  network.navigator = { onLine: true }
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
    'window',
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
    network,
    schedule,
    (id) => timers.delete(id),
    schedule,
    (id) => timers.delete(id),
  )
  setActivePinia(createPinia())
  const board = module.exports.useBoardStore()
  context.after(() => board.reset())
  return { board, sockets, timers, network }
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
  board.reset()
  assert.equal(sockets[0].readyState, 3)
  assert.equal(timers.size, 0)
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
  assert.equal(board.status, 'idle')
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

// Offline phải khóa vẽ ngay; có mạng thì xác thực lại và chờ đủ trạng thái mới trước khi mở Canvas.
test('offline then online fetches a fresh token and restores strokes drawn by another member', async (context) => {
  const tokenRequests = []
  const { board, sockets, timers, network } = setup(context, async (fresh) => {
    tokenRequests.push(fresh)
    return `session-${tokenRequests.length}`
  })
  await board.connect(roomId)
  sockets[0].open()
  const initial = roomState()
  sockets[0].receive(initial)
  network.navigator.onLine = false
  network.dispatchEvent(new Event('offline'))
  assert.equal(board.status, 'reconnecting')
  assert.equal(sockets[0].readyState, 3)
  assert.equal(timers.size, 0)
  board.commit(roomState().document.operations[0])
  assert.equal(board.pendingCount, 0)
  network.navigator.onLine = true
  network.dispatchEvent(new Event('online'))
  await new Promise(setImmediate)
  assert.deepEqual(tokenRequests, [true, true])
  assert.equal(sockets.length, 2)
  sockets[1].open()
  sockets[1].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.notEqual(board.status, 'connected')
  assert.equal(sockets[1].sent.at(-1).roomId, roomId)
  const remote = roomState().document.operations[0]
  sockets[1].receive({
    ...initial,
    sequence: 1,
    document: { ...initial.document, operations: [...initial.document.operations, remote] },
  })
  assert.equal(board.status, 'connected')
  assert.equal(board.error, '')
  assert.equal(board.sequence, 1)
  assert.deepEqual(board.document.operations, [...initial.document.operations, remote])
  network.dispatchEvent(new Event('online'))
  assert.equal(sockets.length, 2)
})

// Mở phòng khi chưa có mạng chỉ chờ online, không gọi Clerk hoặc tạo socket vô ích.
test('an initially offline room waits for online before fetching a token', async (context) => {
  let tokenRequests = 0
  const { board, sockets, timers, network } = setup(context, async () => {
    tokenRequests++
    return 'test-session'
  })
  network.navigator.onLine = false
  await board.connect(roomId)
  assert.equal(tokenRequests, 0)
  assert.equal(sockets.length, 0)
  assert.equal(timers.size, 0)
  assert.equal(board.status, 'reconnecting')
  network.navigator.onLine = true
  network.dispatchEvent(new Event('online'))
  await new Promise(setImmediate)
  assert.equal(tokenRequests, 1)
  assert.equal(sockets.length, 1)
})

// Có mạng chưa chắc Clerk đã truy cập được; lỗi tải token tạm thời vẫn phải thử lại với backoff có giới hạn.
test('temporary token failures retry with bounded backoff until a fresh session is available', async (context) => {
  let tokenRequests = 0
  const { board, sockets, timers } = setup(context, async () => {
    if (++tokenRequests <= 7) throw new Error('Temporary network failure')
    return 'recovered-session'
  })
  await board.connect(roomId)
  for (let attempt = 0; attempt < 7; attempt++) {
    assert.equal(board.status, 'reconnecting')
    const retry = [...timers.values()].find(({ delay }) => delay !== 1000)
    assert.ok(retry)
    const cap = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))
    assert.ok(retry.delay >= cap * 0.8 && retry.delay <= cap)
    await retry.callback()
  }
  assert.equal(tokenRequests, 8)
  assert.equal(sockets.length, 1)
  assert.notEqual(board.status, 'connected')
  sockets[0].open()
  assert.equal(sockets[0].sent[0].token, 'recovered-session')
  sockets[0].receive(roomState())
  assert.equal(board.status, 'connected')
})

// Lỗi mạng khi refresh không được giả thành lỗi hết phiên; chỉ mã 4401 từ server mới dừng retry.
test('a refresh network failure reconnects but server authentication rejection stops retries', async (context) => {
  let tokenRequests = 0
  const { board, sockets, timers, network } = setup(context, async () => {
    if (++tokenRequests === 2) throw new Error('Refresh network failure')
    return 'test-session'
  })
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[0].receive(roomState())
  const refresh = [...timers.values()].find(({ delay }) => delay > 40000 && delay < 50000)
  await refresh.callback()
  assert.equal(board.status, 'reconnecting')
  const retry = [...timers.values()].find(({ delay }) => delay >= 800 && delay < 1000)
  await retry.callback()
  assert.equal(sockets.length, 2)
  sockets[1].open()
  sockets[1].close(4401)
  assert.equal(board.status, 'error')
  assert.equal(timers.size, 0)
  network.dispatchEvent(new Event('online'))
  assert.equal(sockets.length, 2)
})

// Đăng xuất khi offline phải bỏ lần chờ online và dữ liệu cũ, không tự nối lại tài khoản đã rời phòng.
test('leaving an offline room cancels its online listener and prevents reconnection', async (context) => {
  const { board, sockets, network } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive(roomState())
  network.navigator.onLine = false
  network.dispatchEvent(new Event('offline'))
  board.reset()
  network.navigator.onLine = true
  network.dispatchEvent(new Event('online'))
  await new Promise(setImmediate)
  assert.equal(sockets.length, 1)
  assert.equal(board.status, 'idle')
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
})

for (const saved of [false, true]) {
  // Hai nhánh mất acknowledgement: chỉ gửi lại UUID chưa có trên server, giữ đúng thứ tự với nét người khác.
  test(`pending stroke ${saved ? 'already saved' : 'not yet saved'} survives offline recovery without duplication`, async (context) => {
    const { board, sockets, network } = setup(context)
    await board.connect(roomId)
    sockets[0].open()
    sockets[0].receive({ ...roomState(), document: model.emptyDocument() })
    const operation = roomState().document.operations[0]
    board.commit(operation)
    assert.equal(board.pendingCount, 1)
    network.navigator.onLine = false
    network.dispatchEvent(new Event('offline'))
    assert.equal(board.pendingCount, 1)
    assert.deepEqual(board.operations, [operation])
    network.navigator.onLine = true
    network.dispatchEvent(new Event('online'))
    await new Promise(setImmediate)
    const returned = sockets[1]
    returned.open()
    returned.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
    assert.deepEqual(
      returned.sent.map(({ type }) => type),
      ['auth', 'room.join'],
    )
    assert.equal(board.pendingCount, 1)
    assert.notEqual(board.status, 'connected')
    const remote = roomState().document.operations[0]
    const operations = saved ? [operation, remote] : [remote]
    returned.receive({
      ...roomState(),
      sequence: saved ? 2 : 1,
      document: { ...model.emptyDocument(), operations },
    })
    const retries = returned.sent.filter(({ type }) => type === 'operation.commit')
    assert.equal(retries.length, saved ? 0 : 1)
    if (!saved) {
      assert.deepEqual(retries[0].operation, operation)
      assert.equal(board.pendingCount, 1)
      returned.receive({ type: 'operation.committed', operation, sequence: 2 })
    }
    // Ack lặp sau reconnect không được thêm lại nét đã có trong trạng thái hoặc vừa được xác nhận.
    returned.receive({
      type: 'operation.committed',
      operation,
      sequence: saved ? 1 : 2,
      duplicate: true,
    })
    assert.equal(board.pendingCount, 0)
    assert.equal(board.sequence, 2)
    assert.equal(board.status, 'connected')
    assert.equal(board.operations.length, 2)
    assert.equal(new Set(board.operations.map(({ id }) => id)).size, 2)
    assert.deepEqual(board.document.operations, saved ? [operation, remote] : [remote, operation])
  })
}

// Ack nhảy sequence yêu cầu tải lại phòng; không bỏ nét chờ trước khi biết đầy đủ trạng thái có thẩm quyền.
test('a sequence gap keeps the pending stroke until authoritative state confirms it', async (context) => {
  const { board, sockets, timers } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive({ ...roomState(), document: model.emptyDocument() })
  const operation = roomState().document.operations[0]
  board.commit(operation)
  sockets[0].receive({ type: 'operation.committed', operation, sequence: 2 })
  assert.equal(board.status, 'reconnecting')
  assert.equal(board.sequence, 0)
  assert.equal(board.pendingCount, 1)
  assert.deepEqual(board.operations, [operation])
  const retry = [...timers.values()].find(({ delay }) => delay >= 800 && delay < 1000)
  await retry.callback()
  sockets[1].open()
  sockets[1].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.equal(board.pendingCount, 1)
  const remote = roomState().document.operations[0]
  sockets[1].receive({
    ...roomState(),
    sequence: 2,
    document: { ...model.emptyDocument(), operations: [remote, operation] },
  })
  assert.equal(board.pendingCount, 0)
  assert.equal(board.sequence, 2)
  assert.deepEqual(board.document.operations, [remote, operation])
  assert.ok(!sockets[1].sent.some(({ type }) => type === 'operation.commit'))
})

// Chuyển trang rồi quay lại cũng phải đối chiếu UUID như reconnect, kể cả acknowledgement đã thất lạc.
for (const saved of [false, true]) {
  test(`room navigation retains a pending stroke ${saved ? 'saved' : 'not saved'} by the server`, async (context) => {
    const { board, sockets, timers } = setup(context)
    await board.connect(roomId)
    sockets[0].open()
    sockets[0].receive({ ...roomState(), document: model.emptyDocument() })
    const operation = roomState().document.operations[0]
    board.commit(operation)
    const lateMessage = sockets[0].onmessage
    board.leaveRoom()
    assert.equal(sockets[0].readyState, 3)
    assert.equal(timers.size, 0)
    board.prepareRoom(otherRoomId)
    assert.equal(board.operations.length, 0)
    board.leaveRoom()
    board.prepareRoom(roomId)
    assert.equal(board.status, 'connecting')
    assert.deepEqual(board.operations, [operation])
    assert.equal(board.pendingCount, 1)
    lateMessage({
      data: JSON.stringify({ v: 1, type: 'operation.committed', operation, sequence: 1 }),
    })
    assert.equal(board.pendingCount, 1)
    await board.connect(roomId)
    sockets[1].open()
    sockets[1].receive({
      ...roomState(),
      sequence: saved ? 1 : 0,
      document: { ...model.emptyDocument(), operations: saved ? [operation] : [] },
    })
    const retries = sockets[1].sent.filter(({ type }) => type === 'operation.commit')
    assert.equal(retries.length, saved ? 0 : 1)
    if (!saved) {
      assert.deepEqual(retries[0].operation, operation)
      sockets[1].receive({ type: 'operation.committed', operation, sequence: 1 })
    }
    assert.equal(board.pendingCount, 0)
    assert.deepEqual(board.operations, [operation])
  })
}

test('cached rooms stay isolated and cannot draw before fresh room state', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  const original = roomState()
  sockets[0].receive(original)
  board.leaveRoom()
  await board.connect(otherRoomId)
  sockets[1].open()
  sockets[1].receive(roomState(otherRoomId))
  board.leaveRoom()
  assert.equal(board.prepareRoom(roomId).id, roomId)
  assert.deepEqual(board.document, original.document)
  board.commit(roomState().document.operations[0])
  assert.equal(board.pendingCount, 0)
  await board.connect(roomId)
  sockets[2].open()
  assert.notEqual(board.status, 'connected')
  const remote = roomState().document.operations[0]
  sockets[2].receive({
    ...original,
    sequence: 1,
    document: { ...original.document, operations: [...original.document.operations, remote] },
  })
  assert.equal(board.status, 'connected')
  assert.deepEqual(board.document.operations, [...original.document.operations, remote])
})

test('invitation and room caches are private to the current account', async (context) => {
  const { board, sockets } = setup(context)
  board.setAccount('test-owner')
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive(roomState())
  board.rememberInvitation(roomId, 'https://test.invalid/invite/placeholder')
  board.leaveRoom()
  board.prepareRoom(roomId)
  assert.equal(board.invitationUrl, 'https://test.invalid/invite/placeholder')
  board.rememberInvitation(otherRoomId, 'https://test.invalid/invite/wrong-room')
  assert.equal(board.invitationUrl, 'https://test.invalid/invite/placeholder')
  board.leaveRoom()
  board.setAccount('another-user')
  assert.equal(board.prepareRoom(roomId), null)
  assert.equal(board.invitationUrl, '')
  assert.equal(board.document.operations.length, 0)
  board.room = { ...roomState().room }
  board.rememberInvitation(roomId, 'https://test.invalid/invite/not-owner')
  assert.equal(board.invitationUrl, '')
})

test('revoked access deletes cached room state instead of restoring it later', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive(roomState())
  board.leaveRoom()
  board.prepareRoom(roomId)
  await board.connect(roomId)
  sockets[1].open()
  sockets[1].receive({ type: 'error', code: 'ROOM_NOT_FOUND', message: 'Access denied' })
  assert.equal(board.status, 'error')
  assert.equal(board.document.operations.length, 0)
  board.leaveRoom()
  assert.equal(board.prepareRoom(roomId), null)
})

test('cache eviction preserves projects that still have unacknowledged work', async (context) => {
  const { board, sockets } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive(roomState())
  const pending = roomState().document.operations[0]
  board.commit(pending)
  board.leaveRoom()
  for (let index = 0; index < 7; index++) {
    const id = `finished-${index}`
    board.prepareRoom(id)
    board.room = { ...roomState().room, id }
    board.document = roomState().document
    board.leaveRoom()
  }
  board.prepareRoom(roomId)
  assert.equal(board.pendingCount, 1)
  assert.ok(board.operations.some(({ id }) => id === pending.id))
  board.leaveRoom()
  assert.equal(board.prepareRoom('finished-0'), null)
  board.leaveRoom()
  assert.equal(board.prepareRoom('finished-6').id, 'finished-6')
})

// Thu quyền khác mất mạng: xóa đúng phiên, dừng mọi timer/retry và không phục hồi nội dung khi quay lại.
test('4403 revocation clears room data and cached sessions without reconnecting', async (context) => {
  const { board, sockets, timers } = setup(context)
  await board.connect(roomId)
  sockets[0].open()
  sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[0].receive(roomState())
  board.commit(roomState().document.operations[0])
  board.leaveRoom()
  board.prepareRoom(roomId)
  await board.connect(roomId)
  sockets[1].open()
  sockets[1].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[1].receive(roomState())
  sockets[1].close(4403)
  assert.equal(board.revokedRoomId, roomId)
  assert.equal(board.status, 'error')
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
  assert.equal(board.pendingCount, 0)
  assert.equal(timers.size, 0)
  board.leaveRoom()
  assert.equal(board.prepareRoom(roomId), null)
  assert.equal(board.revokedRoomId, '')
})
