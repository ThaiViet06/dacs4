import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/stores/projects.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

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
  setActivePinia(createPinia())
  const projects = module.exports.useProjectsStore()
  context.after(() => projects.setAccount(''))
  projects.setAccount('user-a')
  return { projects, requests, useProjectsStore: module.exports.useProjectsStore }
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
