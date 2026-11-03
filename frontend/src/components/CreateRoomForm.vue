<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { SignInButton, useUser } from '@clerk/vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { createRoom } from '../services/rooms'

const { isLoaded, isSignedIn, user } = useUser()
const emit = defineEmits<{ created: [room: Room] }>()
const title = ref('')
const creating = ref(false)
const titleError = ref('')
const requestError = ref('')
const createdRoom = ref<Room | null>(null)
let requestVersion = 0

// Xóa kết quả của tài khoản cũ và bỏ qua phản hồi đang chờ khi đăng xuất hoặc chuyển tài khoản.
function resetForAccount() {
  requestVersion++
  title.value = ''
  titleError.value = ''
  requestError.value = ''
  createdRoom.value = null
  creating.value = false
}

watch([isSignedIn, () => user.value?.id], resetForAccount, { flush: 'sync' })

// Khi rời trang, phản hồi cũ không được cập nhật trạng thái của biểu mẫu đã đóng.
onBeforeUnmount(() => requestVersion++)

// Xóa lỗi nhập liệu sau khi sửa tên; lỗi gửi yêu cầu chỉ được xóa khi người dùng gửi lại.
function clearTitleError() {
  titleError.value = ''
}

// Chuyển mã lỗi an toàn của API thành hướng dẫn tiếng Việt; không hiển thị token hoặc chi tiết nội bộ.
function creationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại rồi thử tạo phòng.'
  }

  const messages: Record<string, string> = {
    AUTH_REQUIRED: 'Vui lòng đăng nhập để tạo phòng.',
    AUTH_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
    INVALID_INPUT: 'Tên phòng cần có từ 1 đến 100 ký tự sau khi bỏ khoảng trắng ở hai đầu.',
    ORIGIN_DENIED: 'Máy chủ chưa cho phép truy cập từ địa chỉ trang này.',
    RATE_LIMIT: 'Bạn gửi quá nhiều yêu cầu. Vui lòng đợi một phút rồi thử lại.',
  }
  return (
    messages[error.code] ||
    'Chưa nhận được xác nhận tạo phòng. Hãy kiểm tra kết nối trước khi thử lại.'
  )
}

// Kiểm tra tên, chặn gửi trùng và chỉ báo thành công sau khi backend xác nhận phòng đã được lưu.
async function submitRoom() {
  if (!isLoaded.value || !isSignedIn.value || !user.value || creating.value) return

  const roomTitle = title.value.trim()
  titleError.value = ''
  requestError.value = ''
  createdRoom.value = null
  if (!roomTitle || roomTitle.length > 100) {
    titleError.value = 'Nhập tên phòng từ 1 đến 100 ký tự, không chỉ gồm khoảng trắng.'
    return
  }

  const version = ++requestVersion
  creating.value = true
  try {
    const result = await createRoom(roomTitle)
    if (version !== requestVersion) return
    // Không giữ token mời trong giao diện hoặc bộ nhớ trình duyệt khi chưa triển khai luồng lời mời.
    createdRoom.value = result.room
    title.value = ''
    // Báo trang Bộ sưu tập tải lại danh sách sau khi phòng đã được lưu thành công.
    emit('created', result.room)
  } catch (error) {
    if (version === requestVersion) requestError.value = creationErrorMessage(error)
  } finally {
    if (version === requestVersion) creating.value = false
  }
}
</script>

<template>
  <section class="create-room-card" aria-labelledby="create-room-heading">
    <p class="eyebrow">KHÔNG GIAN CỦA BẠN</p>
    <h2 id="create-room-heading">Tạo phòng vẽ</h2>
    <p class="create-room-description">
      Đặt tên để tạo một phòng gắn với tài khoản của bạn. Tính năng vẽ chung và lời mời đang được
      hoàn thiện.
    </p>

    <p v-if="!isLoaded" class="create-room-note" role="status">Đang kiểm tra tài khoản…</p>
    <div v-else-if="!isSignedIn" class="create-room-sign-in">
      <p class="create-room-note">Đăng nhập để tạo phòng và lưu thông tin phòng vào tài khoản.</p>
      <SignInButton mode="modal">
        <button class="button button-primary" type="button">Đăng nhập để tạo phòng</button>
      </SignInButton>
    </div>
    <form v-else novalidate :aria-busy="creating" @submit.prevent="submitRoom">
      <label for="room-title">Tên phòng</label>
      <p id="room-title-help" class="create-room-note">
        Từ 1 đến 100 ký tự. Ví dụ: Phác thảo đồ án.
      </p>
      <input
        id="room-title"
        v-model="title"
        type="text"
        name="title"
        maxlength="100"
        required
        autocomplete="off"
        :disabled="creating"
        :aria-invalid="Boolean(titleError)"
        :aria-describedby="titleError ? 'room-title-help room-title-error' : 'room-title-help'"
        @input="clearTitleError"
      />
      <p v-if="titleError" id="room-title-error" class="create-room-error" role="alert">
        {{ titleError }}
      </p>
      <p v-if="requestError" class="create-room-error" role="alert">{{ requestError }}</p>
      <button class="button button-primary" type="submit" :disabled="creating">
        {{ creating ? 'Đang tạo phòng…' : 'Tạo phòng' }}
      </button>
    </form>

    <div v-if="createdRoom" class="create-room-success" role="status">
      <strong>Đã tạo phòng “{{ createdRoom.title }}”.</strong>
      <p>Thông tin phòng đã được lưu. Bạn có thể xem phòng trong danh sách bên dưới.</p>
    </div>
  </section>
</template>

<style scoped>
/* Giữ biểu mẫu cùng màu với Studio, đủ chỗ nhập tên trên cả màn hình nhỏ. */
.create-room-card {
  width: min(100%, 680px);
  margin: 28px auto 0;
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid #e4e9e2;
  border-radius: 18px;
  background: white;
}

h2 {
  margin-bottom: 12px;
  font-size: 30px;
  letter-spacing: -0.04em;
}
.create-room-description,
.create-room-note {
  color: #677584;
  font-size: 14px;
  line-height: 1.7;
}
.create-room-description {
  margin-bottom: 24px;
}
.create-room-note {
  margin: 8px 0 12px;
}
label {
  font-size: 14px;
  font-weight: 700;
}
input {
  display: block;
  width: 100%;
  min-height: 46px;
  padding: 12px;
  border: 1px solid #b8c5b3;
  border-radius: 10px;
  color: #263b53;
  background: #fffefa;
}
form > .button {
  width: 100%;
  min-height: 46px;
  margin-top: 18px;
}
.button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}
.create-room-error {
  margin: 12px 0 0;
  color: #9b473c;
  font-size: 14px;
  line-height: 1.6;
}

/* Thông báo được đọc bởi trình đọc màn hình và cho phép xuống dòng với tên phòng dài. */
.create-room-success {
  margin-top: 22px;
  padding: 16px;
  border: 1px solid #d8e4d1;
  border-radius: 12px;
  background: #f5f8f2;
  color: #526c4d;
  overflow-wrap: anywhere;
}
.create-room-success p {
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
}
</style>
