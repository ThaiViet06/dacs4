<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Bộ sưu tập</span></div>
    <div class="placeholder-card"><span class="placeholder-illustration">▧</span><p class="eyebrow">ĐANG ĐƯỢC CHUẨN BỊ</p><h1>Những bức vẽ đáng giữ lại.</h1><p>Bộ sưu tập sẽ hiển thị phòng vẽ và bản lưu riêng khi tính năng lưu trữ hoàn thành. Trong lúc này, bạn có thể thử canvas cá nhân.</p><RouterLink class="button button-primary" to="/studio">Mở studio <span aria-hidden="true">↗</span></RouterLink></div>
  </section>
</template>
