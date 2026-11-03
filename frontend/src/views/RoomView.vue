<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { SignInButton, useUser } from '@clerk/vue'
import { RouterLink, useRoute } from 'vue-router'
import DrawingCanvas from '../components/DrawingCanvas.vue'
import RoomInvitation from '../components/RoomInvitation.vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { clerkPublishableKey } from '../services/clerk'
import { getRoom } from '../services/rooms'
import { useBoardStore } from '../stores/board'
import { useDrawingStore } from '../stores/drawing'

const route = useRoute()
const board = useBoardStore()
const drawing = useDrawingStore()
// Chỉ gọi hook khi main.ts đã đăng ký Clerk; thiếu cấu hình vẫn hiển thị được trang hướng dẫn.
const session = clerkPublishableKey ? useUser() : null
const isLoaded = session?.isLoaded ?? ref(true)
const isSignedIn = session?.isSignedIn ?? ref(false)
const user = session?.user ?? ref(null)
const room = ref<Room | null>(null)
const loading = ref(false)
const error = ref('')
let requestVersion = 0

// Giữ cỡ bút và cỡ tẩy riêng như Studio; Canvas nhận cỡ của đúng công cụ đang chọn.
const activeSize = computed({
  // Đọc độ rộng áp dụng cho nét kế tiếp.
  get: () => (drawing.tool === 'eraser' ? drawing.eraserSize : drawing.brushSize),
  // Thanh trượt chỉ thay đổi cỡ của công cụ hiện tại.
  set: (size: number) => {
    if (drawing.tool === 'eraser') drawing.eraserSize = size
    else drawing.brushSize = size
  },
})

// Chỉ báo đã kết nối sau khi server xác thực, kiểm tra thành viên và gửi trạng thái phòng.
const connectionStatus = computed(() => {
  if (board.status === 'connected') return 'Đã kết nối phòng.'
  if (board.status === 'connecting') return 'Đang xác thực và tải trạng thái phòng…'
  if (board.status === 'reconnecting') return 'Mất kết nối. Đang thử kết nối lại…'
  if (board.status === 'error') return 'Chưa kết nối được phòng.'
  return 'Chưa kết nối.'
})

// Đóng phiên cũ trước khi tải metadata; chỉ kết nối WebSocket khi đúng tài khoản đã được cấp quyền.
async function loadRoom() {
  const version = ++requestVersion
  board.local()
  room.value = null
  error.value = ''
  loading.value = false
  if (!isLoaded.value || !isSignedIn.value || !user.value) return
  if (typeof route.params.id !== 'string') {
    error.value = 'Đường dẫn phòng không hợp lệ.'
    return
  }

  loading.value = true
  try {
    const result = await getRoom(route.params.id)
    if (version === requestVersion) {
      room.value = result.room
      void board.connect(result.room.id)
    }
  } catch (cause) {
    if (version !== requestVersion) return
    if (cause instanceof ApiError && cause.status === 404) {
      error.value =
        'Không tìm thấy phòng hoặc bạn chưa có quyền truy cập. Hãy kiểm tra liên kết với chủ phòng.'
    } else if (cause instanceof ApiError && cause.status === 400) {
      error.value = 'Đường dẫn phòng không hợp lệ.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      error.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
    } else {
      error.value = 'Không tải được thông tin phòng. Kiểm tra kết nối rồi bấm Tải lại.'
    }
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

// Cho phép thử lại kết nối bằng token mới sau lỗi phiên hoặc phòng đầy mà không tạo thêm phòng.
function reconnectRoom() {
  if (room.value) void board.connect(room.value.id)
}

// Theo dõi cả route để mở liên tiếp hai phòng không giữ thông tin phòng trước; F5 cũng tự tải lại qua API.
watch([isLoaded, isSignedIn, () => user.value?.id, () => route.params.id], loadRoom, {
  immediate: true,
  flush: 'sync',
})

// Rời trang phải đóng socket, hủy timer và xóa dữ liệu phòng khỏi store dùng chung với Studio.
onBeforeUnmount(() => {
  requestVersion++
  board.local()
})
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb">
      <RouterLink to="/gallery">Bộ sưu tập</RouterLink><span>/</span><span>Phòng vẽ</span>
    </div>
    <div class="studio-heading">
      <div>
        <p class="eyebrow">PHÒNG VẼ CHUNG</p>
        <h1>Thông tin phòng<span class="heading-period">.</span></h1>
      </div>
      <RouterLink class="button button-outline" to="/gallery">Về danh sách phòng</RouterLink>
    </div>

    <div class="room-details" :aria-busy="loading">
      <p v-if="!clerkPublishableKey" role="status">
        Đăng nhập chưa được cấu hình. Bạn vẫn có thể sử dụng Studio cá nhân.
      </p>
      <p v-else-if="!isLoaded" role="status">Đang kiểm tra tài khoản…</p>
      <div v-else-if="!isSignedIn">
        <p>Đăng nhập để xem phòng. Chỉ thành viên mới có quyền truy cập.</p>
        <SignInButton mode="modal"
          ><button class="button button-primary" type="button">Đăng nhập</button></SignInButton
        >
      </div>
      <p v-else-if="loading" role="status">Đang tải thông tin phòng…</p>
      <div v-else-if="error">
        <p class="room-error" role="alert">{{ error }}</p>
        <button class="button button-outline" type="button" @click="loadRoom">Tải lại</button>
      </div>
      <div v-else-if="room">
        <h2>{{ room.title }}</h2>
        <p>
          {{ room.ownerId === user?.id ? 'Bạn là chủ phòng.' : 'Bạn là thành viên của phòng.' }}
        </p>
        <div class="room-connection" aria-live="polite">
          <p role="status">{{ connectionStatus }}</p>
          <p v-if="board.status === 'connected'">
            Trạng thái đã tải: {{ board.document.operations.length }} nét · sequence
            {{ board.sequence }}.
          </p>
          <p v-if="board.error" class="room-error">{{ board.error }}</p>
          <button
            v-if="board.status === 'error'"
            class="button button-outline"
            type="button"
            @click="reconnectRoom"
          >
            Kết nối lại
          </button>
        </div>
        <button
          class="button button-outline"
          type="button"
          :disabled="board.pendingCount > 0"
          @click="loadRoom"
        >
          Tải lại thông tin
        </button>
        <!-- Thành viên không thấy nút tạo link; backend vẫn kiểm tra quyền chủ phòng cho mọi yêu cầu. -->
        <RoomInvitation v-if="room.ownerId === user?.id" :key="room.id" :room-id="room.id" />
      </div>
    </div>

    <section v-if="room" class="canvas-panel room-canvas" aria-label="Bản vẽ chung">
      <div class="canvas-panel-header">
        <strong>{{ room.title }}</strong>
        <span>1600 × 900</span>
      </div>
      <!-- Chỉ cho vẽ sau room.state; mất kết nối sẽ khóa điều khiển và hủy nét đang kéo. -->
      <fieldset class="room-tools" :disabled="board.status !== 'connected'">
        <legend>Công cụ vẽ</legend>
        <label for="room-tool"
          >Công cụ
          <select id="room-tool" v-model="drawing.tool">
            <option value="freehand">Bút tự do</option>
            <option value="line">Đường thẳng</option>
            <option value="rectangle">Hình chữ nhật</option>
            <option value="circle">Hình tròn</option>
            <option value="eraser">Tẩy</option>
          </select>
        </label>
        <label v-if="drawing.tool !== 'eraser'" for="room-color"
          >Màu nét
          <input id="room-color" v-model="drawing.color" type="color" />
        </label>
        <label for="room-size"
          >{{ drawing.tool === 'eraser' ? 'Cỡ tẩy' : 'Độ dày' }}
          <input
            id="room-size"
            v-model.number="activeSize"
            type="range"
            min="1"
            max="50"
            step="1"
          />
          <output for="room-size">{{ activeSize }} px</output>
        </label>
      </fieldset>
      <div class="canvas-wrap">
        <!-- Store ghép nét chờ với nét đã xác nhận; chỉ gửi operation khi thả con trỏ. -->
        <DrawingCanvas
          :key="room.id"
          :operations="board.operations"
          :tool="drawing.tool"
          :color="drawing.color"
          :brush-size="activeSize"
          :enabled="board.status === 'connected'"
          @commit="board.commit"
        />
      </div>
      <div class="canvas-panel-footer" role="status" aria-live="polite">
        <span v-if="board.pendingCount">Đang chờ xác nhận {{ board.pendingCount }} nét…</span>
        <span v-else-if="board.status === 'connected'"
          >Các nét hiện có đã được máy chủ xác nhận.</span
        >
        <span v-else>Chưa thể vẽ. Đang chờ kết nối phòng.</span>
        <span>{{ board.document.operations.length }} nét đã xác nhận</span>
      </div>
    </section>
  </section>
</template>

<style scoped>
/* Thẻ thông tin gọn, tự xuống dòng với tên phòng dài và giữ vùng bấm đủ lớn trên điện thoại. */
.room-details {
  width: min(100%, 680px);
  margin: 28px auto 0;
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid #e4e9e2;
  border-radius: 18px;
  background: white;
}
.room-details h2 {
  font-size: 30px;
  overflow-wrap: anywhere;
}
.room-details p {
  color: #677584;
  font-size: 14px;
  line-height: 1.7;
}
.room-details .room-error {
  color: #9b473c;
}
.room-details .button {
  min-height: 44px;
}
.room-connection {
  margin: 18px 0;
  padding: 0 16px;
  border-left: 3px solid #557c63;
}
.room-canvas {
  margin-top: 24px;
}
.room-canvas .canvas-panel-header strong {
  min-width: 0;
  overflow-wrap: anywhere;
}
.room-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin: 0;
  padding: 12px 20px;
  border: 0;
  font-size: 14px;
}
.room-tools label {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.room-tools select,
.room-tools input[type='color'] {
  min-height: 44px;
  border: 1px solid #d5dfd4;
  border-radius: 6px;
  background: white;
}
.room-tools:disabled {
  opacity: 0.6;
}
</style>
