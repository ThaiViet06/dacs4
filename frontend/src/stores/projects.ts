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
  const notice = ref('')
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
    notice.value = ''
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

  // Cập nhật tên trong card đã có, giữ bộ lọc/nét/sequence và bỏ GET cũ có thể trả lại tên trước đó.
  function updateRenamedRoom(room: Room) {
    if (!accountId || room.ownerId !== accountId) return
    requestVersion++
    loading.value = false
    rooms.value = rooms.value.map((item) =>
      item.id === room.id ? { ...item, title: room.title, updatedAt: room.updatedAt } : item,
    )
  }

  // Chuyển card sang đúng nhóm sau khi server xác nhận, không ghi đè sequence mới hơn hoặc dữ liệu tài khoản khác.
  function updateSharedRoom(room: Room) {
    if (!accountId || room.ownerId !== accountId) return
    requestVersion++
    loading.value = false
    rooms.value = rooms.value.map((item) =>
      item.id === room.id
        ? { ...item, sharingEnabled: room.sharingEnabled, updatedAt: room.updatedAt }
        : item,
    )
    activeGroup.value = room.sharingEnabled ? 'shared' : 'personal'
  }

  // Thu quyền loại card ngay, bỏ GET đang chờ và giữ lý do để trang Studio thông báo sau điều hướng.
  function removeRoom(roomId: string, message: string) {
    requestVersion++
    loading.value = false
    rooms.value = rooms.value.filter((item) => item.id !== roomId)
    notice.value = message
  }

  return {
    rooms,
    loading,
    hasLoaded,
    error,
    activeGroup,
    notice,
    setAccount,
    loadRooms,
    addCreatedRoom,
    updateRenamedRoom,
    updateSharedRoom,
    removeRoom,
  }
})
