<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import {
  upgradeRoomInvitation,
  getRoomSharing,
  setRoomSharing,
  type SharingState,
} from '../services/rooms'
import { useBoardStore } from '../stores/board'

const props = defineProps<{ room: Room; disabled?: boolean; blockedReason?: string }>()
const emit = defineEmits<{ changed: [room: Room]; busy: [value: boolean] }>()
const router = useRouter()
const board = useBoardStore()
// Khi mở từ danh sách Studio chưa có phiên Canvas, hộp thoại giữ link riêng để sao chép.
const localInvitationUrl = ref('')
const invitationUrl = computed(
  () => localInvitationUrl.value || (board.room?.id === props.room.id ? board.invitationUrl : ''),
)
const enabled = ref(false)
const loading = ref(false)
const loaded = ref(false)
const saving = ref(false)
const upgrading = ref(false)
const legacyLink = ref(false)
const confirmLinkUpgrade = ref(false)
const confirmPrivate = ref(false)
const error = ref('')
const copyStatus = ref('')
const busy = computed(() => saving.value || upgrading.value)
let requestVersion = 0

// Báo dialog cha chờ thao tác ghi hoàn tất trước khi cho đóng bằng nút hoặc Esc.
watch(busy, (value) => emit('busy', value), { immediate: true, flush: 'sync' })

// Lắp URL từ route của ứng dụng và giữ trong đúng phiên chủ dự án, không lưu token vào localStorage.
function rememberLink(token: string) {
  const path = router.resolve({ name: 'invite', params: { token } }).href
  localInvitationUrl.value = new URL(path, window.location.origin).href
  board.rememberInvitation(props.room.id, localInvitationUrl.value)
}

// Chỉ dùng trạng thái server xác nhận; tắt xóa link, bật mới nhận lại đúng token hiện tại.
function applyState(state: SharingState, room?: Room) {
  enabled.value = state.enabled
  legacyLink.value = state.enabled && !state.inviteToken
  if (room || state.enabled !== props.room.sharingEnabled)
    emit('changed', room ?? { ...props.room, sharingEnabled: state.enabled })
  if (!state.enabled) {
    localInvitationUrl.value = ''
    board.rememberInvitation(props.room.id, '')
  } else if (state.inviteToken) rememberLink(state.inviteToken)
}

// Chuyển lỗi công khai thành hướng dẫn; không đưa token hay thông báo nội bộ lên giao diện.
function sharingError(cause: unknown) {
  if (!(cause instanceof ApiError) || cause.status === 401)
    return 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
  if (cause.status === 403 || cause.status === 404)
    return 'Bạn không có quyền quản lý chia sẻ hoặc dự án không còn tồn tại. Hãy mở lại từ Studio.'
  if (cause.code === 'SHARING_UNAVAILABLE')
    return 'Chưa thể lấy link hoặc bật chia sẻ. Hãy kiểm tra cấu hình khóa chia sẻ của backend.'
  if (cause.code === 'SHARING_DISABLED')
    return 'Dự án đã chuyển về Cá nhân. Hãy đóng rồi mở lại hộp chia sẻ để cập nhật.'
  return 'Chưa nhận được xác nhận. Kiểm tra kết nối rồi thử lại.'
}

// Mỗi lần mở hộp đọc lại quyền/link hiện hành; GET không tự tạo hoặc thay link cũ.
async function loadSharing() {
  const version = ++requestVersion
  loading.value = true
  loaded.value = false
  confirmPrivate.value = false
  confirmLinkUpgrade.value = false
  error.value = ''
  copyStatus.value = ''
  localInvitationUrl.value = ''
  try {
    const state = await getRoomSharing(props.room.id)
    if (version !== requestVersion) return
    applyState(state)
    loaded.value = true
  } catch (cause) {
    if (version === requestVersion) error.value = sharingError(cause)
  } finally {
    if (version === requestVersion) loading.value = false
  }
}

watch(() => props.room.id, loadSharing, { immediate: true, flush: 'sync' })

// Không cập nhật link hoặc thông báo của phòng cũ sau khi đăng xuất hay rời trang.
onBeforeUnmount(() => requestVersion++)

// Kiểm tra khóa hiện tại mỗi lần chọn; về Cá nhân cần xác nhận vì sẽ thu quyền người đang cộng tác.
function chooseMode(nextEnabled: boolean) {
  if (!loaded.value || busy.value || props.disabled || nextEnabled === enabled.value) return
  if (!nextEnabled) {
    confirmLinkUpgrade.value = false
    confirmPrivate.value = true
  } else void updateSharing(true)
}

// Kiểm tra lại khóa lúc xác nhận vì có thể vừa mất mạng; chỉ đổi nhãn/card sau khi PATCH được xác nhận.
async function updateSharing(nextEnabled: boolean) {
  if (!loaded.value || busy.value || props.disabled || nextEnabled === enabled.value) return
  const version = ++requestVersion
  saving.value = true
  error.value = ''
  copyStatus.value = ''
  try {
    const result = await setRoomSharing(props.room.id, nextEnabled)
    if (version !== requestVersion) return
    applyState(result, result.room)
    confirmPrivate.value = false
  } catch (cause) {
    if (version === requestVersion) error.value = sharingError(cause)
  } finally {
    if (version === requestVersion) saving.value = false
  }
}

// Chỉ hỏi thay link khi đang dùng link cũ; hủy giữ nguyên URL và quyền hiện có.
function requestLinkUpgrade() {
  if (!loaded.value || !legacyLink.value || busy.value || props.disabled) return
  confirmPrivate.value = false
  confirmLinkUpgrade.value = true
  error.value = ''
}

// Nâng link sau xác nhận; lỗi hoặc phản hồi trễ giữ URL cũ, gửi lại vẫn nhận cùng kết quả.
async function upgradeLink() {
  if (
    !loaded.value ||
    !legacyLink.value ||
    !confirmLinkUpgrade.value ||
    busy.value ||
    props.disabled
  )
    return
  const version = ++requestVersion
  upgrading.value = true
  error.value = ''
  copyStatus.value = ''
  try {
    const result = await upgradeRoomInvitation(props.room.id)
    if (version !== requestVersion) return
    applyState(result, result.room)
    confirmLinkUpgrade.value = false
  } catch (cause) {
    if (version !== requestVersion) return
    error.value = sharingError(cause)
  } finally {
    if (version === requestVersion) upgrading.value = false
  }
}

// Sao chép bằng thao tác riêng để trình duyệt cho phép truy cập clipboard; luôn có ô link để chép tay.
async function copyLink() {
  if (!enabled.value || !invitationUrl.value || busy.value) return
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
  <section
    class="room-invitation"
    aria-labelledby="room-invitation-heading"
    :aria-busy="loading || busy"
  >
    <h3 id="room-invitation-heading">Quyền truy cập</h3>
    <p v-if="loading" role="status">Đang kiểm tra chia sẻ…</p>
    <p v-if="error" class="invitation-error" role="alert">{{ error }}</p>
    <button
      v-if="!loaded && !loading"
      class="button button-outline"
      type="button"
      @click="loadSharing"
    >
      Thử lại
    </button>
    <template v-if="loaded">
      <p v-if="disabled" class="invitation-note" role="status">
        {{ blockedReason || 'Chỉ đổi chế độ khi đã kết nối và không còn nét chờ hoặc lỗi lưu.' }}
      </p>
      <fieldset class="sharing-modes" :disabled="busy || disabled">
        <legend>Chọn chế độ dự án</legend>
        <button type="button" :aria-pressed="!enabled" @click="chooseMode(false)">
          Cá nhân<small>Chỉ bạn được truy cập</small>
        </button>
        <button type="button" :aria-pressed="enabled" @click="chooseMode(true)">
          Cùng chỉnh sửa<small>Mời người khác vẽ qua link</small>
        </button>
      </fieldset>
      <div
        v-if="confirmPrivate"
        class="sharing-confirm"
        role="group"
        aria-labelledby="sharing-confirm-title"
      >
        <h3 id="sharing-confirm-title">Chuyển về Cá nhân?</h3>
        <p>
          Người khác sẽ mất quyền truy cập và bị ngắt kết nối. Link hiện tại hết hiệu lực; bản vẽ
          vẫn được giữ nguyên.
        </p>
        <div class="studio-reset-dialog-actions">
          <button
            class="button button-outline"
            type="button"
            :disabled="busy"
            @click="confirmPrivate = false"
          >
            Giữ chia sẻ
          </button>
          <button
            class="button button-primary"
            type="button"
            :disabled="busy || disabled"
            @click="updateSharing(false)"
          >
            Chuyển về Cá nhân
          </button>
        </div>
      </div>
      <div
        v-else-if="confirmLinkUpgrade"
        class="sharing-confirm"
        role="group"
        aria-labelledby="sharing-upgrade-title"
      >
        <h3 id="sharing-upgrade-title">Cập nhật link chia sẻ?</h3>
        <p>
          Link đã gửi trước đây sẽ hết hiệu lực. Thành viên đã tham gia vẫn giữ quyền và tiếp tục
          vẽ; bản vẽ được giữ nguyên.
        </p>
        <div class="studio-reset-dialog-actions">
          <button
            class="button button-outline"
            type="button"
            :disabled="busy"
            @click="confirmLinkUpgrade = false"
          >
            Giữ link cũ
          </button>
          <button
            class="button button-primary"
            type="button"
            :disabled="busy || disabled"
            @click="upgradeLink"
          >
            {{ upgrading ? 'Đang cập nhật…' : 'Xác nhận cập nhật' }}
          </button>
        </div>
      </div>
      <div v-else-if="enabled" class="invitation-result">
        <template v-if="invitationUrl">
          <label for="room-invitation-url">Link mở bản vẽ trong Studio</label>
          <input id="room-invitation-url" type="text" :value="invitationUrl" readonly />
          <button class="button button-outline" type="button" :disabled="busy" @click="copyLink">
            Sao chép link
          </button>
          <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
        </template>
        <template v-if="legacyLink">
          <p class="invitation-note">
            Dự án đang dùng link cũ. Cập nhật để lấy lại cùng link ở những lần mở sau.
          </p>
          <button
            class="button button-outline"
            type="button"
            :disabled="busy || disabled"
            @click="requestLinkUpgrade"
          >
            Cập nhật link
          </button>
        </template>
        <p class="invitation-note">Người nhận mở link và đăng nhập để tự vào bản vẽ.</p>
      </div>
      <p v-else class="invitation-note">Dự án đang riêng tư. Bật Cùng chỉnh sửa để lấy link mời.</p>
      <p v-if="saving" role="status">Đang lưu chế độ chia sẻ…</p>
    </template>
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
.invitation-error[role='alert'] {
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
.sharing-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 16px 0;
  padding: 0;
  border: 0;
}
.sharing-modes legend {
  margin-bottom: 12px;
  font-size: 13px;
  font-weight: 700;
}
.sharing-modes button {
  flex: 1;
  min-width: 150px;
  padding: 14px;
  border: 1px solid #b8c5b3;
  border-radius: 10px;
  background: white;
  color: #526c4d;
  font-size: 14px;
  font-weight: 700;
  text-align: left;
}
.sharing-modes button[aria-pressed='true'] {
  border-color: #7f986c;
  background: #e8f0e0;
}
.sharing-modes small {
  display: block;
  margin-top: 8px;
  font-size: 12px;
  font-weight: 400;
}
.sharing-modes:disabled {
  opacity: 0.6;
}
.sharing-confirm {
  padding: 16px;
  border: 1px solid #cad9be;
  border-radius: 10px;
  background: #f5f8f2;
}
.sharing-confirm h3 {
  font-size: 18px;
}
.sharing-confirm .studio-reset-dialog-actions {
  flex-wrap: wrap;
}
.sharing-confirm button {
  white-space: normal;
}
</style>
