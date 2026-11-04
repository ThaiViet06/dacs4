<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { SignInButton, useUser } from '@clerk/vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { ApiError } from '../services/api'
import { clerkPublishableKey } from '../services/clerk'
import { joinRoom } from '../services/rooms'

const route = useRoute()
const router = useRouter()
// Thiếu cấu hình Clerk vẫn mở được trang thông báo mà không gọi hook thiếu provider.
const session = clerkPublishableKey ? useUser() : null
const isLoaded = session?.isLoaded ?? ref(true)
const isSignedIn = session?.isSignedIn ?? ref(false)
const user = session?.user ?? ref(null)
const joining = ref(false)
const error = ref('')
let requestVersion = 0

// Kiểm tra nhanh định dạng link để không yêu cầu đăng nhập hoặc gọi API cho URL rõ ràng bị sai.
const token = computed(() => (typeof route.params.token === 'string' ? route.params.token : ''))
const validToken = computed(() => /^[A-Za-z0-9_-]{43}$/.test(token.value))

// Đổi tài khoản hoặc link phải bỏ kết quả cũ; chỉ tham gia sau khi người dùng bấm nút.
function resetAttempt() {
  requestVersion++
  joining.value = false
  error.value = ''
}

watch([isLoaded, isSignedIn, () => user.value?.id, token], resetAttempt, { flush: 'sync' })

// Không điều hướng từ phản hồi cũ nếu người dùng đã rời trang lời mời.
onBeforeUnmount(() => requestVersion++)

// Backend xác nhận đã lưu thành viên rồi mới mở phòng; gửi lại cùng lời mời không tạo thành viên trùng.
async function acceptInvitation() {
  if (!isLoaded.value || !isSignedIn.value || !user.value || !validToken.value || joining.value)
    return
  const version = ++requestVersion
  joining.value = true
  error.value = ''
  try {
    const result = await joinRoom(token.value)
    if (version !== requestVersion) return
    // Thay trang lời mời trong lịch sử để nút Quay lại không lặp thao tác tham gia.
    await router.replace({ name: 'studio-project', params: { id: result.room.id } })
  } catch (cause) {
    if (version !== requestVersion) return
    if (cause instanceof ApiError && (cause.status === 400 || cause.status === 404)) {
      error.value = 'Link mời không hợp lệ hoặc đã được thay. Hãy xin link mới từ chủ phòng.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      error.value = 'Không thể xác thực tài khoản. Vui lòng đăng nhập lại.'
    } else if (cause.status === 429) {
      error.value = 'Bạn gửi quá nhiều yêu cầu. Vui lòng đợi một phút rồi thử lại.'
    } else {
      error.value = 'Chưa nhận được xác nhận tham gia. Kiểm tra kết nối rồi thử lại.'
    }
  } finally {
    if (version === requestVersion) joining.value = false
  }
}
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb">
      <RouterLink to="/studio">Studio</RouterLink><span>/</span><span>Lời mời</span>
    </div>
    <div class="placeholder-card invite-card" :aria-busy="joining">
      <span class="placeholder-illustration" aria-hidden="true">✉</span>
      <p class="eyebrow">LỜI MỜI VÀO PHÒNG</p>
      <h1>Vào phòng cùng bạn bè.</h1>
      <p v-if="!validToken" class="invite-error" role="alert">
        Đường dẫn lời mời không hợp lệ. Hãy xin lại link đầy đủ từ chủ phòng.
      </p>
      <p v-else-if="!clerkPublishableKey" role="status">
        Đăng nhập chưa được cấu hình. Chưa thể tham gia phòng lúc này.
      </p>
      <p v-else-if="!isLoaded" role="status">Đang kiểm tra tài khoản…</p>
      <div v-else-if="!isSignedIn">
        <p>Đăng nhập rồi bấm Tham gia phòng để sử dụng lời mời này.</p>
        <SignInButton mode="modal"
          ><button class="button button-primary" type="button">
            Đăng nhập để tham gia
          </button></SignInButton
        >
      </div>
      <div v-else>
        <p>
          Bấm Tham gia phòng để xác nhận lời mời. Thông tin phòng sẽ hiện sau khi bạn có quyền truy
          cập.
        </p>
        <p v-if="error" class="invite-error" role="alert">{{ error }}</p>
        <button
          class="button button-primary"
          type="button"
          :disabled="joining"
          @click="acceptInvitation"
        >
          {{ joining ? 'Đang tham gia…' : 'Tham gia phòng' }}
        </button>
      </div>
      <RouterLink class="text-link invite-back" to="/studio">Về Studio</RouterLink>
    </div>
  </section>
</template>

<style scoped>
/* Trang lời mời chỉ có một thao tác chính; không hiển thị token hoặc thông tin phòng trước khi tham gia. */
.invite-card {
  max-width: 760px;
  margin-inline: auto;
}
.invite-card p {
  color: #677584;
  font-size: 14px;
  line-height: 1.7;
}
.invite-card .eyebrow {
  color: #537156;
}
.invite-card .invite-error {
  color: #9b473c;
}
.button {
  min-height: 44px;
}
.button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}
.invite-back {
  justify-content: center;
  margin-top: 24px;
}
</style>
