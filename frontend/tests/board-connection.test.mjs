import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as model from '../src/drawing/model.ts'
import * as codec from '../src/drawing/codec.ts'
import * as chatModel from '../src/chat/model.ts'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/stores/board.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const roomId = '00000000-0000-4000-8000-000000000001'
const otherRoomId = '00000000-0000-4000-8000-000000000002'

// Chat không được thay đổi sequence/tài liệu nét vẽ hoặc nhận nội dung từ dự án khác.
test('shared chat events are scoped to the joined room and never modify drawing state', async (context) => {
  const { board, socket } = await connectedProject(context, { shared: true })
  const before = JSON.stringify(board.document)
  const sequence = board.sequence
  const message = {
    id: crypto.randomUUID(),
    roomId,
    authorId: 'member',
    sequence: 9,
    text: 'Chào bạn',
    createdAt: '2026-11-17T03:00:00.000Z',
  }
  socket.receive({ type: 'chat.message', message })
  assert.deepEqual(board.lastChatMessage, message)
  assert.equal(board.sequence, sequence)
  assert.equal(JSON.stringify(board.document), before)
  socket.receive({ type: 'chat.message', message: { ...message, roomId: otherRoomId } })
  socket.receive({ type: 'chat.message', message: { ...message, text: 'x'.repeat(1001) } })
  assert.deepEqual(board.lastChatMessage, message)
  socket.close(1006)
  assert.equal(board.lastChatMessage, null)
})

// Dự án Cá nhân hoặc tài khoản mới không được giữ thông điệp chat của phiên cũ.
test('personal projects reject chat events and switching accounts clears the last message', async (context) => {
  const { board, socket } = await connectedProject(context, { shared: false })
  const message = {
    id: crypto.randomUUID(),
    roomId,
    authorId: 'member',
    sequence: 1,
    text: 'Riêng tư',
    createdAt: '2026-11-17T03:00:00.000Z',
  }
  socket.receive({ type: 'chat.message', message })
  assert.equal(board.lastChatMessage, null)
  board.room.sharingEnabled = true
  socket.receive({ type: 'chat.message', message })
  assert.deepEqual(board.lastChatMessage, message)
  board.setAccount('another-account')
  assert.equal(board.lastChatMessage, null)
})

// Kiểu lỗi này chỉ biểu thị SDK xác nhận không có phiên, không dùng cho lỗi mạng tạm thời.
class SignInRequiredError extends Error {}

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
      this.onmessage?.({ data: JSON.stringify({ v: 2, ...message }) })
    }
    // Mô phỏng đóng kết nối; handler bị tháo thì không được tự nối lại.
    close(code = 1000) {
      this.readyState = 3
      this.onclose?.({ code })
    }
  }
  const dependencies = {
    '../drawing/model': model,
    '../drawing/codec': codec,
    '../chat/model': chatModel,
    '../services/auth': { getToken, SignInRequiredError },
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

// Kết nối một dự án với tài khoản/chế độ cụ thể để kiểm tra sự kiện lịch sử trên store thật.
async function connectedProject(context, { accountId = 'test-owner', shared = false } = {}) {
  const session = setup(context)
  session.board.setAccount(accountId)
  await session.board.connect(roomId)
  const socket = session.sockets[0]
  socket.open()
  socket.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  const state = roomState()
  state.room.sharingEnabled = shared
  socket.receive(state)
  return { ...session, socket, state }
}

test('compact acknowledgements and reconnect deltas reconcile pending strokes in server order', async (context) => {
  const { board, sockets } = setup(context)
  board.setAccount('test-owner')
  await board.connect(roomId)
  const [first] = sockets
  first.open()
  const auth = { type: 'auth.ok', drawingSync: true, expiresAt: Date.now() + 60000 }
  first.receive(auth)
  assert.deepEqual(first.sent.at(-1), { v: 2, type: 'room.join', roomId, sync: {} })
  const initial = roomState()
  first.receive(initial)
  const original = initial.document.operations[0]
  const local = { ...original, id: crypto.randomUUID() }
  assert.equal(board.commit(local), true)
  assert.deepEqual(first.sent.at(-1), {
    v: 2,
    type: 'operation.packed',
    id: local.id,
    packed: codec.encodeStroke(local),
  })
  first.receive({ type: 'operation.ack', id: local.id, seq: 1 })
  assert.equal(board.pendingCount, 0)
  assert.deepEqual(board.confirmedOperations, [original, local])
  const pending = { ...original, id: crypto.randomUUID() }
  const remote = { ...original, id: crypto.randomUUID() }
  board.commit(pending)
  first.close(1006)
  await board.connect(roomId)
  const second = sockets.at(-1)
  second.open()
  second.receive(auth)
  assert.deepEqual(second.sent.at(-1).sync, { lastSeq: 1, snapshot: false })
  second.receive({
    type: 'room.sync',
    room: initial.room,
    sequence: 3,
    after: 1,
    epoch: 0,
    snapshot: null,
    events: [remote, pending].map((operation, index) => ({
      sequence: index + 2,
      id: operation.id,
      packed: codec.encodeStroke(operation),
    })),
  })
  assert.deepEqual(board.confirmedOperations, [original, local, remote, pending])
  assert.equal(board.pendingCount, 0)
  assert.equal(board.status, 'connected')
  assert.equal(board.sequence, 3)
})

// Dùng UUID riêng cho mỗi lần ẩn/hiện, giữ UUID nét làm đích xuyên qua reconnect và cache.
function visibility(targetId, visible = false) {
  return { id: crypto.randomUUID(), type: 'visibility', targetId, visible }
}

// Tạo một nét mới trong phiên, độc lập với nét cũ đã có khi tải phòng.
function newStroke(state, type = 'line') {
  const original = state.document.operations[0]
  return type === 'eraser'
    ? {
        id: crypto.randomUUID(),
        type,
        width: original.width,
        color: original.color,
        points: [original.start, original.end],
      }
    : { ...original, id: crypto.randomUUID() }
}

// Cho server giả xác nhận thao tác cuối ở sequence tiếp theo, không tự cập nhật stack trong test.
function acknowledgeLast(board, socket) {
  const message = socket.sent.at(-1)
  assert.equal(message.type, 'operation.commit')
  socket.receive({
    type: 'operation.committed',
    sequence: board.sequence + 1,
    operation: message.operation,
  })
  return message.operation
}

test('personal undo and redo move through new strokes and erasing only after acknowledgement', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  const first = newStroke(state)
  const erased = newStroke(state, 'eraser')
  for (const operation of [first, erased]) {
    board.commit(operation)
    assert.equal(board.canUndo, false)
    acknowledgeLast(board, socket)
  }
  assert.equal(board.canUndo, true)
  board.undo()
  const hidden = socket.sent.at(-1).operation
  assert.equal(hidden.targetId, erased.id)
  assert.equal(hidden.visible, false)
  assert.equal(board.canRedo, false)
  board.undo()
  assert.equal(socket.sent.at(-1).operation.id, hidden.id)
  acknowledgeLast(board, socket)
  socket.receive({
    type: 'operation.committed',
    sequence: board.sequence,
    operation: hidden,
    duplicate: true,
  })
  assert.equal(board.canRedo, true)
  board.undo()
  assert.equal(acknowledgeLast(board, socket).targetId, first.id)
  assert.equal(board.canUndo, false)
  assert.deepEqual(board.operations, state.document.operations)
  for (const operation of [first, erased]) {
    board.redo()
    const shown = acknowledgeLast(board, socket)
    assert.equal(shown.targetId, operation.id)
    assert.equal(shown.visible, true)
  }
  assert.deepEqual(board.operations, [...state.document.operations, first, erased])
  assert.equal(board.canRedo, false)
})

test('a newly acknowledged stroke after undo clears only the redo branch', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const first = newStroke(state)
  board.commit(first)
  acknowledgeLast(board, socket)
  board.undo()
  acknowledgeLast(board, socket)
  const next = newStroke(state)
  board.commit(next)
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  acknowledgeLast(board, socket)
  assert.equal(board.canRedo, false)
  const sent = socket.sent.length
  board.redo()
  assert.equal(socket.sent.length, sent)
  board.undo()
  assert.equal(acknowledgeLast(board, socket).targetId, next.id)
  assert.deepEqual(board.operations, state.document.operations)
})

for (const direction of ['undo', 'redo'])
  for (const saved of [false, true]) {
    test(`${direction} ${saved ? 'saved before lost ACK' : 'not saved'} recovers once and moves its stack after canonical confirmation`, async (context) => {
      const { board, socket, sockets, state, network } = await connectedProject(context)
      const local = newStroke(state)
      board.commit(local)
      acknowledgeLast(board, socket)
      if (direction === 'redo') {
        board.undo()
        acknowledgeLast(board, socket)
      }
      const canonical = model.normalizeDocument(board.document)
      const sequence = board.sequence
      board[direction]()
      const event = socket.sent.at(-1).operation
      network.navigator.onLine = false
      network.dispatchEvent(new Event('offline'))
      assert.equal(board.canUndo, false)
      assert.equal(board.canRedo, false)
      network.navigator.onLine = true
      network.dispatchEvent(new Event('online'))
      await new Promise(setImmediate)
      const returned = sockets[1]
      returned.open()
      returned.receive({
        ...state,
        sequence: sequence + (saved ? 1 : 0),
        document: {
          ...canonical,
          operations: saved ? [...canonical.operations, event] : canonical.operations,
        },
      })
      const retries = returned.sent.filter(({ type }) => type === 'operation.commit')
      assert.equal(retries.length, saved ? 0 : 1)
      if (!saved) {
        assert.deepEqual(retries[0].operation, event)
        assert.equal(board.canUndo, false)
        returned.receive({ type: 'operation.committed', operation: event, sequence: sequence + 1 })
      }
      returned.receive({
        type: 'operation.committed',
        operation: event,
        sequence: sequence + 1,
        duplicate: true,
      })
      assert.equal(board.pendingCount, 0)
      assert.equal(board.canRedo, direction === 'undo')
      assert.equal(board.canUndo, direction === 'redo')
      board[direction === 'undo' ? 'redo' : 'undo']()
      assert.equal(returned.sent.at(-1).operation.targetId, local.id)
    })
  }

for (const saved of [false, true]) {
  test(`a local stroke ${saved ? 'already saved' : 'retried'} becomes undoable after a lost-ack reconnect`, async (context) => {
    const { board, socket, sockets, state, network } = await connectedProject(context)
    const local = newStroke(state)
    board.commit(local)
    network.navigator.onLine = false
    network.dispatchEvent(new Event('offline'))
    network.navigator.onLine = true
    network.dispatchEvent(new Event('online'))
    await new Promise(setImmediate)
    const returned = sockets[1]
    returned.open()
    returned.receive({
      ...state,
      sequence: saved ? 1 : 0,
      document: {
        ...state.document,
        operations: saved ? [...state.document.operations, local] : state.document.operations,
      },
    })
    if (!saved) acknowledgeLast(board, returned)
    assert.equal(board.canUndo, true)
    board.undo()
    assert.equal(returned.sent.at(-1).operation.targetId, local.id)
    assert.equal(socket.readyState, 3)
  })
}

test('rename preserves history while a sharing mode change resets stacks without changing saved events', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  board.commit(newStroke(state))
  acknowledgeLast(board, socket)
  board.undo()
  acknowledgeLast(board, socket)
  board.room = { ...board.room, title: 'Renamed' }
  assert.equal(board.canRedo, true)
  const document = model.normalizeDocument(board.document)
  board.room.sharingEnabled = true
  board.room.sharingEnabled = false
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  assert.deepEqual(board.document, document)
})

test('mode changes during a pending undo keep the acknowledged result but never revive the old stack', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  board.commit(newStroke(state))
  acknowledgeLast(board, socket)
  board.undo()
  board.room.sharingEnabled = true
  const event = acknowledgeLast(board, socket)
  assert.equal(board.pendingCount, 0)
  board.room.sharingEnabled = false
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  assert.ok(board.document.operations.some(({ id }) => id === event.id))
})

test('reopening an editor or changing accounts does not restore session undo stacks from the document cache', async (context) => {
  const { board, socket, sockets, state } = await connectedProject(context)
  board.commit(newStroke(state))
  acknowledgeLast(board, socket)
  const document = model.normalizeDocument(board.document)
  board.leaveRoom()
  await board.connect(roomId)
  sockets[1].open()
  sockets[1].receive({ ...state, sequence: 1, document })
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  assert.deepEqual(board.document, document)
  board.setAccount('other')
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
})

test('shared owners and members cannot create session history through project undo or redo', async (context) => {
  for (const options of [{ shared: true }, { accountId: 'other-member' }]) {
    const { board, socket, state } = await connectedProject(context, options)
    board.commit(newStroke(state))
    acknowledgeLast(board, socket)
    const before = socket.sent.length
    board.undo()
    board.redo()
    assert.equal(board.canUndo, false)
    assert.equal(board.canRedo, false)
    assert.equal(socket.sent.length, before)
  }
})

test('a rejected undo restores visible strokes without creating a redo acknowledgement', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const local = newStroke(state)
  board.commit(local)
  acknowledgeLast(board, socket)
  board.undo()
  const hidden = socket.sent.at(-1).operation
  socket.receive({
    type: 'error',
    code: 'INVALID_INPUT',
    message: 'Cannot undo',
    operationId: hidden.id,
  })
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  assert.deepEqual(board.operations, [...state.document.operations, local])
  assert.deepEqual(board.rejected, [hidden])
})

test('a visibility change from another tab resets the local history and retains canonical drawing state', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const local = newStroke(state)
  board.commit(local)
  acknowledgeLast(board, socket)
  socket.receive({ type: 'operation.committed', sequence: 2, operation: visibility(local.id) })
  assert.equal(board.canUndo, false)
  assert.equal(board.canRedo, false)
  assert.deepEqual(board.operations, state.document.operations)
})

test('v2 normalizes legacy state and renders visibility in order without losing raw history', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const original = state.document.operations[0]
  assert.equal(state.document.version, 1)
  assert.equal(board.document.version, 2)
  const hidden = visibility(original.id)
  socket.receive({ type: 'operation.committed', sequence: 1, operation: hidden })
  assert.deepEqual(board.operations, [])
  assert.deepEqual(board.document.operations, [original, hidden])
  assert.deepEqual((await board.exportDocument()).operations, [original, hidden])
  const shown = visibility(original.id, true)
  socket.receive({ type: 'operation.committed', sequence: 2, operation: shown })
  socket.receive({ type: 'operation.committed', sequence: 2, operation: shown, duplicate: true })
  assert.deepEqual(board.operations, [original])
  assert.deepEqual(board.document.operations, [original, hidden, shown])
  assert.ok(socket.sent.every(({ v }) => v === 2))
})

test('v2 state can begin with hidden strokes and exports retain history plus pending drawings', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const original = state.document.operations[0]
  const hidden = visibility(original.id)
  socket.receive({
    ...state,
    sequence: 1,
    document: { ...state.document, version: 2, operations: [original, hidden] },
  })
  assert.deepEqual(board.operations, [])
  const next = { ...original, id: crypto.randomUUID() }
  board.commit(next)
  assert.deepEqual(board.operations, [next])
  assert.deepEqual((await board.exportDocument()).operations, [original, hidden, next])
})

test('pending visibility is optimistic until acknowledged and permission errors restore the drawing', async (context) => {
  for (const code of ['INVALID_INPUT', 'OWNER_REQUIRED', 'PERSONAL_MODE_REQUIRED']) {
    const { board, socket, state } = await connectedProject(context)
    const original = state.document.operations[0]
    const hidden = visibility(original.id)
    board.commit(hidden)
    assert.equal(board.pendingCount, 1)
    assert.deepEqual(board.operations, [])
    assert.deepEqual(board.document.operations, [original])
    assert.deepEqual(socket.sent.at(-1), { v: 2, type: 'operation.commit', operation: hidden })
    socket.receive({ type: 'error', code, message: 'Cannot save event', operationId: hidden.id })
    assert.equal(board.pendingCount, 0)
    assert.deepEqual(board.operations, [original])
    assert.deepEqual(board.rejected, [hidden])
    assert.deepEqual((await board.exportDocument()).operations, [original, hidden])
  }
})

for (const saved of [false, true]) {
  test(`visibility ${saved ? 'already committed' : 'not committed'} reconciles by raw history UUID after offline recovery`, async (context) => {
    const { board, socket, sockets, network, state } = await connectedProject(context)
    const original = state.document.operations[0]
    const hidden = visibility(original.id)
    board.commit(hidden)
    network.navigator.onLine = false
    network.dispatchEvent(new Event('offline'))
    assert.equal(board.pendingCount, 1)
    network.navigator.onLine = true
    network.dispatchEvent(new Event('online'))
    await new Promise(setImmediate)
    const returned = sockets[1]
    returned.open()
    returned.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
    returned.receive({
      ...state,
      sequence: saved ? 1 : 0,
      document: {
        ...state.document,
        version: 2,
        operations: saved ? [original, hidden] : [original],
      },
    })
    const retries = returned.sent.filter(({ type }) => type === 'operation.commit')
    assert.equal(retries.length, saved ? 0 : 1)
    if (!saved) {
      assert.deepEqual(retries[0].operation, hidden)
      assert.equal(board.pendingCount, 1)
      returned.receive({ type: 'operation.committed', sequence: 1, operation: hidden })
    }
    returned.receive({
      type: 'operation.committed',
      sequence: 1,
      operation: hidden,
      duplicate: true,
    })
    assert.equal(board.pendingCount, 0)
    assert.deepEqual(board.document.operations, [original, hidden])
    assert.deepEqual(board.operations, [])
    assert.equal(socket.readyState, 3)
  })
}

test('visibility with a sequence gap remains pending until canonical v2 state confirms it', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const hidden = visibility(state.document.operations[0].id)
  board.commit(hidden)
  socket.receive({ type: 'operation.committed', operation: hidden, sequence: 2 })
  assert.equal(board.status, 'reconnecting')
  assert.equal(board.pendingCount, 1)
  assert.deepEqual(board.document.operations, state.document.operations)
})

test('an acknowledgement outside known history cannot discard a pending visibility event', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  socket.receive({ ...state, sequence: 1 })
  const hidden = visibility(state.document.operations[0].id)
  board.commit(hidden)
  socket.receive({ type: 'operation.committed', operation: hidden, sequence: 1 })
  assert.equal(board.status, 'reconnecting')
  assert.equal(board.pendingCount, 1)
})

test('visibility cannot be sent by a shared owner, member or while another operation is pending', async (context) => {
  for (const options of [{ shared: true }, { accountId: 'other-member' }, {}]) {
    const { board, socket, state } = await connectedProject(context, options)
    const original = state.document.operations[0]
    if (!options.shared && !options.accountId)
      board.commit({ ...original, id: crypto.randomUUID() })
    const before = socket.sent.length
    board.commit(visibility(original.id))
    assert.equal(socket.sent.length, before)
    assert.deepEqual(
      board.operations.filter(({ id }) => id === original.id),
      [original],
    )
  }
})

test('a protocol mismatch locks the board without discarding pending history or retrying', async (context) => {
  const { board, socket, sockets, timers, state } = await connectedProject(context)
  const hidden = visibility(state.document.operations[0].id)
  board.commit(hidden)
  socket.receive({ v: 1, type: 'presence', members: [] })
  assert.equal(board.status, 'error')
  assert.equal(board.pendingCount, 1)
  assert.equal(timers.size, 0)
  assert.match(board.error, /Phiên bản kết nối/)
  await board.connect(roomId)
  const returned = sockets[1]
  returned.open()
  returned.receive(state)
  assert.deepEqual(returned.sent.at(-1).operation, hidden)
  returned.receive({ type: 'operation.committed', operation: hidden, sequence: 1 })
  assert.equal(board.pendingCount, 0)
  assert.deepEqual(board.operations, [])
})

test('auth precedes room join and only authoritative state marks the board connected', async (context) => {
  const { board, sockets, timers } = setup(context)
  await board.connect(roomId)
  const socket = sockets[0]
  assert.equal(board.status, 'connecting')
  assert.equal(socket.sent.length, 0)
  socket.open()
  assert.deepEqual(socket.sent, [{ v: 2, type: 'auth', token: 'test-session' }])
  socket.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.deepEqual(socket.sent.at(-1), { v: 2, type: 'room.join', roomId })
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
  lateMessage({ data: JSON.stringify({ v: 2, ...roomState() }) })
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

// Hết chỗ khi reconnect không được xóa nét chờ hoặc tự lặp; thử lại chỉ gửi nét sau trạng thái mới.
test('a full project preserves pending work until a successful manual reconnect', async (context) => {
  const { board, socket, state, sockets, timers, network } = await connectedProject(context)
  const operation = newStroke(state)
  board.commit(operation)
  socket.close(1006)
  const retry = [...timers.values()].find(({ delay }) => delay >= 800 && delay < 1000)
  await retry.callback()
  sockets[1].open()
  sockets[1].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  sockets[1].receive({ type: 'error', code: 'ROOM_FULL', message: 'Internal capacity detail' })
  assert.equal(board.status, 'error')
  assert.equal(board.authRequired, false)
  assert.equal(board.room.id, roomId)
  assert.equal(board.pendingCount, 1)
  assert.equal(board.document.operations.length, 1)
  assert.equal(board.operations.at(-1).id, operation.id)
  assert.equal(board.canUndo, false)
  assert.equal(board.commit(newStroke(state)), false)
  assert.equal(timers.size, 0)
  assert.match(board.error, /10 kết nối/)
  assert.match(board.error, /tab vẽ/)
  assert.match(board.error, /Kết nối lại/)
  assert.doesNotMatch(board.error, /Internal/)
  network.dispatchEvent(new Event('offline'))
  network.dispatchEvent(new Event('online'))
  await new Promise(setImmediate)
  assert.equal(sockets.length, 2)
  await board.connect(roomId)
  const returned = sockets[2]
  returned.open()
  returned.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
  assert.equal(returned.sent.filter(({ type }) => type === 'operation.commit').length, 0)
  returned.receive(state)
  const commits = returned.sent.filter(({ type }) => type === 'operation.commit')
  assert.equal(commits.length, 1)
  assert.equal(commits[0].operation.id, operation.id)
  acknowledgeLast(board, returned)
  assert.equal(board.status, 'connected')
  assert.equal(board.pendingCount, 0)
  assert.equal(board.document.operations.filter((item) => item.id === operation.id).length, 1)
})

for (const savedBeforeRetry of [false, true]) {
  // Lỗi ghi giữ cảnh báo qua reconnect; chỉ ACK hoặc trạng thái chứa UUID mới xác nhận nét đã lưu.
  test(`a write error recovers a ${savedBeforeRetry ? 'saved but unacknowledged' : 'not yet saved'} stroke without an early save`, async (context) => {
    const { board, socket, state, sockets, timers } = await connectedProject(context)
    const operation = newStroke(state)
    const second = newStroke(state, 'eraser')
    board.commit(operation)
    board.commit(second)
    socket.receive({
      type: 'error',
      code: 'SERVICE_UNAVAILABLE',
      operationId: operation.id,
      message: 'Service unavailable',
    })
    assert.equal(board.hasSaveError, true)
    assert.equal(board.status, 'reconnecting')
    assert.equal(board.pendingCount, 2)
    assert.equal(board.document.operations.length, 1)
    assert.equal(board.operations.at(-1).id, second.id)
    const retry = [...timers.values()].find(({ delay }) => delay >= 800 && delay < 1000)
    await retry.callback()
    const returned = sockets[1]
    returned.open()
    returned.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
    assert.equal(board.hasSaveError, true)
    assert.equal(returned.sent.filter(({ type }) => type === 'operation.commit').length, 0)
    returned.receive({
      ...state,
      sequence: savedBeforeRetry ? 1 : 0,
      document: {
        ...state.document,
        operations: [...state.document.operations, ...(savedBeforeRetry ? [operation] : [])],
      },
    })
    const commits = returned.sent.filter(({ type }) => type === 'operation.commit')
    assert.deepEqual(
      commits.map((message) => message.operation.id),
      savedBeforeRetry ? [second.id] : [operation.id, second.id],
    )
    assert.equal(board.status, 'connected')
    assert.equal(board.hasSaveError, true)
    assert.equal(board.canUndo, false)
    const sent = returned.sent.length
    assert.equal(board.commit(newStroke(state)), false)
    board.preview(newStroke(state))
    assert.equal(returned.sent.length, sent)
    for (const message of commits) {
      returned.receive({
        type: 'operation.committed',
        sequence: board.sequence + 1,
        operation: message.operation,
      })
      assert.equal(board.hasSaveError, board.pendingCount > 0)
    }
    assert.equal(board.hasSaveError, false)
    assert.equal(board.pendingCount, 0)
    assert.equal(board.document.operations.filter((item) => item.id === operation.id).length, 1)
    assert.equal(board.document.operations.filter((item) => item.id === second.id).length, 1)
    assert.equal(board.canUndo, true)
  })
}

// Đổi trang không làm mất cảnh báo/nét chờ của cùng tài khoản; đổi tài khoản phải xóa cả hai.
test('write failures stay with cached projects and never cross account boundaries', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  const operation = newStroke(state)
  board.commit(operation)
  socket.receive({ type: 'error', code: 'SERVICE_UNAVAILABLE', operationId: operation.id })
  board.leaveRoom()
  board.prepareRoom(otherRoomId)
  assert.equal(board.hasSaveError, false)
  board.prepareRoom(roomId)
  assert.equal(board.hasSaveError, true)
  assert.equal(board.pendingCount, 1)
  assert.equal(board.operations.at(-1).id, operation.id)
  board.setAccount('another-account')
  assert.equal(board.hasSaveError, false)
  assert.equal(board.pendingCount, 0)
  assert.equal(board.document.operations.length, 0)
  assert.equal(board.prepareRoom(roomId), null)
})

// Lỗi đọc trạng thái/preview không được gắn nhầm thành lỗi ghi của nét khác đang chờ.
test('service errors without a matching pending UUID do not mark a drawing write as failed', async (context) => {
  for (const operationId of [undefined, crypto.randomUUID()]) {
    const { board, socket, state } = await connectedProject(context)
    board.commit(newStroke(state))
    socket.receive({ type: 'error', code: 'SERVICE_UNAVAILABLE', operationId })
    assert.equal(board.hasSaveError, false)
    assert.equal(board.pendingCount, 1)
    assert.equal(board.status, 'reconnecting')
  }
})

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
  assert.deepEqual(socket.sent.at(-1), { v: 2, type: 'auth.refresh', token: 'session-2' })
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
  assert.deepEqual(socket.sent.at(-1), { v: 2, type: 'operation.commit', operation })
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

// Server từ chối xác thực phải khóa ngay, kể cả frame đóng socket chưa tới; giữ nét chờ trong RAM.
test('authentication error frames stop drawing immediately without discarding pending work', async (context) => {
  for (const code of ['AUTH_REQUIRED', 'AUTH_EXPIRED']) {
    const { board, socket, state, sockets, timers, network } = await connectedProject(context)
    const operation = newStroke(state)
    board.commit(operation)
    const previousHandler = socket.onmessage
    socket.receive({ type: 'error', code, message: 'Private authentication detail' })
    assert.equal(board.status, 'error')
    assert.equal(board.authRequired, true)
    assert.equal(board.room.id, roomId)
    assert.equal(board.pendingCount, 1)
    assert.equal(board.operations.at(-1).id, operation.id)
    assert.equal(board.commit(newStroke(state)), false)
    assert.equal(board.canUndo, false)
    assert.equal(board.canRedo, false)
    assert.equal(timers.size, 0)
    assert.match(board.error, /Đăng nhập lại/)
    assert.doesNotMatch(board.error, /Private/)
    // Frame trễ không được biến nét chưa lưu thành đã lưu sau khi phiên đã bị khóa.
    previousHandler({
      data: JSON.stringify({ v: 2, type: 'operation.committed', sequence: 1, operation }),
    })
    network.dispatchEvent(new Event('offline'))
    network.dispatchEvent(new Event('online'))
    await new Promise(setImmediate)
    assert.equal(sockets.length, 1)
    assert.equal(board.pendingCount, 1)
  }
})

for (const savedBeforeExpiry of [false, true]) {
  // Nối lại cùng tài khoản phải đối chiếu trạng thái trước retry, dùng UUID cũ khi ACK bị mất.
  test(`expired authentication recovers a ${savedBeforeExpiry ? 'saved but unacknowledged' : 'not yet saved'} stroke exactly once`, async (context) => {
    const { board, socket, state, sockets, timers } = await connectedProject(context)
    const operation = newStroke(state)
    board.commit(operation)
    socket.close(4401)
    assert.equal(board.authRequired, true)
    assert.equal(board.pendingCount, 1)
    assert.equal(board.document.operations.length, 1)
    assert.equal(timers.size, 0)
    await board.connect(roomId)
    const returned = sockets[1]
    returned.open()
    returned.receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
    assert.equal(board.pendingCount, 1)
    assert.equal(returned.sent.filter((message) => message.type === 'operation.commit').length, 0)
    returned.receive({
      ...state,
      sequence: savedBeforeExpiry ? 1 : 0,
      document: {
        ...state.document,
        operations: [...state.document.operations, ...(savedBeforeExpiry ? [operation] : [])],
      },
    })
    const retries = returned.sent.filter((message) => message.type === 'operation.commit')
    assert.equal(retries.length, savedBeforeExpiry ? 0 : 1)
    if (!savedBeforeExpiry) {
      assert.equal(retries[0].operation.id, operation.id)
      acknowledgeLast(board, returned)
    }
    assert.equal(board.status, 'connected')
    assert.equal(board.authRequired, false)
    assert.equal(board.pendingCount, 0)
    assert.equal(board.document.operations.filter((item) => item.id === operation.id).length, 1)
    assert.equal(board.operations.length, 2)
    assert.equal(board.canUndo, true)
  })
}

for (const stage of ['initial', 'refresh']) {
  // Không có token lúc mở hoặc refresh phải dừng timer; SDK báo lỗi mạng vẫn được test retry riêng.
  test(`an absent token during ${stage} authentication stops automatic reconnects`, async (context) => {
    let calls = 0
    const { board, sockets, timers, network } = setup(context, async () => {
      calls++
      if (stage === 'initial' || calls > 1) throw new SignInRequiredError('Missing session')
      return 'test-session'
    })
    await board.connect(roomId)
    if (stage === 'refresh') {
      sockets[0].open()
      sockets[0].receive({ type: 'auth.ok', expiresAt: Date.now() + 60000 })
      sockets[0].receive(roomState())
      const refresh = [...timers.values()].find(({ delay }) => delay > 40000 && delay < 50000)
      await refresh.callback()
    }
    assert.equal(board.status, 'error')
    assert.equal(board.authRequired, true)
    assert.equal(timers.size, 0)
    network.dispatchEvent(new Event('online'))
    await new Promise(setImmediate)
    assert.equal(calls, stage === 'initial' ? 1 : 2)
  })
}

// Giữ dữ liệu khi hết phiên không được làm rò dữ liệu sau khi người dùng đổi tài khoản.
test('switching accounts after authentication expiry clears retained documents and pending work', async (context) => {
  const { board, socket, state } = await connectedProject(context)
  board.commit(newStroke(state))
  socket.close(4401)
  assert.equal(board.pendingCount, 1)
  board.setAccount('another-account')
  assert.equal(board.status, 'idle')
  assert.equal(board.authRequired, false)
  assert.equal(board.pendingCount, 0)
  assert.equal(board.room, null)
  assert.equal(board.document.operations.length, 0)
  assert.equal(board.prepareRoom(roomId), null)
})

// Lỗi mạng khi refresh không được giả thành hết phiên; mã xác thực của server hoặc SDK thiếu token mới dừng retry.
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
    assert.equal(board.hasUnsavedChanges(roomId), true)
    assert.equal(board.hasUnsavedChanges(otherRoomId), false)
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
      data: JSON.stringify({ v: 2, type: 'operation.committed', operation, sequence: 1 }),
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
  assert.deepEqual(board.document, model.normalizeDocument(original.document))
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

// Khi quyền kết thúc, xóa đúng phiên, dừng retry và không phục hồi nội dung khi quay lại.
for (const [code, reason] of [
  [4403, /tắt chia sẻ/],
  [4404, /đã bị xóa/],
]) {
  test(`${code} clears room data and cached sessions without reconnecting`, async (context) => {
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
    sockets[1].close(code)
    assert.equal(board.revokedRoomId, roomId)
    assert.match(board.error, reason)
    assert.equal(board.status, 'error')
    assert.equal(board.room, null)
    assert.equal(board.document.operations.length, 0)
    assert.equal(board.pendingCount, 0)
    assert.equal(timers.size, 0)
    board.leaveRoom()
    assert.equal(board.prepareRoom(roomId), null)
    assert.equal(board.revokedRoomId, '')
  })
}
