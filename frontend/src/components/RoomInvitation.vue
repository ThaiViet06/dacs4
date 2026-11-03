<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ApiError } from '../services/api'
import { createInvitation } from '../services/rooms'

const props = defineProps<{ roomId: string }>()
const router = useRouter()
const invitationUrl = ref('')
const creating = ref(false)
const error = ref('')
const copyStatus = ref('')
let requestVersion = 0

// Link chỉ giữ trong lần mở phòng hiện tại; xóa dữ liệu và bỏ phản hồi cũ khi đổi phòng.
function clearInvitation() {
  requestVersion++
  invitationUrl.value = ''
  creating.value = false
  error.value = ''
  copyStatus.value = ''
}

watch(() => props.roomId, clearInvitation, { flush: 'sync' })

// Không cập nhật link hoặc thông báo của phòng cũ sau khi đăng xuất hay rời trang.
onBeforeUnmount(() => requestVersion++)

// Phát link khi chủ phòng bấm nút; giữ nguyên link này cho các lần sao chép tiếp theo.
async function createLink() {
  if (creating.value || invitationUrl.value) return
  const version = ++requestVersion
  creating.value = true
  error.value = ''
  try {
    const { inviteToken } = await createInvitation(props.roomId)
    if (version !== requestVersion) return
    const path = router.resolve({ name: 'invite', params: { token: inviteToken } }).href
    invitationUrl.value = new URL(path, window.location.origin).href
  } catch (cause) {
    if (version !== requestVersion) return
    if (cause instanceof ApiError && cause.status === 403) {
      error.value = 'Chỉ chủ phòng mới được tạo link mời.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      error.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
    } else {
      error.value = 'Chưa nhận được xác nhận tạo link. Kiểm tra kết nối rồi thử lại.'
    }
  } finally {
    if (version === requestVersion) creating.value = false
  }
}

// Sao chép bằng thao tác riêng để trình duyệt cho phép truy cập clipboard; luôn có ô link để chép tay.
async function copyLink() {
  if (!invitationUrl.value) return
  const version = requestVersion
  copyStatus.value = ''
  try {
    await navigator.clipboard.writeText(invitationUrl.value)
    if (version === requestVersion) copyStatus.value = 'Đã sao chép link mời.'
  } catch {
    if (version === requestVersion)
      copyStatus.value = 'Không sao chép tự động được. Hãy chọn link và nhấn Ctrl+C.'
  }
}
</script>

<template>
  <section class="room-invitation" aria-labelledby="room-invitation-heading" :aria-busy="creating">
    <h3 id="room-invitation-heading">Mời bạn vào phòng</h3>
    <p class="invitation-note">
      Link mới thay link mời trước đó nếu có. Thành viên hiện tại vẫn giữ quyền truy cập.
    </p>
    <button
      v-if="!invitationUrl"
      class="button button-outline"
      type="button"
      :disabled="creating"
      @click="createLink"
    >
      {{ creating ? 'Đang tạo link…' : 'Tạo link mời' }}
    </button>
    <p v-if="error" class="invitation-error" role="alert">{{ error }}</p>
    <div v-if="invitationUrl" class="invitation-result">
      <label for="room-invitation-url">Link mời vào phòng</label>
      <input id="room-invitation-url" type="text" :value="invitationUrl" readonly />
      <button class="button button-outline" type="button" @click="copyLink">Sao chép link</button>
      <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
      <p class="invitation-note">Người nhận mở link, đăng nhập rồi bấm Tham gia phòng.</p>
    </div>
  </section>
</template>

<style scoped>
/* Khối lời mời nằm trong thông tin phòng; ô chỉ đọc cho phép sao chép tay khi clipboard bị chặn. */
.room-invitation {
  margin-top: 24px;
  padding-top: 22px;
  border-top: 1px solid #e4e9e2;
}
h3 {
  margin: 0 0 12px;
  font-size: 20px;
}
p {
  font-size: 13px;
  line-height: 1.7;
}
.invitation-note {
  color: #677584;
}
.invitation-error {
  color: #9b473c;
}
label {
  display: block;
  margin: 18px 0 8px;
  font-size: 13px;
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
.button {
  min-height: 44px;
}
.button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}
.invitation-result .button {
  margin-top: 12px;
}
</style>
