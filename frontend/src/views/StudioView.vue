<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import DrawingCanvas from '../components/DrawingCanvas.vue'
import { useBoardStore } from '../stores/board'
import { useDrawingStore } from '../stores/drawing'

const board = useBoardStore()
const drawing = useDrawingStore()
const operationCount = computed(() => board.document.operations.length)
// Thanh trượt đọc và ghi cỡ của công cụ đang chọn; bút và tẩy giữ giá trị riêng.
const activeSize = computed({
  get: () => drawing.tool === 'eraser' ? drawing.eraserSize : drawing.brushSize,
  set: (size: number) => {
    if (drawing.tool === 'eraser') drawing.eraserSize = size
    else drawing.brushSize = size
  },
})

onMounted(() => { if (board.status !== 'local') board.local() })

function startOver() {
  if (operationCount.value && !window.confirm('Tạo trang giấy mới? Những nét vẽ hiện tại sẽ mất.')) return
  board.local()
}
</script>

<template>
  <div class="studio-page page-container">
    <div class="studio-heading">
      <div>
        <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Studio cá nhân</span></div>
        <h1>Trang giấy của bạn<span class="heading-period">.</span></h1>
        <p>Chọn công cụ rồi kéo trên trang giấy để vẽ.</p>
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
          <div class="panel-meta"><span class="status-dot"></span>{{ operationCount }} thao tác</div>
        </div>
        <div class="canvas-wrap"><DrawingCanvas :operations="board.operations" :tool="drawing.tool" :color="drawing.color" :brush-size="activeSize" @commit="board.commit" /></div>
        <div class="canvas-panel-footer"><span>✦ Kéo chuột hoặc chạm để vẽ</span><span>Bản nháp trong phiên hiện tại</span></div>
      </section>

      <aside class="studio-sidebar" aria-label="Thông tin công cụ">
        <section class="sidebar-card">
          <p class="sidebar-eyebrow">CÔNG CỤ VẼ</p>
          <div class="tool-list" role="group" aria-label="Chọn công cụ vẽ">
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'freehand' }" type="button" :aria-pressed="drawing.tool === 'freehand'" @click="drawing.tool = 'freehand'">
              <span class="tool-option-icon" aria-hidden="true">〰</span><span class="tool-option-copy"><strong>Bút tự do</strong><small>Vẽ theo chuyển động</small></span><span v-if="drawing.tool === 'freehand'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'line' }" type="button" :aria-pressed="drawing.tool === 'line'" @click="drawing.tool = 'line'">
              <span class="tool-option-icon" aria-hidden="true">╱</span><span class="tool-option-copy"><strong>Đường thẳng</strong><small>Kéo từ đầu đến cuối</small></span><span v-if="drawing.tool === 'line'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'rectangle' }" type="button" :aria-pressed="drawing.tool === 'rectangle'" @click="drawing.tool = 'rectangle'">
              <span class="tool-option-icon" aria-hidden="true">▭</span><span class="tool-option-copy"><strong>Hình chữ nhật</strong><small>Kéo để chọn hai góc</small></span><span v-if="drawing.tool === 'rectangle'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'circle' }" type="button" :aria-pressed="drawing.tool === 'circle'" @click="drawing.tool = 'circle'">
              <span class="tool-option-icon" aria-hidden="true">◯</span><span class="tool-option-copy"><strong>Hình tròn</strong><small>Kéo từ tâm ra bán kính</small></span><span v-if="drawing.tool === 'circle'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'eraser' }" type="button" :aria-pressed="drawing.tool === 'eraser'" @click="drawing.tool = 'eraser'">
              <span class="tool-option-icon" aria-hidden="true">⌫</span><span class="tool-option-copy"><strong>Tẩy</strong><small>Xóa nét khi kéo</small></span><span v-if="drawing.tool === 'eraser'" class="active-check" aria-hidden="true">✓</span>
            </button>
          </div>
          <div v-if="drawing.tool === 'eraser'" class="tool-detail"><span>Chế độ</span><strong>Tẩy nét</strong></div>
          <div v-else class="tool-control">
            <label class="tool-control-label" for="stroke-color">Màu nét</label>
            <div class="color-control">
              <input id="stroke-color" v-model="drawing.color" class="color-input" type="color" />
              <strong>{{ drawing.color.toUpperCase() }}</strong>
            </div>
          </div>
          <div class="tool-control">
            <div class="tool-control-heading">
              <label class="tool-control-label" for="brush-size">{{ drawing.tool === 'eraser' ? 'Cỡ tẩy' : 'Độ dày nét' }}</label>
              <output for="brush-size">{{ activeSize }} px</output>
            </div>
            <input id="brush-size" v-model.number="activeSize" class="size-input" type="range" min="1" max="50" step="1" />
          </div>
          <p class="sidebar-helper">Đổi công cụ không làm mất những nét đã vẽ.</p>
        </section>
        <section class="sidebar-tip"><div class="tip-icon">✴</div><p>Đôi khi một nét nguệch ngoạc là điểm bắt đầu của ý tưởng tuyệt vời.</p></section>
        <p class="session-note">Canvas hiện được giữ trong phiên trình duyệt. Tải lại trang sẽ tạo bản vẽ mới.</p>
      </aside>
    </div>
  </div>
</template>
