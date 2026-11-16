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
const recovery = ref<'retry' | 'sign-in' | 'new-link'>('retry')
let requestVersion = 0

// Kiểm tra nhanh định dạng link để không yêu cầu đăng nhập hoặc gọi API cho URL rõ ràng bị sai.
const token = computed(() => (typeof route.params.token === 'string' ? route.params.token : ''))
const validToken = computed(() => /^[A-Za-z0-9_-]{43}$/.test(token.value))

// Phiên/link mới bỏ trạng thái lỗi cũ để lời mời mới được kiểm tra lại khi Clerk sẵn sàng.
function joinWhenReady() {
  requestVersion++
  joining.value = false
  error.value = ''
  recovery.value = 'retry'
  void acceptInvitation()
}

watch([isLoaded, isSignedIn, () => user.value?.id, token], joinWhenReady, {
  immediate: true,
  flush: 'sync',
})

// Không điều hướng từ phản hồi cũ nếu người dùng đã rời trang lời mời.
onBeforeUnmount(() => requestVersion++)

// Chỉ thử lại lỗi tạm thời; link bị server vô hiệu phải được thay, không gửi lặp cùng link hỏng.
async function acceptInvitation() {
  if (
    !isLoaded.value ||
    !isSignedIn.value ||
    !user.value ||
    !validToken.value ||
    joining.value ||
    recovery.value === 'new-link'
  )
    return
  const version = ++requestVersion
  joining.value = true
  error.value = ''
  recovery.value = 'retry'
  try {
    const result = await joinRoom(token.value)
    if (version !== requestVersion) return
    // Thay trang lời mời trong lịch sử để nút Quay lại không lặp thao tác tham gia.
    await router.replace({ name: 'studio-project', params: { id: result.room.id } })
  } catch (cause) {
    if (version !== requestVersion) return
    if (
      cause instanceof ApiError &&
      (cause.code === 'INVITATION_INVALID' ||
        (cause.status === 400 && cause.code === 'INVALID_INPUT'))
    ) {
      recovery.value = 'new-link'
      error.value =
        'Link không hợp lệ, đã được thay hoặc dự án đã tắt chia sẻ. Hãy xin link mới từ chủ dự án.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      recovery.value = 'sign-in'
      error.value = 'Không thể xác thực tài khoản. Đăng nhập lại rồi bấm Thử lại.'
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
      <p class="eyebrow">LỜI MỜI VẼ CHUNG</p>
      <h1>Mở bản vẽ được chia sẻ.</h1>
      <p v-if="!validToken" class="invite-error" role="alert">
        Đường dẫn lời mời không hợp lệ. Hãy xin lại link đầy đủ từ chủ dự án.
      </p>
      <p v-else-if="!clerkPublishableKey" role="status">
        Đăng nhập chưa được cấu hình. Chưa thể mở dự án lúc này.
      </p>
      <p v-else-if="!isLoaded" role="status">Đang kiểm tra tài khoản…</p>
      <div v-else-if="!isSignedIn">
        <p>Đăng nhập để ứng dụng kiểm tra lời mời và tự mở bản vẽ.</p>
        <SignInButton mode="modal"
          ><button class="button button-primary" type="button">
            Đăng nhập để mở bản vẽ
          </button></SignInButton
        >
      </div>
      <p v-else-if="joining" role="status">Đang xác nhận lời mời và mở bản vẽ…</p>
      <div v-else-if="error">
        <p class="invite-error" role="alert">{{ error }}</p>
        <div class="invite-actions">
          <SignInButton v-if="recovery === 'sign-in'" mode="modal">
            <button class="button button-primary" type="button">Đăng nhập lại</button>
          </SignInButton>
          <button
            v-if="recovery !== 'new-link'"
            class="button button-outline"
            type="button"
            @click="acceptInvitation"
          >
            Thử lại
          </button>
        </div>
      </div>
      <p v-else role="status">Đang chờ phiên đăng nhập để mở bản vẽ…</p>
      <RouterLink class="text-link invite-back" to="/studio">Về Studio</RouterLink>
    </div>
  </section>
</template>

<style scoped>
/* Trang lời mời tự mở Canvas sau xác nhận; chỉ hiện đăng nhập hoặc thử lại khi cần người dùng xử lý. */
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
.invite-actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 12px;
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
