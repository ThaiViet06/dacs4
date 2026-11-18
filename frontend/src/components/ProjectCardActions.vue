<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId } from 'vue'
import RenameProjectForm from './RenameProjectForm.vue'
import RoomInvitation from './RoomInvitation.vue'
import type { Room } from '../drawing/model'
import { ApiError } from '../services/api'
import { deleteRoom } from '../services/rooms'
import { useBoardStore } from '../stores/board'

const props = defineProps<{ room: Room }>()
const emit = defineEmits<{
  renamed: [room: Room]
  'sharing-changed': [room: Room]
  removed: [message: string]
}>()
type Action = 'rename' | 'sharing' | 'delete'
const board = useBoardStore()
const menuId = useId()
const menuOpen = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const action = ref<Action | null>(null)
const dialog = ref<HTMLDialogElement | null>(null)
const renameForm = ref<InstanceType<typeof RenameProjectForm> | null>(null)
const busy = ref(false)
const error = ref('')
const sharingBlocked = computed(() => board.hasUnsavedChanges(props.room.id))
let active = true

// Đưa focus vào nút để menu có thể đóng khi người dùng bấm ra ngoài hoặc Tab sang thẻ khác.
function toggleMenu() {
  menuOpen.value = !menuOpen.value
  if (menuOpen.value) trigger.value?.focus()
}

// Chuyển focus giữa các mục cùng menu không làm menu đóng.
function closeOutside(event: FocusEvent) {
  const menu = event.currentTarget as HTMLElement
  if (!menu.contains(event.relatedTarget as Node | null)) menuOpen.value = false
}

// Trả focus về nút ba chấm trước khi đóng menu hoặc chuyển vào hộp thoại.
function closeMenu() {
  if (!menuOpen.value) return
  trigger.value?.focus()
  menuOpen.value = false
}

// Chỉ dựng hộp thoại đang cần, rồi mở sau khi Vue đã gắn nó vào trang.
async function openAction(nextAction: Action) {
  if (action.value) return
  closeMenu()
  action.value = nextAction
  error.value = ''
  await nextTick()
  if (!active) return
  if (nextAction === 'rename') renameForm.value?.openDialog()
  else dialog.value?.showModal()
}

// Hủy hoặc Esc chỉ đóng hộp khi không có yêu cầu đang chờ xác nhận.
function closeDialog() {
  if (busy.value) return
  dialog.value?.close()
  action.value = null
}

// Giữ thẻ đến khi nhận xác nhận xóa hoặc API xác nhận dự án không còn truy cập được.
async function confirmDelete() {
  if (action.value !== 'delete' || busy.value) return
  const id = props.room.id
  busy.value = true
  error.value = ''
  try {
    await deleteRoom(id)
    if (active) emit('removed', 'Đã xóa dự án.')
  } catch (cause) {
    if (!active) return
    if (cause instanceof ApiError && cause.status === 404 && cause.code === 'ROOM_NOT_FOUND') {
      emit('removed', 'Dự án không còn trong danh sách của bạn.')
    } else if (cause instanceof ApiError && cause.code === 'OWNER_REQUIRED') {
      error.value = 'Chỉ chủ dự án mới có thể xóa.'
    } else if (!(cause instanceof ApiError) || cause.status === 401) {
      error.value = 'Phiên đăng nhập không hợp lệ. Đăng nhập lại rồi thử xóa.'
    } else {
      error.value = 'Chưa xác nhận được việc xóa. Kiểm tra kết nối rồi thử lại.'
    }
  } finally {
    if (active) busy.value = false
  }
}

// Khi đổi tài khoản hoặc rời Studio, đóng hộp và bỏ phản hồi đến muộn.
onBeforeUnmount(() => {
  active = false
  if (dialog.value?.open) dialog.value.close()
})
</script>

<template>
  <div class="project-card-actions" @focusout="closeOutside" @keydown.esc.stop.prevent="closeMenu">
    <button
      ref="trigger"
      class="project-actions-trigger"
      type="button"
      :aria-label="`Tùy chọn dự án ${room.title}`"
      :aria-controls="menuId"
      :aria-expanded="menuOpen"
      @click="toggleMenu"
    >
      <span aria-hidden="true">⋮</span>
    </button>
    <div v-show="menuOpen" :id="menuId" class="project-actions-menu">
      <button type="button" aria-haspopup="dialog" @click="openAction('rename')">Đổi tên</button>
      <button type="button" aria-haspopup="dialog" @click="openAction('sharing')">
        Đổi chế độ chia sẻ
      </button>
      <button
        class="project-action-danger"
        type="button"
        aria-haspopup="dialog"
        @click="openAction('delete')"
      >
        Xóa dự án
      </button>
    </div>
  </div>
  <RenameProjectForm
    v-if="action === 'rename'"
    ref="renameForm"
    :room="room"
    hide-trigger
    @renamed="emit('renamed', $event)"
    @closed="action = null"
  />
  <dialog
    v-else-if="action"
    ref="dialog"
    class="studio-reset-dialog"
    :aria-labelledby="`${menuId}-heading`"
    @cancel.prevent="closeDialog"
  >
    <div class="studio-reset-dialog-content">
      <h2 :id="`${menuId}-heading`">
        {{ action === 'sharing' ? 'Đổi chế độ chia sẻ' : 'Xóa dự án?' }}
      </h2>
      <RoomInvitation
        v-if="action === 'sharing'"
        :room="room"
        :disabled="sharingBlocked"
        blocked-reason="Mở lại dự án và xử lý các nét chưa lưu trước khi đổi chế độ."
        @busy="busy = $event"
        @changed="emit('sharing-changed', $event)"
      />
      <template v-else>
        <p>
          Xóa vĩnh viễn <strong>“{{ room.title }}”</strong>, gồm bản vẽ và lịch sử trò chuyện.
        </p>
        <p v-if="error" class="project-action-danger" role="alert">{{ error }}</p>
      </template>
      <div class="studio-reset-dialog-actions">
        <button class="button button-outline" type="button" :disabled="busy" @click="closeDialog">
          {{ action === 'sharing' ? 'Đóng' : 'Hủy' }}
        </button>
        <button
          v-if="action === 'delete'"
          class="button project-delete-button"
          type="button"
          :disabled="busy"
          @click="confirmDelete"
        >
          {{ busy ? 'Đang xóa…' : 'Xóa dự án' }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.project-card-actions {
  position: absolute;
  z-index: 1;
  top: 12px;
  right: 12px;
}
.project-actions-trigger {
  display: grid;
  width: 44px;
  height: 44px;
  place-items: center;
  padding: 0;
  border: 1px solid #d9e1dc;
  border-radius: 10px;
  color: #34483e;
  background: white;
  font-size: 24px;
  line-height: 1;
}
.project-actions-trigger:hover,
.project-actions-trigger[aria-expanded='true'] {
  border-color: #a8b99e;
  background: #e8f0e0;
}
.project-actions-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  width: 192px;
  padding: 4px;
  border: 1px solid #d9e1dc;
  border-radius: 12px;
  background: white;
  box-shadow: 0 10px 24px #263b5326;
}
.project-actions-menu button {
  display: block;
  width: 100%;
  min-height: 44px;
  padding: 8px 12px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: #263b53;
  text-align: left;
  font: inherit;
}
.project-actions-menu button:hover,
.project-actions-menu button:focus-visible {
  background: #f0f5eb;
}
.project-action-danger,
.project-actions-menu .project-action-danger {
  color: #a03b36;
}
.project-actions-menu .project-action-danger:hover,
.project-actions-menu .project-action-danger:focus-visible {
  background: #faeeeb;
}
.project-delete-button {
  color: white;
  background: #a03b36;
}
.project-delete-button:hover:enabled {
  background: #86312d;
}
.studio-reset-dialog button:disabled {
  cursor: wait;
  opacity: 0.6;
}
.studio-reset-dialog strong {
  overflow-wrap: anywhere;
}
</style>
