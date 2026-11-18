<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RouterLink, useRouter } from 'vue-router'
import { SignInButton, useUser } from '@clerk/vue'
import CreateRoomForm from './CreateRoomForm.vue'
import ProjectCardActions from './ProjectCardActions.vue'
import type { Room } from '../drawing/model'
import { useBoardStore } from '../stores/board'
import { useProjectsStore } from '../stores/projects'

const { isLoaded, isSignedIn, user } = useUser()
const router = useRouter()
const projects = useProjectsStore()
const board = useBoardStore()
const { rooms, loading, hasLoaded, error, activeGroup } = storeToRefs(projects)
const { loadRooms } = projects
const dateFormatter = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
})
// Lọc danh sách đã tải: cá nhân chỉ gồm dự án riêng của mình, chung gồm các dự án đang chia sẻ.
const visibleRooms = computed(() =>
  rooms.value.filter((room) =>
    activeGroup.value === 'personal'
      ? room.ownerId === user.value?.id && !room.sharingEnabled
      : room.sharingEnabled,
  ),
)

// Hiển thị ngày giờ theo trình duyệt; dữ liệu ngày không hợp lệ vẫn không làm hỏng danh sách.
function formatUpdatedAt(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Chưa rõ thời gian' : dateFormatter.format(date)
}

// Quay lại Studio giữ card và bộ lọc đã có; cập nhật ngầm bằng phiên đăng nhập hiện tại.
watch(
  [isLoaded, isSignedIn, () => user.value?.id],
  () => {
    projects.setAccount(isLoaded.value && isSignedIn.value ? (user.value?.id ?? '') : '')
    if (isLoaded.value && isSignedIn.value) void loadRooms()
  },
  { immediate: true, flush: 'sync' },
)

// Lưu dự án đã được server xác nhận vào cache rồi mở editor, để quay về Studio thấy ngay thẻ mới.
function roomCreated(room: Room) {
  projects.addCreatedRoom(room)
  void router.push({ name: 'studio-project', params: { id: room.id } })
}

// Bỏ dữ liệu đã mở và thẻ trong cache sau khi xác nhận quyền của tài khoản hiện tại.
function roomRemoved(room: Room, message: string) {
  if (!isSignedIn.value || user.value?.id !== room.ownerId) return
  board.forgetRoom(room.id)
  projects.removeRoom(room.id, message)
}
</script>

<template>
  <section class="room-list-section" aria-labelledby="room-list-heading" :aria-busy="loading">
    <div class="room-list-heading">
      <h2 id="room-list-heading">Dự án đã lưu</h2>
      <button
        v-if="isLoaded && isSignedIn"
        class="button button-outline"
        type="button"
        :disabled="loading"
        @click="loadRooms"
      >
        {{ loading ? 'Đang cập nhật…' : 'Tải lại' }}
      </button>
    </div>
    <div v-if="isLoaded && isSignedIn" class="project-filters" role="group" aria-label="Loại dự án">
      <button
        type="button"
        :aria-pressed="activeGroup === 'personal'"
        aria-controls="project-grid"
        @click="activeGroup = 'personal'"
      >
        Cá nhân
      </button>
      <button
        type="button"
        :aria-pressed="activeGroup === 'shared'"
        aria-controls="project-grid"
        @click="activeGroup = 'shared'"
      >
        Chung
      </button>
    </div>
    <p v-if="!isLoaded" class="room-list-note" role="status">Đang kiểm tra tài khoản…</p>
    <div v-else-if="!isSignedIn" class="room-list-note">
      <p>Đăng nhập để xem và tạo dự án của bạn.</p>
      <SignInButton mode="modal">
        <button class="button button-primary" type="button">Đăng nhập</button>
      </SignInButton>
    </div>
    <p v-else-if="loading && !hasLoaded" class="room-list-note" role="status">Đang tải dự án…</p>
    <p v-else-if="error" class="room-list-error" role="alert">{{ error }}</p>
    <p v-else-if="!visibleRooms.length" class="room-list-note" role="status">
      {{
        activeGroup === 'personal'
          ? 'Bạn chưa có dự án cá nhân. Bấm thẻ “+” để bắt đầu.'
          : 'Chưa có dự án chung. Các dự án đang chia sẻ hoặc bạn được mời tham gia sẽ hiện tại đây.'
      }}
    </p>
    <ul
      id="project-grid"
      class="project-grid"
      :aria-label="activeGroup === 'personal' ? 'Dự án cá nhân' : 'Dự án chung'"
    >
      <li class="project-card project-card-create">
        <CreateRoomForm @created="roomCreated" />
      </li>
      <li v-for="room in visibleRooms" :key="room.id" class="project-card">
        <RouterLink
          class="project-card-link"
          :to="{ name: 'studio-project', params: { id: room.id } }"
          :aria-label="`Mở ${room.title} trong Studio`"
        >
          <!-- Biểu tượng trang giấy là trang trí, không giả làm ảnh nội dung bản vẽ. -->
          <div class="project-card-cover" aria-hidden="true">
            <svg viewBox="0 0 48 48" fill="none">
              <rect x="10" y="6" width="28" height="36" rx="4" />
              <path d="M17 29c3-10 5-11 7-4s5 6 7-2M17 15h9" stroke-linecap="round" />
            </svg>
          </div>
          <div class="project-card-content">
            <span class="project-mode">{{ room.sharingEnabled ? 'Chung' : 'Cá nhân' }}</span>
            <h3>{{ room.title }}</h3>
            <span class="project-role">{{
              room.ownerId === user?.id ? 'Chủ dự án' : 'Thành viên'
            }}</span>
            <time class="project-updated" :datetime="room.updatedAt">
              Cập nhật: {{ formatUpdatedAt(room.updatedAt) }}
            </time>
            <span class="project-card-open">Mở bản vẽ <span aria-hidden="true">↗</span></span>
          </div>
        </RouterLink>
        <ProjectCardActions
          v-if="isSignedIn && room.ownerId === user?.id"
          :room="room"
          @renamed="projects.updateRenamedRoom"
          @sharing-changed="projects.updateSharedRoom"
          @removed="roomRemoved(room, $event)"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* Lưới dùng hết chiều rộng Studio và tự xuống hàng trên màn hình nhỏ. */
.room-list-section {
  margin-top: 32px;
}
.room-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
h2 {
  margin: 0;
  font-size: 26px;
  letter-spacing: -0.04em;
}
.room-list-heading .button {
  min-height: 44px;
  padding: 10px 14px;
  flex-shrink: 0;
}
.project-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 20px;
}
.project-filters button {
  min-height: 44px;
  padding: 10px 20px;
  border: 1px solid #d9e1dc;
  border-radius: 10px;
  background: white;
  color: #677584;
  font-size: 14px;
  font-weight: 700;
}
.project-filters button:hover,
.project-filters button[aria-pressed='true'] {
  border-color: #a8b99e;
  background: #e8f0e0;
  color: #526c4d;
}
.button:disabled {
  cursor: wait;
  opacity: 0.6;
  transform: none;
}
.room-list-note,
.room-list-error {
  margin: 18px 0 0;
  font-size: 14px;
  line-height: 1.7;
}
.room-list-note {
  color: #677584;
}
.room-list-error {
  color: #9b473c;
}
.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 20px;
  list-style: none;
  margin: 24px 0 0;
  padding: 0;
}
.project-card {
  position: relative;
  min-width: 0;
  border: 1px solid #e0e7db;
  border-radius: 16px;
  background: white;
  transition:
    border-color 0.2s,
    box-shadow 0.2s;
}
.project-card:hover,
.project-card:focus-within {
  border-color: #91a77f;
  box-shadow: 0 8px 24px #526c4d10;
}
.project-card-create {
  border: 1px dashed #a8b99e;
  background: #f0f5eb;
}
.project-card-link {
  display: flex;
  flex-direction: column;
  height: 100%;
  border-radius: inherit;
}
.project-card-cover {
  display: grid;
  place-items: center;
  min-height: 130px;
  border-radius: 16px 16px 0 0;
  background: #f1f4ed;
  color: #8a9f7b;
}
.project-card-cover svg {
  width: 48px;
  stroke: currentColor;
  stroke-width: 2;
}
.project-card-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 20px;
}
.project-card h3 {
  min-width: 0;
  margin: 0;
  font-size: 20px;
  overflow-wrap: anywhere;
}
.project-mode {
  padding: 4px 8px;
  border-radius: 6px;
  color: #526c4d;
  background: #f5f8f2;
  font-size: 12px;
}
.project-role,
.project-updated {
  color: #77827b;
  font-size: 12px;
}
.project-card-open {
  display: flex;
  justify-content: space-between;
  align-self: stretch;
  gap: 12px;
  margin-top: auto;
  padding-top: 8px;
  color: #526c4d;
  font-size: 13px;
  font-weight: 700;
}
</style>
