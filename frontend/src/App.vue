<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <RouterLink class="brand" to="/" aria-label="Nét Chung - trang chủ">
        <span class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none">
            <path d="M10 28c5-16 10-17 12-5 2 10 7 7 9-3" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" />
            <circle cx="30.5" cy="12.5" r="3" fill="currentColor" />
          </svg>
        </span>
        <span>Nét Chung<span class="brand-dot">.</span></span>
      </RouterLink>

      <nav class="main-nav" aria-label="Điều hướng chính">
        <RouterLink to="/">Trang chủ</RouterLink>
        <RouterLink to="/studio">Studio</RouterLink>
        <RouterLink to="/gallery">Bộ sưu tập</RouterLink>
      </nav>

      <RouterLink class="header-action" to="/studio">Mở canvas <span aria-hidden="true">↗</span></RouterLink>
    </header>

    <main id="main-content"><RouterView /></main>

    <footer class="site-footer">
      <span>Nét Chung · Không gian cho những ý tưởng cùng nhau.</span>
      <span>Đồ án ứng dụng vẽ trực tuyến</span>
    </footer>
  </div>
</template>
