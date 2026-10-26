<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { appendPoint, coordinates, HEIGHT, WIDTH, type Operation } from '../drawing/model'
import { render } from '../drawing/renderer'

const props = withDefaults(defineProps<{
  operations: Operation[]
  tool?: 'freehand' | 'line' | 'rectangle' | 'circle' | 'eraser'
  color?: string
  brushSize?: number
  enabled?: boolean
}>(), {
  tool: 'freehand',
  color: '#263b53',
  brushSize: 4,
  enabled: true,
})

const emit = defineEmits<{ commit: [operation: Operation] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const active = ref<Operation | null>(null)
let pointerId: number | null = null
let resizeObserver: ResizeObserver | undefined
let committedFrame = 0
let previewFrame = 0

function repaintCommitted() {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  // Canvas dưới chỉ dựng lại các thao tác đã lưu khi dữ liệu hoặc kích thước thay đổi.
  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  context.clearRect(0, 0, WIDTH, HEIGHT)
  render(context, props.operations)
}

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

function requestCommittedRepaint() {
  if (committedFrame) return
  committedFrame = requestAnimationFrame(() => {
    committedFrame = 0
    repaintCommitted()
  })
}

function requestPreviewRepaint() {
  if (previewFrame) return
  previewFrame = requestAnimationFrame(() => {
    previewFrame = 0
    repaintPreview()
  })
}

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

function pointFrom(event: PointerEvent) {
  return coordinates(event.clientX, event.clientY, canvas.value!.getBoundingClientRect())
}

function start(event: PointerEvent) {
  if (!props.enabled || !event.isPrimary || event.button !== 0 || active.value || !canvas.value) return
  event.preventDefault()
  pointerId = event.pointerId
  const point = pointFrom(event)
  // Chốt màu và độ dày lúc bắt đầu để đổi điều khiển giữa chừng chỉ ảnh hưởng nét kế tiếp.
  const common = { id: crypto.randomUUID(), width: props.brushSize, color: props.color }
  // Bút và tẩy lưu đường đi; các hình lưu hai điểm, trong đó điểm đầu của hình tròn là tâm.
  active.value = props.tool === 'freehand' || props.tool === 'eraser'
    ? { ...common, type: props.tool, points: [point] }
    : { ...common, type: props.tool, start: point, end: point }
  canvas.value.setPointerCapture(event.pointerId)
  // Theo dõi trên window để vẫn nhận pointerup nếu trình duyệt làm mất pointer capture ngoài canvas.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  requestPreviewRepaint()
}

function move(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  event.preventDefault()
  if (active.value.type === 'line' || active.value.type === 'rectangle' || active.value.type === 'circle') {
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

function finish(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  move(event)
  const operation = active.value
  active.value = null
  pointerId = null
  window.removeEventListener('pointermove', move)
  window.removeEventListener('pointerup', finish)
  window.removeEventListener('pointercancel', cancelPointer)
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  // Chữ nhật cần đủ hai chiều; đường thẳng và hình tròn cần bán kính/khoảng kéo khác 0.
  const hasSize = operation.type === 'rectangle'
    ? operation.start.x !== operation.end.x && operation.start.y !== operation.end.y
    : operation.type === 'line' || operation.type === 'circle'
      ? operation.start.x !== operation.end.x || operation.start.y !== operation.end.y
      : true
  if (hasSize) {
    emit('commit', operation)
  }
  requestPreviewRepaint()
}

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

function cancelPointer(event: PointerEvent) {
  if (event.pointerId === pointerId) cancel()
}

watch(() => props.operations, requestCommittedRepaint, { deep: true })
watch(() => props.enabled, (enabled) => { if (!enabled) cancel() })
watch(() => props.tool, () => { if (active.value) cancel() })

onMounted(() => {
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value!)
  window.addEventListener('blur', cancel)
  resize()
})

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
      :aria-label="tool === 'eraser' ? 'Kéo để tẩy nét vẽ' : tool === 'circle' ? 'Kéo từ tâm để vẽ hình tròn' : tool === 'rectangle' ? 'Kéo để vẽ hình chữ nhật' : tool === 'line' ? 'Kéo để vẽ đường thẳng' : 'Kéo để vẽ nét tự do'"
      @pointerdown="start"
    />
    <canvas ref="previewCanvas" :width="WIDTH" :height="HEIGHT" class="drawing-canvas-preview" aria-hidden="true" />
  </div>
</template>
