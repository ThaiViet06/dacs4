<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import DrawingCanvas from './DrawingCanvas.vue'
import RoomInvitation from './RoomInvitation.vue'
import type { Operation, Room, Tool } from '../drawing/model'
import { useBoardStore } from '../stores/board'
import { useDraftStore } from '../stores/draft'
import { useDrawingStore } from '../stores/drawing'

const props = defineProps<{ room?: Room; isOwner?: boolean }>()
// Cùng một editor: có metadata dự án thì dùng dữ liệu server, còn bản nháp dùng lịch sử local.
const isProject = computed(() => Boolean(props.room))
const toolNames: Record<Tool, string> = {
  freehand: 'Bút tự do',
  line: 'Đường thẳng',
  rectangle: 'Hình chữ nhật',
  circle: 'Hình tròn',
  eraser: 'Tẩy',
}
const toolShortcuts: Record<string, Tool> = {
  p: 'freehand',
  l: 'line',
  r: 'rectangle',
  c: 'circle',
  e: 'eraser',
}
const board = useBoardStore()
const draft = useDraftStore()
const drawing = useDrawingStore()
// Bản nháp và dự án có dữ liệu riêng nhưng cùng dùng renderer và các công cụ.
const operations = computed(() => (isProject.value ? board.operations : draft.document.operations))
// Chỉ mở Canvas và thanh công cụ dự án sau khi đã nhận room.state từ server.
const canDraw = computed(() => !isProject.value || board.status === 'connected')
// Phân biệt rõ nét đang chờ với nét đã được server xác nhận.
const saveStatus = computed(() => {
  if (!isProject.value) return 'Bản nháp trong phiên hiện tại'
  if (board.pendingCount) return `Đang chờ xác nhận ${board.pendingCount} nét…`
  if (board.rejected.length) return `Có ${board.rejected.length} nét chưa được lưu`
  if (board.status === 'connected') return 'Đã lưu các nét hiện có'
  if (board.status === 'error') return 'Chưa kết nối được. Hãy thử lại.'
  return 'Đang kết nối và tải bản vẽ…'
})
// Đếm các thao tác đã lưu trong bản vẽ để cập nhật nhãn phía trên canvas.
const operationCount = computed(() =>
  isProject.value ? board.document.operations.length : draft.document.operations.length,
)
// Thanh trượt đọc và ghi cỡ của công cụ đang chọn; bút và tẩy giữ giá trị riêng.
const activeSize = computed({
  // Lấy kích thước của bút hoặc tẩy đang được chọn.
  get: () => (drawing.tool === 'eraser' ? drawing.eraserSize : drawing.brushSize),
  // Ghi kích thước mới vào đúng công cụ, không làm đổi kích thước công cụ còn lại.
  set: (size: number) => {
    if (drawing.tool === 'eraser') drawing.eraserSize = size
    else drawing.brushSize = size
  },
})
// Trạng thái này hiển thị trên màn hình và được đọc lại khi đổi công cụ, màu hoặc độ dày.
const toolStatus = computed(() =>
  drawing.tool === 'eraser'
    ? `Đang dùng ${toolNames.eraser}, cỡ ${activeSize.value} px.`
    : `Đang dùng ${toolNames[drawing.tool]}, màu ${drawing.color.toUpperCase()}, độ dày ${activeSize.value} px.`,
)
// Lời nhắc giải thích trạng thái lịch sử thay đổi ngay khi vẽ, hoàn tác hoặc làm lại.
const historyHint = computed(() => {
  if (isProject.value)
    return 'Hoàn tác/làm lại hiện chỉ hỗ trợ bản vẽ thử, chưa áp dụng cho dự án tự lưu.'
  if (!draft.canUndo && !draft.canRedo) return 'Chưa có nét vẽ để hoàn tác. Hãy vẽ lên canvas.'
  if (!draft.canUndo) return 'Đã hoàn tác hết nét vẽ. Bạn có thể làm lại.'
  if (!draft.canRedo) return 'Chưa có thao tác để làm lại. Hãy hoàn tác một nét trước.'
  return 'Bạn có thể hoàn tác hoặc làm lại.'
})
const actionFeedback = ref('')
const resetDialog = ref<HTMLDialogElement | null>(null)
const shareDialog = ref<HTMLDialogElement | null>(null)
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
  if (isProject.value || !draft.canUndo) return
  draft.undo()
  showActionFeedback('Đã hoàn tác một nét vẽ.')
}

// Khôi phục nét vừa hoàn tác khi lịch sử làm lại còn thao tác.
function redoStroke() {
  if (isProject.value || !draft.canRedo) return
  draft.redo()
  showActionFeedback('Đã làm lại một nét vẽ.')
}

// Xử lý phím chọn công cụ và hoàn tác/làm lại khi người dùng không nhập văn bản.
function handleToolShortcut(event: KeyboardEvent) {
  // Khi hộp xác nhận đang mở, chỉ để hộp thoại nhận phím (kể cả Esc để đóng).
  if (resetDialog.value?.open || shareDialog.value?.open || !canDraw.value) return
  // Ô nhập văn bản và dialog tự xử lý bàn phím; thanh cỡ bút/màu vẫn dùng phím tắt Canvas.
  const target = event.target
  if (
    event.isComposing ||
    event.repeat ||
    (target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.closest(
          'input:not([type="range"]):not([type="color"]), textarea, select, [role="textbox"], dialog, [role="dialog"]',
        )))
  )
    return
  const key = event.key.toLowerCase()
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (isProject.value && (key === 'z' || key === 'y')) {
      event.preventDefault()
      showActionFeedback(historyHint.value)
      return
    }
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

// Khi vào editor chỉ đăng ký phím tắt; dữ liệu bản nháp/dự án do các store giữ riêng.
onMounted(() => {
  window.addEventListener('keydown', handleToolShortcut)
})
// Khi rời Studio, gỡ phím tắt, đóng hộp thoại và hủy bộ hẹn giờ thông báo.
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleToolShortcut)
  closeResetDialog()
  closeSharing()
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
  if (isProject.value) return
  // Hỏi cả khi đã hoàn tác hết vì trang mới cũng xóa các nét còn trong lịch sử làm lại.
  if (draft.canUndo || draft.canRedo) {
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
  if (isProject.value) return
  closeResetDialog()
  draft.reset()
  showActionFeedback('Đã tạo trang giấy mới.')
}

// Mở hộp chia sẻ cho chủ dự án đang ở chế độ chung; backend vẫn kiểm tra quyền thực tế.
function openSharing() {
  if (props.isOwner && props.room?.sharingEnabled) shareDialog.value?.showModal()
}

// Đóng dialog khi bấm nút hoặc rời editor, trả việc điều khiển bàn phím về Canvas.
function closeSharing() {
  if (shareDialog.value?.open) shareDialog.value.close()
}

// Thử nối lại đúng dự án với token mới, giữ nét đang chờ và dữ liệu server.
function reconnectProject() {
  if (props.room) void board.connect(props.room.id)
}

// Chuyển nét hoàn thành đến đúng nơi lưu, tránh bản nháp lọt vào dữ liệu dự án.
function commitStroke(operation: Operation) {
  if (isProject.value) board.commit(operation)
  else draft.commit(operation)
}
</script>

<template>
  <div class="studio-page page-container">
    <!-- Vùng thông báo tồn tại sẵn để trình đọc màn hình nhận nội dung mới khi thao tác hoàn tất. -->
    <div class="studio-action-feedback" role="status" aria-live="polite" aria-atomic="true">
      <span v-if="actionFeedback" class="studio-action-toast">{{ actionFeedback }}</span>
    </div>
    <!-- Dialog gốc của HTML giữ focus trong hộp và hỗ trợ phím Esc; nội dung được tạo kiểu theo Studio. -->
    <dialog
      v-if="!isProject"
      ref="resetDialog"
      class="studio-reset-dialog"
      aria-labelledby="reset-dialog-title"
      aria-describedby="reset-dialog-description"
    >
      <div class="studio-reset-dialog-content">
        <span class="studio-reset-dialog-icon" aria-hidden="true">↺</span>
        <p class="studio-reset-dialog-eyebrow">BẮT ĐẦU LẠI</p>
        <h2 id="reset-dialog-title">Tạo trang giấy mới?</h2>
        <p id="reset-dialog-description">
          Bản vẽ và lịch sử Hoàn tác/Làm lại trong phiên này sẽ bị xóa. Bạn không thể khôi phục
          chúng sau khi tạo trang mới.
        </p>
        <div class="studio-reset-dialog-actions">
          <button class="button button-outline" type="button" @click="cancelStartOver">
            Giữ bản vẽ
          </button>
          <button class="button studio-reset-confirm" type="button" @click="confirmStartOver">
            Tạo trang mới
          </button>
        </div>
      </div>
    </dialog>
    <dialog
      ref="shareDialog"
      class="studio-reset-dialog studio-sharing-dialog"
      aria-labelledby="studio-sharing-title"
    >
      <div class="studio-reset-dialog-content">
        <h2 id="studio-sharing-title">Chia sẻ bản vẽ</h2>
        <RoomInvitation v-if="room?.sharingEnabled && isOwner" :key="room.id" :room-id="room.id" />
        <div class="studio-reset-dialog-actions">
          <button class="button button-outline" type="button" @click="closeSharing">Đóng</button>
        </div>
      </div>
    </dialog>
    <div class="studio-heading">
      <div>
        <div class="breadcrumb">
          <RouterLink to="/studio">Studio</RouterLink><span>/</span
          ><span>{{ isProject ? 'Dự án' : 'Vẽ thử' }}</span>
        </div>
        <h1 class="studio-project-title">
          {{ room?.title ?? 'Trang giấy của bạn' }}<span class="heading-period">.</span>
        </h1>
        <p>
          {{
            isProject
              ? 'Vẽ trên dự án của bạn. Các nét hoàn thành được tự động lưu.'
              : 'Chọn công cụ rồi kéo trên trang giấy để vẽ.'
          }}
        </p>
      </div>
      <div class="studio-heading-actions">
        <span class="mode-pill"
          ><span class="status-dot" aria-hidden="true"></span
          >{{
            isProject
              ? room?.sharingEnabled
                ? 'Cùng chỉnh sửa'
                : 'Dự án cá nhân'
              : 'Bản nháp cá nhân'
          }}</span
        >
        <template v-if="isProject">
          <button
            v-if="isOwner && room?.sharingEnabled"
            class="button button-primary"
            type="button"
            :disabled="!canDraw"
            @click="openSharing"
          >
            Chia sẻ
          </button>
        </template>
        <button v-else class="button button-outline" type="button" @click="startOver">
          Tạo trang mới
        </button>
        <RouterLink class="button button-outline" to="/studio">Về Studio</RouterLink>
      </div>
    </div>

    <div v-if="isProject" class="studio-project-status" aria-live="polite">
      <span>{{ isOwner ? 'Bạn là chủ dự án.' : 'Bạn đang cùng chỉnh sửa.' }}</span>
      <span role="status">{{ saveStatus }}</span>
      <span v-if="board.error" class="studio-project-error">{{ board.error }}</span>
      <button
        v-if="board.status === 'error'"
        class="button button-outline"
        type="button"
        @click="reconnectProject"
      >
        Kết nối lại
      </button>
    </div>

    <div class="studio-layout">
      <section class="canvas-panel" aria-label="Khu vực vẽ">
        <div class="canvas-panel-header">
          <div class="panel-title">
            <span class="panel-title-icon">✳</span
            ><strong>{{ isProject ? 'Canvas dự án' : 'Canvas tự do' }}</strong
            ><span class="panel-subtitle">1600 × 900</span>
          </div>
          <div class="panel-meta" role="status" aria-live="polite" aria-atomic="true">
            <span class="status-dot" aria-hidden="true"></span>{{ operationCount }} thao tác
          </div>
        </div>
        <div class="canvas-wrap">
          <DrawingCanvas
            :operations="operations"
            :tool="drawing.tool"
            :color="drawing.color"
            :brush-size="activeSize"
            :enabled="canDraw"
            @commit="commitStroke"
          />
        </div>
        <div class="canvas-panel-footer">
          <span>{{ canDraw ? '✦ Kéo chuột hoặc chạm để vẽ' : 'Đang chờ kết nối để vẽ tiếp' }}</span
          ><span>{{ saveStatus }}</span>
        </div>
      </section>

      <aside class="studio-sidebar" aria-label="Thông tin công cụ">
        <section class="sidebar-card">
          <fieldset class="studio-tools" :disabled="!canDraw">
            <legend class="sidebar-eyebrow">CÔNG CỤ VẼ</legend>
            <div class="tool-list" role="group" aria-label="Chọn công cụ vẽ">
              <button
                class="tool-option"
                :class="{ 'is-selected': drawing.tool === 'freehand' }"
                type="button"
                :aria-pressed="drawing.tool === 'freehand'"
                aria-keyshortcuts="P"
                @click="drawing.tool = 'freehand'"
              >
                <span class="tool-option-icon" aria-hidden="true">〰</span
                ><span class="tool-option-copy"
                  ><strong>Bút tự do</strong><small>Vẽ theo chuyển động</small></span
                ><kbd class="tool-shortcut" aria-hidden="true">P</kbd
                ><span v-if="drawing.tool === 'freehand'" class="active-check" aria-hidden="true"
                  >✓</span
                >
              </button>
              <button
                class="tool-option"
                :class="{ 'is-selected': drawing.tool === 'line' }"
                type="button"
                :aria-pressed="drawing.tool === 'line'"
                aria-keyshortcuts="L"
                @click="drawing.tool = 'line'"
              >
                <span class="tool-option-icon" aria-hidden="true">╱</span
                ><span class="tool-option-copy"
                  ><strong>Đường thẳng</strong><small>Kéo từ đầu đến cuối</small></span
                ><kbd class="tool-shortcut" aria-hidden="true">L</kbd
                ><span v-if="drawing.tool === 'line'" class="active-check" aria-hidden="true"
                  >✓</span
                >
              </button>
              <button
                class="tool-option"
                :class="{ 'is-selected': drawing.tool === 'rectangle' }"
                type="button"
                :aria-pressed="drawing.tool === 'rectangle'"
                aria-keyshortcuts="R"
                @click="drawing.tool = 'rectangle'"
              >
                <span class="tool-option-icon" aria-hidden="true">▭</span
                ><span class="tool-option-copy"
                  ><strong>Hình chữ nhật</strong><small>Kéo để chọn hai góc</small></span
                ><kbd class="tool-shortcut" aria-hidden="true">R</kbd
                ><span v-if="drawing.tool === 'rectangle'" class="active-check" aria-hidden="true"
                  >✓</span
                >
              </button>
              <button
                class="tool-option"
                :class="{ 'is-selected': drawing.tool === 'circle' }"
                type="button"
                :aria-pressed="drawing.tool === 'circle'"
                aria-keyshortcuts="C"
                @click="drawing.tool = 'circle'"
              >
                <span class="tool-option-icon" aria-hidden="true">◯</span
                ><span class="tool-option-copy"
                  ><strong>Hình tròn</strong><small>Kéo từ tâm ra bán kính</small></span
                ><kbd class="tool-shortcut" aria-hidden="true">C</kbd
                ><span v-if="drawing.tool === 'circle'" class="active-check" aria-hidden="true"
                  >✓</span
                >
              </button>
              <button
                class="tool-option"
                :class="{ 'is-selected': drawing.tool === 'eraser' }"
                type="button"
                :aria-pressed="drawing.tool === 'eraser'"
                aria-keyshortcuts="E"
                @click="drawing.tool = 'eraser'"
              >
                <span class="tool-option-icon" aria-hidden="true">⌫</span
                ><span class="tool-option-copy"
                  ><strong>Tẩy</strong><small>Xóa nét khi kéo</small></span
                ><kbd class="tool-shortcut" aria-hidden="true">E</kbd
                ><span v-if="drawing.tool === 'eraser'" class="active-check" aria-hidden="true"
                  >✓</span
                >
              </button>
            </div>
            <div v-if="drawing.tool === 'eraser'" class="tool-detail">
              <span>Chế độ</span><strong>Tẩy nét</strong>
            </div>
            <div v-else class="tool-control">
              <label class="tool-control-label" for="stroke-color">Màu nét</label>
              <div class="color-control">
                <input id="stroke-color" v-model="drawing.color" class="color-input" type="color" />
                <strong>{{ drawing.color.toUpperCase() }}</strong>
              </div>
            </div>
            <div class="tool-control">
              <div class="tool-control-heading">
                <label class="tool-control-label" for="brush-size">{{
                  drawing.tool === 'eraser' ? 'Cỡ tẩy' : 'Độ dày nét'
                }}</label>
                <output for="brush-size">{{ activeSize }} px</output>
              </div>
              <input
                id="brush-size"
                v-model.number="activeSize"
                class="size-input"
                type="range"
                min="1"
                max="50"
                step="1"
              />
            </div>
            <!-- Hai nút dùng chung lịch sử với phím tắt và tự khóa khi không còn thao tác phù hợp. -->
            <div
              v-if="!isProject"
              class="studio-history-actions"
              role="group"
              aria-label="Lịch sử bản vẽ"
            >
              <button
                type="button"
                :disabled="!draft.canUndo"
                aria-describedby="studio-history-hint"
                aria-keyshortcuts="Control+Z Meta+Z"
                @click="undoStroke"
              >
                Hoàn tác <kbd>Ctrl+Z</kbd>
              </button>
              <button
                type="button"
                :disabled="!draft.canRedo"
                aria-describedby="studio-history-hint"
                aria-keyshortcuts="Control+Y Control+Shift+Z Meta+Shift+Z"
                @click="redoStroke"
              >
                Làm lại <kbd>Ctrl+Y</kbd>
              </button>
            </div>
            <!-- Lời nhắc luôn hiện trên màn hình và được trình đọc màn hình thông báo khi trạng thái đổi. -->
            <p
              id="studio-history-hint"
              class="studio-history-hint"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {{ historyHint }}
            </p>
            <p class="studio-tool-status" role="status" aria-live="polite" aria-atomic="true">
              {{ toolStatus }}
            </p>
            <p class="studio-shortcut-help">
              Phím tắt: P bút, L đường thẳng, R chữ nhật, C hình tròn, E tẩy.
            </p>
            <p class="sidebar-helper">Đổi công cụ không làm mất những nét đã vẽ.</p>
          </fieldset>
        </section>
        <section class="sidebar-tip">
          <div class="tip-icon">✴</div>
          <p>Đôi khi một nét nguệch ngoạc là điểm bắt đầu của ý tưởng tuyệt vời.</p>
        </section>
        <p class="session-note">
          {{
            isProject
              ? 'Nét đã xác nhận được lưu vào dự án và tải lại khi bạn mở lần sau.'
              : 'Canvas hiện được giữ trong phiên trình duyệt. Tải lại trang sẽ tạo bản vẽ mới.'
          }}
        </p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.studio-tools {
  min-width: 0;
  margin: 0;
  padding: 0;
  border: 0;
}
.studio-tools:disabled {
  opacity: 0.6;
}
.studio-tools :disabled {
  cursor: not-allowed;
}
.studio-project-title {
  overflow-wrap: anywhere;
}
.studio-heading-actions {
  flex-wrap: wrap;
}
.studio-project-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 20px;
  margin: -10px 0 22px;
  color: #627d65;
  font-size: 13px;
}
.studio-project-error {
  color: #9b473c;
}
.studio-sharing-dialog {
  width: min(520px, calc(100vw - 32px));
}
</style>
