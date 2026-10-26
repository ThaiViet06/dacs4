import { reactive } from 'vue'

interface ClerkUser { id: string; firstName: string | null; username: string | null }
interface ClerkSession { getToken(options?: { skipCache: boolean }): Promise<string | null> }
interface ClerkClient {
  user: ClerkUser | null
  session: ClerkSession | null
  load(options: { ui: { ClerkUI: unknown } }): Promise<void>
  addListener(callback: (state: { user: ClerkUser | null; session: ClerkSession | null }) => void): () => void
  openSignIn(options?: { forceRedirectUrl: string }): void
  signOut(): Promise<void>
}
declare global { interface Window { Clerk?: ClerkClient; __internal_ClerkUICtor?: unknown } }
const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined
export const auth = reactive({ configured: Boolean(publishableKey), ready: !publishableKey, userId: '', name: '', error: '' })
let initialization: Promise<void> | undefined

// Tải script Clerk từ tên miền cấu hình và báo lỗi nếu tải thất bại hoặc quá hạn.
function loadScript(src: string, key?: string): Promise<void> {
  // Promise kết thúc khi script tải xong hoặc gặp lỗi.
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.crossOrigin = 'anonymous'
    if (key) script.dataset.clerkPublishableKey = key
    // Báo script đã tải xong và hủy đồng hồ chờ.
    script.onload = () => { clearTimeout(timer); resolve() }
    // Gỡ script hỏng và trả lỗi cho luồng khởi tạo đăng nhập.
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Could not connect to sign-in. Check your connection and Clerk settings.')) }
    // Giới hạn thời gian chờ script để giao diện không đứng mãi.
    const timer = setTimeout(() => { script.remove(); reject(new Error('Sign-in took too long. Please reload.')) }, 15000)
    document.head.appendChild(script)
  })
}
// Khởi tạo Clerk một lần, đồng bộ người dùng hiện tại vào trạng thái giao diện.
export function initializeAuth() {
  if (!publishableKey) return Promise.resolve()
  // Dùng lại cùng Promise nếu nhiều nơi yêu cầu khởi tạo cùng lúc.
  initialization ??= (async () => {
    try {
      if (!/^pk_(test|live)_/.test(publishableKey)) throw new Error('The Clerk publishable key is invalid.')
      const domain = atob(publishableKey.split('_')[2] || '').replace(/\$$/, '')
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error('The Clerk domain is invalid.')
      await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`)
      await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey)
      if (!window.Clerk) throw new Error('Sign-in could not initialize. Please reload.')
      await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
      // Cập nhật tên và ID khi tài khoản đăng nhập hoặc đăng xuất.
      const update = ({ user }: { user: ClerkUser | null }) => {
        auth.userId = user?.id || ''
        auth.name = user?.firstName || user?.username || 'Artist'
      }
      update(window.Clerk)
      window.Clerk.addListener(update)
    } catch (error) { auth.error = error instanceof Error ? error.message : 'Sign-in is unavailable.' }
    finally { auth.ready = true }
  })()
  return initialization
}
// Lấy token phiên Clerk cho API/WebSocket; có thể yêu cầu token mới khi nối lại.
export async function getToken(fresh = false) {
  await initializeAuth()
  const token = await window.Clerk?.session?.getToken({ skipCache: fresh })
  if (!token) throw new Error('Sign in to access shared rooms and saved drawings.')
  return token
}
// Mở giao diện đăng nhập Clerk rồi quay về trang hiện tại.
export function signIn() { window.Clerk?.openSignIn({ forceRedirectUrl: window.location.href }) }
// Đăng xuất khỏi Clerk và xóa ID người dùng trên giao diện.
export async function signOut() { await window.Clerk?.signOut(); auth.userId = '' }
