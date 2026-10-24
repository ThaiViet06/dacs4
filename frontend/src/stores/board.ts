import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { emptyDocument, type Operation, type DrawingDocument, type Room } from '../drawing/model'
import { getToken } from '../services/auth'
import { WS_URL } from '../services/api'

export const useBoardStore = defineStore('board', () => {
  const document = ref<DrawingDocument>(emptyDocument())
  const room = ref<Room | null>(null)
  const status = ref<'local' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('local')
  const error = ref('')
  const sequence = ref(0)
  const members = ref<{ clientId: string; userId: string }[]>([])
  const pending = ref<Record<string, Operation>>({})
  const rejected = ref<Operation[]>([])
  const previews = ref<Record<string, { clientId: string; operation: Operation; seenAt: number }>>({})
  const operations = computed(() => [...document.value.operations, ...Object.values(pending.value)])
  const pendingCount = computed(() => Object.keys(pending.value).length)
  const remotePreviews = computed(() => Object.values(previews.value).map((item) => item.operation))
  let socket: WebSocket | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let tokenTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setInterval> | undefined
  let generation = 0
  let attempt = 0
  let target = ''
  function send(type: string, data: Record<string, unknown> = {}) {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({ v: 1, type, ...data }))
    return true
  }
  function disconnect() {
    generation++
    clearTimeout(retryTimer); clearTimeout(tokenTimer); clearTimeout(watchdog); clearInterval(previewTimer)
    if (socket) { socket.onclose = null; socket.close() }
    socket = undefined
    members.value = []
    previews.value = {}
  }
  function local() {
    disconnect(); target = ''; room.value = null; sequence.value = 0; pending.value = {}; rejected.value = []
    document.value = emptyDocument(); status.value = 'local'; error.value = ''
  }
  async function connect(roomId: string) {
    disconnect()
    if (target !== roomId) { pending.value = {}; rejected.value = []; document.value = emptyDocument(); sequence.value = 0; room.value = null }
    target = roomId
    attempt = 0
    error.value = ''
    const current = generation
    previewTimer = setInterval(() => {
      for (const [id, preview] of Object.entries(previews.value)) if (Date.now() - preview.seenAt > 10000) delete previews.value[id]
    }, 1000)
    async function open() {
      if (current !== generation) return
      status.value = attempt ? 'reconnecting' : 'connecting'
      try {
        const token = await getToken(true)
        if (current !== generation) return
        socket = new WebSocket(WS_URL)
        watchdog = setTimeout(() => socket?.close(), 75000)
        socket.onopen = () => send('auth', { token })
        socket.onerror = () => { error.value = 'Connection interrupted. Retrying automatically…' }
        socket.onmessage = (event) => {
          if (current !== generation) return
          try {
            const message = JSON.parse(event.data)
            if (message.v !== 1) throw new Error('Unsupported server protocol. Please reload.')
            if (message.type === 'auth.ok') {
              clearTimeout(tokenTimer)
              tokenTimer = setTimeout(async () => {
                try { const fresh = await getToken(true); if (current === generation) send('auth.refresh', { token: fresh }) }
                catch { if (current === generation) { error.value = 'Sign in again to reconnect.'; socket?.close(4401) } }
              }, Math.max(1000, message.expiresAt - Date.now() - 15000))
              if (status.value !== 'connected') send('room.join', { roomId })
            } else if (message.type === 'room.state') {
              document.value = message.document
              sequence.value = message.sequence
              room.value = message.room
              previews.value = {}
              clearTimeout(watchdog)
              const known = new Set(document.value.operations.map((operation) => operation.id))
              for (const [id, operation] of Object.entries(pending.value)) {
                if (known.has(id)) delete pending.value[id]
                else send('operation.commit', { operation })
              }
              status.value = 'connected'; attempt = 0; error.value = ''
            } else if (message.type === 'operation.committed') {
              delete pending.value[message.operation.id]; delete previews.value[message.operation.id]
              if (message.sequence > sequence.value) {
                if (message.sequence !== sequence.value + 1) { socket?.close(4000, 'Resynchronize'); return }
                document.value.operations.push(message.operation); sequence.value = message.sequence
              }
            } else if (message.type === 'operation.preview') {
              previews.value[message.operation.id] = { clientId: message.clientId, operation: message.operation, seenAt: Date.now() }
            } else if (message.type === 'preview.cancel') {
              if (previews.value[message.operationId]?.clientId === message.clientId) delete previews.value[message.operationId]
            } else if (message.type === 'presence') {
              members.value = message.members
              const active = new Set(members.value.map((member) => member.clientId))
              for (const [id, preview] of Object.entries(previews.value)) if (!active.has(preview.clientId)) delete previews.value[id]
            } else if (message.type === 'error') {
              error.value = message.message
              if (message.operationId && pending.value[message.operationId] && ['INVALID_INPUT', 'OPERATION_CONFLICT', 'DOCUMENT_FULL'].includes(message.code)) {
                rejected.value.push(pending.value[message.operationId]!); delete pending.value[message.operationId]
              }
              if (['ROOM_NOT_FOUND', 'ROOM_FULL', 'JOIN_REQUIRED'].includes(message.code)) {
                status.value = 'error'; if (socket) socket.onclose = null; socket?.close(); clearTimeout(watchdog)
              } else if (message.code === 'SERVICE_UNAVAILABLE' || message.code === 'RATE_LIMIT') socket?.close(4000, 'Retry pending operations')
            }
          } catch (cause) { error.value = cause instanceof Error ? cause.message : 'Unable to synchronize.'; socket?.close(4000) }
        }
        socket.onclose = (event) => {
          if (current !== generation) return
          clearTimeout(tokenTimer); clearTimeout(watchdog)
          previews.value = {}; members.value = []
          if (event.code === 4401) { status.value = 'error'; error.value = 'Your session expired. Sign in, then reconnect.'; return }
          status.value = 'reconnecting'
          error.value = 'Connection interrupted. Your pending strokes will retry when connected.'
          const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.2)
          retryTimer = setTimeout(open, delay)
        }
      } catch (cause) { status.value = 'error'; error.value = cause instanceof Error ? cause.message : 'Sign in to connect.' }
    }
    await open()
  }
  function commit(operation: Operation) {
    if (status.value === 'local') document.value.operations.push(operation)
    else if (status.value === 'connected') { pending.value[operation.id] = operation; send('operation.commit', { operation }) }
  }
  function preview(operation: Operation) { if (status.value === 'connected') send('operation.preview', { operation }) }
  function cancelPreview(operationId: string) { if (status.value === 'connected') send('preview.cancel', { operationId }) }
  function exportDocument() { return { ...document.value, operations: [...operations.value, ...rejected.value] } }
  return { document, room, status, error, sequence, members, operations, pendingCount, rejected, remotePreviews, local, connect, disconnect, commit, preview, cancelPreview, exportDocument }
})
