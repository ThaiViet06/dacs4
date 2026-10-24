<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <section class="placeholder-page page-container">
    <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Phòng vẽ</span></div>
    <div class="placeholder-card"><span class="placeholder-illustration">◌</span><p class="eyebrow">PHÒNG VẼ CHUNG</p><h1>Vẽ cùng nhau, sắp tới.</h1><p>Phòng vẽ cần đăng nhập và đồng bộ thời gian thực. Hai phần đó nằm ở pha 4–5; hiện tại hãy thử vẽ trên canvas cá nhân.</p><RouterLink class="button button-primary" to="/studio">Mở studio <span aria-hidden="true">↗</span></RouterLink></div>
  </section>
</template>
