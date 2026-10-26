import { getToken } from './auth'
export const API_URL = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')
export const WS_URL = import.meta.env.VITE_WS_URL || `${API_URL.replace(/^http/, 'ws')}/ws`
// Gọi API đã xác thực bằng token Clerk và trả dữ liệu hoặc lỗi có thể hiển thị.
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await getToken()
  let response: Response
  try {
    response = await fetch(`${API_URL}/api${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(75000),
    })
  } catch { throw new Error('Could not reach the server. It may be waking up; please retry.') }
  const data = await response.json().catch(() => null)
  if (!response.ok || !data) throw new Error(data?.error?.message || 'The server is starting or unavailable. Please retry.')
  return data as T
}
