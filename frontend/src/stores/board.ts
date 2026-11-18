import { computed, ref, shallowRef, watch } from 'vue'
import { defineStore } from 'pinia'
import {
  emptyDocument,
  getVisibleOperations,
  normalizeDocument,
  PROTOCOL_VERSION,
  WIDTH,
  HEIGHT,
  type Operation,
  type DrawingDocumentV2,
  type DrawingEvent,
  type Room,
} from '../drawing/model'
import { getToken, SignInRequiredError } from '../services/auth'
import { api, API_URL, WS_URL } from '../services/api'
import { decodeStroke, encodeStroke } from '../drawing/codec'
import { isChatMessage, type ChatMessage } from '../chat/model'

interface RoomSession {
  room: Room | null
  document: DrawingDocumentV2
  sequence: number
  pending: Record<string, DrawingEvent>
  hasSaveError: boolean
  rejected: DrawingEvent[]
  invitationUrl: string
}
interface HistoryAction {
  type: 'draw' | 'undo' | 'redo'
  targetId: string
}
interface OperationFrame {
  sequence: number
  operation?: DrawingEvent
  id?: string
  packed?: string
  targetSequence?: number
}
interface SyncFrame {
  room: Room
  sequence: number
  after: number
  epoch: number
  events: OperationFrame[]
  snapshot: { sequence: number; visibleCount: number } | null
}

// Dùng cùng một bộ giải mã cho nét trực tiếp và phần đuôi khi kết nối lại.
function frameOperation(frame: OperationFrame): DrawingEvent {
  const operation =
    frame.packed && frame.id ? decodeStroke(frame.id, frame.packed) : frame.operation
  if (typeof operation?.id !== 'string') throw new Error('Missing operation')
  return operation
}

// Tải ảnh bằng token hiện tại, không lưu ảnh riêng tư vào HTTP cache.
async function loadSnapshot(roomId: string, sequence: number) {
  const token = await getToken()
  const response = await fetch(`${API_URL}/api/rooms/${roomId}/render-snapshot/${sequence}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error('Snapshot unavailable')
  const bitmap = await createImageBitmap(await response.blob())
  if (bitmap.width === WIDTH && bitmap.height === HEIGHT) return bitmap
  bitmap.close()
  throw new Error('Invalid snapshot dimensions')
}

// Giữ phiên dự án theo tài khoản; bản nháp Vẽ thử nằm ở store draft riêng.
export const useBoardStore = defineStore('board', () => {
  const document = ref<DrawingDocumentV2>(normalizeDocument(emptyDocument()))
  const room = ref<Room | null>(null)
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const error = ref('')
  const hasSaveError = ref(false)
  const authRequired = ref(false)
  const revokedRoomId = ref('')
  const sequence = ref(0)
  const renderedSnapshot = shallowRef<{
    bitmap: ImageBitmap
    sequence: number
    visibleCount: number
  } | null>(null)
  const confirmedOperations = ref<Operation[]>([])
  const knownIds = new Set<string>()
  let materialized = false
  let renderEpoch: number | undefined
  let forceVector = false
  let enhanced = false
  const members = ref<{ clientId: string; userId: string }[]>([])
  const pending = ref<Record<string, DrawingEvent>>({})
  const rejected = ref<DrawingEvent[]>([])
  const previews = ref<Record<string, { clientId: string; operation: Operation; seenAt: number }>>(
    {},
  )
  const invitationUrl = ref('')
  const lastChatMessage = ref<ChatMessage | null>(null)
  const sessions = new Map<string, RoomSession>()
  const undoStack = ref<string[]>([])
  const redoStack = ref<string[]>([])
  const historyActions = new Map<string, HistoryAction>()
  let accountId = ''
  // Giữ lịch sử đầy đủ trong document; Canvas chỉ nhận nét đang hiện, kể cả hiệu ứng của thao tác chờ xác nhận.
  const operations = computed(() =>
    getVisibleOperations({
      ...document.value,
      operations: [...document.value.operations, ...Object.values(pending.value)],
    }),
  )
  // Đếm thao tác đã gửi nhưng chưa được máy chủ xác nhận, gồm cả nét và sự kiện ẩn/hiện.
  const pendingCount = computed(() => Object.keys(pending.value).length)
  const pendingStrokes = computed(() =>
    Object.values(pending.value).filter((event): event is Operation => event.type !== 'visibility'),
  )
  // Hoàn tác hiện ngay với nét vector. Nét đang chờ lưu được vẽ ở lớp preview riêng.
  const renderOperations = computed(() => {
    const visibility = Object.values(pending.value).find((event) => event.type === 'visibility')
    return visibility
      ? getVisibleOperations({
          ...document.value,
          operations: [...document.value.operations, visibility],
        })
      : confirmedOperations.value
  })
  // Chỉ chủ Cá nhân có lịch sử riêng; mọi thao tác phải lưu xong trước khi hoàn tác/làm lại.
  const personalOwner = computed(
    () => room.value?.ownerId === accountId && room.value?.sharingEnabled === false,
  )
  const historyReady = computed(
    () =>
      personalOwner.value &&
      status.value === 'connected' &&
      !pendingCount.value &&
      !rejected.value.length,
  )
  const canUndo = computed(() => historyReady.value && undoStack.value.length > 0)
  const canRedo = computed(() => historyReady.value && redoStack.value.length > 0)
  // Trích các nét tạm thời của người khác để hiển thị ở lớp xem trước.
  const remotePreviews = computed(() => Object.values(previews.value).map((item) => item.operation))
  let socket: WebSocket | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let tokenTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setInterval> | undefined
  let stopNetworkWatching: (() => void) | undefined
  let generation = 0
  let attempt = 0
  let target = ''
  // Bắt đầu lịch sử phiên mới khi đổi chế độ; tên/sequence đổi hoặc reconnect cùng chế độ không xóa stack.
  watch(() => room.value?.sharingEnabled, resetHistory, { flush: 'sync' })
  // Cảnh báo lỗi lưu chỉ hết khi các lệnh chờ đã được xử lý; lệnh bị từ chối có danh sách rejected riêng.
  watch(
    pendingCount,
    (count) => {
      if (!count) hasSaveError.value = false
    },
    { flush: 'sync' },
  )
  // Chỉ xóa lịch sử điều khiển trong RAM, giữ nguyên nét và sự kiện đã lưu trong document.
  function resetHistory() {
    undoStack.value = []
    redoStack.value = []
    historyActions.clear()
  }
  // Chuyển stack sau acknowledgement hoặc room.state xác nhận UUID; ACK lặp không đổi stack lần nữa.
  function acknowledgeHistory(event: DrawingEvent) {
    const action = historyActions.get(event.id)
    if (!action) return
    historyActions.delete(event.id)
    if (!personalOwner.value) return
    if (action.type === 'draw') {
      if (event.type !== 'visibility') {
        undoStack.value.push(action.targetId)
        redoStack.value = []
      }
      return
    }
    const source = action.type === 'undo' ? undoStack : redoStack
    const destination = action.type === 'undo' ? redoStack : undoStack
    if (
      event.type !== 'visibility' ||
      event.targetId !== action.targetId ||
      event.visible !== (action.type === 'redo') ||
      source.value.at(-1) !== action.targetId
    ) {
      resetHistory()
      return
    }
    source.value.pop()
    destination.value.push(action.targetId)
  }
  // Gửi một sự kiện mới cho nét đầu stack; stack chỉ thay đổi khi server xác nhận, không phải lúc bấm nút.
  function changeHistory(type: 'undo' | 'redo') {
    if (type === 'undo' ? !canUndo.value : !canRedo.value) return
    const targetId = (type === 'undo' ? undoStack.value : redoStack.value).at(-1)!
    const event: DrawingEvent = {
      id: crypto.randomUUID(),
      type: 'visibility',
      targetId,
      visible: type === 'redo',
    }
    historyActions.set(event.id, { type, targetId })
    if (!commit(event)) historyActions.delete(event.id)
  }
  // Hoàn tác nét đã được xác nhận gần nhất của lần mở editor này.
  function undo() {
    changeHistory('undo')
  }
  // Hiện lại nét vừa hoàn tác ở vị trí gốc trong lịch sử server.
  function redo() {
    changeHistory('redo')
  }
  // Gửi một thông điệp đúng phiên bản giao thức khi WebSocket đang mở.
  function send(type: string, data: Record<string, unknown> = {}) {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type, ...data }))
    return true
  }
  // Chọn định dạng gọn sau khi máy chủ báo hỗ trợ, giữ JSON cho các sự kiện ẩn/hiện.
  function sendCommit(operation: DrawingEvent) {
    const packed = enhanced && operation.type !== 'visibility' && encodeStroke(operation)
    if (packed) send('operation.packed', { id: operation.id, packed })
    else send('operation.commit', { operation })
  }

  // Thay ảnh nền và giải phóng bộ nhớ bitmap khi đổi tài liệu.
  function setSnapshot(snapshot: typeof renderedSnapshot.value) {
    renderedSnapshot.value?.bitmap.close()
    renderedSnapshot.value = snapshot
  }

  // Dựng lại chỉ mục khi tải tài liệu hoặc đổi trạng thái ẩn/hiện của một nét.
  function indexDocument() {
    knownIds.clear()
    for (const operation of document.value.operations) knownIds.add(operation.id)
    confirmedOperations.value = getVisibleOperations(document.value)
  }
  // Đóng kết nối hiện tại, hủy bộ hẹn giờ và bỏ trạng thái hiện diện tạm thời.
  function disconnect() {
    generation++
    enhanced = false
    stopNetworkWatching?.()
    stopNetworkWatching = undefined
    clearTimeout(retryTimer)
    clearTimeout(tokenTimer)
    clearTimeout(watchdog)
    clearInterval(previewTimer)
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
    }
    socket = undefined
    members.value = []
    previews.value = {}
    lastChatMessage.value = null
  }
  // Hết phiên thì dừng mọi retry và khóa vẽ, giữ nét chờ cho cùng tài khoản; đăng xuất vẫn xóa cache.
  function requireAuthentication() {
    disconnect()
    authRequired.value = true
    status.value = 'error'
    error.value = 'Phiên đăng nhập không còn hợp lệ. Đăng nhập lại rồi bấm Kết nối lại.'
  }
  // Xóa phần đang hiển thị, không xóa các phiên đã giữ để mở lại dự án sau.
  function clearActive() {
    resetHistory()
    setSnapshot(null)
    materialized = false
    renderEpoch = undefined
    forceVector = false
    target = ''
    room.value = null
    sequence.value = 0
    pending.value = {}
    hasSaveError.value = false
    rejected.value = []
    invitationUrl.value = ''
    document.value = normalizeDocument(emptyDocument())
    indexDocument()
    status.value = 'idle'
    error.value = ''
    authRequired.value = false
  }
  // Giữ tối đa năm dự án gần nhất đã lưu; phiên còn nét chờ/lỗi không bị loại khỏi bộ nhớ.
  function rememberRoom() {
    if (!target) return
    sessions.delete(target)
    sessions.set(target, {
      room: room.value,
      document: renderedSnapshot.value ? normalizeDocument(emptyDocument()) : document.value,
      sequence: renderedSnapshot.value ? 0 : sequence.value,
      pending: pending.value,
      hasSaveError: hasSaveError.value,
      rejected: rejected.value,
      invitationUrl: invitationUrl.value,
    })
    for (const [id, session] of sessions) {
      if (sessions.size <= 5) break
      if (id !== target && !Object.keys(session.pending).length && !session.rejected.length)
        sessions.delete(id)
    }
  }
  // Rời editor đóng socket nhưng giữ cả nét chưa xác nhận để gửi lại khi mở đúng dự án.
  function leaveRoom() {
    rememberRoom()
    disconnect()
    clearActive()
  }
  // Đăng xuất/đổi tài khoản xóa mọi dữ liệu dự án và phản hồi đang chờ của tài khoản cũ.
  function reset() {
    disconnect()
    sessions.clear()
    clearActive()
    revokedRoomId.value = ''
  }
  // Header gọi cả khi người dùng ở ngoài editor, tránh phục hồi dữ liệu của tài khoản trước.
  function setAccount(userId: string) {
    if (accountId === userId) return
    accountId = userId
    reset()
  }
  // Dựng lại Canvas cũ ở chế độ khóa vẽ, chờ kiểm tra quyền và room.state mới từ server.
  function prepareRoom(roomId: string) {
    rememberRoom()
    disconnect()
    clearActive()
    target = roomId
    revokedRoomId.value = ''
    const saved = sessions.get(roomId)
    if (saved) {
      room.value = saved.room
      document.value = saved.document
      indexDocument()
      sequence.value = saved.sequence
      pending.value = saved.pending
      hasSaveError.value = saved.hasSaveError
      rejected.value = saved.rejected
      invitationUrl.value = saved.invitationUrl
    }
    status.value = 'connecting'
    return room.value
  }
  // Khi server từ chối quyền, bỏ dữ liệu cache của dự án để lần mở sau không hiện nội dung cũ.
  function forgetRoom(roomId: string) {
    sessions.delete(roomId)
    if (target === roomId) {
      disconnect()
      clearActive()
    }
  }
  // Studio kiểm tra cả nét đang mở lẫn nét chờ được giữ trong phiên cache trước khi đổi chế độ.
  function hasUnsavedChanges(roomId: string) {
    if (target === roomId) return pendingCount.value > 0 || rejected.value.length > 0
    const saved = sessions.get(roomId)
    return Boolean(saved && (Object.keys(saved.pending).length > 0 || saved.rejected.length > 0))
  }

  // Mất quyền hoặc bị xóa phải bỏ cache và báo editor để điều hướng về Studio.
  function closeRoomAccess(roomId: string, message: string) {
    forgetRoom(roomId)
    status.value = 'error'
    error.value = message
    revokedRoomId.value = roomId
  }

  // Link chỉ được nhớ cho đúng dự án đang mở và đúng tài khoản chủ, không gửi lại yêu cầu tạo link.
  function rememberInvitation(roomId: string, url: string) {
    if (target === roomId && room.value?.ownerId === accountId) invitationUrl.value = url
  }
  // Chỉ bỏ nét đang chờ sau khi có xác nhận đúng UUID và mốc thứ tự.
  function confirmSaved(operation: DrawingEvent) {
    acknowledgeHistory(operation)
    delete pending.value[operation.id]
    delete previews.value[operation.id]
  }

  // Nét mới nối vào danh sách render. Undo/redo dựng lại từ lịch sử đã có.
  function appendSaved(operation: DrawingEvent, nextSequence: number) {
    document.value.operations.push(operation)
    knownIds.add(operation.id)
    sequence.value = nextSequence
    if (operation.type === 'visibility') {
      if (!pending.value[operation.id]) resetHistory()
      confirmedOperations.value = getVisibleOperations(document.value)
    } else {
      confirmedOperations.value.push(operation)
    }
    confirmSaved(operation)
  }

  // Ảnh đã gộp nét không thể sửa ngược. Yêu cầu vector nếu thay đổi nhắm tới nét trong ảnh.
  function requiresVector(operation: DrawingEvent, targetSequence?: number) {
    return Boolean(
      renderedSnapshot.value &&
      operation.type === 'visibility' &&
      (targetSequence !== undefined && targetSequence !== null
        ? targetSequence <= renderedSnapshot.value.sequence
        : !knownIds.has(operation.targetId)),
    )
  }

  // Ghi nhận mốc đã phục hồi trước khi gửi lại UUID chưa thấy trong tài liệu.
  function finishJoin() {
    materialized = true
    forceVector = false
    clearTimeout(watchdog)
    for (const operation of Object.values(pending.value)) {
      if (knownIds.has(operation.id)) confirmSaved(operation)
      else sendCommit(operation)
    }
    status.value = 'connected'
    attempt = 0
    error.value = ''
  }
  // Lấy token mới khi chủ động kết nối lại; chỉ gửi nét chờ sau room.state của đúng phòng/tài khoản.
  async function connect(roomId: string) {
    if (target !== roomId) prepareRoom(roomId)
    else disconnect()
    attempt = 0
    error.value = ''
    authRequired.value = false
    const current = generation
    // Trình duyệt báo offline thì đóng socket ngay và giữ nguyên tài liệu/nét chờ để nối lại cùng phòng.
    function pauseForOffline() {
      disconnect()
      status.value = 'reconnecting'
      error.value = 'Mất mạng. Bản vẽ đang được giữ trong trang này; chờ kết nối trở lại.'
      const paused = generation
      // Khi có mạng, lấy token mới và tải lại phòng; đổi phòng/đăng xuất sẽ hủy lần chờ này.
      function resume() {
        if (paused === generation) void connect(roomId)
      }
      window.addEventListener('online', resume, { once: true })
      stopNetworkWatching = () => window.removeEventListener('online', resume)
    }
    window.addEventListener('offline', pauseForOffline)
    stopNetworkWatching = () => window.removeEventListener('offline', pauseForOffline)
    if (!window.navigator.onLine) {
      pauseForOffline()
      return
    }

    // Dùng chung backoff cho lỗi socket và lỗi tải token tạm thời; mỗi phòng chỉ có một lần thử đang hẹn.
    function retry() {
      if (current !== generation) return
      clearTimeout(retryTimer)
      clearTimeout(tokenTimer)
      clearTimeout(watchdog)
      previews.value = {}
      members.value = []
      lastChatMessage.value = null
      status.value = 'reconnecting'
      error.value = 'Kết nối bị gián đoạn. Đang chờ kết nối lại với máy chủ.'
      const delay =
        Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.2)
      retryTimer = setTimeout(open, delay)
    }
    // Bỏ nét xem trước cũ nếu bên gửi ngắt kết nối trước khi hủy nét.
    previewTimer = setInterval(() => {
      for (const [id, preview] of Object.entries(previews.value))
        if (Date.now() - preview.seenAt > 10000) delete previews.value[id]
    }, 1000)
    // Lấy token mới, mở WebSocket và đăng ký các xử lý đồng bộ của phòng.
    async function open() {
      if (current !== generation) return
      status.value = attempt ? 'reconnecting' : 'connecting'
      try {
        const token = await getToken(true)
        if (current !== generation) return
        const connection = new WebSocket(WS_URL)
        socket = connection
        enhanced = false
        let joining = false
        let syncInProgress = false
        let bufferedBytes = 0
        const buffered: MessageEvent[] = []
        // Giữ thứ tự các xác nhận đến trong lúc tải ảnh, giới hạn bộ đệm và thử lại nếu quá tải.
        async function restoreSync(message: SyncFrame) {
          syncInProgress = true
          try {
            if (
              message.room?.id !== roomId ||
              !Number.isSafeInteger(message.after) ||
              message.after < 0 ||
              !Number.isSafeInteger(message.sequence) ||
              !Number.isSafeInteger(message.epoch) ||
              !Array.isArray(message.events) ||
              message.sequence !== message.after + message.events.length ||
              (message.snapshot
                ? message.snapshot.sequence !== message.after ||
                  !Number.isSafeInteger(message.snapshot.visibleCount) ||
                  message.snapshot.visibleCount < 0
                : !materialized || sequence.value !== message.after)
            )
              throw new Error('Invalid sync state')
            const events = message.events.map((frame, index) => {
              if (frame.sequence !== message.after + index + 1)
                throw new Error('Invalid event order')
              return frameOperation(frame)
            })
            if (message.snapshot) {
              const bitmap = await loadSnapshot(roomId, message.after)
              if (
                current !== generation ||
                socket !== connection ||
                connection.readyState !== WebSocket.OPEN
              ) {
                bitmap.close()
                return
              }
              resetHistory()
              setSnapshot({ bitmap, ...message.snapshot })
              document.value = normalizeDocument(emptyDocument())
              sequence.value = message.after
              indexDocument()
            }
            room.value = message.room
            for (const [index, operation] of events.entries()) {
              if (
                knownIds.has(operation.id) ||
                requiresVector(operation, message.events[index]?.targetSequence)
              )
                throw new Error('Cannot replay event')
              appendSaved(operation, message.after + index + 1)
            }
            renderEpoch = message.epoch
            finishJoin()
            syncInProgress = false
            for (const frame of buffered) connection.onmessage?.(frame)
            buffered.length = 0
          } catch {
            if (current === generation && socket === connection) {
              forceVector = true
              connection.close(4000, 'Restore vector document')
            }
          }
        }
        // Đóng kết nối nếu máy chủ không gửi trạng thái phòng trong thời hạn chờ.
        watchdog = setTimeout(() => connection.close(), 75000)
        // Gửi token ngay khi WebSocket đã sẵn sàng.
        connection.onopen = () => {
          if (current === generation && socket === connection) send('auth', { token })
        }
        // Hiện lỗi kết nối để người dùng biết ứng dụng sẽ thử lại.
        connection.onerror = () => {
          if (current === generation && socket === connection)
            error.value = 'Kết nối bị gián đoạn. Đang thử lại…'
        }
        // Phân loại phản hồi xác thực, trạng thái phòng, nét vẽ và lỗi từ máy chủ.
        connection.onmessage = (event) => {
          if (
            current !== generation ||
            socket !== connection ||
            connection.readyState !== WebSocket.OPEN
          )
            return
          try {
            const message = JSON.parse(event.data)
            if (message.v !== PROTOCOL_VERSION) {
              // Khóa vẽ và giữ dữ liệu/nét chờ khi hai phía khác phiên bản, tránh lặp reconnect vô ích.
              disconnect()
              status.value = 'error'
              error.value =
                'Phiên bản kết nối không tương thích. Cập nhật backend rồi bấm Kết nối lại.'
              return
            }
            if (syncInProgress && ['operation.committed', 'operation.ack'].includes(message.type)) {
              bufferedBytes += event.data.length
              if (buffered.length >= 256 || bufferedBytes > 1024 * 1024)
                connection.close(4000, 'Sync buffer full')
              else buffered.push(event)
              return
            }
            if (message.type === 'auth.ok') {
              enhanced = message.drawingSync === true
              clearTimeout(tokenTimer)
              // Làm mới token trước khi hết hạn để phiên vẽ chung tiếp tục hoạt động.
              tokenTimer = setTimeout(
                async () => {
                  if (current !== generation || socket !== connection) return
                  try {
                    const fresh = await getToken(true)
                    if (current === generation && socket === connection)
                      send('auth.refresh', { token: fresh })
                  } catch (cause) {
                    if (current === generation && socket === connection) {
                      // SDK không còn token thì cần đăng nhập; lỗi mạng vẫn được nối lại có backoff.
                      if (cause instanceof SignInRequiredError) requireAuthentication()
                      else connection.close(4000, 'Retry token refresh')
                    }
                  }
                },
                Math.max(1000, message.expiresAt - Date.now() - 15000),
              )
              if (!joining) {
                joining = true
                const sync = forceVector
                  ? { vectorOnly: true }
                  : materialized
                    ? {
                        lastSeq: sequence.value,
                        epoch: renderEpoch,
                        snapshot: Boolean(renderedSnapshot.value),
                      }
                    : {}
                send('room.join', enhanced ? { roomId, sync } : { roomId })
              }
            } else if (message.type === 'room.sync') {
              if (!enhanced || syncInProgress || status.value === 'connected')
                throw new Error('Unexpected sync frame')
              void restoreSync(message)
            } else if (message.type === 'room.state') {
              // Không nhận nhầm tài liệu phòng khác hoặc đánh dấu kết nối với trạng thái thiếu dữ liệu.
              if (
                message.room?.id !== roomId ||
                !Number.isSafeInteger(message.sequence) ||
                message.sequence < 0 ||
                ![1, 2].includes(message.document?.version) ||
                message.document.width !== WIDTH ||
                message.document.height !== HEIGHT ||
                !Array.isArray(message.document.operations)
              )
                throw new Error('Trạng thái phòng không hợp lệ. Đang thử tải lại…')
              const previous = new Set(knownIds)
              setSnapshot(null)
              renderEpoch = undefined
              document.value = normalizeDocument(message.document)
              indexDocument()
              sequence.value = message.sequence
              room.value = message.room
              previews.value = {}
              // Nét đã có trong trạng thái server được xác nhận tại chỗ; nét còn thiếu gửi lại nguyên UUID.
              for (const operation of document.value.operations) {
                // Tab khác đổi ẩn/hiện thì bỏ lịch sử phiên cũ; tài liệu chuẩn của server luôn được giữ.
                if (
                  operation.type === 'visibility' &&
                  !previous.has(operation.id) &&
                  !pending.value[operation.id]
                )
                  resetHistory()
                acknowledgeHistory(operation)
              }
              finishJoin()
            } else if (message.type === 'operation.committed' || message.type === 'operation.ack') {
              const ack = message.type === 'operation.ack'
              const next = ack ? message.seq : message.sequence
              const operation = ack ? pending.value[message.id] : frameOperation(message)
              if (!Number.isSafeInteger(next) || next < 1)
                throw new Error('Invalid acknowledgement')
              if (!operation && ack && next <= sequence.value) return
              if (!operation) throw new Error('Unknown acknowledgement')
              const known = knownIds.has(operation.id)
              if (next > sequence.value) {
                if (next !== sequence.value + 1 || known) {
                  socket?.close(4000, 'Resynchronize')
                  return
                }
                if (requiresVector(operation, message.targetSequence)) {
                  forceVector = true
                  connection.close(4000, 'Restore vector document')
                  return
                }
                appendSaved(operation, next)
              } else if (
                known ||
                (ack && renderedSnapshot.value && next <= renderedSnapshot.value.sequence)
              ) {
                confirmSaved(operation)
              } else {
                // Ack cũ không có trong lịch sử không được làm mất một thao tác chưa lưu.
                connection.close(4000, 'Resynchronize')
                return
              }
            } else if (message.type === 'chat.message') {
              // Chat đi chung socket nhưng có lịch sử riêng, không đổi document/sequence nét vẽ.
              if (
                status.value === 'connected' &&
                room.value?.sharingEnabled &&
                isChatMessage(message.message, roomId)
              )
                lastChatMessage.value = message.message
            } else if (message.type === 'operation.preview') {
              if (status.value !== 'connected') return
              if (message.operation?.type === 'visibility') throw new Error('Invalid preview')
              previews.value[message.operation.id] = {
                clientId: message.clientId,
                operation: message.operation,
                seenAt: Date.now(),
              }
            } else if (message.type === 'preview.cancel') {
              if (previews.value[message.operationId]?.clientId === message.clientId)
                delete previews.value[message.operationId]
            } else if (message.type === 'presence') {
              members.value = message.members
              const active = new Set(members.value.map((member) => member.clientId))
              for (const [id, preview] of Object.entries(previews.value))
                if (!active.has(preview.clientId)) delete previews.value[id]
            } else if (message.type === 'error') {
              // Khóa ngay khi server từ chối phiên, không chờ frame đóng socket mới dừng nhận nét.
              if (['AUTH_REQUIRED', 'AUTH_EXPIRED'].includes(message.code)) {
                requireAuthentication()
                return
              }
              error.value = message.message
              // Lỗi ghi không làm mất UUID hoặc nét chờ; giữ cảnh báo qua reconnect đến xác nhận thật.
              if (
                message.code === 'SERVICE_UNAVAILABLE' &&
                Object.hasOwn(pending.value, message.operationId)
              )
                hasSaveError.value = true
              if (
                message.operationId &&
                pending.value[message.operationId] &&
                [
                  'INVALID_INPUT',
                  'OPERATION_CONFLICT',
                  'DOCUMENT_FULL',
                  'OWNER_REQUIRED',
                  'PERSONAL_MODE_REQUIRED',
                ].includes(message.code)
              ) {
                rejected.value.push(pending.value[message.operationId]!)
                delete pending.value[message.operationId]
                historyActions.delete(message.operationId)
              }
              if (['ROOM_NOT_FOUND', 'ROOM_FULL', 'JOIN_REQUIRED'].includes(message.code)) {
                const reasons: Record<string, string> = {
                  ROOM_NOT_FOUND: 'Không tìm thấy phòng hoặc bạn chưa có quyền truy cập.',
                  // Giới hạn tính theo tab/socket; người dùng chủ động nối lại sau khi có chỗ trống.
                  ROOM_FULL:
                    'Dự án đã đủ 10 kết nối, mỗi tab vẽ tính một kết nối. Chờ người khác rời đi hoặc đóng bớt tab vẽ rồi bấm Kết nối lại.',
                  JOIN_REQUIRED: 'Chưa tham gia kết nối phòng. Hãy kết nối lại.',
                }
                const reason = reasons[message.code]!
                if (message.code === 'ROOM_NOT_FOUND') closeRoomAccess(roomId, reason)
                else {
                  disconnect()
                  status.value = 'error'
                  error.value = reason
                }
              } else if (message.code === 'SERVICE_UNAVAILABLE' || message.code === 'RATE_LIMIT')
                socket?.close(4000, 'Retry pending operations')
            }
          } catch {
            error.value = 'Không đọc được trạng thái phòng. Đang thử kết nối lại…'
            connection.close(4000)
          }
        }
        // Khi mất kết nối, dọn trạng thái tạm và thử nối lại theo thời gian chờ tăng dần.
        connection.onclose = (event) => {
          if (current !== generation || socket !== connection) return
          // 4403 là thu quyền chia sẻ, 4404 là dự án bị xóa. Cả hai đều kết thúc phiên vẽ.
          if (event.code === 4403 || event.code === 4404) {
            closeRoomAccess(
              roomId,
              event.code === 4404
                ? 'Dự án đã bị xóa.'
                : 'Chủ dự án đã tắt chia sẻ. Hãy xin link mới nếu muốn tham gia lại.',
            )
            return
          }
          if (event.code === 4401) {
            requireAuthentication()
            return
          }
          retry()
        }
      } catch (cause) {
        // Token của phiên cũ có thể trả lỗi sau khi đã chuyển phòng hoặc đăng xuất; bỏ qua kết quả đó.
        if (current !== generation) return
        if (cause instanceof SignInRequiredError) requireAuthentication()
        else retry()
      }
    }
    await open()
  }
  // Giữ UUID đến acknowledgement và chặn nét mới khi đang phục hồi lỗi ghi của các nét chờ.
  function commit(operation: DrawingEvent) {
    if (status.value === 'connected' && !hasSaveError.value) {
      if (
        operation.type === 'visibility' &&
        (room.value?.ownerId !== accountId ||
          room.value.sharingEnabled ||
          pendingCount.value ||
          rejected.value.length)
      )
        return false
      if (operation.type !== 'visibility' && personalOwner.value)
        historyActions.set(operation.id, { type: 'draw', targetId: operation.id })
      pending.value[operation.id] = operation
      sendCommit(operation)
      return true
    }
    return false
  }
  // Chỉ gửi preview khi có thể vẽ; lỗi ghi đang phục hồi không nhận thêm cử chỉ mới.
  function preview(operation: Operation) {
    if (
      status.value === 'connected' &&
      !hasSaveError.value &&
      (socket?.bufferedAmount ?? 0) < 64 * 1024
    )
      send('operation.preview', { operation })
  }
  // Báo cho phòng bỏ nét xem trước khi thao tác kéo bị hủy.
  function cancelPreview(operationId: string) {
    if (status.value === 'connected') send('preview.cancel', { operationId })
  }
  // Xuất cả lịch sử gốc và thao tác chờ/lỗi, không làm mất nét bị ẩn hay sự kiện cần để khôi phục bản vẽ.
  async function exportDocument() {
    const current = generation
    const activeRoom = target
    const snapshot = renderedSnapshot.value
    const state = snapshot
      ? await api<{ room: Room; document: DrawingDocumentV2 }>(
          `/rooms/${activeRoom}/render-document`,
        )
      : null
    if (state && (current !== generation || target !== activeRoom || state.room.id !== activeRoom))
      throw new Error('Dự án đã thay đổi trong lúc tải bản vẽ.')
    const saved = state ? normalizeDocument(state.document) : document.value
    const savedIds = new Set(saved.operations.map((operation) => operation.id))
    return {
      ...saved,
      operations: [
        ...saved.operations,
        ...[...Object.values(pending.value), ...rejected.value].filter(
          (operation) => !savedIds.has(operation.id),
        ),
      ],
    }
  }
  return {
    document,
    room,
    status,
    error,
    hasSaveError,
    authRequired,
    revokedRoomId,
    sequence,
    members,
    operations,
    confirmedOperations,
    renderOperations,
    pendingStrokes,
    renderedSnapshot,
    pendingCount,
    canUndo,
    canRedo,
    undo,
    redo,
    rejected,
    remotePreviews,
    invitationUrl,
    lastChatMessage,
    prepareRoom,
    leaveRoom,
    forgetRoom,
    hasUnsavedChanges,
    rememberInvitation,
    setAccount,
    reset,
    connect,
    disconnect,
    commit,
    preview,
    cancelPreview,
    exportDocument,
  }
})
