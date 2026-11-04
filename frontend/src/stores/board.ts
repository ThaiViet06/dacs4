import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import {
  emptyDocument,
  WIDTH,
  HEIGHT,
  type Operation,
  type DrawingDocument,
  type Room,
} from '../drawing/model'
import { getToken } from '../services/auth'
import { WS_URL } from '../services/api'

interface RoomSession {
  room: Room | null
  document: DrawingDocument
  sequence: number
  pending: Record<string, Operation>
  rejected: Operation[]
  invitationUrl: string
}

// Giữ phiên dự án theo tài khoản; bản nháp Vẽ thử nằm ở store draft riêng.
export const useBoardStore = defineStore('board', () => {
  const document = ref<DrawingDocument>(emptyDocument())
  const room = ref<Room | null>(null)
  const status = ref<'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('idle')
  const error = ref('')
  const revokedRoomId = ref('')
  const sequence = ref(0)
  const members = ref<{ clientId: string; userId: string }[]>([])
  const pending = ref<Record<string, Operation>>({})
  const rejected = ref<Operation[]>([])
  const previews = ref<Record<string, { clientId: string; operation: Operation; seenAt: number }>>(
    {},
  )
  const invitationUrl = ref('')
  const sessions = new Map<string, RoomSession>()
  let accountId = ''
  // Ghép thao tác đã xác nhận với nét đang chờ để người dùng thấy ngay nét vừa vẽ.
  const operations = computed(() => [...document.value.operations, ...Object.values(pending.value)])
  // Đếm nét đã gửi nhưng chưa được máy chủ xác nhận.
  const pendingCount = computed(() => Object.keys(pending.value).length)
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
  // Gửi một thông điệp đúng phiên bản giao thức khi WebSocket đang mở.
  function send(type: string, data: Record<string, unknown> = {}) {
    if (socket?.readyState !== WebSocket.OPEN) return false
    socket.send(JSON.stringify({ v: 1, type, ...data }))
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
  // Xóa phần đang hiển thị, không xóa các phiên đã giữ để mở lại dự án sau.
  function clearActive() {
    target = ''
    room.value = null
    sequence.value = 0
    pending.value = {}
    rejected.value = []
    invitationUrl.value = ''
    document.value = emptyDocument()
    status.value = 'idle'
    error.value = ''
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
  // Chuẩn bị kết nối phòng; giữ nét đang chờ khi nối lại đúng phòng cũ.
  async function connect(roomId: string) {
    if (target !== roomId) prepareRoom(roomId)
    else disconnect()
    attempt = 0
    error.value = ''
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
            if (message.v !== 1)
              throw new Error('Phiên bản kết nối không tương thích. Vui lòng tải lại trang.')
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
                  } catch {
                    if (current === generation && socket === connection) {
                      // Lỗi tải token có thể do mất mạng; server mới quyết định phiên đã hết hạn bằng 4401.
                      connection.close(4000, 'Retry token refresh')
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
                message.document?.version !== 1 ||
                message.document.width !== WIDTH ||
                message.document.height !== HEIGHT ||
                !Array.isArray(message.document.operations)
              )
                throw new Error('Trạng thái phòng không hợp lệ. Đang thử tải lại…')
              document.value = message.document
              sequence.value = message.sequence
              room.value = message.room
              previews.value = {}
              clearTimeout(watchdog)
              // Nét đã có trong trạng thái server được xác nhận tại chỗ; nét còn thiếu gửi lại nguyên UUID.
              const known = new Set(document.value.operations.map((operation) => operation.id))
              for (const [id, operation] of Object.entries(pending.value)) {
                if (known.has(id)) delete pending.value[id]
                else send('operation.commit', { operation })
              }
              status.value = 'connected'
              attempt = 0
              error.value = ''
            } else if (message.type === 'operation.committed') {
              if (message.sequence > sequence.value) {
                if (message.sequence !== sequence.value + 1) {
                  socket?.close(4000, 'Resynchronize')
                  return
                }
                document.value.operations.push(message.operation)
                sequence.value = message.sequence
              }
              // Chỉ bỏ nét chờ sau khi xử lý đúng sequence; nếu thiếu sequence thì giữ lại đến lúc tải lại phòng.
              delete pending.value[message.operation.id]
              delete previews.value[message.operation.id]
            } else if (message.type === 'operation.preview') {
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
              error.value = message.message
              if (
                message.operationId &&
                pending.value[message.operationId] &&
                ['INVALID_INPUT', 'OPERATION_CONFLICT', 'DOCUMENT_FULL'].includes(message.code)
              ) {
                rejected.value.push(pending.value[message.operationId]!)
                delete pending.value[message.operationId]
              }
              if (['ROOM_NOT_FOUND', 'ROOM_FULL', 'JOIN_REQUIRED'].includes(message.code)) {
                const reasons: Record<string, string> = {
                  ROOM_NOT_FOUND: 'Không tìm thấy phòng hoặc bạn chưa có quyền truy cập.',
                  ROOM_FULL: 'Phòng đã đủ 10 kết nối. Hãy thử lại sau.',
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
            reset()
            status.value = 'error'
            error.value = 'Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi kết nối.'
            return
          }
          retry()
        }
      } catch {
        // Token của phiên cũ có thể trả lỗi sau khi đã chuyển phòng hoặc đăng xuất; bỏ qua kết quả đó.
        if (current !== generation) return
        retry()
      }
    }
    await open()
  }
  // Chỉ gửi nét khi room.state đã được xác nhận; giữ UUID trong pending đến khi nhận acknowledgement.
  function commit(operation: Operation) {
    if (status.value === 'connected') {
      pending.value[operation.id] = operation
      send('operation.commit', { operation })
    }
  }
  // Gửi nét đang kéo để thành viên khác nhìn thấy trước khi nét được lưu.
  function preview(operation: Operation) {
    if (status.value === 'connected') send('operation.preview', { operation })
  }
  // Báo cho phòng bỏ nét xem trước khi thao tác kéo bị hủy.
  function cancelPreview(operationId: string) {
    if (status.value === 'connected') send('preview.cancel', { operationId })
  }
  // Tạo bản tài liệu gồm nét đã lưu, đang chờ và bị từ chối để người dùng có thể giữ lại.
  function exportDocument() {
    return { ...document.value, operations: [...operations.value, ...rejected.value] }
  }
  return {
    document,
    room,
    status,
    error,
    revokedRoomId,
    sequence,
    members,
    operations,
    pendingCount,
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
