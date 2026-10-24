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

function loadScript(src: string, key?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.crossOrigin = 'anonymous'
    if (key) script.dataset.clerkPublishableKey = key
    script.onload = () => { clearTimeout(timer); resolve() }
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Could not connect to sign-in. Check your connection and Clerk settings.')) }
    const timer = setTimeout(() => { script.remove(); reject(new Error('Sign-in took too long. Please reload.')) }, 15000)
    document.head.appendChild(script)
  })
}
export function initializeAuth() {
  if (!publishableKey) return Promise.resolve()
  initialization ??= (async () => {
    try {
      if (!/^pk_(test|live)_/.test(publishableKey)) throw new Error('The Clerk publishable key is invalid.')
      const domain = atob(publishableKey.split('_')[2] || '').replace(/\$$/, '')
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) throw new Error('The Clerk domain is invalid.')
      await loadScript(`https://${domain}/npm/@clerk/ui@1/dist/ui.browser.js`)
      await loadScript(`https://${domain}/npm/@clerk/clerk-js@6/dist/clerk.browser.js`, publishableKey)
      if (!window.Clerk) throw new Error('Sign-in could not initialize. Please reload.')
      await window.Clerk.load({ ui: { ClerkUI: window.__internal_ClerkUICtor } })
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
export async function getToken(fresh = false) {
  await initializeAuth()
  const token = await window.Clerk?.session?.getToken({ skipCache: fresh })
  if (!token) throw new Error('Sign in to access shared rooms and saved drawings.')
  return token
}
export function signIn() { window.Clerk?.openSignIn({ forceRedirectUrl: window.location.href }) }
export async function signOut() { await window.Clerk?.signOut(); auth.userId = '' }
