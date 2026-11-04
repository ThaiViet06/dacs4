import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { parse, compileScript } from '@vue/compiler-sfc'
import { createRenderer, reactive, ref, nextTick } from 'vue'
import { createMemoryHistory } from 'vue-router'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// Biên dịch script/component thật, chỉ thay các dịch vụ hoặc phần tử DOM cần mô phỏng trong Node.
function loadModule(source, dependencies, globals = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), code)(
    (name) => dependencies[name] ?? (name.endsWith('.vue') ? { default: {} } : require(name)),
    module,
    module.exports,
    ...Object.values(globals),
  )
  return module.exports.default
}

// Mount script để chạy watcher/lifecycle Vue thật mà không cần browser, Clerk hoặc backend.
function mountScript(context, filename, dependencies, props = {}, globals = {}) {
  const file = new URL('../src/' + filename, import.meta.url)
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename })
  const component = loadModule(
    compileScript(descriptor, { id: 'studio-test' }).content,
    {
      '../stores/projects': { useProjectsStore: () => ({}) },
      ...dependencies,
      'vue-router': {
        ...require('vue-router'),
        useRouter: () => ({ replace() {} }),
        ...dependencies['vue-router'],
      },
    },
    globals,
  )
  let state
  const events = []
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
      state = component.setup(props, {
        ...ctx,
        emit: (name, ...args) => events.push({ name, args }),
      })
      return () => null
    },
  })
  app.mount({})
  let mounted = true
  // Dọn lifecycle đúng một lần, kể cả test chủ động unmount trước bước cleanup.
  const unmount = () => {
    if (mounted) {
      app.unmount()
      mounted = false
    }
  }
  context.after(unmount)
  return { state, unmount, events }
}

// Tạo dialog nhỏ để kiểm tra mở/đóng và quyền thao tác của editor.
function dialog() {
  return {
    open: false,
    showModal() {
      this.open = true
    },
    close() {
      this.open = false
    },
  }
}

// Dữ liệu store giả chỉ ghi nhận lời gọi; logic đồng bộ thực tế được kiểm tra ở board-connection.test.mjs.
function setup(context, project = false, isOwner = true, sharingEnabled = true) {
  const calls = { local: 0, undo: 0, redo: 0, connect: [] }
  const board = reactive({
    status: project ? 'connected' : 'idle',
    pendingCount: 0,
    rejected: [],
    error: '',
    document: { operations: [{ id: 'existing-stroke' }] },
    connect(id) {
      calls.connect.push(id)
    },
  })
  const draft = reactive({
    document: { operations: [{ id: 'draft-stroke' }] },
    canUndo: true,
    canRedo: true,
    reset() {
      calls.local++
    },
    undo() {
      calls.undo++
    },
    redo() {
      calls.redo++
    },
  })
  const drawing = reactive({ tool: 'freehand', color: '#123456', brushSize: 4, eraserSize: 24 })
  const room = project ? { id: 'project-a', title: 'Saved project', sharingEnabled } : undefined
  const listeners = new Set()
  const window = {
    addEventListener: (_, handler) => listeners.add(handler),
    removeEventListener: (_, handler) => listeners.delete(handler),
  }
  const mounted = mountScript(
    context,
    'components/StudioEditor.vue',
    {
      '../stores/board': { useBoardStore: () => board },
      '../stores/draft': { useDraftStore: () => draft },
      '../stores/drawing': { useDrawingStore: () => drawing },
    },
    { room, isOwner },
    { window, HTMLElement: class {} },
  )
  mounted.state.resetDialog.value = dialog()
  mounted.state.shareDialog.value = dialog()
  return { ...mounted, board, drawing, calls, listeners }
}

// Project editor không được chạy nhánh reset local hoặc làm mất kết nối/nét đã tải khi vừa mount.
test('project Studio keeps loaded drawing and blocks local reset actions', (context) => {
  const { state, board, calls } = setup(context, true)
  assert.equal(calls.local, 0)
  assert.equal(state.isProject.value, true)
  assert.equal(state.canDraw.value, true)
  state.startOver()
  state.confirmStartOver()
  assert.equal(calls.local, 0)
  assert.equal(board.document.operations.length, 1)
  state.reconnectProject()
  assert.deepEqual(calls.connect, ['project-a'])
})

// Bản nháp vẫn dùng công cụ/phím tắt, lịch sử local và dialog xác nhận trước khi tạo trang mới.
test('local Studio retains shortcuts, undo redo and reset confirmation', async (context) => {
  const { state, drawing, calls } = setup(context)
  const key = (value, ctrlKey = false) => ({
    key: value,
    ctrlKey,
    target: null,
    preventDefault() {},
  })
  state.handleToolShortcut(key('e'))
  assert.equal(drawing.tool, 'eraser')
  assert.equal(state.activeSize.value, 24)
  state.activeSize.value = 35
  assert.equal(drawing.eraserSize, 35)
  assert.equal(drawing.brushSize, 4)
  state.handleToolShortcut(key('z', true))
  state.handleToolShortcut(key('y', true))
  assert.equal(calls.undo, 1)
  assert.equal(calls.redo, 1)
  state.startOver()
  assert.equal(state.resetDialog.value.open, true)
  assert.equal(calls.local, 0)
  state.cancelStartOver()
  assert.equal(calls.local, 0)
  state.confirmStartOver()
  assert.equal(calls.local, 1)
  await nextTick()
})

// Bắt sự kiện qua listener thật của component, gồm hai cách làm lại và tổ hợp Command trên macOS.
test('local keyboard listener handles undo and both redo shortcuts', (context) => {
  const { calls, listeners } = setup(context)
  const [keydown] = listeners
  let prevented = 0
  for (const options of [
    { key: 'z', ctrlKey: true },
    { key: 'y', ctrlKey: true },
    { key: 'Z', ctrlKey: true, shiftKey: true },
    { key: 'z', metaKey: true },
    { key: 'Z', metaKey: true, shiftKey: true },
  ])
    keydown({ ...options, target: null, preventDefault: () => prevented++ })
  assert.equal(calls.undo, 2)
  assert.equal(calls.redo, 3)
  assert.equal(prevented, 5)
  keydown({ key: 'z', ctrlKey: true, repeat: true, preventDefault() {} })
  keydown({ key: 'z', ctrlKey: true, isComposing: true, preventDefault() {} })
  assert.equal(calls.undo, 2)
})

// Dự án tự lưu chưa có sự kiện undo: báo giới hạn thay vì sửa nét local rồi sai dữ liệu khi F5.
test('saved projects explain unsupported history shortcuts without changing strokes', async (context) => {
  const { state, board, calls } = setup(context, true)
  state.handleToolShortcut({ key: 'z', ctrlKey: true, target: null, preventDefault() {} })
  await nextTick()
  assert.match(state.actionFeedback.value, /chỉ hỗ trợ bản vẽ thử/)
  assert.equal(board.document.operations.length, 1)
  assert.equal(calls.undo, 0)
  assert.equal(calls.redo, 0)
})

// Canvas/công cụ phải khóa khi mất kết nối và không báo đã lưu khi còn nét chờ hoặc bị từ chối.
test('project Studio locks offline tools and distinguishes pending and rejected strokes', (context) => {
  const { state, board, drawing } = setup(context, true)
  board.pendingCount = 2
  assert.match(state.saveStatus.value, /2/)
  board.status = 'reconnecting'
  assert.equal(state.canDraw.value, false)
  state.handleToolShortcut({ key: 'e', target: null, preventDefault() {} })
  assert.equal(drawing.tool, 'freehand')
  board.pendingCount = 0
  board.rejected.push({ id: 'rejected-stroke' })
  assert.match(state.saveStatus.value, /chưa được lưu/)
  board.rejected = []
  board.status = 'connected'
  assert.equal(state.canDraw.value, true)
  assert.match(state.saveStatus.value, /Đã lưu/)
})

// Chủ mở hộp ở cả hai chế độ; thành viên không được mở và phím tắt Canvas không can thiệp vào dialog.
test('sharing dialog is limited to project owners and isolates shortcuts', (context) => {
  for (const [owner, shared, allowed] of [
    [true, true, true],
    [false, true, false],
    [true, false, true],
  ]) {
    const { state, drawing } = setup(context, true, owner, shared)
    state.openSharing()
    assert.equal(state.shareDialog.value.open, allowed)
    if (allowed) {
      state.handleToolShortcut({ key: 'e', target: null, preventDefault() {} })
      assert.equal(drawing.tool, 'freehand')
      state.closeSharing()
      assert.equal(state.shareDialog.value.open, false)
    }
  }
})

// Rời editor dọn sự kiện/dialog, còn kết nối dự án do ProjectView quản lý nên không bị reset lần thứ hai.
test('unmounting the editor removes shortcuts and closes its dialogs', (context) => {
  const { state, calls, listeners, unmount } = setup(context, true)
  assert.equal(listeners.size, 1)
  state.openSharing()
  const share = state.shareDialog.value
  unmount()
  assert.equal(listeners.size, 0)
  assert.equal(share.open, false)
  assert.equal(calls.local, 0)
})

// Link cũ chỉ chuyển hướng; danh sách, bản nháp và dự án có component riêng, không nhận nhầm try là ID.
test('Studio separates projects and drafts and redirects old links preserving query and hash', async () => {
  const source = readFileSync(new URL('../src/router/index.ts', import.meta.url), 'utf8').replace(
    'import.meta.env.BASE_URL',
    "'/'",
  )
  const router = loadModule(source, {
    'vue-router': { ...require('vue-router'), createWebHistory: createMemoryHistory },
  })
  await router.push('/studio')
  const dashboard = router.currentRoute.value.matched.at(-1).components.default
  await router.push('/rooms/project-a?from=invite#canvas')
  assert.equal(router.currentRoute.value.name, 'studio-project')
  assert.equal(router.currentRoute.value.fullPath, '/studio/project-a?from=invite#canvas')
  await router.push('/studio/try')
  assert.equal(router.currentRoute.value.name, 'studio-try')
  assert.notEqual(router.currentRoute.value.matched.at(-1).components.default, dashboard)
  await router.push('/gallery?from=old#projects')
  assert.equal(router.currentRoute.value.name, 'studio')
  assert.equal(router.currentRoute.value.fullPath, '/studio?from=old#projects')
  assert.equal(router.currentRoute.value.matched.at(-1).components.default, dashboard)
})

// Loader vẫn phải bỏ metadata trễ khi đăng xuất/đổi ID trước khi editor mới được phép xuất hiện.
test('project loader ignores stale metadata and disconnects on sign out', async (context) => {
  const session = { isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: 'owner' }) }
  const route = reactive({ params: { id: 'project-a' } })
  const requests = []
  const connects = []
  let cleanups = 0
  const { state } = mountScript(context, 'views/ProjectView.vue', {
    '@clerk/vue': { useUser: () => session },
    'vue-router': { useRoute: () => route },
    '../services/clerk': { clerkPublishableKey: 'configured' },
    '../services/api': { ApiError: class extends Error {} },
    '../services/rooms': {
      getRoom: (id) => new Promise((resolve) => requests.push({ id, resolve })),
    },
    '../stores/board': {
      useBoardStore: () => ({
        setAccount() {
          cleanups++
        },
        prepareRoom: () => null,
        leaveRoom() {},
        connect: (id) => connects.push(id),
      }),
    },
  })
  route.params.id = 'project-b'
  requests[0].resolve({ room: { id: 'project-a' } })
  await nextTick()
  assert.equal(state.room.value, null)
  assert.equal(connects.length, 0)
  requests[1].resolve({ room: { id: 'project-b' } })
  await nextTick()
  assert.deepEqual(connects, ['project-b'])
  session.isSignedIn.value = false
  assert.equal(state.room.value, null)
  assert.ok(cleanups >= 3)
})

test('project loader exposes cached metadata while waiting but does not connect early', async (context) => {
  const cached = { id: 'project-a', title: 'Cached title' }
  let resolveMetadata
  const connects = []
  const board = {
    setAccount() {},
    prepareRoom: () => cached,
    leaveRoom() {},
    connect: (id) => connects.push(id),
  }
  const { state } = mountScript(context, 'views/ProjectView.vue', {
    '@clerk/vue': {
      useUser: () => ({ isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: 'owner' }) }),
    },
    'vue-router': { useRoute: () => ({ params: { id: cached.id } }) },
    '../services/clerk': { clerkPublishableKey: 'configured' },
    '../services/api': { ApiError: class extends Error {} },
    '../services/rooms': {
      getRoom: () =>
        new Promise((resolve) => {
          resolveMetadata = resolve
        }),
    },
    '../stores/board': { useBoardStore: () => board },
  })
  assert.deepEqual(state.room.value, cached)
  assert.equal(state.loading.value, true)
  assert.deepEqual(connects, [])
  resolveMetadata({ room: { ...cached, title: 'Current title' } })
  await nextTick()
  assert.equal(state.room.value.title, 'Current title')
  assert.equal(board.room.title, 'Current title')
  assert.deepEqual(connects, [cached.id])
})

test('project metadata failures discard forbidden caches and preserve service-error sessions', async (context) => {
  for (const status of [401, 403, 404, 503]) {
    class ApiError extends Error {
      constructor() {
        super('Metadata rejected')
        this.status = status
      }
    }
    const cached = { id: 'project-a', title: 'Cached title' }
    const forgotten = []
    let resets = 0
    const { state } = mountScript(context, 'views/ProjectView.vue', {
      '@clerk/vue': {
        useUser: () => ({ isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: 'owner' }) }),
      },
      'vue-router': { useRoute: () => ({ params: { id: cached.id } }) },
      '../services/clerk': { clerkPublishableKey: 'configured' },
      '../services/api': { ApiError },
      '../services/rooms': {
        getRoom: async () => {
          throw new ApiError()
        },
      },
      '../stores/board': {
        useBoardStore: () => ({
          setAccount() {},
          prepareRoom: () => cached,
          leaveRoom() {},
          forgetRoom: (id) => forgotten.push(id),
          reset: () => resets++,
          connect() {
            assert.fail('Rejected metadata cannot start a connection')
          },
        }),
      },
    })
    await nextTick()
    assert.notEqual(state.error.value, '')
    assert.equal(resets, status === 401 ? 1 : 0)
    assert.deepEqual(forgotten, [403, 404].includes(status) ? [cached.id] : [])
    assert.equal(state.room.value?.id ?? null, status === 503 ? cached.id : null)
  }
})

// Dùng biểu mẫu thật với API giữ chờ để kiểm tra xác nhận, gửi trùng và phản hồi sau khi rời trang.
function setupRename(context) {
  class ApiError extends Error {
    // Mô phỏng mã lỗi công khai, không đưa thông báo nội bộ của dịch vụ vào giao diện.
    constructor(status, code = 'SERVICE_UNAVAILABLE') {
      super('Internal fixture detail')
      this.status = status
      this.code = code
    }
  }
  const props = reactive({
    room: { id: 'project-a', title: 'Original', ownerId: 'owner' },
    disabled: false,
  })
  const requests = []
  const mounted = mountScript(
    context,
    'components/RenameProjectForm.vue',
    {
      '../services/api': { ApiError },
      '../services/rooms': {
        renameRoom: (id, title) =>
          new Promise((resolve, reject) => requests.push({ id, title, resolve, reject })),
      },
    },
    props,
  )
  mounted.state.renameDialog.value = dialog()
  return { ...mounted, props, requests, ApiError }
}

test('rename validates trimmed title and skips unchanged or disconnected submissions', async (context) => {
  const { state, props, requests } = setupRename(context)
  state.openDialog()
  assert.equal(state.title.value, 'Original')
  for (const title of ['   ', 'x'.repeat(101)]) {
    state.title.value = title
    await state.submitRename()
    assert.notEqual(state.titleError.value, '')
  }
  state.title.value = '  Original  '
  await state.submitRename()
  assert.equal(state.renameDialog.value.open, false)
  props.disabled = true
  state.openDialog()
  state.title.value = 'Changed while offline'
  await state.submitRename()
  assert.equal(state.renameDialog.value.open, false)
  assert.equal(requests.length, 0)
})

test('rename waits for acknowledgement and prevents duplicate requests or closing while saving', async (context) => {
  const { state, props, requests, events } = setupRename(context)
  state.openDialog()
  state.title.value = '  New project title  '
  const pending = state.submitRename()
  await state.submitRename()
  state.closeDialog()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].id, 'project-a')
  assert.equal(requests[0].title, 'New project title')
  assert.equal(state.saving.value, true)
  assert.equal(state.renameDialog.value.open, true)
  assert.equal(props.room.title, 'Original')
  assert.equal(events.length, 0)
  const saved = { ...props.room, title: 'New project title' }
  requests[0].resolve({ room: saved })
  await pending
  assert.deepEqual(events, [{ name: 'renamed', args: [saved] }])
  assert.equal(state.renameDialog.value.open, false)
  assert.equal(state.saving.value, false)
})

test('rename errors keep the input and original title and allow retry without false success', async (context) => {
  for (const [status, code] of [[401], [403], [404], [400, 'INVALID_INPUT'], [503]]) {
    const { state, props, requests, events, ApiError } = setupRename(context)
    state.openDialog()
    state.title.value = 'New title'
    const failed = state.submitRename()
    requests[0].reject(new ApiError(status, code))
    await failed
    assert.equal(state.saving.value, false)
    assert.equal(state.renameDialog.value.open, true)
    assert.equal(state.title.value, 'New title')
    assert.equal(props.room.title, 'Original')
    assert.equal(events.length, 0)
    assert.notEqual(state.requestError.value, '')
    assert.doesNotMatch(state.requestError.value, /Internal fixture/)
    const retry = state.submitRename()
    requests[1].resolve({ room: { ...props.room, title: 'New title' } })
    await retry
    assert.equal(events.length, 1)
  }
})

test('rename discards late results after leaving or switching projects', async (context) => {
  for (const change of ['unmount', 'project']) {
    const { state, props, requests, events, unmount } = setupRename(context)
    state.openDialog()
    state.title.value = 'Late title'
    const pending = state.submitRename()
    if (change === 'unmount') unmount()
    else {
      props.room = { ...props.room, id: 'project-b', title: 'Other project' }
      await nextTick()
    }
    requests[0].resolve({ room: { id: 'project-a', title: 'Late title' } })
    await pending
    assert.equal(events.length, 0)
    assert.equal(state.renameDialog.value.open, false)
  }
})

test('confirmed rename updates editor and card without overwriting newer stroke metadata', async (context) => {
  const session = { isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: 'owner' }) }
  const current = {
    id: 'project-a',
    ownerId: 'owner',
    title: 'Original',
    sequence: 12,
    sharingEnabled: true,
  }
  const board = {
    room: current,
    setAccount() {},
    prepareRoom: () => current,
    leaveRoom() {},
    connect() {},
  }
  const updates = []
  const { state } = mountScript(context, 'views/ProjectView.vue', {
    '@clerk/vue': { useUser: () => session },
    'vue-router': { useRoute: () => ({ params: { id: current.id } }) },
    '../services/clerk': { clerkPublishableKey: 'configured' },
    '../services/api': { ApiError: class extends Error {} },
    '../services/rooms': { getRoom: async () => ({ room: current }) },
    '../stores/board': { useBoardStore: () => board },
    '../stores/projects': {
      useProjectsStore: () => ({ updateRenamedRoom: (room) => updates.push(room) }),
    },
  })
  await nextTick()
  const saved = {
    ...current,
    title: 'New title',
    sequence: 10,
    sharingEnabled: false,
    updatedAt: '2026-11-04T03:00:00Z',
  }
  state.roomRenamed(saved)
  assert.equal(state.room.value.title, saved.title)
  assert.equal(board.room.title, saved.title)
  assert.equal(board.room.sequence, 12)
  assert.equal(board.room.sharingEnabled, true)
  assert.equal(updates.length, 1)
  state.roomRenamed({ ...saved, id: 'another-project' })
  state.roomRenamed({ ...saved, ownerId: 'another-owner' })
  assert.equal(updates.length, 1)
  session.isSignedIn.value = false
  state.roomRenamed(saved)
  assert.equal(updates.length, 1)
})

// Biểu mẫu thật với API giữ chờ; mọi token đều là fixture, không cần Clerk hoặc Supabase.
function setupSharing(context, shared = false) {
  class ApiError extends Error {
    // Chỉ mô phỏng mã lỗi công khai để kiểm tra lời hướng dẫn trên giao diện.
    constructor(status = 503, code = 'SERVICE_UNAVAILABLE') {
      super('Private fixture error')
      this.status = status
      this.code = code
    }
  }
  const props = reactive({
    room: { id: 'project-a', title: 'Project', ownerId: 'owner', sharingEnabled: shared },
    disabled: false,
  })
  const board = reactive({
    room: props.room,
    invitationUrl: '',
    rememberInvitation(id, url) {
      if (id === this.room.id) this.invitationUrl = url
    },
  })
  const reads = []
  const writes = []
  const upgrades = []
  const copied = []
  const mounted = mountScript(
    context,
    'components/RoomInvitation.vue',
    {
      'vue-router': {
        useRouter: () => ({ resolve: ({ params }) => ({ href: '/invite/' + params.token }) }),
      },
      '../stores/board': { useBoardStore: () => board },
      '../services/api': { ApiError },
      '../services/rooms': {
        getRoomSharing: (id) =>
          new Promise((resolve, reject) => reads.push({ id, resolve, reject })),
        setRoomSharing: (id, enabled) =>
          new Promise((resolve, reject) => writes.push({ id, enabled, resolve, reject })),
        upgradeRoomInvitation: (id) =>
          new Promise((resolve, reject) => upgrades.push({ id, resolve, reject })),
      },
    },
    props,
    {
      window: { location: { origin: 'http://localhost:5173' } },
      navigator: { clipboard: { writeText: async (value) => copied.push(value) } },
    },
  )
  return { ...mounted, props, board, reads, writes, upgrades, copied, ApiError }
}

test('sharing reads without rotating links and restores an existing HMAC invitation', async (context) => {
  const { state, reads, upgrades, board, copied } = setupSharing(context, true)
  assert.equal(state.loading.value, true)
  reads[0].resolve({ enabled: true, inviteToken: 'T'.repeat(43) })
  await nextTick()
  assert.equal(state.loaded.value, true)
  state.requestLinkUpgrade()
  await state.upgradeLink()
  assert.equal(state.confirmLinkUpgrade.value, false)
  assert.equal(upgrades.length, 0)
  assert.equal(board.invitationUrl, 'http://localhost:5173/invite/' + 'T'.repeat(43))
  await state.copyLink()
  assert.deepEqual(copied, [board.invitationUrl])
})

test('sharing waits for saved strokes and server acknowledgement and prevents duplicate writes', async (context) => {
  const { state, props, reads, writes, events, board } = setupSharing(context)
  state.chooseMode(true)
  assert.equal(writes.length, 0)
  reads[0].resolve({ enabled: false })
  await nextTick()
  props.disabled = true
  state.chooseMode(true)
  assert.equal(writes.length, 0)
  props.disabled = false
  const saving = state.updateSharing(true)
  await state.updateSharing(true)
  assert.equal(writes.length, 1)
  assert.equal(state.enabled.value, false)
  assert.equal(state.busy.value, true)
  assert.equal(events.filter(({ name }) => name === 'changed').length, 0)
  const saved = { ...props.room, sharingEnabled: true }
  writes[0].resolve({ enabled: true, room: saved, inviteToken: 'T'.repeat(43) })
  await saving
  assert.equal(state.enabled.value, true)
  assert.ok(board.invitationUrl)
  assert.deepEqual(events.find(({ name }) => name === 'changed').args, [saved])
  assert.equal(state.busy.value, false)
})

test('switching to private asks for confirmation and removes the link only after success', async (context) => {
  const { state, props, board, reads, writes } = setupSharing(context, true)
  reads[0].resolve({ enabled: true, inviteToken: 'T'.repeat(43) })
  await nextTick()
  state.chooseMode(false)
  assert.equal(state.confirmPrivate.value, true)
  assert.equal(writes.length, 0)
  state.confirmPrivate.value = false
  assert.ok(board.invitationUrl)
  state.chooseMode(false)
  const saving = state.updateSharing(false)
  assert.ok(board.invitationUrl)
  writes[0].resolve({ enabled: false, room: { ...props.room, sharingEnabled: false } })
  await saving
  assert.equal(state.confirmPrivate.value, false)
  assert.equal(state.enabled.value, false)
  assert.equal(board.invitationUrl, '')
})

test('sharing errors preserve the confirmed mode and offer retry without false success', async (context) => {
  const { state, reads, writes, props, events, ApiError } = setupSharing(context)
  reads[0].reject(new ApiError())
  await nextTick()
  assert.equal(state.loaded.value, false)
  assert.notEqual(state.error.value, '')
  const retry = state.loadSharing()
  reads[1].resolve({ enabled: false })
  await retry
  for (const [status, code] of [
    [503, 'SERVICE_UNAVAILABLE'],
    [503, 'SHARING_UNAVAILABLE'],
    [401, 'AUTH_EXPIRED'],
    [403, 'OWNER_REQUIRED'],
  ]) {
    const pending = state.updateSharing(true)
    writes.at(-1).reject(new ApiError(status, code))
    await pending
    assert.equal(state.enabled.value, false)
    assert.equal(props.room.sharingEnabled, false)
    assert.equal(state.busy.value, false)
    assert.notEqual(state.error.value, '')
    assert.doesNotMatch(state.error.value, /Private fixture/)
  }
  assert.equal(events.filter(({ name }) => name === 'changed').length, 0)
})

test('legacy sharing requires confirmation and keeps the current link until upgrade acknowledgement', async (context) => {
  const { state, reads, upgrades, board, props } = setupSharing(context, true)
  board.invitationUrl = 'http://localhost:5173/invite/' + 'L'.repeat(43)
  const oldLink = board.invitationUrl
  reads[0].resolve({ enabled: true })
  await nextTick()
  await state.upgradeLink()
  assert.equal(upgrades.length, 0)
  props.disabled = true
  state.requestLinkUpgrade()
  assert.equal(state.confirmLinkUpgrade.value, false)
  props.disabled = false
  state.requestLinkUpgrade()
  assert.equal(state.confirmLinkUpgrade.value, true)
  state.confirmLinkUpgrade.value = false
  assert.equal(board.invitationUrl, oldLink)
  assert.equal(upgrades.length, 0)
  state.requestLinkUpgrade()
  const requested = state.upgradeLink()
  await state.upgradeLink()
  assert.equal(upgrades.length, 1)
  assert.equal(state.busy.value, true)
  assert.equal(board.invitationUrl, oldLink)
  upgrades[0].resolve({ enabled: true, room: props.room, inviteToken: 'T'.repeat(43) })
  await requested
  assert.equal(state.legacyLink.value, false)
  assert.equal(state.confirmLinkUpgrade.value, false)
  assert.ok(board.invitationUrl.endsWith('T'.repeat(43)))
})

test('failed link upgrades retain the old URL and allow a confirmed retry', async (context) => {
  const { state, reads, upgrades, board, props, ApiError } = setupSharing(context, true)
  board.invitationUrl = 'http://localhost:5173/invite/' + 'L'.repeat(43)
  const oldLink = board.invitationUrl
  reads[0].resolve({ enabled: true })
  await nextTick()
  state.requestLinkUpgrade()
  const failed = state.upgradeLink()
  upgrades[0].reject(new ApiError())
  await failed
  assert.equal(state.busy.value, false)
  assert.equal(state.legacyLink.value, true)
  assert.equal(state.confirmLinkUpgrade.value, true)
  assert.equal(board.invitationUrl, oldLink)
  assert.notEqual(state.error.value, '')
  const retry = state.upgradeLink()
  upgrades[1].resolve({ enabled: true, room: props.room, inviteToken: 'T'.repeat(43) })
  await retry
  assert.ok(board.invitationUrl.endsWith('T'.repeat(43)))
})

test('late sharing responses after navigation cannot change the new project or its link', async (context) => {
  for (const step of ['read', 'write', 'upgrade']) {
    const { state, reads, writes, upgrades, board, events, unmount, props } = setupSharing(
      context,
      step === 'upgrade',
    )
    let pending
    if (step === 'write') {
      reads[0].resolve({ enabled: false })
      await nextTick()
      pending = state.updateSharing(true)
    }
    if (step === 'upgrade') {
      reads[0].resolve({ enabled: true })
      await nextTick()
      state.requestLinkUpgrade()
      pending = state.upgradeLink()
    }
    unmount()
    if (step === 'read') reads[0].resolve({ enabled: true, inviteToken: 'T'.repeat(43) })
    else
      (step === 'write' ? writes : upgrades)[0].resolve({
        enabled: true,
        room: { ...props.room, sharingEnabled: true },
        inviteToken: 'T'.repeat(43),
      })
    await pending
    await nextTick()
    assert.equal(board.invitationUrl, '')
    assert.equal(events.filter(({ name }) => name === 'changed').length, 0)
  }
})

test('sharing dialog blocks closing during writes and blocks mode changes with unsaved strokes', (context) => {
  const { state, board, unmount } = setup(context, true, true, false)
  state.openSharing()
  assert.equal(state.shareDialog.value.open, true)
  board.pendingCount = 1
  assert.equal(state.sharingBlocked.value, true)
  board.pendingCount = 0
  board.rejected.push({ id: 'rejected' })
  assert.equal(state.sharingBlocked.value, true)
  state.sharingBusy.value = true
  state.closeSharing()
  assert.equal(state.shareDialog.value.open, true)
  unmount()
  assert.equal(state.shareDialog.value.open, false)
})

test('sharing metadata and revocation update cards, preserve strokes and redirect to Studio', async (context) => {
  const current = {
    id: 'project-a',
    ownerId: 'owner',
    title: 'Current title',
    sequence: 12,
    sharingEnabled: true,
  }
  const board = reactive({
    room: current,
    revokedRoomId: '',
    setAccount() {},
    prepareRoom: () => current,
    leaveRoom() {},
    connect() {},
    rememberInvitation() {},
  })
  const updates = []
  const removals = []
  const redirects = []
  const { state } = mountScript(context, 'views/ProjectView.vue', {
    '@clerk/vue': {
      useUser: () => ({ isLoaded: ref(true), isSignedIn: ref(true), user: ref({ id: 'owner' }) }),
    },
    'vue-router': {
      useRoute: () => ({ params: { id: current.id } }),
      useRouter: () => ({ replace: (value) => redirects.push(value) }),
    },
    '../services/clerk': { clerkPublishableKey: 'configured' },
    '../services/api': { ApiError: class extends Error {} },
    '../services/rooms': { getRoom: async () => ({ room: current }) },
    '../stores/board': { useBoardStore: () => board },
    '../stores/projects': {
      useProjectsStore: () => ({
        updateSharedRoom: (room) => updates.push(room),
        removeRoom: (...args) => removals.push(args),
      }),
    },
  })
  await nextTick()
  state.sharingChanged({ ...current, title: 'Stale title', sequence: 10, sharingEnabled: false })
  assert.equal(state.room.value.sharingEnabled, false)
  assert.equal(board.room.sharingEnabled, false)
  assert.equal(board.room.sequence, 12)
  assert.equal(board.room.title, 'Current title')
  state.sharingChanged({ ...current, ownerId: 'another-user' })
  assert.equal(updates.length, 1)
  board.revokedRoomId = 'another-project'
  assert.equal(redirects.length, 0)
  board.revokedRoomId = current.id
  assert.equal(state.room.value, null)
  assert.equal(removals[0][0], current.id)
  assert.match(removals[0][1], /tắt chia sẻ/)
  assert.deepEqual(redirects, [{ name: 'studio' }])
})
