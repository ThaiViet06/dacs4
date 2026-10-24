<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="home-page page-container">
    <section class="hero">
      <div class="hero-copy">
        <p class="eyebrow"><span class="eyebrow-line"></span> MỘT KHÔNG GIAN ĐỂ SÁNG TẠO</p>
        <h1>Mọi ý tưởng<br />bắt đầu từ <em>một nét vẽ.</em></h1>
        <p class="hero-description">Bật canvas lên, phác thảo điều bạn đang nghĩ. Khi phòng vẽ chung sẵn sàng, những nét vẽ ấy sẽ kết nối bạn bè ở bất cứ đâu.</p>
        <div class="hero-actions">
          <RouterLink class="button button-primary" to="/studio">Bắt đầu vẽ <span aria-hidden="true">↗</span></RouterLink>
          <a class="text-link" href="#how-it-works">Khám phá thêm <span aria-hidden="true">↓</span></a>
        </div>
        <div class="hero-note"><span class="status-dot"></span> Studio vẽ tự do đã sẵn sàng</div>
      </div>

      <div class="hero-art" aria-label="Minh họa những nét vẽ trên trang giấy">
        <div class="hero-art-paper">
          <span class="paper-label">MỘT TRANG GIẤY, VÔ VÀN Ý TƯỞNG</span>
          <svg viewBox="0 0 520 380" role="img" aria-label="Nét vẽ màu xanh, vàng và cam">
            <path d="M82 243c26-73 70-132 122-107 37 17-26 111 21 130 48 19 96-140 145-110 43 25-4 70 46 78" stroke="#304e61" stroke-width="15" stroke-linecap="round" fill="none" />
            <path d="M131 102c54-39 90-45 147-19" stroke="#e8a556" stroke-width="12" stroke-linecap="round" fill="none" />
            <path d="M320 91c36-29 81-29 101 18" stroke="#b8cb95" stroke-width="12" stroke-linecap="round" fill="none" />
            <circle cx="105" cy="295" r="19" fill="#efbf87" /><circle cx="399" cy="290" r="10" fill="#b8cb95" />
            <path d="m203 314 18 9m-10-18 2 18M70 152l21-4m-10-8 3 24" stroke="#304e61" stroke-width="5" stroke-linecap="round" />
          </svg>
          <span class="paper-corner">01 / 03</span>
        </div>
        <div class="floating-label">Đặt bút xuống. Điều hay sẽ đến.</div>
      </div>
    </section>

    <section id="how-it-works" class="feature-section">
      <div class="section-heading"><p class="eyebrow">CÁCH NÉT CHUNG HOẠT ĐỘNG</p><h2>Một chỗ cho mọi nét vẽ.</h2></div>
      <div class="feature-grid">
        <article class="feature-card"><span class="feature-number">01</span><div class="feature-glyph">✳</div><h3>Phác thảo tự do</h3><p>Vẽ bằng chuột, bút cảm ứng hoặc chạm tay trên một canvas rộng rãi.</p></article>
        <article class="feature-card"><span class="feature-number">02</span><div class="feature-glyph">◌</div><h3>Mở phòng chung</h3><p>Phòng vẽ và lời mời sẽ được thêm ở giai đoạn đồng bộ tiếp theo.</p></article>
        <article class="feature-card"><span class="feature-number">03</span><div class="feature-glyph">▧</div><h3>Lưu ý tưởng</h3><p>Bộ sưu tập và bản lưu riêng sẽ có khi phần lưu trữ được kết nối.</p></article>
      </div>
    </section>
  </div>
</template>
