<script setup lang="ts">
import { RouterLink } from 'vue-router'
import RoomList from '../components/RoomList.vue'
import { clerkPublishableKey } from '../services/clerk'
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb">
      <RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Studio</span>
    </div>
    <div class="studio-heading">
      <div>
        <p class="eyebrow">STUDIO</p>
        <h1>Dự án của bạn<span class="heading-period">.</span></h1>
        <p>Tạo dự án hoặc tiếp tục bản vẽ bạn đã tạo và được chia sẻ.</p>
      </div>
      <RouterLink class="button button-outline" to="/studio/try"
        >Vẽ thử không lưu <span aria-hidden="true">↗</span></RouterLink
      >
    </div>
    <!-- Chỉ dùng hook Clerk trong component con khi plugin đã được cung cấp từ main.ts. -->
    <RoomList v-if="clerkPublishableKey" />
    <div v-else class="placeholder-card">
      <h2>Đăng nhập chưa sẵn sàng</h2>
      <p>Chưa thể mở dự án lúc này. Bạn vẫn có thể chọn Vẽ thử không lưu.</p>
    </div>
  </section>
</template>
