<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useUser } from '@clerk/vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { createRoom } from '../services/rooms'

const { isLoaded, isSignedIn, user } = useUser()
const emit = defineEmits<{ created: [room: Room] }>()
const title = ref('')
const creating = ref(false)
const titleError = ref('')
const requestError = ref('')
const createDialog = ref<HTMLDialogElement | null>(null)
let requestVersion = 0

// Xóa kết quả của tài khoản cũ và bỏ qua phản hồi đang chờ khi đăng xuất hoặc chuyển tài khoản.
function resetForAccount() {
  requestVersion++
  title.value = ''
  titleError.value = ''
  requestError.value = ''
  creating.value = false
  closeDialog()
}

watch([isSignedIn, () => user.value?.id], resetForAccount, { flush: 'sync' })

// Khi rời trang, bỏ phản hồi đang chờ và đóng dialog của trang cũ.
onBeforeUnmount(() => {
  requestVersion++
  createDialog.value?.close()
})

// Thẻ dấu cộng mở biểu mẫu trống; showModal giữ focus và bàn phím bên trong hộp.
function openDialog() {
  if (!isLoaded.value || !isSignedIn.value || creating.value) return
  title.value = ''
  titleError.value = ''
  requestError.value = ''
  createDialog.value?.showModal()
}

// Chưa có xác nhận từ server thì không đóng hộp, tránh người dùng vô tình gửi tạo trùng.
function closeDialog() {
  if (!creating.value && createDialog.value?.open) createDialog.value.close()
}

// Xóa lỗi nhập liệu sau khi sửa tên; lỗi gửi yêu cầu chỉ được xóa khi người dùng gửi lại.
function clearTitleError() {
  titleError.value = ''
}

// Chuyển mã lỗi an toàn của API thành hướng dẫn tiếng Việt; không hiển thị token hoặc chi tiết nội bộ.
function creationErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại rồi thử tạo dự án.'
  }

  const messages: Record<string, string> = {
    AUTH_REQUIRED: 'Vui lòng đăng nhập để tạo dự án.',
    AUTH_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
    INVALID_INPUT: 'Tên dự án cần có từ 1 đến 100 ký tự sau khi bỏ khoảng trắng ở hai đầu.',
    ORIGIN_DENIED: 'Máy chủ chưa cho phép truy cập từ địa chỉ trang này.',
    RATE_LIMIT: 'Bạn gửi quá nhiều yêu cầu. Vui lòng đợi một phút rồi thử lại.',
  }
  return (
    messages[error.code] ||
    'Chưa nhận được xác nhận tạo dự án. Hãy kiểm tra kết nối trước khi thử lại.'
  )
}

// Kiểm tra tên, chặn gửi trùng và chỉ báo thành công sau khi backend xác nhận dự án đã được lưu.
async function submitRoom() {
  if (!isLoaded.value || !isSignedIn.value || !user.value || creating.value) return

  const roomTitle = title.value.trim()
  titleError.value = ''
  requestError.value = ''
  if (!roomTitle || roomTitle.length > 100) {
    titleError.value = 'Nhập tên dự án từ 1 đến 100 ký tự, không chỉ gồm khoảng trắng.'
    return
  }

  const version = ++requestVersion
  creating.value = true
  try {
    const result = await createRoom(roomTitle)
    if (version !== requestVersion) return
    title.value = ''
    createDialog.value?.close()
    // Gửi ID đã được server xác nhận để Studio mở ngay editor của dự án mới.
    emit('created', result.room)
  } catch (error) {
    if (version === requestVersion) requestError.value = creationErrorMessage(error)
  } finally {
    if (version === requestVersion) creating.value = false
  }
}
</script>

<template>
  <button
    class="create-project-tile"
    type="button"
    aria-label="Tạo dự án mới"
    aria-haspopup="dialog"
    :disabled="!isLoaded || !isSignedIn"
    @click="openDialog"
  >
    <span class="create-project-plus" aria-hidden="true">+</span>
    <strong>Tạo dự án mới</strong>
    <span>{{ isSignedIn ? 'Bắt đầu từ một trang giấy trống' : 'Đăng nhập để tạo dự án' }}</span>
  </button>
  <dialog
    ref="createDialog"
    class="studio-reset-dialog"
    aria-labelledby="create-room-heading"
    @cancel.prevent="closeDialog"
  >
    <div class="create-room-content">
      <p class="eyebrow">TRANG GIẤY MỚI</p>
      <h2 id="create-room-heading">Tạo dự án</h2>
      <p class="create-room-note">Dự án mới là riêng tư. Các nét vẽ sẽ được tự động lưu.</p>
      <form novalidate :aria-busy="creating" @submit.prevent="submitRoom">
        <label for="room-title">Tên dự án</label>
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
          autofocus
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
        <div class="create-room-actions">
          <button
            class="button button-outline"
            type="button"
            :disabled="creating"
            @click="closeDialog"
          >
            Hủy
          </button>
          <button class="button button-primary" type="submit" :disabled="creating">
            {{ creating ? 'Đang tạo…' : 'Tạo dự án' }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>

<style scoped>
/* Nút dấu cộng lấp đầy một ô trong lưới, ngang hàng với các dự án đã lưu. */
.create-project-tile {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  min-height: 310px;
  height: 100%;
  padding: 28px 20px;
  border: 0;
  border-radius: 16px;
  color: #526c4d;
  background: transparent;
  text-align: center;
}
.create-project-tile:hover:not(:disabled) {
  background: #e8f0e0;
}
.create-project-tile:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.create-project-plus {
  display: grid;
  place-items: center;
  width: 56px;
  height: 56px;
  margin-bottom: 4px;
  border: 1px solid #cad9be;
  border-radius: 50%;
  background: #e4eddb;
  font-size: 36px;
  font-weight: 400;
}
.create-project-tile strong {
  font-size: 17px;
}
.create-project-tile > span:last-child {
  font-size: 12px;
}
.create-room-content {
  padding: 28px;
}

h2 {
  margin-bottom: 12px;
  font-size: 30px;
  letter-spacing: -0.04em;
}
.create-room-note {
  color: #677584;
  font-size: 14px;
  line-height: 1.7;
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
.create-room-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 10px;
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
</style>
