<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import DrawingCanvas from '../components/DrawingCanvas.vue'
import { useBoardStore } from '../stores/board'
import { useDrawingStore } from '../stores/drawing'

const board = useBoardStore()
const drawing = useDrawingStore()
const strokeCount = computed(() => board.document.operations.length)

onMounted(() => { if (board.status !== 'local') board.local() })

function startOver() {
  if (strokeCount.value && !window.confirm('Tạo trang giấy mới? Những nét vẽ hiện tại sẽ mất.')) return
  board.local()
}
</script>

<template>
  <div class="studio-page page-container">
    <div class="studio-heading">
      <div>
        <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Studio cá nhân</span></div>
        <h1>Trang giấy của bạn<span class="heading-period">.</span></h1>
        <p>Hãy bắt đầu bằng một nét vẽ tự do.</p>
      </div>
      <div class="studio-heading-actions">
        <span class="mode-pill"><span class="status-dot"></span> CHẾ ĐỘ CÁ NHÂN</span>
        <button class="button button-outline" type="button" @click="startOver">Tạo trang mới</button>
      </div>
    </div>

    <div class="studio-layout">
      <section class="canvas-panel" aria-label="Khu vực vẽ">
        <div class="canvas-panel-header">
          <div class="panel-title"><span class="panel-title-icon">✳</span><strong>Canvas tự do</strong><span class="panel-subtitle">1600 × 900</span></div>
          <div class="panel-meta"><span class="status-dot"></span>{{ strokeCount }} nét vẽ</div>
        </div>
        <div class="canvas-wrap"><DrawingCanvas :operations="board.operations" :color="drawing.color" :brush-size="drawing.brushSize" @commit="board.commit" /></div>
        <div class="canvas-panel-footer"><span>✦ Kéo chuột hoặc chạm để vẽ</span><span>Bản nháp trong phiên hiện tại</span></div>
      </section>

      <aside class="studio-sidebar" aria-label="Thông tin công cụ">
        <section class="sidebar-card">
          <p class="sidebar-eyebrow">CÔNG CỤ HIỆN TẠI</p>
          <div class="active-tool"><span class="active-tool-icon">〰</span><div><strong>Bút tự do</strong><small>Vẽ theo chuyển động của bạn</small></div><span class="active-check">✓</span></div>
          <div class="tool-detail"><span>Màu nét</span><div><i class="color-swatch" :style="{ background: drawing.color }"></i><strong>{{ drawing.color.toUpperCase() }}</strong></div></div>
          <div class="tool-detail"><span>Độ dày</span><strong>{{ drawing.brushSize }} px</strong></div>
          <p class="sidebar-helper">Các hình dạng, màu vẽ và tẩy sẽ được bổ sung trong pha 3.</p>
        </section>
        <section class="sidebar-tip"><div class="tip-icon">✴</div><p>Đôi khi một nét nguệch ngoạc là điểm bắt đầu của ý tưởng tuyệt vời.</p></section>
        <p class="session-note">Canvas hiện được giữ trong phiên trình duyệt. Tải lại trang sẽ tạo bản vẽ mới.</p>
      </aside>
    </div>
  </div>
</template>
