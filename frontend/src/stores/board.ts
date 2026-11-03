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

// Store giữ bản vẽ cá nhân hoặc trạng thái phòng chung, gồm cả thao tác chưa được máy chủ xác nhận.
export const useBoardStore = defineStore('board', () => {
  const document = ref<DrawingDocument>(emptyDocument())
  const room = ref<Room | null>(null)
  const status = ref<'local' | 'connecting' | 'connected' | 'reconnecting' | 'error'>('local')
  const error = ref('')
  const sequence = ref(0)
  const members = ref<{ clientId: string; userId: string }[]>([])
  const pending = ref<Record<string, Operation>>({})
  const rejected = ref<Operation[]>([])
  const previews = ref<Record<string, { clientId: string; operation: Operation; seenAt: number }>>(
    {},
  )
  // Chỉ Studio cá nhân dùng lịch sử này; thao tác phòng chung đã lưu trên máy chủ không bị xóa ngược.
  const redoStack = ref<Operation[]>([])
  // Ghép thao tác đã xác nhận với nét đang chờ để người dùng thấy ngay nét vừa vẽ.
  const operations = computed(() => [...document.value.operations, ...Object.values(pending.value)])
  // Chỉ cho hoàn tác thao tác trên bản vẽ cá nhân khi còn nét đã lưu.
  const canUndo = computed(() => status.value === 'local' && document.value.operations.length > 0)
  // Chỉ cho làm lại trên bản vẽ cá nhân khi còn nét trong lịch sử hoàn tác.
  const canRedo = computed(() => status.value === 'local' && redoStack.value.length > 0)
  // Đếm nét đã gửi nhưng chưa được máy chủ xác nhận.
  const pendingCount = computed(() => Object.keys(pending.value).length)
  // Trích các nét tạm thời của người khác để hiển thị ở lớp xem trước.
  const remotePreviews = computed(() => Object.values(previews.value).map((item) => item.operation))
  let socket: WebSocket | undefined
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let tokenTimer: ReturnType<typeof setTimeout> | undefined
  let watchdog: ReturnType<typeof setTimeout> | undefined
  let previewTimer: ReturnType<typeof setInterval> | undefined
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
  // Chuyển về trang vẽ cá nhân trống và xóa dữ liệu của phòng trước đó.
  function local() {
    disconnect()
    target = ''
    room.value = null
    sequence.value = 0
    pending.value = {}
    rejected.value = []
    // Trang giấy mới bắt đầu một lịch sử riêng, không thể làm lại nét của trang cũ.
    redoStack.value = []
    document.value = emptyDocument()
    status.value = 'local'
    error.value = ''
  }
  // Chuẩn bị kết nối phòng; giữ nét đang chờ khi nối lại đúng phòng cũ.
  async function connect(roomId: string) {
    disconnect()
    redoStack.value = []
    if (target !== roomId) {
      pending.value = {}
      rejected.value = []
      document.value = emptyDocument()
      sequence.value = 0
      room.value = null
    }
    target = roomId
    attempt = 0
    error.value = ''
    const current = generation
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
                      error.value = 'Vui lòng đăng nhập lại để kết nối.'
                      connection.close(4401)
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
              const known = new Set(document.value.operations.map((operation) => operation.id))
              for (const [id, operation] of Object.entries(pending.value)) {
                if (known.has(id)) delete pending.value[id]
                else send('operation.commit', { operation })
              }
              status.value = 'connected'
              attempt = 0
              error.value = ''
            } else if (message.type === 'operation.committed') {
              delete pending.value[message.operation.id]
              delete previews.value[message.operation.id]
              if (message.sequence > sequence.value) {
                if (message.sequence !== sequence.value + 1) {
                  socket?.close(4000, 'Resynchronize')
                  return
                }
                document.value.operations.push(message.operation)
                sequence.value = message.sequence
              }
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
                disconnect()
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
          clearTimeout(tokenTimer)
          clearTimeout(watchdog)
          previews.value = {}
          members.value = []
          if (event.code === 4401) {
            disconnect()
            status.value = 'error'
            error.value = 'Phiên đăng nhập đã hết hạn. Đăng nhập lại rồi kết nối.'
            return
          }
          status.value = 'reconnecting'
          error.value = 'Kết nối bị gián đoạn. Đang chờ kết nối lại với máy chủ.'
          const delay =
            Math.min(30000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.2)
          // Thử mở lại cùng phòng, sau đó gửi lại nét chưa được xác nhận.
          retryTimer = setTimeout(open, delay)
        }
      } catch {
        // Token của phiên cũ có thể trả lỗi sau khi đã chuyển phòng hoặc đăng xuất; bỏ qua kết quả đó.
        if (current !== generation) return
        disconnect()
        status.value = 'error'
        error.value = 'Không thể xác thực kết nối. Kiểm tra mạng hoặc đăng nhập lại.'
      }
    }
    await open()
  }
  // Lưu nét tại chỗ hoặc gửi nét lên phòng và chờ máy chủ xác nhận.
  function commit(operation: Operation) {
    if (status.value === 'local') {
      // Một nét mới sau khi hoàn tác tạo nhánh mới, nên xóa các nét có thể làm lại.
      redoStack.value = []
      document.value.operations.push(operation)
    } else if (status.value === 'connected') {
      pending.value[operation.id] = operation
      send('operation.commit', { operation })
    }
  }
  // Chuyển nét cuối cùng của trang cá nhân sang lịch sử làm lại.
  function undoLocal() {
    if (!canUndo.value) return
    const operation = document.value.operations.pop()
    if (operation) redoStack.value.push(operation)
  }
  // Đưa nét vừa hoàn tác trở lại bản vẽ cá nhân.
  function redoLocal() {
    if (!canRedo.value) return
    // Giữ nguyên ID và thứ tự thao tác để canvas phát lại cả nét vẽ lẫn nét tẩy chính xác.
    const operation = redoStack.value.pop()
    if (operation) document.value.operations.push(operation)
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
    sequence,
    members,
    operations,
    canUndo,
    canRedo,
    pendingCount,
    rejected,
    remotePreviews,
    local,
    connect,
    disconnect,
    commit,
    undoLocal,
    redoLocal,
    preview,
    cancelPreview,
    exportDocument,
  }
})
