<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { mergeChatMessages, type ChatMessage, type ChatProfile } from '../chat/model'
import { ApiError } from '../services/api'
import { getChatMessages, getChatProfiles, postChatMessage } from '../services/chat'

const props = defineProps<{
  roomId: string
  currentUserId: string
  connected: boolean
  incomingMessage?: ChatMessage | null
}>()
const messages = ref<ChatMessage[]>([])
const draft = ref('')
const loading = ref(false)
const loaded = ref(false)
const sending = ref(false)
const denied = ref(false)
const error = ref('')
const list = ref<HTMLElement | null>(null)
const unconfirmed = ref<{ id: string; text: string } | null>(null)
const profiles = ref(new Map<string, ChatProfile>())
const hiddenAvatars = ref(new Set<string>())
// Chỉ tải lại hồ sơ khi danh sách người gửi thay đổi hoặc vừa tải lại lịch sử.
const authorIds = computed(() =>
  [...new Set(messages.value.map((message) => message.authorId))].sort().join(','),
)
const profilesReady = computed(
  () => props.connected && loaded.value && !loading.value && !denied.value,
)
// Tin chờ xác nhận dùng cùng bố cục với tin đã lưu, thêm giờ sau khi server trả về.
const entries = computed(() => {
  const pending = unconfirmed.value
  const items = pending
    ? [...messages.value, { ...pending, authorId: props.currentUserId, createdAt: null }]
    : messages.value
  return items.map((message) => {
    const profile = profiles.value.get(message.authorId)
    const own = message.authorId === props.currentUserId
    return {
      message,
      own,
      name: profile?.name || (own ? 'Bạn' : 'Thành viên'),
      avatar: profile?.avatarUrl ?? '',
    }
  })
})
const canSend = computed(
  () =>
    props.connected &&
    loaded.value &&
    !loading.value &&
    !sending.value &&
    !denied.value &&
    draft.value.trim().length > 0 &&
    draft.value.trim().length <= 1000,
)
const clock = new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const calendar = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
  hourCycle: 'h23',
})
let generation = 0
let sendVersion = 0
let activeRoom = ''
let activeUser = ''

// Hiện giờ theo múi giờ của trình duyệt, thêm ngày cho những tin từ trước hôm nay.
function messageTime(value: string) {
  const sent = new Date(value)
  return sent.toDateString() === new Date().toDateString()
    ? clock.format(sent)
    : calendar.format(sent)
}

// Tin tới qua HTTP hoặc WebSocket đều khử trùng; xác nhận UUID cũ sẽ gỡ trạng thái gửi lại.
function receive(incoming: unknown) {
  messages.value = mergeChatMessages(messages.value, incoming, props.roomId)
  // Xác nhận cả tin đã nằm ngoài 50 tin hiển thị, ví dụ retry sau một lần mất mạng dài.
  if (
    unconfirmed.value &&
    Array.isArray(incoming) &&
    incoming.some((message) => message.id === unconfirmed.value?.id)
  ) {
    if (draft.value.trim() === unconfirmed.value.text) draft.value = ''
    unconfirmed.value = null
    sending.value = false
    error.value = ''
  }
}

// Phân biệt thu quyền với lỗi tạm thời; lỗi chat không khóa chức năng vẽ.
function reportError(cause: unknown, action: 'load' | 'send') {
  if (
    cause instanceof ApiError &&
    ([401, 403, 404].includes(cause.status ?? 0) || cause.code === 'SHARING_DISABLED')
  ) {
    denied.value = true
    messages.value = []
    profiles.value.clear()
    hiddenAvatars.value.clear()
    draft.value = ''
    unconfirmed.value = null
    error.value =
      cause.status === 401
        ? 'Phiên đăng nhập đã hết hạn. Đăng nhập lại để trò chuyện.'
        : 'Trò chuyện đã đóng hoặc bạn không còn quyền truy cập.'
    return
  }
  error.value =
    action === 'send'
      ? 'Chưa nhận được xác nhận gửi tin. Kiểm tra kết nối rồi bấm Gửi lại.'
      : 'Chưa tải được tin nhắn. Bạn vẫn có thể vẽ và thử tải lại.'
}

// Tải lại sau reconnect; ghép với tin đã tới trong khi GET đang chờ để không làm mất tin mới.
async function loadMessages() {
  if (!props.connected || loading.value || sending.value) return
  const version = ++generation
  loading.value = true
  error.value = ''
  try {
    const result = await getChatMessages(props.roomId)
    if (version !== generation) return
    receive(result.messages)
    loaded.value = true
    denied.value = false
  } catch (cause) {
    if (version === generation) reportError(cause, 'load')
  } finally {
    if (version === generation) loading.value = false
  }
}

// Chỉ gửi khi đang kết nối; giữ nguyên UUID/nội dung nếu người dùng thử lại sau mất phản hồi.
async function sendMessage() {
  if (!canSend.value) return
  const text = draft.value.trim()
  const outgoing =
    unconfirmed.value?.text === text ? unconfirmed.value : { id: crypto.randomUUID(), text }
  unconfirmed.value = outgoing
  const version = generation
  const attempt = ++sendVersion
  sending.value = true
  error.value = ''
  try {
    const result = await postChatMessage(props.roomId, outgoing)
    if (version === generation && attempt === sendVersion) receive([result.message])
  } catch (cause) {
    // Broadcast có thể xác nhận trước khi phản hồi HTTP bị mất, khi đó không báo gửi thất bại.
    if (version === generation && attempt === sendVersion && unconfirmed.value?.id === outgoing.id)
      reportError(cause, 'send')
  } finally {
    if (version === generation && attempt === sendVersion) sending.value = false
  }
}

// Enter gửi, Shift+Enter xuống dòng; không chặn Enter đang dùng để hoàn tất bộ gõ tiếng Việt.
function composerKey(event: KeyboardEvent) {
  if (
    event.key === 'Enter' &&
    !event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.isComposing
  ) {
    event.preventDefault()
    void sendMessage()
  }
}

// Đổi tài khoản/dự án xóa chat cũ; mất mạng giữ bản nháp, nối lại đối chiếu lịch sử trước khi gửi.
watch(
  [() => props.roomId, () => props.currentUserId, () => props.connected],
  () => {
    generation++
    loading.value = false
    sending.value = false
    loaded.value = false
    if (activeRoom !== props.roomId || activeUser !== props.currentUserId) {
      messages.value = []
      profiles.value.clear()
      hiddenAvatars.value.clear()
      draft.value = ''
      unconfirmed.value = null
      error.value = ''
      denied.value = false
    }
    activeRoom = props.roomId
    activeUser = props.currentUserId
    if (props.connected) void loadMessages()
  },
  { immediate: true, flush: 'sync' },
)

// Hồ sơ về muộn khi đổi dự án hoặc tài khoản phải được bỏ qua như lịch sử chat.
watch(
  [profilesReady, () => props.roomId, () => props.currentUserId, authorIds],
  async ([ready, roomId], _, onCleanup) => {
    if (!ready) return
    let active = true
    onCleanup(() => {
      active = false
    })
    try {
      const result = await getChatProfiles(roomId)
      if (active)
        profiles.value = new Map(result.profiles.map((profile) => [profile.userId, profile]))
    } catch {
      // Giữ tên đã tải và hiển thị biểu tượng mặc định nếu hồ sơ chưa có.
    }
  },
)

// Chỉ nhận thông báo khi đang ở đúng phiên kết nối; component bị ẩn ngay khi về Cá nhân.
watch(
  () => props.incomingMessage,
  (message) => {
    if (props.connected && message?.roomId === props.roomId && !denied.value) receive([message])
  },
)

// Cuộn danh sách để thấy cả tin đang gửi và tin mới, giữ nguyên vị trí của Canvas.
watch([() => messages.value.at(-1)?.id, () => unconfirmed.value?.id], async () => {
  await nextTick()
  if (list.value) list.value.scrollTop = list.value.scrollHeight
})

// Bỏ phản hồi HTTP đến muộn sau khi rời editor hoặc tắt chia sẻ.
onBeforeUnmount(() => {
  generation++
})
</script>

<template>
  <section class="project-chat" aria-labelledby="project-chat-title">
    <header class="chat-heading">
      <div class="chat-heading-main">
        <span class="chat-heading-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7">
            <path
              d="M20 11.5c0 4.1-3.6 7-8 7a10 10 0 0 1-2.7-.4L5 20l1.1-3.4A6.6 6.6 0 0 1 4 11.5c0-3.9 3.6-7 8-7s8 3.1 8 7Z"
              stroke-linejoin="round"
            />
            <path d="M8.8 11.5h6.4" stroke-linecap="round" />
          </svg>
        </span>
        <div>
          <h2 id="project-chat-title">Trò chuyện</h2>
          <p class="chat-connection" :class="{ 'chat-online': connected }" role="status">
            <span aria-hidden="true"></span>{{ connected ? 'Đã kết nối' : 'Chờ kết nối' }}
          </p>
        </div>
      </div>
      <button
        class="chat-reload"
        type="button"
        :disabled="!connected || loading || sending"
        @click="loadMessages"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path
            d="M20 7v5h-5M4 17v-5h5M5.6 8.5A7.5 7.5 0 0 1 18 7l2 5M4 12l2 5a7.5 7.5 0 0 0 12.4-1.5"
          />
        </svg>
        Tải lại
      </button>
    </header>
    <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
    <div
      ref="list"
      class="chat-thread"
      role="log"
      aria-label="Tin nhắn dự án"
      aria-live="polite"
      tabindex="0"
    >
      <ol v-if="entries.length" class="chat-messages">
        <li
          v-for="{ message, own, name, avatar } in entries"
          :key="message.id"
          class="chat-message"
          :class="{ 'chat-own': own }"
        >
          <span class="chat-avatar" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
            >
              <circle cx="12" cy="8" r="3.2" />
              <path d="M6 19v-.6a6 6 0 0 1 12 0v.6" />
            </svg>
            <img
              v-if="avatar && !hiddenAvatars.has(avatar)"
              :src="avatar"
              alt=""
              loading="lazy"
              referrerpolicy="no-referrer"
              @error="hiddenAvatars.add(avatar)"
            />
          </span>
          <div class="chat-message-body">
            <div class="chat-meta">
              <strong>{{ name }}</strong>
              <time v-if="message.createdAt" :datetime="message.createdAt">
                {{ messageTime(message.createdAt) }}
              </time>
              <span v-else>{{ sending ? 'Đang gửi…' : 'Chưa xác nhận' }}</span>
            </div>
            <!-- Vue hiển thị nội dung tin dưới dạng văn bản. -->
            <p>{{ message.text }}</p>
          </div>
        </li>
      </ol>
      <p v-else-if="loading" class="chat-empty" role="status">Đang tải tin nhắn…</p>
      <p v-else-if="loaded && !denied" class="chat-empty">Chưa có tin nhắn.</p>
      <p v-else-if="!connected" class="chat-empty">Đang chờ kết nối lại.</p>
    </div>
    <form @submit.prevent="sendMessage">
      <label for="project-chat-input">Tin nhắn</label>
      <textarea
        id="project-chat-input"
        v-model="draft"
        rows="2"
        maxlength="1000"
        :disabled="!connected || !loaded || denied || sending"
        placeholder="Viết tin nhắn…"
        @keydown="composerKey"
      ></textarea>
      <div class="chat-compose-actions">
        <small
          ><span class="chat-keyboard-hint">Enter để gửi · Shift+Enter xuống dòng</span
          ><span>{{ draft.length }}/1000</span></small
        >
        <button class="button button-primary chat-send" type="submit" :disabled="!canSend">
          {{ sending ? 'Đang gửi…' : unconfirmed ? 'Gửi lại' : 'Gửi' }}
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="m21 3-7.5 18-3.2-7.3L3 10.5 21 3Zm0 0L10.3 13.7" />
          </svg>
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.project-chat {
  min-width: 0;
  padding: 16px;
  border: 1px solid #e4e9e2;
  border-radius: 17px;
  background: #fff;
  color: #263b53;
}
.chat-heading,
.chat-heading-main,
.chat-reload,
.chat-compose-actions,
.chat-compose-actions small {
  display: flex;
  align-items: center;
  gap: 10px;
}
.chat-heading,
.chat-compose-actions {
  justify-content: space-between;
}
.chat-heading-icon,
.chat-avatar {
  display: grid;
  flex: none;
  place-items: center;
  color: #426449;
  background: #e3eee1;
}
.chat-heading-icon {
  width: 42px;
  height: 42px;
  border-radius: 13px;
}
.chat-heading-icon svg {
  width: 24px;
  height: 24px;
}
.chat-heading h2 {
  margin: 0;
  font-size: 18px;
  line-height: 1.25;
}
.chat-connection {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 3px 0 0;
  color: #536371;
  font-size: 12px;
}
.chat-connection span {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #a37135;
}
.chat-connection.chat-online span {
  background: #508056;
}
.chat-reload {
  gap: 6px;
  min-height: 40px;
  padding: 7px 11px;
  border: 1px solid #dce6dc;
  border-radius: 9px;
  background: #fff;
  color: #415a49;
  font: inherit;
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
}
.chat-reload:hover:not(:disabled) {
  background: #edf3ec;
}
.chat-reload svg,
.chat-send svg {
  width: 16px;
  height: 16px;
}
.chat-thread {
  min-height: 108px;
  max-height: 320px;
  overflow-y: auto;
  margin: 16px 0;
  padding: 12px;
  border: 1px solid #e7ece6;
  border-radius: 12px;
  background: #f6f8f5;
  overscroll-behavior-y: contain;
  scrollbar-gutter: stable;
}
.chat-messages {
  display: grid;
  justify-items: start;
  gap: 15px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.chat-message {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  max-width: 100%;
}
.chat-own {
  flex-direction: row-reverse;
  justify-self: end;
}
.chat-avatar {
  position: relative;
  width: 36px;
  height: 36px;
  overflow: hidden;
  border-radius: 50%;
}
.chat-avatar svg {
  width: 19px;
  height: 19px;
}
.chat-avatar img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #e3eee1;
}
.chat-own .chat-avatar {
  color: #385c76;
  background: #e4edf5;
}
.chat-message-body {
  display: grid;
  justify-items: start;
  gap: 4px;
  min-width: 0;
}
.chat-own .chat-message-body {
  justify-items: end;
}
.chat-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 2px 8px;
  color: #536371;
  font-size: 12px;
}
.chat-own .chat-meta {
  justify-content: flex-end;
}
.chat-meta strong {
  color: #263b53;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.chat-meta time {
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.chat-message-body p {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 9px 12px;
  border: 1px solid #e4ebe4;
  border-radius: 3px 13px 13px 13px;
  background: #fff;
  font-size: 14px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.chat-own .chat-message-body p {
  border-color: #d3e4d2;
  border-radius: 13px 3px 13px 13px;
  background: #e5f0e3;
}
.chat-empty {
  margin: 24px 0;
  color: #536371;
  text-align: center;
  font-size: 13px;
}
.chat-compose-actions small {
  flex-wrap: wrap;
  min-width: 0;
  color: #536371;
  font-size: 12px;
}
.chat-error {
  color: #9b473c;
  font-size: 13px;
}
form {
  display: grid;
  gap: 8px;
}
label {
  font-size: 13px;
  font-weight: 600;
}
textarea {
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  border: 1px solid #ccd8c9;
  border-radius: 10px;
  background: #fff;
  color: inherit;
  resize: vertical;
  font: inherit;
  line-height: 1.5;
}
textarea:focus-visible,
button:focus-visible,
.chat-thread:focus-visible {
  outline: 2px solid #627d65;
  outline-offset: 3px;
}
button:disabled,
textarea:disabled {
  opacity: 0.62;
}
.chat-send {
  gap: 8px;
  white-space: nowrap;
}
@media (min-width: 900px) {
  /* Hàng lưới lấy chiều cao từ Canvas. Lịch sử chat cuộn trong phần còn lại. */
  .project-chat {
    display: flex;
    flex-direction: column;
    align-self: stretch;
    contain: size;
    overflow-y: auto;
  }
  .chat-heading,
  form {
    flex: none;
  }
  .chat-thread {
    flex: 1 1 0;
    min-height: 0;
    max-height: none;
  }
}
@media (max-width: 600px) {
  .chat-keyboard-hint {
    display: none;
  }
  .chat-avatar {
    width: 32px;
    height: 32px;
  }
}
</style>
