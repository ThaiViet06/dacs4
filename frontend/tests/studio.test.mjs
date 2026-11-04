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
    dependencies,
    globals,
  )
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
      state = component.setup(props, ctx)
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
  return { state, unmount }
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

// Chỉ chủ dự án đang chia sẻ mới mở được dialog; dialog đang mở không bị phím tắt Canvas can thiệp.
test('sharing dialog is limited to shared project owners and isolates shortcuts', (context) => {
  for (const [owner, shared, allowed] of [
    [true, true, true],
    [false, true, false],
    [true, false, false],
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
