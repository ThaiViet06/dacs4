<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { SignInButton, useUser } from '@clerk/vue'
import { RouterLink, useRoute } from 'vue-router'
import StudioEditor from '../components/StudioEditor.vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { clerkPublishableKey } from '../services/clerk'
import { getRoom } from '../services/rooms'
import { useBoardStore } from '../stores/board'

const route = useRoute()
const board = useBoardStore()
// Chỉ gọi hook khi main.ts đã đăng ký Clerk; bản nháp local vẫn dùng được khi thiếu cấu hình.
const session = clerkPublishableKey ? useUser() : null
const isLoaded = session?.isLoaded ?? ref(true)
const isSignedIn = session?.isSignedIn ?? ref(false)
const user = session?.user ?? ref(null)
const room = ref<Room | null>(null)
const loading = ref(false)
const error = ref('')
let requestVersion = 0

// Hiện cache ở chế độ khóa vẽ, rồi kiểm tra quyền và đồng bộ; phản hồi phiên cũ luôn bị bỏ qua.
async function loadRoom() {
  const version = ++requestVersion
  board.setAccount(isLoaded.value && isSignedIn.value ? (user.value?.id ?? '') : '')
  room.value = null
  error.value = ''
  loading.value = false
  if (!isLoaded.value || !isSignedIn.value || !user.value) return
  if (typeof route.params.id !== 'string') {
    board.leaveRoom()
    error.value = 'Đường dẫn dự án không hợp lệ.'
    return
  }
  const roomId = route.params.id
  room.value = board.prepareRoom(roomId)
  loading.value = true
  try {
    const result = await getRoom(roomId)
    if (version === requestVersion) {
      room.value = result.room
      board.room = result.room
      void board.connect(result.room.id)
    }
  } catch (cause) {
    if (version !== requestVersion) return
    if (!(cause instanceof ApiError) || cause.status === 401) {
      board.reset()
      room.value = null
    } else if ([400, 403, 404].includes(cause.status ?? 0)) {
      board.forgetRoom(roomId)
      room.value = null
    }
    if (cause instanceof ApiError && cause.status === 404) {
      error.value =
        'Không tìm thấy dự án hoặc bạn chưa có quyền truy cập. Hãy kiểm tra liên kết với chủ dự án.'
    } else if (cause instanceof ApiError && cause.status === 400) {
      error.value = 'Đường dẫn dự án không hợp lệ.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      error.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
    } else {
      error.value = 'Không tải được dự án. Kiểm tra kết nối rồi bấm Tải lại.'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

// F5 hoặc đổi ID/phiên đều lấy lại metadata; thay đổi tài khoản phải dọn bản vẽ cũ ngay.
watch([isLoaded, isSignedIn, () => user.value?.id, () => route.params.id], loadRoom, {
  immediate: true,
  flush: 'sync',
})

// Rời trang đóng socket và giữ phiên/nét chờ; bản nháp Vẽ thử thuộc store riêng nên không bị xóa.
onBeforeUnmount(() => {
  requestVersion++
  board.leaveRoom()
})
</script>

<template>
  <StudioEditor
    v-if="room && !error"
    :key="room.id"
    :room="room"
    :is-owner="room.ownerId === user?.id"
  />
  <section v-else class="studio-page page-container">
    <div class="breadcrumb">
      <RouterLink to="/studio">Studio</RouterLink><span>/</span><span>Mở dự án</span>
    </div>
    <div class="studio-heading">
      <h1>Mở bản vẽ trong Studio<span class="heading-period">.</span></h1>
    </div>
    <div class="studio-access-card" :aria-busy="loading">
      <p v-if="!clerkPublishableKey" role="status">
        Đăng nhập chưa được cấu hình. Bạn vẫn có thể vẽ thử trong Studio cá nhân.
      </p>
      <p v-else-if="!isLoaded" role="status">Đang kiểm tra tài khoản…</p>
      <div v-else-if="!isSignedIn">
        <p>Đăng nhập để mở dự án. Chỉ người có quyền mới được truy cập.</p>
        <SignInButton mode="modal"
          ><button class="button button-primary" type="button">Đăng nhập</button></SignInButton
        >
      </div>
      <p v-else-if="loading" role="status">Đang tải bản vẽ…</p>
      <div v-else-if="error">
        <p class="studio-access-error" role="alert">{{ error }}</p>
        <button class="button button-outline" type="button" @click="loadRoom">Tải lại</button>
      </div>
      <RouterLink class="text-link" to="/studio">Về Studio</RouterLink>
    </div>
  </section>
</template>

<style scoped>
.studio-access-card {
  max-width: 680px;
  padding: 28px;
  border: 1px solid #e4e9e2;
  border-radius: 18px;
  background: white;
}
.studio-access-card p {
  color: #677584;
  line-height: 1.7;
}
.studio-access-card .studio-access-error {
  color: #9b473c;
}
.studio-access-card .text-link {
  display: inline-block;
  margin-top: 20px;
}
</style>
