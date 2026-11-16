import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = readFileSync(new URL('../src/services/api.ts', import.meta.url), 'utf8').replaceAll(
  'import.meta.env',
  'testEnvironment',
)
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

// Giữ cùng kiểu lỗi giữa SDK giả và API thật để phân biệt thiếu phiên với lỗi mạng.
class SignInRequiredError extends Error {}

// Chạy helper thật với fetch/token/thời gian chờ giả; không gọi Clerk, mạng hoặc chờ 75 giây.
function setup(fetchResponse, token = async () => 'test-token') {
  const requests = []
  const controller = new AbortController()
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'fetch', 'AbortSignal', 'testEnvironment', compiled)(
    () => ({ getToken: token, SignInRequiredError }),
    module,
    module.exports,
    async (...args) => {
      requests.push(args)
      return fetchResponse(controller)
    },
    {
      timeout(milliseconds) {
        assert.equal(milliseconds, 75000)
        return controller.signal
      },
    },
    { VITE_API_BASE_URL: 'https://api.example.test/' },
  )
  return { ...module.exports, requests, controller }
}

test('authenticated reads use the configured origin, token and request deadline', async () => {
  const { api, API_URL, WS_URL, requests, controller } = setup(() => Response.json({ rooms: [] }))
  assert.deepEqual(await api('/rooms'), { rooms: [] })
  assert.equal(API_URL, 'https://api.example.test')
  assert.equal(WS_URL, 'wss://api.example.test/ws')
  assert.equal(requests.length, 1)
  const [url, options] = requests[0]
  assert.equal(url, `${API_URL}/api/rooms`)
  assert.equal(options.method, 'GET')
  assert.deepEqual(options.headers, { Authorization: 'Bearer test-token' })
  assert.equal(options.body, undefined)
  assert.equal(options.signal, controller.signal)
})

test('write requests serialize JSON once and return only the confirmed response', async () => {
  const result = { room: { id: 'project-a', title: 'Sketch' } }
  const { api, requests } = setup(() => Response.json(result, { status: 201 }))
  assert.deepEqual(await api('/rooms', 'POST', { title: 'Sketch' }), result)
  assert.equal(requests.length, 1)
  assert.equal(requests[0][1].method, 'POST')
  assert.equal(requests[0][1].headers['Content-Type'], 'application/json')
  assert.deepEqual(JSON.parse(requests[0][1].body), { title: 'Sketch' })
})

test('missing authentication stops before any HTTP request', async () => {
  const failure = new SignInRequiredError('Sign-in required')
  const { api, requests } = setup(
    () => assert.fail('Unauthenticated requests cannot reach fetch'),
    async () => {
      throw failure
    },
  )
  await assert.rejects(api('/rooms'), (error) => error === failure)
  assert.equal(requests.length, 0)
})

// SDK gặp lỗi mạng không được khiến giao diện xóa cache hoặc yêu cầu đăng nhập lại.
test('a token download failure is a network error and makes no HTTP request', async () => {
  const { api, ApiError, requests } = setup(
    () => assert.fail('A token is required before fetch'),
    async () => {
      throw new TypeError('Private sign-in transport details')
    },
  )
  await assert.rejects(api('/rooms'), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.status, undefined)
    assert.doesNotMatch(error.message, /Private/)
    return true
  })
  assert.equal(requests.length, 0)
})

test('network failures do not retry writes or expose internal fetch details', async () => {
  const { api, ApiError, requests } = setup(() => {
    throw new TypeError('Private transport details')
  })
  await assert.rejects(api('/rooms', 'POST', { title: 'Sketch' }), (error) => {
    assert.ok(error instanceof ApiError)
    assert.equal(error.code, 'NETWORK_ERROR')
    assert.equal(error.status, undefined)
    assert.doesNotMatch(error.message, /Private/)
    return true
  })
  assert.equal(requests.length, 1)
})

test('the deadline covers both fetch and reading the response body', async () => {
  for (const stage of ['fetch', 'body']) {
    const { api, requests } = setup((controller) => {
      // Giả lập hết hạn ở từng giai đoạn để kiểm tra cả trường hợp đã nhận HTTP 200 nhưng chưa đủ JSON.
      const expire = () => {
        controller.abort(new DOMException('Timed out', 'TimeoutError'))
        throw controller.signal.reason
      }
      return stage === 'fetch' ? expire() : { ok: true, status: 200, json: async () => expire() }
    })
    await assert.rejects(api('/rooms', 'POST', { title: 'Sketch' }), (error) => {
      assert.equal(error.code, 'REQUEST_TIMEOUT')
      assert.equal(error.status, stage === 'fetch' ? undefined : 200)
      return true
    })
    assert.equal(requests.length, 1)
  }
})

test('an interrupted response body is a network failure rather than a successful write', async () => {
  const { api, requests } = setup(() => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new TypeError('Connection closed before JSON was complete')
    },
  }))
  await assert.rejects(api('/rooms', 'POST', { title: 'Sketch' }), {
    code: 'NETWORK_ERROR',
    status: 200,
  })
  assert.equal(requests.length, 1)
})

test('HTML and invalid JSON responses never confirm a write or trigger an automatic retry', async () => {
  for (const [status, body] of [
    [503, '<html>Starting up</html>'],
    [200, '<html>Starting up</html>'],
    [200, 'null'],
    [200, '[]'],
    [200, '"Unexpected response"'],
  ]) {
    const { api, requests } = setup(() => new Response(body, { status }))
    await assert.rejects(api('/rooms', 'POST', { title: 'Sketch' }), {
      code: 'SERVICE_UNAVAILABLE',
      status,
    })
    assert.equal(requests.length, 1)
  }
})

test('backend error codes and HTTP status survive JSON or non-JSON failures', async () => {
  for (const [status, code] of [
    [401, 'AUTH_EXPIRED'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMIT'],
    [503, 'SERVICE_UNAVAILABLE'],
  ]) {
    for (const body of [
      JSON.stringify({ error: { code, message: 'Request rejected' } }),
      '<html>Unavailable</html>',
      JSON.stringify({ error: { code: { unexpected: true }, message: 123 } }),
    ]) {
      const { api } = setup(() => new Response(body, { status }))
      await assert.rejects(api('/rooms'), (error) => {
        assert.equal(error.status, status)
        assert.equal(error.code, body.includes('Request rejected') ? code : 'SERVICE_UNAVAILABLE')
        assert.equal(typeof error.message, 'string')
        return true
      })
    }
  }
})
