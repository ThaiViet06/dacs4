import { computed, ref, watch } from 'vue'
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
import { WS_URL } from '../services/api'

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
  const members = ref<{ clientId: string; userId: string }[]>([])
  const pending = ref<Record<string, DrawingEvent>>({})
  const rejected = ref<DrawingEvent[]>([])
  const previews = ref<Record<string, { clientId: string; operation: Operation; seenAt: number }>>(
    {},
  )
  const invitationUrl = ref('')
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
  // Đóng kết nối hiện tại, hủy bộ hẹn giờ và bỏ trạng thái hiện diện tạm thời.
  function disconnect() {
    generation++
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
    target = ''
    room.value = null
    sequence.value = 0
    pending.value = {}
    hasSaveError.value = false
    rejected.value = []
    invitationUrl.value = ''
    document.value = normalizeDocument(emptyDocument())
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
      document: document.value,
      sequence: sequence.value,
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
  // Link chỉ được nhớ cho đúng dự án đang mở và đúng tài khoản chủ, không gửi lại yêu cầu tạo link.
  function rememberInvitation(roomId: string, url: string) {
    if (target === roomId && room.value?.ownerId === accountId) invitationUrl.value = url
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
          if (current !== generation || socket !== connection) return
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
            if (message.type === 'auth.ok') {
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
              if (status.value !== 'connected') send('room.join', { roomId })
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
              const previous = new Set(document.value.operations.map((operation) => operation.id))
              document.value = normalizeDocument(message.document)
              sequence.value = message.sequence
              room.value = message.room
              previews.value = {}
              clearTimeout(watchdog)
              // Nét đã có trong trạng thái server được xác nhận tại chỗ; nét còn thiếu gửi lại nguyên UUID.
              const known = new Set(document.value.operations.map((operation) => operation.id))
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
              for (const [id, operation] of Object.entries(pending.value)) {
                if (known.has(id)) delete pending.value[id]
                else send('operation.commit', { operation })
              }
              status.value = 'connected'
              attempt = 0
              error.value = ''
            } else if (message.type === 'operation.committed') {
              if (
                !Number.isSafeInteger(message.sequence) ||
                message.sequence < 1 ||
                typeof message.operation?.id !== 'string'
              )
                throw new Error('Invalid acknowledgement')
              const known = document.value.operations.some(
                (operation) => operation.id === message.operation.id,
              )
              if (message.sequence > sequence.value) {
                if (message.sequence !== sequence.value + 1 || known) {
                  socket?.close(4000, 'Resynchronize')
                  return
                }
                document.value.operations.push(message.operation)
                sequence.value = message.sequence
                if (message.operation.type === 'visibility' && !pending.value[message.operation.id])
                  resetHistory()
              } else if (!known) {
                // Ack cũ không có trong lịch sử không được làm mất một thao tác chưa lưu.
                connection.close(4000, 'Resynchronize')
                return
              }
              acknowledgeHistory(message.operation)
              // Chỉ bỏ nét chờ sau khi xử lý đúng sequence; nếu thiếu sequence thì giữ lại đến lúc tải lại phòng.
              delete pending.value[message.operation.id]
              delete previews.value[message.operation.id]
            } else if (message.type === 'operation.preview') {
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
                if (message.code === 'ROOM_NOT_FOUND') forgetRoom(roomId)
                else disconnect()
                status.value = 'error'
                error.value = reasons[message.code]!
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
          // Thu quyền là kết thúc truy cập, không phải mất mạng: xóa cache và báo trang dự án để quay về Studio.
          if (event.code === 4403) {
            forgetRoom(roomId)
            status.value = 'error'
            error.value = 'Chủ dự án đã tắt chia sẻ. Hãy xin link mới nếu muốn tham gia lại.'
            revokedRoomId.value = roomId
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
      send('operation.commit', { operation })
      return true
    }
    return false
  }
  // Chỉ gửi preview khi có thể vẽ; lỗi ghi đang phục hồi không nhận thêm cử chỉ mới.
  function preview(operation: Operation) {
    if (status.value === 'connected' && !hasSaveError.value)
      send('operation.preview', { operation })
  }
  // Báo cho phòng bỏ nét xem trước khi thao tác kéo bị hủy.
  function cancelPreview(operationId: string) {
    if (status.value === 'connected') send('preview.cancel', { operationId })
  }
  // Xuất cả lịch sử gốc và thao tác chờ/lỗi, không làm mất nét bị ẩn hay sự kiện cần để khôi phục bản vẽ.
  function exportDocument() {
    return {
      ...document.value,
      operations: [
        ...document.value.operations,
        ...Object.values(pending.value),
        ...rejected.value,
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
    pendingCount,
    canUndo,
    canRedo,
    undo,
    redo,
    rejected,
    remotePreviews,
    invitationUrl,
    prepareRoom,
    leaveRoom,
    forgetRoom,
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
