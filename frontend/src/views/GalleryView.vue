<script setup lang="ts">
import { ref } from 'vue'
import { RouterLink } from 'vue-router'
import CreateRoomForm from '../components/CreateRoomForm.vue'
import RoomList from '../components/RoomList.vue'
import { clerkPublishableKey } from '../services/clerk'

const roomListVersion = ref(0)

// Yêu cầu danh sách tải lại từ server khi biểu mẫu vừa tạo phòng thành công.
function refreshRooms() {
  roomListVersion.value++
}
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb">
      <RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Bộ sưu tập</span>
    </div>
    <div class="studio-heading">
      <div>
        <p class="eyebrow">BỘ SƯU TẬP</p>
        <h1>Không gian cho ý tưởng<span class="heading-period">.</span></h1>
        <p>Tạo phòng và xem các phòng bạn đã tham gia. Bản lưu riêng sẽ được bổ sung sau.</p>
      </div>
      <RouterLink class="button button-outline" to="/studio"
        >Mở studio <span aria-hidden="true">↗</span></RouterLink
      >
    </div>
    <!-- Chỉ dùng hook Clerk trong component con khi plugin đã được cung cấp từ main.ts. -->
    <template v-if="clerkPublishableKey">
      <CreateRoomForm @created="refreshRooms" />
      <RoomList :refresh-key="roomListVersion" />
    </template>
    <div v-else class="placeholder-card">
      <h2>Đăng nhập chưa sẵn sàng</h2>
      <p>Chưa thể tạo phòng lúc này. Bạn vẫn có thể vẽ trong Studio cá nhân.</p>
    </div>
  </section>
</template>
