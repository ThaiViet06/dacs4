<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { renameRoom } from '../services/rooms'

const props = defineProps<{ room: Room; disabled?: boolean; hideTrigger?: boolean }>()
const emit = defineEmits<{ renamed: [room: Room]; closed: [] }>()
const renameDialog = ref<HTMLDialogElement | null>(null)
const title = ref('')
const titleError = ref('')
const requestError = ref('')
const saving = ref(false)
let requestVersion = 0

// Mở hộp với tên hiện tại; tên trên editor vẫn giữ nguyên cho đến khi server xác nhận.
function openDialog() {
  if (props.disabled || saving.value) return
  title.value = props.room.title
  titleError.value = ''
  requestError.value = ''
  renameDialog.value?.showModal()
}

// Menu trên thẻ dự án có thể mở cùng biểu mẫu mà editor đang dùng.
defineExpose({ openDialog })

// Chờ yêu cầu đang gửi hoàn tất trước khi cho đóng bằng Hủy hoặc Esc.
function closeDialog() {
  if (saving.value || !renameDialog.value?.open) return
  renameDialog.value.close()
  emit('closed')
}

// Rời dự án hoặc mất quyền chủ thì đóng hộp và bỏ mọi phản hồi còn chờ.
function discardRequest() {
  requestVersion++
  saving.value = false
  title.value = ''
  titleError.value = ''
  requestError.value = ''
  if (renameDialog.value?.open) renameDialog.value.close()
}

watch(() => props.room.id, discardRequest)
onBeforeUnmount(discardRequest)

// Kiểm tra tên, chặn gửi trùng và chỉ chuyển metadata đã lưu về editor; lỗi không làm mất tên đang nhập.
async function submitRename() {
  if (props.disabled || saving.value) return
  const newTitle = title.value.trim()
  titleError.value = ''
  requestError.value = ''
  if (!newTitle || newTitle.length > 100) {
    titleError.value = 'Nhập tên dự án từ 1 đến 100 ký tự, không chỉ gồm khoảng trắng.'
    return
  }
  if (newTitle === props.room.title) {
    closeDialog()
    return
  }
  const version = ++requestVersion
  saving.value = true
  try {
    const result = await renameRoom(props.room.id, newTitle)
    if (version !== requestVersion) return
    emit('renamed', result.room)
    renameDialog.value?.close()
    emit('closed')
  } catch (cause) {
    if (version !== requestVersion) return
    if (!(cause instanceof ApiError) || cause.status === 401) {
      requestError.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
    } else if (cause.status === 403 || cause.status === 404) {
      requestError.value =
        'Dự án không còn tồn tại hoặc bạn không có quyền đổi tên. Hãy mở lại từ Studio.'
    } else if (cause.code === 'INVALID_INPUT') {
      requestError.value = 'Tên dự án cần có từ 1 đến 100 ký tự.'
    } else {
      requestError.value = 'Chưa nhận được xác nhận đổi tên. Kiểm tra kết nối rồi thử lại.'
    }
  } finally {
    if (version === requestVersion) saving.value = false
  }
}
</script>

<template>
  <button
    v-if="!hideTrigger"
    class="button button-outline"
    type="button"
    aria-haspopup="dialog"
    :disabled="disabled"
    @click="openDialog"
  >
    Đổi tên
  </button>
  <dialog
    ref="renameDialog"
    class="studio-reset-dialog"
    aria-labelledby="rename-project-heading"
    @cancel.prevent="closeDialog"
  >
    <div class="studio-reset-dialog-content">
      <h2 id="rename-project-heading">Đổi tên dự án</h2>
      <form novalidate :aria-busy="saving" @submit.prevent="submitRename">
        <label for="rename-project-title">Tên dự án</label>
        <p id="rename-project-help">Từ 1 đến 100 ký tự.</p>
        <input
          id="rename-project-title"
          v-model="title"
          type="text"
          name="title"
          maxlength="100"
          required
          autofocus
          autocomplete="off"
          :disabled="saving"
          :aria-invalid="Boolean(titleError)"
          :aria-describedby="
            titleError ? 'rename-project-help rename-project-error' : 'rename-project-help'
          "
          @input="titleError = ''"
        />
        <p v-if="titleError" id="rename-project-error" class="rename-error" role="alert">
          {{ titleError }}
        </p>
        <p v-if="requestError" class="rename-error" role="alert">{{ requestError }}</p>
        <div class="studio-reset-dialog-actions">
          <button
            class="button button-outline"
            type="button"
            :disabled="saving"
            @click="closeDialog"
          >
            Hủy
          </button>
          <button class="button button-primary" type="submit" :disabled="saving || disabled">
            {{ saving ? 'Đang lưu…' : 'Lưu tên' }}
          </button>
        </div>
      </form>
    </div>
  </dialog>
</template>

<style scoped>
label {
  font-size: 14px;
  font-weight: 700;
}
#rename-project-help {
  margin: 8px 0 12px;
  color: #677584;
  font-size: 13px;
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
.rename-error[role='alert'] {
  margin: 12px 0 0;
  color: #9b473c;
  font-size: 14px;
  line-height: 1.6;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
  transform: none;
}
</style>
