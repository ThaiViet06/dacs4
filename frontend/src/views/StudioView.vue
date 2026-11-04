<script setup lang="ts">
import { RouterLink } from 'vue-router'
import RoomList from '../components/RoomList.vue'
import { clerkPublishableKey } from '../services/clerk'
import { useProjectsStore } from '../stores/projects'

const projects = useProjectsStore()
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
    <div v-if="projects.notice" class="sharing-notice" role="status">
      <p>{{ projects.notice }}</p>
      <button class="button button-outline" type="button" @click="projects.notice = ''">
        Đóng
      </button>
    </div>
    <!-- Chỉ dùng hook Clerk trong component con khi plugin đã được cung cấp từ main.ts. -->
    <RoomList v-if="clerkPublishableKey" />
    <div v-else class="placeholder-card">
      <h2>Đăng nhập chưa sẵn sàng</h2>
      <p>Chưa thể mở dự án lúc này. Bạn vẫn có thể chọn Vẽ thử không lưu.</p>
    </div>
  </section>
</template>

<style scoped>
.sharing-notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid #cad9be;
  border-radius: 12px;
  background: #f0f5eb;
  color: #526c4d;
}
.sharing-notice p {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
}
.sharing-notice .button {
  flex-shrink: 0;
  padding: 10px 14px;
}
</style>
