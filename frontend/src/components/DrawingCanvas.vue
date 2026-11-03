<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { appendPoint, coordinates, HEIGHT, WIDTH, type Operation } from '../drawing/model'
import { render } from '../drawing/renderer'

const props = withDefaults(
  defineProps<{
    operations: Operation[]
    tool?: 'freehand' | 'line' | 'rectangle' | 'circle' | 'eraser'
    color?: string
    brushSize?: number
    enabled?: boolean
  }>(),
  {
    tool: 'freehand',
    color: '#263b53',
    brushSize: 4,
    enabled: true,
  },
)

const emit = defineEmits<{ commit: [operation: Operation] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const active = ref<Operation | null>(null)
let pointerId: number | null = null
let resizeObserver: ResizeObserver | undefined
let committedFrame = 0
let previewFrame = 0

// Vẽ lại toàn bộ thao tác đã lưu trên lớp canvas chính theo tọa độ 1600 × 900.
function repaintCommitted() {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  // Canvas dưới chỉ dựng lại các thao tác đã lưu khi dữ liệu hoặc kích thước thay đổi.
  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  context.clearRect(0, 0, WIDTH, HEIGHT)
  render(context, props.operations)
}

// Làm mới lớp xem trước để nét đang kéo không ghi đè lên bản vẽ đã lưu.
function repaintPreview() {
  const element = previewCanvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  // Canvas trên luôn được xóa trước khi vẽ nét đang kéo; hủy thao tác không chạm vào nét đã lưu.
  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  context.clearRect(0, 0, WIDTH, HEIGHT)
  const operation = active.value
  if (!operation) return
  if (operation.type === 'eraser') {
    // Phủ màu giấy để xem trước vùng tẩy; khi lưu, renderer vẫn xóa bằng destination-out.
    const paperColor = getComputedStyle(canvas.value!.parentElement!).backgroundColor
    render(context, [{ ...operation, type: 'freehand', color: paperColor }])
  } else {
    render(context, [operation])
  }
}

// Gom các yêu cầu vẽ lại bản chính vào một khung hình của trình duyệt.
function requestCommittedRepaint() {
  if (committedFrame) return
  committedFrame = requestAnimationFrame(() => {
    committedFrame = 0
    repaintCommitted()
  })
}

// Gom các lần cập nhật nét xem trước vào một khung hình.
function requestPreviewRepaint() {
  if (previewFrame) return
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0
    repaintPreview()
  })
}

// Khớp kích thước bộ đệm của hai canvas với kích thước hiển thị và độ nét màn hình.
function resize() {
  const element = canvas.value
  const preview = previewCanvas.value
  if (!element || !preview) return
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }
  // Hai canvas có cùng bộ đệm pixel để nét xem trước trùng khít với nét đã lưu ở mọi DPR.
  if (preview.width !== width || preview.height !== height) {
    preview.width = width
    preview.height = height
  }
  requestCommittedRepaint()
  requestPreviewRepaint()
}

// Đổi tọa độ con trỏ trên màn hình sang tọa độ cố định của bản vẽ.
function pointFrom(event: PointerEvent) {
  return coordinates(event.clientX, event.clientY, canvas.value!.getBoundingClientRect())
}

// Bắt đầu một nét mới, lưu công cụ hiện tại và giữ quyền theo dõi con trỏ.
function start(event: PointerEvent) {
  if (!props.enabled || !event.isPrimary || event.button !== 0 || active.value || !canvas.value)
    return
  event.preventDefault()
  pointerId = event.pointerId
  const point = pointFrom(event)
  // Chốt màu và độ dày lúc bắt đầu để đổi điều khiển giữa chừng chỉ ảnh hưởng nét kế tiếp.
  const common = { id: crypto.randomUUID(), width: props.brushSize, color: props.color }
  // Bút và tẩy lưu đường đi; các hình lưu hai điểm, trong đó điểm đầu của hình tròn là tâm.
  active.value =
    props.tool === 'freehand' || props.tool === 'eraser'
      ? { ...common, type: props.tool, points: [point] }
      : { ...common, type: props.tool, start: point, end: point }
  canvas.value.setPointerCapture(event.pointerId)
  // Theo dõi trên window để vẫn nhận pointerup nếu trình duyệt làm mất pointer capture ngoài canvas.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  requestPreviewRepaint()
}

// Cập nhật đường đi của bút/tẩy hoặc điểm cuối của hình khi kéo con trỏ.
function move(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  event.preventDefault()
  if (
    active.value.type === 'line' ||
    active.value.type === 'rectangle' ||
    active.value.type === 'circle'
  ) {
    // Cập nhật điểm kéo của hình đang xem trước mà chưa ghi thêm thao tác vào bản vẽ.
    active.value = { ...active.value, end: pointFrom(event) }
  } else {
    // Tẩy lấy mẫu con trỏ như bút tự do để khi phát lại vẫn xóa đúng đường đã kéo.
    const coalesced = event.getCoalescedEvents?.()
    const samples = coalesced?.length ? coalesced : [event]
    for (const sample of samples) {
      const operation = active.value
      if (!operation || !('points' in operation)) continue
      const point = pointFrom(sample)
      const last = operation.points.at(-1)
      if (point.x !== last?.x || point.y !== last?.y) active.value = appendPoint(operation, point)
    }
  }
  requestPreviewRepaint()
}

// Kết thúc thao tác kéo; hủy nét nếu quyền vẽ mất trước pointerup, còn hợp lệ thì phát cho nơi lưu.
function finish(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  if (!props.enabled) {
    cancel()
    return
  }
  move(event)
  const operation = active.value
  active.value = null
  pointerId = null
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', finish)
  window.removeEventListener('pointercancel', cancelPointer)
  if (canvas.value?.hasPointerCapture(event.pointerId))
    canvas.value.releasePointerCapture(event.pointerId)
  // Chữ nhật cần đủ hai chiều; đường thẳng và hình tròn cần bán kính/khoảng kéo khác 0.
  const hasSize =
    operation.type === 'rectangle'
      ? operation.start.x !== operation.end.x && operation.start.y !== operation.end.y
      : operation.type === 'line' || operation.type === 'circle'
        ? operation.start.x !== operation.end.x || operation.start.y !== operation.end.y
        : true
  if (hasSize) {
    emit('commit', operation)
  }
  requestPreviewRepaint()
}

// Hủy nét đang vẽ và gỡ các sự kiện con trỏ mà không lưu thao tác.
function cancel() {
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', finish)
  window.removeEventListener('pointercancel', cancelPointer)
  if (pointerId !== null && canvas.value?.hasPointerCapture(pointerId)) {
    canvas.value.releasePointerCapture(pointerId)
  }
  pointerId = null
  active.value = null
  requestPreviewRepaint()
}

// Chỉ hủy nét khi trình duyệt báo hủy đúng con trỏ đang được theo dõi.
function cancelPointer(event: PointerEvent) {
  if (event.pointerId === pointerId) cancel()
}

// Khi danh sách thao tác thay đổi, vẽ lại lớp canvas đã lưu.
watch(() => props.operations, requestCommittedRepaint, { deep: true })
// Khi quyền vẽ bị tắt, hủy nét dở để tránh lưu một thao tác không hợp lệ.
watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) cancel()
  },
  { flush: 'sync' },
)
// Khi đổi công cụ giữa lúc kéo, hủy nét để mỗi thao tác chỉ có một kiểu vẽ.
watch(
  () => props.tool,
  () => {
    if (active.value) cancel()
  },
)

// Khi canvas xuất hiện, theo dõi thay đổi kích thước và hủy nét nếu cửa sổ mất focus.
onMounted(() => {
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value!)
  window.addEventListener('blur', cancel)
  resize()
})

// Khi canvas bị tháo, dừng observer, sự kiện và các khung hình còn chờ.
onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('blur', cancel)
  cancel()
  cancelAnimationFrame(committedFrame)
  cancelAnimationFrame(previewFrame)
})
</script>

<template>
  <div class="drawing-canvas-stack">
    <canvas
      ref="canvas"
      :width="WIDTH"
      :height="HEIGHT"
      class="drawing-canvas"
      role="img"
      :aria-label="
        tool === 'eraser'
          ? 'Kéo để tẩy nét vẽ'
          : tool === 'circle'
            ? 'Kéo từ tâm để vẽ hình tròn'
            : tool === 'rectangle'
              ? 'Kéo để vẽ hình chữ nhật'
              : tool === 'line'
                ? 'Kéo để vẽ đường thẳng'
                : 'Kéo để vẽ nét tự do'
      "
      @pointerdown="start"
    />
    <canvas
      ref="previewCanvas"
      :width="WIDTH"
      :height="HEIGHT"
      class="drawing-canvas-preview"
      aria-hidden="true"
    />
  </div>
</template>
