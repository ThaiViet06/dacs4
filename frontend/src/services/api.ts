import { getToken, SignInRequiredError } from './auth'
export const API_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(
  /\/$/,
  '',
)
export const WS_URL = import.meta.env.VITE_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`

export class ApiError extends Error {
  code: string
  status?: number

  // Giữ mã lỗi nghiệp vụ và HTTP để giao diện chọn lời hướng dẫn phù hợp, không phải đoán từ câu chữ.
  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

// Phân biệt quá thời gian chờ với mất kết nối, kể cả khi chỉ mới đọc được một phần phản hồi.
function connectionError(signal: AbortSignal, status?: number): ApiError {
  return new ApiError(
    signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
    signal.aborted ? 'The server took too long to respond.' : 'Could not reach the server.',
    status,
  )
}

// Phân biệt lỗi phiên/lỗi mạng tải token; gọi API một lần và chỉ thành công khi đã đọc đủ JSON.
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let token: string
  try {
    token = await getToken()
  } catch (cause) {
    if (cause instanceof SignInRequiredError) throw cause
    throw new ApiError('NETWORK_ERROR', 'Could not reach the sign-in service. Please retry.')
  }
  const signal = AbortSignal.timeout(75000)
  let response: Response
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal,
    })
  } catch {
    throw connectionError(signal)
  }
  const data = await response.json().catch((cause: unknown) => {
    // Trang HTML lúc máy chủ khởi động khác với phản hồi bị ngắt giữa chừng do mất mạng/quá hạn.
    if (signal.aborted || !(cause instanceof SyntaxError))
      throw connectionError(signal, response.status)
    return null
  })
  if (!response.ok || !data || typeof data !== 'object' || Array.isArray(data))
    throw new ApiError(
      typeof data?.error?.code === 'string' ? data.error.code : 'SERVICE_UNAVAILABLE',
      typeof data?.error?.message === 'string'
        ? data.error.message
        : 'The server is starting or unavailable. Please retry.',
      response.status,
    )
  return data as T
}
