import { ref } from 'vue'
import { defineStore } from 'pinia'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { listRooms } from '../services/rooms'

// Giữ danh sách trong bộ nhớ khi chuyển trang; dữ liệu chỉ thuộc một tài khoản hiện tại.
export const useProjectsStore = defineStore('projects', () => {
  const rooms = ref<Room[]>([])
  const loading = ref(false)
  const hasLoaded = ref(false)
  const error = ref('')
  const activeGroup = ref<'personal' | 'shared'>('personal')
  let accountId = ''
  let requestVersion = 0

  // Đăng xuất/đổi tài khoản xóa cache ngay và vô hiệu hóa mọi phản hồi của phiên trước.
  function setAccount(userId: string) {
    if (userId === accountId) return
    accountId = userId
    requestVersion++
    rooms.value = []
    loading.value = false
    hasLoaded.value = false
    error.value = ''
    activeGroup.value = 'personal'
  }

  // Tải lần đầu hoặc cập nhật ngầm, giữ card cũ trong lúc chờ và gộp các yêu cầu đang chạy.
  async function loadRooms() {
    if (!accountId || loading.value) return
    const version = ++requestVersion
    loading.value = true
    error.value = ''
    try {
      const result = await listRooms()
      if (version !== requestVersion) return
      rooms.value = result.rooms
      hasLoaded.value = true
    } catch (cause) {
      if (version !== requestVersion) return
      if (!(cause instanceof ApiError) || cause.status === 401) {
        rooms.value = []
        hasLoaded.value = false
        error.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
      } else {
        error.value = hasLoaded.value
          ? 'Chưa cập nhật được danh sách. Dữ liệu đã tải vẫn được giữ; hãy bấm Tải lại.'
          : 'Không tải được danh sách dự án. Kiểm tra kết nối rồi bấm Tải lại.'
      }
    } finally {
      if (version === requestVersion) loading.value = false
    }
  }

  // Thêm dự án vừa tạo vào cache; phản hồi GET cũ không được ghi đè mất thẻ mới.
  function addCreatedRoom(room: Room) {
    if (!accountId || room.ownerId !== accountId) return
    requestVersion++
    loading.value = false
    rooms.value = [room, ...rooms.value.filter((item) => item.id !== room.id)]
    hasLoaded.value = true
    error.value = ''
    activeGroup.value = 'personal'
  }

  return { rooms, loading, hasLoaded, error, activeGroup, setAccount, loadRooms, addCreatedRoom }
})
