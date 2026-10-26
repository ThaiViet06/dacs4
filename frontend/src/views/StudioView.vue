<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import DrawingCanvas from '../components/DrawingCanvas.vue'
import type { Tool } from '../drawing/model'
import { useBoardStore } from '../stores/board'
import { useDrawingStore } from '../stores/drawing'

const toolNames: Record<Tool, string> = {
  freehand: 'Bút tự do',
  line: 'Đường thẳng',
  rectangle: 'Hình chữ nhật',
  circle: 'Hình tròn',
  eraser: 'Tẩy',
}
const toolShortcuts: Record<string, Tool> = { p: 'freehand', l: 'line', r: 'rectangle', c: 'circle', e: 'eraser' }
const board = useBoardStore()
const drawing = useDrawingStore()
// Đếm các thao tác đã lưu trong bản vẽ để cập nhật nhãn phía trên canvas.
const operationCount = computed(() => board.document.operations.length)
// Thanh trượt đọc và ghi cỡ của công cụ đang chọn; bút và tẩy giữ giá trị riêng.
const activeSize = computed({
  // Lấy kích thước của bút hoặc tẩy đang được chọn.
  get: () => drawing.tool === 'eraser' ? drawing.eraserSize : drawing.brushSize,
  // Ghi kích thước mới vào đúng công cụ, không làm đổi kích thước công cụ còn lại.
  set: (size: number) => {
    if (drawing.tool === 'eraser') drawing.eraserSize = size
    else drawing.brushSize = size
  },
})
// Trạng thái này hiển thị trên màn hình và được đọc lại khi đổi công cụ, màu hoặc độ dày.
const toolStatus = computed(() => drawing.tool === 'eraser'
  ? `Đang dùng ${toolNames.eraser}, cỡ ${activeSize.value} px.`
  : `Đang dùng ${toolNames[drawing.tool]}, màu ${drawing.color.toUpperCase()}, độ dày ${activeSize.value} px.`)
// Lời nhắc giải thích trạng thái lịch sử thay đổi ngay khi vẽ, hoàn tác hoặc làm lại.
const historyHint = computed(() => {
  if (!board.canUndo && !board.canRedo) return 'Chưa có nét vẽ để hoàn tác. Hãy vẽ lên canvas.'
  if (!board.canUndo) return 'Đã hoàn tác hết nét vẽ. Bạn có thể làm lại.'
  if (!board.canRedo) return 'Chưa có thao tác để làm lại. Hãy hoàn tác một nét trước.'
  return 'Bạn có thể hoàn tác hoặc làm lại.'
})
const actionFeedback = ref('')
const resetDialog = ref<HTMLDialogElement | null>(null)
let feedbackTimer: ReturnType<typeof setTimeout> | undefined
let feedbackGeneration = 0

// Hiện thông báo ngắn sau thao tác và tự ẩn sau 2,5 giây.
function showActionFeedback(message: string) {
  // Xóa thông báo cũ trước khi hiện lại để trình đọc màn hình nhận cả thao tác lặp liên tiếp.
  const generation = ++feedbackGeneration
  clearTimeout(feedbackTimer)
  actionFeedback.value = ''
  // Đợi Vue cập nhật giao diện trước khi đưa thông báo mới vào vùng đọc màn hình.
  void nextTick(() => {
    if (generation !== feedbackGeneration) return
    actionFeedback.value = message
    // Thao tác mới đặt lại thời gian hiển thị; bộ hẹn giờ cũ không được xóa thông báo mới.
    // Chỉ xóa thông báo nếu chưa có thao tác mới thay thế nó.
    feedbackTimer = setTimeout(() => {
      if (generation === feedbackGeneration) actionFeedback.value = ''
    }, 2500)
  })
}

// Hoàn tác nét vẽ cuối cùng khi lịch sử còn thao tác và báo kết quả.
function undoStroke() {
  if (!board.canUndo) return
  board.undoLocal()
  showActionFeedback('Đã hoàn tác một nét vẽ.')
}

// Khôi phục nét vừa hoàn tác khi lịch sử làm lại còn thao tác.
function redoStroke() {
  if (!board.canRedo) return
  board.redoLocal()
  showActionFeedback('Đã làm lại một nét vẽ.')
}

// Xử lý phím chọn công cụ và hoàn tác/làm lại khi người dùng không nhập văn bản.
function handleToolShortcut(event: KeyboardEvent) {
  // Khi hộp xác nhận đang mở, chỉ để hộp thoại nhận phím (kể cả Esc để đóng).
  if (resetDialog.value?.open) return
  // Để các ô nhập tự xử lý Ctrl+Z; chỉ bắt phím tắt khi người dùng đang thao tác trên Studio.
  const target = event.target
  if (event.isComposing || event.repeat
    || (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="textbox"]')))) return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    // Ctrl+Z hoàn tác; Ctrl+Y hoặc Ctrl+Shift+Z làm lại nét vừa hoàn tác.
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undoStroke()
    } else if ((key === 'y' && !event.shiftKey) || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redoStroke()
    }
    return
  }
  if (event.ctrlKey || event.altKey || event.metaKey) return
  const tool = toolShortcuts[key]
  if (!tool) return
  event.preventDefault()
  drawing.tool = tool
}

// Khi vào Studio, chuẩn bị trang vẽ cá nhân và bắt đầu lắng nghe phím tắt.
onMounted(() => {
  if (board.status !== 'local') board.local()
  window.addEventListener('keydown', handleToolShortcut)
})
// Khi rời Studio, gỡ phím tắt, đóng hộp thoại và hủy bộ hẹn giờ thông báo.
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleToolShortcut)
  closeResetDialog()
  feedbackGeneration++
  clearTimeout(feedbackTimer)
})

// Đóng hộp xác nhận tạo trang mới nếu hộp đang mở.
function closeResetDialog() {
  // Trang giấy trống tạo ngay, nên chỉ gọi close khi hộp xác nhận thực sự đang mở.
  if (resetDialog.value?.open) resetDialog.value.close()
}

// Mở hộp xác nhận nếu có lịch sử nét vẽ; trang trống được tạo mới ngay.
function startOver() {
  // Hỏi cả khi đã hoàn tác hết vì trang mới cũng xóa các nét còn trong lịch sử làm lại.
  if (board.canUndo || board.canRedo) {
    resetDialog.value?.showModal()
    return
  }
  confirmStartOver()
}

// Giữ nguyên bản vẽ hiện tại và đóng hộp xác nhận.
function cancelStartOver() {
  // Đóng hộp xác nhận mà không thay đổi bản vẽ hoặc hiện thông báo thành công.
  closeResetDialog()
}

// Xóa bản vẽ và lịch sử làm lại, rồi báo đã tạo trang giấy mới.
function confirmStartOver() {
  closeResetDialog()
  board.local()
  showActionFeedback('Đã tạo trang giấy mới.')
}
</script>

<template>
  <div class="studio-page page-container">
    <!-- Vùng thông báo tồn tại sẵn để trình đọc màn hình nhận nội dung mới khi thao tác hoàn tất. -->
    <div class="studio-action-feedback" role="status" aria-live="polite" aria-atomic="true">
      <span v-if="actionFeedback" class="studio-action-toast">{{ actionFeedback }}</span>
    </div>
    <!-- Dialog gốc của HTML giữ focus trong hộp và hỗ trợ phím Esc; nội dung được tạo kiểu theo Studio. -->
    <dialog ref="resetDialog" class="studio-reset-dialog" aria-labelledby="reset-dialog-title" aria-describedby="reset-dialog-description">
      <div class="studio-reset-dialog-content">
        <span class="studio-reset-dialog-icon" aria-hidden="true">↺</span>
        <p class="studio-reset-dialog-eyebrow">BẮT ĐẦU LẠI</p>
        <h2 id="reset-dialog-title">Tạo trang giấy mới?</h2>
        <p id="reset-dialog-description">Bản vẽ và lịch sử Hoàn tác/Làm lại trong phiên này sẽ bị xóa. Bạn không thể khôi phục chúng sau khi tạo trang mới.</p>
        <div class="studio-reset-dialog-actions">
          <button class="button button-outline" type="button" @click="cancelStartOver">Giữ bản vẽ</button>
          <button class="button studio-reset-confirm" type="button" @click="confirmStartOver">Tạo trang mới</button>
        </div>
      </div>
    </dialog>
    <div class="studio-heading">
      <div>
        <div class="breadcrumb"><RouterLink to="/">Trang chủ</RouterLink><span>/</span><span>Studio cá nhân</span></div>
        <h1>Trang giấy của bạn<span class="heading-period">.</span></h1>
        <p>Chọn công cụ rồi kéo trên trang giấy để vẽ.</p>
      </div>
      <div class="studio-heading-actions">
        <span class="mode-pill"><span class="status-dot" aria-hidden="true"></span>Chế độ cá nhân</span>
        <button class="button button-outline" type="button" @click="startOver">Tạo trang mới</button>
      </div>
    </div>

    <div class="studio-layout">
      <section class="canvas-panel" aria-label="Khu vực vẽ">
        <div class="canvas-panel-header">
          <div class="panel-title"><span class="panel-title-icon">✳</span><strong>Canvas tự do</strong><span class="panel-subtitle">1600 × 900</span></div>
          <div class="panel-meta" role="status" aria-live="polite" aria-atomic="true"><span class="status-dot" aria-hidden="true"></span>{{ operationCount }} thao tác</div>
        </div>
        <div class="canvas-wrap"><DrawingCanvas :operations="board.operations" :tool="drawing.tool" :color="drawing.color" :brush-size="activeSize" @commit="board.commit" /></div>
        <div class="canvas-panel-footer"><span>✦ Kéo chuột hoặc chạm để vẽ</span><span>Bản nháp trong phiên hiện tại</span></div>
      </section>

      <aside class="studio-sidebar" aria-label="Thông tin công cụ">
        <section class="sidebar-card">
          <p class="sidebar-eyebrow">CÔNG CỤ VẼ</p>
          <div class="tool-list" role="group" aria-label="Chọn công cụ vẽ">
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'freehand' }" type="button" :aria-pressed="drawing.tool === 'freehand'" aria-keyshortcuts="P" @click="drawing.tool = 'freehand'">
              <span class="tool-option-icon" aria-hidden="true">〰</span><span class="tool-option-copy"><strong>Bút tự do</strong><small>Vẽ theo chuyển động</small></span><kbd class="tool-shortcut" aria-hidden="true">P</kbd><span v-if="drawing.tool === 'freehand'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'line' }" type="button" :aria-pressed="drawing.tool === 'line'" aria-keyshortcuts="L" @click="drawing.tool = 'line'">
              <span class="tool-option-icon" aria-hidden="true">╱</span><span class="tool-option-copy"><strong>Đường thẳng</strong><small>Kéo từ đầu đến cuối</small></span><kbd class="tool-shortcut" aria-hidden="true">L</kbd><span v-if="drawing.tool === 'line'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'rectangle' }" type="button" :aria-pressed="drawing.tool === 'rectangle'" aria-keyshortcuts="R" @click="drawing.tool = 'rectangle'">
              <span class="tool-option-icon" aria-hidden="true">▭</span><span class="tool-option-copy"><strong>Hình chữ nhật</strong><small>Kéo để chọn hai góc</small></span><kbd class="tool-shortcut" aria-hidden="true">R</kbd><span v-if="drawing.tool === 'rectangle'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'circle' }" type="button" :aria-pressed="drawing.tool === 'circle'" aria-keyshortcuts="C" @click="drawing.tool = 'circle'">
              <span class="tool-option-icon" aria-hidden="true">◯</span><span class="tool-option-copy"><strong>Hình tròn</strong><small>Kéo từ tâm ra bán kính</small></span><kbd class="tool-shortcut" aria-hidden="true">C</kbd><span v-if="drawing.tool === 'circle'" class="active-check" aria-hidden="true">✓</span>
            </button>
            <button class="tool-option" :class="{ 'is-selected': drawing.tool === 'eraser' }" type="button" :aria-pressed="drawing.tool === 'eraser'" aria-keyshortcuts="E" @click="drawing.tool = 'eraser'">
              <span class="tool-option-icon" aria-hidden="true">⌫</span><span class="tool-option-copy"><strong>Tẩy</strong><small>Xóa nét khi kéo</small></span><kbd class="tool-shortcut" aria-hidden="true">E</kbd><span v-if="drawing.tool === 'eraser'" class="active-check" aria-hidden="true">✓</span>
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
          <!-- Hai nút dùng chung lịch sử với phím tắt và tự khóa khi không còn thao tác phù hợp. -->
          <div class="studio-history-actions" role="group" aria-label="Lịch sử bản vẽ">
            <button type="button" :disabled="!board.canUndo" aria-describedby="studio-history-hint" aria-keyshortcuts="Control+Z Meta+Z" @click="undoStroke">Hoàn tác <kbd>Ctrl+Z</kbd></button>
            <button type="button" :disabled="!board.canRedo" aria-describedby="studio-history-hint" aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z" @click="redoStroke">Làm lại <kbd>Ctrl+Y</kbd></button>
          </div>
          <!-- Lời nhắc luôn hiện trên màn hình và được trình đọc màn hình thông báo khi trạng thái đổi. -->
          <p id="studio-history-hint" class="studio-history-hint" role="status" aria-live="polite" aria-atomic="true">{{ historyHint }}</p>
          <p class="studio-tool-status" role="status" aria-live="polite" aria-atomic="true">{{ toolStatus }}</p>
          <p class="studio-shortcut-help">Phím tắt: P bút, L đường thẳng, R chữ nhật, C hình tròn, E tẩy.</p>
          <p class="sidebar-helper">Đổi công cụ không làm mất những nét đã vẽ.</p>
        </section>
        <section class="sidebar-tip"><div class="tip-icon">✴</div><p>Đôi khi một nét nguệch ngoạc là điểm bắt đầu của ý tưởng tuyệt vời.</p></section>
        <p class="session-note">Canvas hiện được giữ trong phiên trình duyệt. Tải lại trang sẽ tạo bản vẽ mới.</p>
      </aside>
    </div>
  </div>
</template>
