<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { mergeChatMessages, type ChatMessage } from '../chat/model'
import { ApiError } from '../services/api'
import { getChatMessages, postChatMessage } from '../services/chat'

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
const list = ref<HTMLOListElement | null>(null)
const unconfirmed = ref<{ id: string; text: string } | null>(null)
const authors = computed(() => [...new Set(messages.value.map((message) => message.authorId))])
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
const clock = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit' })
let generation = 0
let sendVersion = 0
let activeRoom = ''
let activeUser = ''

// Hiện nhãn người gửi mà không đưa ID Clerk lên giao diện.
function authorLabel(authorId: string) {
  return authorId === props.currentUserId
    ? 'Bạn'
    : `Thành viên ${authors.value.indexOf(authorId) + 1}`
}

// Hiện giờ ngắn; datetime đầy đủ vẫn có trên thẻ time để trình đọc màn hình sử dụng.
function messageTime(value: string) {
  return clock.format(new Date(value))
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
      <h2 id="project-chat-title">Trò chuyện</h2>
      <button
        class="text-link"
        type="button"
        :disabled="!connected || loading || sending"
        @click="loadMessages"
      >
        Tải lại
      </button>
    </header>
    <p v-if="!connected" class="chat-notice" role="status">Chờ kết nối để trò chuyện tiếp.</p>
    <p v-else-if="loading" class="chat-notice" role="status">Đang tải tin nhắn…</p>
    <p v-if="error" class="chat-error" role="alert">{{ error }}</p>
    <ol ref="list" class="chat-messages" role="log" aria-label="Tin nhắn dự án" aria-live="polite">
      <li
        v-for="message in messages"
        :key="message.id"
        :class="{ 'chat-own': message.authorId === currentUserId }"
      >
        <div class="chat-meta">
          <strong>{{ authorLabel(message.authorId) }}</strong
          ><time :datetime="message.createdAt">{{ messageTime(message.createdAt) }}</time>
        </div>
        <!-- Nội dung là văn bản Vue escape tự động, không render HTML người gửi nhập. -->
        <p>{{ message.text }}</p>
      </li>
      <li v-if="unconfirmed" class="chat-own" :key="unconfirmed.id">
        <div class="chat-meta">{{ sending ? 'Đang gửi…' : 'Chưa xác nhận' }}</div>
        <p>{{ unconfirmed.text }}</p>
      </li>
    </ol>
    <p v-if="loaded && !messages.length" class="chat-notice">
      Chưa có tin nhắn. Bắt đầu trò chuyện cùng mọi người.
    </p>
    <form @submit.prevent="sendMessage">
      <label for="project-chat-input">Tin nhắn</label>
      <textarea
        id="project-chat-input"
        v-model="draft"
        rows="3"
        maxlength="1000"
        :disabled="!connected || !loaded || denied || sending"
        placeholder="Nhắn cho thành viên trong dự án…"
        @keydown="composerKey"
      ></textarea>
      <div class="chat-compose-actions">
        <small>Enter để gửi · Shift+Enter xuống dòng · {{ draft.length }}/1000</small>
        <button class="button button-primary" type="submit" :disabled="!canSend">
          {{ sending ? 'Đang gửi…' : unconfirmed ? 'Gửi lại' : 'Gửi' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.project-chat {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 22px;
  border: 1px solid #e4e9e2;
  border-radius: 17px;
  background: white;
}
.chat-heading,
.chat-meta,
.chat-compose-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.chat-heading h2 {
  margin: 0;
  font-size: 18px;
}
.chat-messages {
  display: grid;
  gap: 12px;
  max-height: 280px;
  margin: 18px 0;
  padding: 0 8px 0 0;
  overflow-y: auto;
  list-style: none;
}
.chat-messages li {
  width: min(85%, 680px);
  padding: 12px 14px;
  border-radius: 12px;
  background: #f3f5f1;
}
.chat-messages .chat-own {
  justify-self: end;
  background: #edf3e8;
}
.chat-meta {
  color: #627d65;
  font-size: 12px;
}
.chat-meta time {
  color: #77838a;
}
.chat-messages p {
  margin: 8px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.chat-notice,
.chat-compose-actions small {
  color: #677584;
  font-size: 12px;
}
.chat-error {
  color: #9b473c;
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
  resize: vertical;
  font: inherit;
}
textarea:focus-visible,
button:focus-visible {
  outline: 2px solid #627d65;
  outline-offset: 3px;
}
textarea:disabled {
  opacity: 0.65;
}
@media (max-width: 600px) {
  .project-chat {
    padding: 16px;
  }
  .chat-compose-actions {
    flex-wrap: wrap;
  }
  .chat-messages li {
    width: 100%;
    box-sizing: border-box;
  }
}
</style>
