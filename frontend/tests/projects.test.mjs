import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
import { createSSRApp, h, nextTick, ref } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/stores/projects.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const { descriptor } = parse(
  readFileSync(new URL('../src/components/RoomList.vue', import.meta.url), 'utf8'),
  { filename: 'RoomList.vue' },
)
const listCompiled = ts.transpileModule(
  compileScript(descriptor, { id: 'project-list-test', inlineTemplate: true }).content,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText

class ApiError extends Error {
  // Dùng cùng kiểu lỗi mà store nhận từ API, không cần gọi Clerk hoặc backend.
  constructor(status) {
    super('Test API failure')
    this.status = status
  }
}

// Chạy store thật với yêu cầu giữ chờ để kiểm tra thứ tự phản hồi và thay đổi tài khoản.
function setup(context) {
  const requests = []
  const dependencies = {
    '../services/api': { ApiError },
    '../services/rooms': {
      listRooms: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
  )
  const pinia = createPinia()
  setActivePinia(pinia)
  const projects = module.exports.useProjectsStore()
  context.after(() => projects.setAccount(''))
  projects.setAccount('user-a')
  return { projects, requests, pinia, useProjectsStore: module.exports.useProjectsStore }
}

// Render RoomList với Pinia thật; chỉ giả Clerk/API và component con, lấy ID từ các card được render.
async function renderRoomList({ pinia, useProjectsStore }, userId = 'user-a') {
  const module = { exports: {} }
  const dependencies = {
    '../stores/projects': { useProjectsStore },
    '../stores/board': { useBoardStore: () => ({}) },
    '@clerk/vue': {
      useUser: () => ({ isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: userId }) }),
      SignInButton: { render: () => null },
    },
    'vue-router': {
      useRouter: () => ({ push() {} }),
      RouterLink: {
        props: ['to'],
        // Đánh dấu card thật mà không phải khởi tạo điều hướng trong Node.
        render() {
          return h('a', { 'data-room-id': this.to.params.id }, this.$slots.default?.())
        },
      },
    },
    './CreateRoomForm.vue': {
      __esModule: true,
      default: { render: () => h('button', 'Tạo dự án') },
    },
    './ProjectCardActions.vue': {
      __esModule: true,
      default: {
        props: ['room'],
        // Đánh dấu đúng thẻ có nút quản lý để kiểm tra quyền render của RoomList.
        render() {
          return h('button', { 'data-actions-for': this.room.id }, 'Tùy chọn')
        },
      },
    },
  }
  new Function('require', 'module', 'exports', listCompiled)(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
  )
  const html = await renderToString(createSSRApp(module.exports.default).use(pinia))
  return { html, ids: Array.from(html.matchAll(/data-room-id="([^"]+)"/g), (match) => match[1]) }
}

// Tạo metadata nhỏ để nhận biết dữ liệu của từng tài khoản.
function room(id = 'room-a', ownerId = 'user-a') {
  return { id, title: id, ownerId, sharingEnabled: false, updatedAt: '2026-11-04T00:00:00Z' }
}

test('same-account visits retain cards and filter while a single refresh is pending', async (context) => {
  const { projects, requests, useProjectsStore } = setup(context)
  const first = projects.loadRooms()
  assert.equal(projects.loading, true)
  assert.equal(projects.hasLoaded, false)
  requests[0].resolve({ rooms: [room()] })
  await first
  projects.activeGroup = 'shared'
  projects.setAccount('user-a')
  assert.equal(useProjectsStore(), projects)
  const refresh = projects.loadRooms()
  await projects.loadRooms()
  assert.equal(requests.length, 2)
  assert.equal(projects.hasLoaded, true)
  assert.deepEqual(
    projects.rooms.map((item) => item.id),
    ['room-a'],
  )
  assert.equal(projects.activeGroup, 'shared')
  requests[1].resolve({ rooms: [room('updated-room')] })
  await refresh
  assert.equal(projects.rooms[0].id, 'updated-room')
  assert.equal(projects.loading, false)
})

test('a successfully loaded empty list is also cached', async (context) => {
  const { projects, requests } = setup(context)
  const first = projects.loadRooms()
  requests[0].resolve({ rooms: [] })
  await first
  const refresh = projects.loadRooms()
  assert.equal(projects.hasLoaded, true)
  requests[1].resolve({ rooms: [] })
  await refresh
  assert.deepEqual(projects.rooms, [])
})

test('network or service errors keep cached cards and allow a later retry', async (context) => {
  const { projects, requests } = setup(context)
  const first = projects.loadRooms()
  requests[0].resolve({ rooms: [room()] })
  await first
  const refresh = projects.loadRooms()
  requests[1].reject(new ApiError(503))
  await refresh
  assert.equal(projects.rooms[0].id, 'room-a')
  assert.equal(projects.hasLoaded, true)
  assert.equal(projects.loading, false)
  assert.match(projects.error, /Chưa cập nhật/)
  const retry = projects.loadRooms()
  requests[2].resolve({ rooms: [room('new-data')] })
  await retry
  assert.equal(projects.error, '')
  assert.equal(projects.rooms[0].id, 'new-data')
})

test('authentication rejection removes previously cached private metadata', async (context) => {
  const { projects, requests } = setup(context)
  const first = projects.loadRooms()
  requests[0].resolve({ rooms: [room()] })
  await first
  const refresh = projects.loadRooms()
  requests[1].reject(new ApiError(401))
  await refresh
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.hasLoaded, false)
  assert.match(projects.error, /xác thực/)
})

test('changing accounts clears the cache and ignores the old account response', async (context) => {
  const { projects, requests } = setup(context)
  projects.addCreatedRoom(room())
  projects.activeGroup = 'shared'
  const oldRequest = projects.loadRooms()
  projects.setAccount('user-b')
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.hasLoaded, false)
  assert.equal(projects.activeGroup, 'personal')
  const newRequest = projects.loadRooms()
  requests[0].resolve({ rooms: [room()] })
  await oldRequest
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.loading, true)
  requests[1].resolve({ rooms: [room('room-b', 'user-b')] })
  await newRequest
  assert.equal(projects.rooms[0].ownerId, 'user-b')
})

test('signing out and back into the same account invalidates old failures', async (context) => {
  const { projects, requests } = setup(context)
  const oldRequest = projects.loadRooms()
  projects.setAccount('')
  await projects.loadRooms()
  assert.equal(requests.length, 1)
  projects.setAccount('user-a')
  const newRequest = projects.loadRooms()
  requests[0].reject(new ApiError(401))
  await oldRequest
  assert.equal(projects.loading, true)
  assert.equal(projects.error, '')
  requests[1].resolve({ rooms: [room()] })
  await newRequest
  assert.equal(projects.rooms.length, 1)
})

test('a newly created card survives an older list response without duplicates', async (context) => {
  const { projects, requests } = setup(context)
  const oldRequest = projects.loadRooms()
  projects.addCreatedRoom(room('created-room'))
  projects.addCreatedRoom(room('created-room'))
  projects.addCreatedRoom(room('other-account-room', 'user-b'))
  assert.equal(projects.rooms.length, 1)
  assert.equal(projects.loading, false)
  assert.equal(projects.hasLoaded, true)
  const refresh = projects.loadRooms()
  requests[0].resolve({ rooms: [] })
  await oldRequest
  assert.equal(projects.rooms[0].id, 'created-room')
  assert.equal(projects.loading, true)
  requests[1].resolve({ rooms: [room('created-room'), room('older-room')] })
  await refresh
  assert.equal(projects.rooms.length, 2)
})

// Phản hồi danh sách bắt đầu trước PATCH không được trả card về tên cũ; không đổi bộ lọc/sequence.
test('renamed cards retain current metadata and reject stale lists or another account', async (context) => {
  const { projects, requests } = setup(context)
  projects.addCreatedRoom({ ...room(), sequence: 12 })
  projects.activeGroup = 'shared'
  const oldRequest = projects.loadRooms()
  const renamed = { ...room(), title: 'Renamed', updatedAt: '2026-11-04T03:00:00Z', sequence: 10 }
  projects.updateRenamedRoom(renamed)
  requests[0].resolve({ rooms: [room()] })
  await oldRequest
  assert.equal(projects.loading, false)
  assert.equal(projects.rooms[0].title, 'Renamed')
  assert.equal(projects.rooms[0].sequence, 12)
  assert.equal(projects.rooms[0].updatedAt, renamed.updatedAt)
  assert.equal(projects.activeGroup, 'shared')
  projects.updateRenamedRoom({ ...renamed, ownerId: 'user-b', title: 'Wrong account' })
  assert.equal(projects.rooms[0].title, 'Renamed')
  projects.setAccount('user-b')
  projects.updateRenamedRoom(renamed)
  assert.deepEqual(projects.rooms, [])
  projects.updateRenamedRoom({ ...room('uncached', 'user-b'), title: 'Direct-link project' })
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.hasLoaded, false)
})

// Chuyển chế độ đưa card sang đúng mục, giữ metadata mới hơn và không để GET cũ trả về nhóm trước đó.
test('sharing updates move cards between groups without overwriting newer stroke metadata', async (context) => {
  const { projects, requests } = setup(context)
  projects.addCreatedRoom({ ...room(), sequence: 12 })
  const loading = projects.loadRooms()
  projects.updateSharedRoom({ ...room(), sharingEnabled: true, sequence: 10 })
  requests[0].resolve({ rooms: [room()] })
  await loading
  assert.equal(projects.rooms[0].sharingEnabled, true)
  assert.equal(projects.rooms[0].sequence, 12)
  assert.equal(projects.activeGroup, 'shared')
  projects.updateSharedRoom({ ...room(), ownerId: 'user-b', sharingEnabled: false })
  assert.equal(projects.rooms[0].sharingEnabled, true)
  projects.updateSharedRoom({ ...room(), sharingEnabled: false })
  assert.equal(projects.activeGroup, 'personal')
})

// Card đã thu hồi không xuất hiện lại từ phản hồi cũ; thông báo cũng không lọt sang tài khoản sau.
test('revoked project cards stay removed and notices clear on account changes', async (context) => {
  const { projects, requests } = setup(context)
  projects.addCreatedRoom(room())
  const loading = projects.loadRooms()
  projects.removeRoom('room-a', 'Access revoked')
  requests[0].resolve({ rooms: [room()] })
  await loading
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.notice, 'Access revoked')
  projects.setAccount('user-b')
  assert.equal(projects.notice, '')
})

// Nối thay đổi metadata của store với template thật; phản hồi cũ không được trả card sang nhóm trước đó.
test('rendered owner cards move between personal and shared groups after confirmed mode changes', async (context) => {
  const session = setup(context)
  const { projects, requests } = session
  projects.addCreatedRoom(room())
  const personal = await renderRoomList(session)
  assert.deepEqual(personal.ids, ['room-a'])
  assert.match(personal.html, /data-actions-for="room-a"/)
  projects.updateSharedRoom({ ...room(), sharingEnabled: true })
  const shared = await renderRoomList(session)
  assert.equal(projects.activeGroup, 'shared')
  assert.deepEqual(shared.ids, ['room-a'])
  assert.match(shared.html, /data-actions-for="room-a"/)
  assert.match(shared.html, /Dự án chung/)
  projects.activeGroup = 'personal'
  assert.deepEqual((await renderRoomList(session)).ids, [])
  projects.updateSharedRoom({ ...room(), sharingEnabled: false })
  assert.deepEqual((await renderRoomList(session)).ids, ['room-a'])
  projects.activeGroup = 'shared'
  assert.deepEqual((await renderRoomList(session)).ids, [])
  requests[0].resolve({ rooms: [{ ...room(), sharingEnabled: true }] })
  requests[1].resolve({ rooms: [{ ...room(), sharingEnabled: true }] })
  await nextTick()
  assert.equal(projects.rooms[0].sharingEnabled, false)
  assert.deepEqual((await renderRoomList(session)).ids, [])
})

// Cập nhật danh sách đã thu quyền phải bỏ card Chung; tài khoản sau không nhận card từ phản hồi phiên cũ.
test('rendered member cards disappear after permission refresh and stay isolated across accounts', async (context) => {
  const session = setup(context)
  const { projects, requests } = session
  projects.setAccount('user-b')
  const personal = room('member-personal', 'user-b')
  const shared = { ...room('invited-project'), sharingEnabled: true }
  const initial = projects.loadRooms()
  requests[0].resolve({ rooms: [personal, shared] })
  await initial
  projects.activeGroup = 'shared'
  const member = await renderRoomList(session, 'user-b')
  assert.deepEqual(member.ids, ['invited-project'])
  assert.match(member.html, /Thành viên/)
  assert.match(member.html, /data-actions-for="invited-project"/)
  projects.activeGroup = 'personal'
  assert.deepEqual((await renderRoomList(session, 'user-b')).ids, ['member-personal'])
  projects.activeGroup = 'shared'
  requests[1].resolve({ rooms: [personal] })
  await nextTick()
  assert.deepEqual((await renderRoomList(session, 'user-b')).ids, [])
  projects.setAccount('user-a')
  assert.deepEqual((await renderRoomList(session)).ids, [])
  requests[2].resolve({ rooms: [personal, shared] })
  await nextTick()
  assert.deepEqual(projects.rooms, [])
  assert.equal(projects.activeGroup, 'personal')
})
