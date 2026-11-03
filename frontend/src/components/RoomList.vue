<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useUser } from '@clerk/vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { listRooms } from '../services/rooms'

const props = defineProps<{ refreshKey: number }>()
const { isLoaded, isSignedIn, user } = useUser()
const rooms = ref<Room[]>([])
const loading = ref(false)
const error = ref('')
let requestVersion = 0

// Tải phòng theo token hiện tại; xóa dữ liệu cũ và bỏ qua phản hồi trễ khi đổi tài khoản hoặc tải lại.
async function loadRooms() {
  const version = ++requestVersion
  rooms.value = []
  error.value = ''
  loading.value = false
  if (!isLoaded.value || !isSignedIn.value || !user.value) return

  loading.value = true
  try {
    const result = await listRooms()
    if (version === requestVersion) rooms.value = result.rooms
  } catch (cause) {
    if (version !== requestVersion) return
    error.value =
      cause instanceof ApiError && cause.status !== 401
        ? 'Không tải được danh sách phòng. Kiểm tra kết nối rồi bấm Tải lại.'
        : 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

// Tự tải sau khi Clerk sẵn sàng, đổi tài khoản hoặc tạo phòng; không giữ cache qua các phiên đăng nhập.
watch([isLoaded, isSignedIn, () => user.value?.id, () => props.refreshKey], loadRooms, {
  immediate: true,
})

// Phản hồi của yêu cầu đang chờ không được ghi lại dữ liệu khi người dùng đã rời trang.
onBeforeUnmount(() => requestVersion++)
</script>

<template>
  <section class="room-list-card" aria-labelledby="room-list-heading" :aria-busy="loading">
    <div class="room-list-heading">
      <h2 id="room-list-heading">Phòng của bạn</h2>
      <button
        v-if="isLoaded && isSignedIn"
        class="button button-outline"
        type="button"
        :disabled="loading"
        @click="loadRooms"
      >
        Tải lại
      </button>
    </div>
    <p v-if="!isLoaded" class="room-list-note" role="status">Đang kiểm tra tài khoản…</p>
    <p v-else-if="!isSignedIn" class="room-list-note">Đăng nhập để xem các phòng của bạn.</p>
    <p v-else-if="loading" class="room-list-note" role="status">Đang tải phòng…</p>
    <p v-else-if="error" class="room-list-error" role="alert">{{ error }}</p>
    <p v-else-if="!rooms.length" class="room-list-note" role="status">
      Bạn chưa có phòng nào. Tạo phòng bằng biểu mẫu bên trên.
    </p>
    <ul v-else class="room-list" aria-label="Phòng đã tạo hoặc tham gia">
      <li v-for="room in rooms" :key="room.id" class="room-list-item">
        <h3>{{ room.title }}</h3>
        <span class="room-role">{{ room.ownerId === user?.id ? 'Chủ phòng' : 'Thành viên' }}</span>
        <RouterLink
          class="button button-outline room-open"
          :to="{ name: 'room', params: { id: room.id } }"
          :aria-label="`Mở phòng ${room.title}`"
          >Mở phòng</RouterLink
        >
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Danh sách chỉ hiển thị thông tin cần thiết, cùng kích thước với biểu mẫu tạo phòng. */
.room-list-card {
  width: min(100%, 680px);
  margin: 24px auto 0;
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid #e4e9e2;
  border-radius: 18px;
  background: white;
}
.room-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -0.04em;
}
.room-list-heading .button {
  min-height: 44px;
  padding: 10px 14px;
  flex-shrink: 0;
}
.button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}
.room-list-note,
.room-list-error {
  margin: 18px 0 0;
  font-size: 14px;
  line-height: 1.7;
}
.room-list-note {
  color: #677584;
}
.room-list-error {
  color: #9b473c;
}
.room-list {
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
}
.room-list-item {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 16px 0;
  border-top: 1px solid #e4e9e2;
}
.room-list-item h3 {
  min-width: 0;
  margin: 0;
  font-size: 17px;
  overflow-wrap: anywhere;
  flex: 1 1 180px;
}
.room-role {
  padding: 6px 10px;
  border-radius: 8px;
  color: #526c4d;
  background: #f5f8f2;
  font-size: 12px;
}
.room-open {
  min-height: 44px;
  padding: 10px 14px;
  flex-shrink: 0;
}
</style>
