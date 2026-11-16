import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/services/auth.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

// Chạy helper thật với SDK giả để kiểm tra phiên mà không gọi Clerk hoặc đọc khóa local.
function setup(sdkToken = async () => 'test-session', configured = true) {
  const requests = []
  const dependencies = {
    '@clerk/vue': {
      getToken: async (options) => {
        requests.push(options)
        return sdkToken()
      },
    },
    './clerk': { clerkPublishableKey: configured ? 'configured' : '' },
  }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', compiled)(
    (name) => dependencies[name],
    module,
    module.exports,
  )
  return { ...module.exports, requests }
}

// HTTP dùng token hiện tại, còn reconnect/refresh có thể yêu cầu SDK bỏ cache.
test('valid sessions return the SDK token with the requested cache policy', async () => {
  const { getToken, requests } = setup()
  assert.equal(await getToken(), 'test-session')
  assert.equal(await getToken(true), 'test-session')
  assert.deepEqual(requests, [{ skipCache: false }, { skipCache: true }])
})

// Thiếu cấu hình được báo trước khi chạm SDK, không giả thành mất mạng.
test('missing Clerk configuration requires sign-in without calling the SDK', async () => {
  const { getToken, SignInRequiredError, requests } = setup(undefined, false)
  await assert.rejects(getToken(), SignInRequiredError)
  assert.equal(requests.length, 0)
})

// SDK trả null xác nhận không còn phiên; nơi gọi phải dừng retry tự động.
test('an absent session token raises a distinct sign-in requirement', async () => {
  const { getToken, SignInRequiredError } = setup(async () => null)
  await assert.rejects(getToken(true), SignInRequiredError)
})

// Lỗi tải token chưa chứng minh hết phiên, nên được giữ riêng để nơi gọi thử lại kết nối.
test('an SDK network failure is not classified as an ended session', async () => {
  const failure = new TypeError('Temporary SDK network failure')
  const { getToken, SignInRequiredError } = setup(async () => {
    throw failure
  })
  await assert.rejects(getToken(true), (error) => {
    assert.equal(error, failure)
    assert.equal(error instanceof SignInRequiredError, false)
    return true
  })
})
