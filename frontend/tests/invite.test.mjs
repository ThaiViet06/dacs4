import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { compileScript, parse } from '@vue/compiler-sfc'
import { createRenderer, nextTick, reactive, ref } from 'vue'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const filename = 'InviteView.vue'
const { descriptor } = parse(
  readFileSync(new URL('../src/views/InviteView.vue', import.meta.url), 'utf8'),
  { filename },
)
const compiled = ts.transpileModule(compileScript(descriptor, { id: 'invite-test' }).content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

class ApiError extends Error {
  // Giả lập lỗi API công khai; chi tiết dịch vụ không được đưa thẳng vào giao diện.
  constructor(status) {
    super('Private fixture detail')
    this.status = status
  }
}

// Chạy watcher/lifecycle Vue thật với Clerk, route và request giả; không dùng token tài khoản hoặc database thật.
function setup(
  context,
  {
    loaded = true,
    signed = true,
    userId = 'member',
    token = 'A'.repeat(43),
    configured = true,
  } = {},
) {
  const session = {
    isLoaded: ref(loaded),
    isSignedIn: ref(signed),
    user: ref(userId ? { id: userId } : null),
  }
  const route = reactive({ params: { token } })
  const requests = []
  const redirects = []
  let hookCalls = 0
  const dependencies = {
    '@clerk/vue': {
      useUser: () => {
        hookCalls++
        return session
      },
      SignInButton: {},
    },
    'vue-router': {
      useRoute: () => route,
      useRouter: () => ({ replace: async (target) => redirects.push(target) }),
      RouterLink: {},
    },
    '../services/clerk': { clerkPublishableKey: configured ? 'fixture-publishable' : '' },
    '../services/api': { ApiError },
    '../services/rooms': {
      joinRoom: (value) =>
        new Promise((resolve, reject) => requests.push({ token: value, resolve, reject })),
    },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    (name) => dependencies[name] ?? require(name),
    module,
    module.exports,
  )
  const component = module.exports.default
  let state
  const renderer = createRenderer({
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
  const app = renderer.createApp({
    setup(_, ctx) {
      state = component.setup({}, ctx)
      return () => null
    },
  })
  app.mount({})
  let mounted = true
  // Dọn watcher và vô hiệu hóa phản hồi cũ, kể cả test đã chủ động rời trang trước khi cleanup.
  const unmount = () => {
    if (mounted) {
      app.unmount()
      mounted = false
    }
  }
  context.after(unmount)
  return { state, session, route, requests, redirects, unmount, hookCalls }
}

test('a signed-in visitor joins automatically once and replaces the invite route after acknowledgement', async (context) => {
  const { state, session, requests, redirects } = setup(context)
  assert.equal(requests.length, 1)
  assert.equal(state.joining.value, true)
  assert.deepEqual(redirects, [])
  await state.acceptInvitation()
  session.user.value = { id: 'member', fullName: 'Updated profile' }
  await nextTick()
  assert.equal(requests.length, 1)
  requests[0].resolve({ room: { id: 'confirmed-project' } })
  await nextTick()
  assert.deepEqual(redirects, [{ name: 'studio-project', params: { id: 'confirmed-project' } }])
})

test('automatic invitation joining waits for Clerk readiness and a complete signed-in identity', async (context) => {
  const { session, requests } = setup(context, { loaded: false, signed: false, userId: null })
  assert.equal(requests.length, 0)
  session.isSignedIn.value = true
  session.user.value = { id: 'member' }
  assert.equal(requests.length, 0)
  session.isLoaded.value = true
  assert.equal(requests.length, 1)
  await nextTick()
  assert.equal(requests.length, 1)
})

test('unsigned visitors, missing auth configuration and malformed links never call the join API', (context) => {
  for (const options of [
    { signed: false, userId: null },
    { userId: null },
    { configured: false },
    { token: 'short' },
    { token: '/'.repeat(43) },
    { token: ['A'.repeat(43)] },
  ]) {
    const { requests, redirects, hookCalls } = setup(context, options)
    assert.equal(requests.length, 0)
    assert.deepEqual(redirects, [])
    if (options.configured === false) assert.equal(hookCalls, 0)
  }
})

test('changing accounts ignores an old join response and opens only the current account result', async (context) => {
  const { session, requests, redirects } = setup(context)
  session.user.value = { id: 'second-member' }
  assert.equal(requests.length, 2)
  requests[0].resolve({ room: { id: 'old-account-project' } })
  await nextTick()
  assert.deepEqual(redirects, [])
  requests[1].resolve({ room: { id: 'current-account-project' } })
  await nextTick()
  assert.deepEqual(redirects, [
    { name: 'studio-project', params: { id: 'current-account-project' } },
  ])
})

test('switching invitation links discards old failures and only accepts the latest link', async (context) => {
  const { state, route, requests, redirects } = setup(context)
  route.params.token = 'B'.repeat(43)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].token, 'B'.repeat(43))
  requests[0].reject(new ApiError(404))
  await nextTick()
  assert.equal(state.error.value, '')
  assert.equal(state.joining.value, true)
  requests[1].resolve({ room: { id: 'latest-project' } })
  await nextTick()
  assert.deepEqual(redirects, [{ name: 'studio-project', params: { id: 'latest-project' } }])
})

test('signing out, leaving or changing to a malformed invite prevents late navigation', async (context) => {
  for (const action of ['signout', 'unmount', 'invalid-link']) {
    const { session, route, requests, redirects, unmount } = setup(context)
    if (action === 'signout') session.isSignedIn.value = false
    else if (action === 'unmount') unmount()
    else route.params.token = 'invalid'
    requests[0].resolve({ room: { id: 'late-project' } })
    await nextTick()
    assert.equal(requests.length, 1)
    assert.deepEqual(redirects, [])
  }
})

test('invalid, expired and service failures show safe errors without an automatic retry loop', async (context) => {
  for (const status of [400, 404, 401, 429, 503, null]) {
    const { state, requests, redirects, session } = setup(context)
    requests[0].reject(status ? new ApiError(status) : new Error('Private authentication detail'))
    await nextTick()
    assert.equal(state.joining.value, false)
    assert.notEqual(state.error.value, '')
    assert.doesNotMatch(state.error.value, /Private/)
    assert.deepEqual(redirects, [])
    session.user.value = { id: 'member', fullName: 'Same account' }
    await nextTick()
    assert.equal(requests.length, 1)
    if ([400, 404].includes(status)) assert.match(state.error.value, /xin link mới/)
  }
})

test('manual retry after a transient join failure remains idempotent and blocks duplicate clicks', async (context) => {
  const { state, requests, redirects } = setup(context)
  requests[0].reject(new ApiError(503))
  await nextTick()
  const retry = state.acceptInvitation()
  await state.acceptInvitation()
  assert.equal(requests.length, 2)
  assert.equal(state.error.value, '')
  assert.equal(requests[0].token, requests[1].token)
  requests[1].resolve({ room: { id: 'recovered-project' } })
  await retry
  assert.deepEqual(redirects, [{ name: 'studio-project', params: { id: 'recovered-project' } }])
})
