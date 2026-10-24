<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Lời mời</span></div>
    <div class="placeholder-card"><span class="placeholder-illustration">✉</span><p class="eyebrow">LỜI MỜI VÀO PHÒNG</p><h1>Hẹn bạn ở canvas chung.</h1><p>Luồng tham gia bằng lời mời sẽ hoạt động sau khi tài khoản và phòng vẽ được kết nối. Bạn vẫn có thể vẽ tự do ngay bây giờ.</p><RouterLink class="button button-primary" to="/studio">Mở studio <span aria-hidden="true">↗</span></RouterLink></div>
  </section>
</template>
