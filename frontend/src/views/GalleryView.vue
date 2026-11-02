<script setup lang="ts">
import { RouterLink } from 'vue-router'
import CreateRoomForm from '../components/CreateRoomForm.vue'
import { clerkPublishableKey } from '../services/clerk'
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
        <p>Tạo phòng trước; danh sách phòng và bản lưu riêng sẽ được thêm ở các bước tiếp theo.</p>
      </div>
      <RouterLink class="button button-outline" to="/studio"
        >Mở studio <span aria-hidden="true">↗</span></RouterLink
      >
    </div>
    <!-- Chỉ dùng hook Clerk trong component con khi plugin đã được cung cấp từ main.ts. -->
    <CreateRoomForm v-if="clerkPublishableKey" />
    <div v-else class="placeholder-card">
      <h2>Đăng nhập chưa sẵn sàng</h2>
      <p>Chưa thể tạo phòng lúc này. Bạn vẫn có thể vẽ trong Studio cá nhân.</p>
    </div>
  </section>
</template>
