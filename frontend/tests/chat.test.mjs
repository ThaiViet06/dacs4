import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, nextTick, reactive } from 'vue'
import ts from 'typescript'
import * as model from '../src/chat/model.ts'

const require = createRequire(import.meta.url)
const roomId = '00000000-0000-4000-8000-000000000001'
const otherRoomId = '00000000-0000-4000-8000-000000000002'
const { descriptor } = parse(
  readFileSync(new URL('../src/components/ProjectChat.vue', import.meta.url), 'utf8'),
)
const compiled = ts.transpileModule(
  compileScript(descriptor, { id: 'project-chat-test' }).content,
  {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  },
).outputText

class ApiError extends Error {
  // Mô phỏng lỗi có cấu trúc từ API, không gọi Clerk hoặc Supabase.
  constructor(status, code = 'SERVICE_UNAVAILABLE') {
    super('Test chat failure')
    this.status = status
    this.code = code
  }
}

// Tạo tin hợp lệ với thứ tự/UUID độc lập; không dùng dữ liệu tài khoản thật.
function message(sequence = 1, values = {}) {
  return {
    id: crypto.randomUUID(),
    roomId,
    authorId: 'member',
    sequence,
    text: `Tin ${sequence}`,
    createdAt: '2026-11-17T03:00:00.000Z',
    ...values,
  }
}

// Chờ cả Promise HTTP giả và watcher Vue hoàn tất trước khi kiểm tra trạng thái.
async function flush() {
  await Promise.resolve()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

// Mount script/lifecycle thật, chỉ thay HTTP bằng Promise giữ chờ để điều khiển các cuộc đua phản hồi.
function setup(context) {
  const requests = []
  const profileRequests = []
  const sends = []
  const dependencies = {
    '../chat/model': model,
    '../services/api': { ApiError },
    '../services/chat': {
      getChatMessages: (id) =>
        new Promise((resolve, reject) => requests.push({ id, resolve, reject })),
      getChatProfiles: (id) =>
        new Promise((resolve, reject) => profileRequests.push({ id, resolve, reject })),
      postChatMessage: (id, input) =>
        new Promise((resolve, reject) => sends.push({ id, input, resolve, reject })),
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
  )
  const props = reactive({ roomId, currentUserId: 'owner', connected: true, incomingMessage: null })
  let state
  const host = createRenderer({
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp() {},
  })
  const app = host.createApp({
    setup(_, ctx) {
      state = module.exports.default.setup(props, ctx)
      return () => null
    },
  })
  app.mount({})
  let mounted = true
  // Dọn watcher đúng một lần, kể cả test chủ động rời editor trước khi HTTP trả về.
  function unmount() {
    if (mounted) {
      app.unmount()
      mounted = false
    }
  }
  context.after(unmount)
  return { state, props, requests, profileRequests, sends, unmount }
}

// Chuẩn bị lịch sử trống đã xác nhận để test tập trung vào việc gửi tin.
async function ready(context) {
  const fixture = setup(context)
  fixture.requests[0].resolve({ messages: [] })
  await flush()
  return fixture
}

test('chat merges HTTP history and live messages without duplicates, keeps order and caps visible history', () => {
  const history = Array.from({ length: 55 }, (_, index) => message(index + 1))
  const merged = model.mergeChatMessages([history[54]], history, roomId)
  assert.equal(merged.length, 50)
  assert.deepEqual(
    merged.map((item) => item.sequence),
    Array.from({ length: 50 }, (_, index) => index + 6),
  )
  assert.throws(() => model.mergeChatMessages([], [message(1, { roomId: otherRoomId })], roomId))
  assert.throws(() => model.mergeChatMessages([], [message(1, { text: 'x'.repeat(1001) })], roomId))
})

test('a live message received during history loading survives the HTTP response', async (context) => {
  const { state, props, requests } = setup(context)
  const first = message(1)
  const second = message(2)
  props.incomingMessage = second
  await flush()
  requests[0].resolve({ messages: [first] })
  await flush()
  assert.deepEqual(
    state.messages.value.map((item) => item.id),
    [first.id, second.id],
  )
  assert.equal(state.loaded.value, true)
})

test('names and avatars enrich chat without blocking messages or leaking a previous project profile', async (context) => {
  const { state, props, requests, profileRequests } = setup(context)
  requests[0].resolve({ messages: [message()] })
  await flush()
  assert.equal(state.loaded.value, true)
  assert.equal(state.entries.value[0].name, 'Thành viên')
  const profile = {
    userId: 'member',
    name: 'Mai Nguyễn',
    avatarUrl: 'https://img.clerk.com/profile',
  }
  profileRequests[0].resolve({ profiles: [profile] })
  await flush()
  assert.equal(state.entries.value[0].name, profile.name)
  assert.equal(state.entries.value[0].avatar, profile.avatarUrl)
  props.incomingMessage = message(2)
  await flush()
  assert.equal(profileRequests.length, 1)
  props.incomingMessage = message(3, { authorId: 'new-member' })
  await flush()
  assert.equal(profileRequests.length, 2)
  props.roomId = otherRoomId
  requests[1].resolve({ messages: [message(1, { roomId: otherRoomId })] })
  profileRequests[1].resolve({ profiles: [profile] })
  await flush()
  assert.equal(state.entries.value[0].name, 'Thành viên')
  assert.equal(state.entries.value[0].avatar, '')
  assert.equal(profileRequests.at(-1).id, otherRoomId)
})

test('sending waits for confirmation and reuses the same UUID after an uncertain response', async (context) => {
  const { state, sends } = await ready(context)
  state.draft.value = 'Tin chưa xác nhận'
  const first = state.sendMessage()
  assert.equal(state.sending.value, true)
  assert.equal(state.messages.value.length, 0)
  await state.sendMessage()
  assert.equal(sends.length, 1)
  sends[0].reject(new ApiError(undefined, 'NETWORK_ERROR'))
  await first
  assert.equal(state.draft.value, 'Tin chưa xác nhận')
  assert.match(state.error.value, /Chưa nhận được xác nhận/)
  const retry = state.sendMessage()
  assert.deepEqual(sends[1].input, sends[0].input)
  sends[1].resolve({ message: message(1, { ...sends[0].input, authorId: 'owner' }) })
  await retry
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.draft.value, '')
  assert.equal(state.unconfirmed.value, null)
})

test('WebSocket acknowledgement wins over a later failed HTTP response', async (context) => {
  const { state, props, sends } = await ready(context)
  state.draft.value = 'Đã tới người nhận'
  const pending = state.sendMessage()
  props.incomingMessage = message(1, { ...sends[0].input, authorId: 'owner' })
  await flush()
  sends[0].reject(new ApiError(503))
  await pending
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.error.value, '')
  assert.equal(state.draft.value, '')
})

test('reconnect restores confirmed history before sending and clears an acknowledged draft without resending', async (context) => {
  const { state, props, requests, sends } = await ready(context)
  state.draft.value = 'Tin trong lúc mất mạng'
  const pending = state.sendMessage()
  const saved = message(1, { ...sends[0].input, authorId: 'owner' })
  props.connected = false
  assert.equal(state.canSend.value, false)
  sends[0].resolve({ message: saved })
  await pending
  assert.equal(state.messages.value.length, 0)
  props.connected = true
  assert.equal(state.canSend.value, false)
  requests[1].resolve({ messages: [saved] })
  await flush()
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.draft.value, '')
  assert.equal(sends.length, 1)
})

test('account or project changes discard old messages, drafts and late HTTP results', async (context) => {
  const { state, props, requests } = setup(context)
  state.draft.value = 'Bản nháp tài khoản cũ'
  props.currentUserId = 'another-user'
  assert.equal(state.draft.value, '')
  requests[0].resolve({ messages: [message()] })
  requests[1].resolve({ messages: [] })
  await flush()
  assert.equal(state.messages.value.length, 0)
  props.roomId = otherRoomId
  props.incomingMessage = message()
  requests[2].resolve({ messages: [message(1, { roomId: otherRoomId })] })
  await flush()
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.messages.value[0].roomId, otherRoomId)
})

test('private mode or revoked access clears chat and prevents further sending', async (context) => {
  const { state, sends } = await ready(context)
  state.receive([message()])
  state.draft.value = 'Tin bị chặn'
  const pending = state.sendMessage()
  sends[0].reject(new ApiError(409, 'SHARING_DISABLED'))
  await pending
  assert.equal(state.messages.value.length, 0)
  assert.equal(state.denied.value, true)
  assert.equal(state.draft.value, '')
  assert.equal(state.canSend.value, false)
  await state.sendMessage()
  assert.equal(sends.length, 1)
})

test('history failures can be retried without creating a message', async (context) => {
  const { state, requests, sends } = setup(context)
  requests[0].reject(new ApiError(503))
  await flush()
  assert.equal(state.loaded.value, false)
  assert.match(state.error.value, /Chưa tải được/)
  const retry = state.loadMessages()
  requests[1].resolve({ messages: [message()] })
  await retry
  assert.equal(state.messages.value.length, 1)
  assert.equal(state.loaded.value, true)
  assert.equal(sends.length, 0)
})

test('Enter sends, Shift+Enter and IME composition keep their normal text input behavior', async (context) => {
  const { state, sends } = await ready(context)
  state.draft.value = 'Xin chào'
  let prevented = 0
  const event = { key: 'Enter', preventDefault: () => prevented++ }
  state.composerKey({ ...event, isComposing: true })
  state.composerKey({ ...event, shiftKey: true })
  assert.equal(prevented, 0)
  assert.equal(sends.length, 0)
  state.composerKey(event)
  assert.equal(prevented, 1)
  assert.equal(sends.length, 1)
  sends[0].resolve({ message: message(1, { ...sends[0].input, authorId: 'owner' }) })
  await flush()
  assert.equal(state.draft.value, '')
})

test('leaving the editor ignores an unfinished history response', async (context) => {
  const { state, requests, unmount } = setup(context)
  unmount()
  requests[0].resolve({ messages: [message()] })
  await flush()
  assert.equal(state.messages.value.length, 0)
})

test('a retried message older than the visible history still clears its pending draft', async (context) => {
  const { state, sends } = await ready(context)
  state.draft.value = 'Tin đã lưu trước khi mất mạng'
  const first = state.sendMessage()
  sends[0].reject(new ApiError(undefined, 'NETWORK_ERROR'))
  await first
  state.receive(Array.from({ length: 50 }, (_, index) => message(index + 2)))
  const retry = state.sendMessage()
  assert.deepEqual(sends[1].input, sends[0].input)
  sends[1].resolve({ message: message(1, { ...sends[0].input, authorId: 'owner' }) })
  await retry
  assert.equal(state.messages.value.length, 50)
  assert.equal(state.messages.value[0].sequence, 2)
  assert.equal(state.draft.value, '')
  assert.equal(state.unconfirmed.value, null)
})

test('a socket acknowledgement unlocks composing and an older HTTP result cannot interrupt the next send', async (context) => {
  const { state, props, sends } = await ready(context)
  state.draft.value = 'Tin đầu'
  const first = state.sendMessage()
  props.incomingMessage = message(1, { ...sends[0].input, authorId: 'owner' })
  await flush()
  assert.equal(state.sending.value, false)
  state.draft.value = 'Tin sau'
  const second = state.sendMessage()
  sends[0].reject(new ApiError(503))
  await first
  assert.equal(state.sending.value, true)
  assert.equal(state.draft.value, 'Tin sau')
  assert.equal(state.error.value, '')
  sends[1].resolve({ message: message(2, { ...sends[1].input, authorId: 'owner' }) })
  await second
  assert.equal(state.messages.value.length, 2)
  assert.equal(state.sending.value, false)
  assert.equal(state.draft.value, '')
})
