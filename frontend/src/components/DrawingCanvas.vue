<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { appendPoint, coordinates, HEIGHT, WIDTH, type Operation } from '../drawing/model'
import { render } from '../drawing/renderer'

const props = withDefaults(defineProps<{
  operations: Operation[]
  tool?: 'freehand' | 'line' | 'rectangle'
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
const active = ref<Operation | null>(null)
let pointerId: number | null = null
let resizeObserver: ResizeObserver | undefined
let frame = 0

function repaint() {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  // Canvas pixels are rebuilt from vector operations after every size change.
  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  context.clearRect(0, 0, WIDTH, HEIGHT)
  render(context, props.operations)
  // Nét xem trước được dựng từ active; danh sách thao tác chỉ đổi sau khi thả con trỏ.
  if (active.value) render(context, [active.value])
}

function requestRepaint() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    repaint()
  })
}

function resize() {
  const element = canvas.value
  if (!element) return
  const rect = element.getBoundingClientRect()
  if (!rect.width || !rect.height) return
  const ratio = window.devicePixelRatio || 1
  const width = Math.max(1, Math.round(rect.width * ratio))
  const height = Math.max(1, Math.round(rect.height * ratio))
  if (element.width !== width || element.height !== height) {
    element.width = width
    element.height = height
  }
  requestRepaint()
}

function pointFrom(event: PointerEvent) {
  return coordinates(event.clientX, event.clientY, canvas.value!.getBoundingClientRect())
}

function start(event: PointerEvent) {
  if (!props.enabled || !event.isPrimary || event.button !== 0 || active.value || !canvas.value) return
  event.preventDefault()
  pointerId = event.pointerId
  const point = pointFrom(event)
  const common = { id: crypto.randomUUID(), width: props.brushSize, color: props.color }
  // Đường thẳng và chữ nhật lưu hai góc kéo; bút tự do lưu toàn bộ đường đi.
  active.value = props.tool === 'freehand'
    ? { ...common, type: 'freehand', points: [point] }
    : { ...common, type: props.tool, start: point, end: point }
  canvas.value.setPointerCapture(event.pointerId)
  // Theo dõi trên window để vẫn nhận pointerup nếu trình duyệt làm mất pointer capture ngoài canvas.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  requestRepaint()
}

function move(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  event.preventDefault()
  if (active.value.type === 'line' || active.value.type === 'rectangle') {
    // Hai công cụ hình học chỉ cập nhật đầu cuối; nét xem trước không tạo thêm thao tác.
    active.value = { ...active.value, end: pointFrom(event) }
  } else {
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
  requestRepaint()
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
  // Chữ nhật cần cả chiều rộng và chiều cao; đường thẳng chỉ cần một chiều thay đổi.
  const hasSize = operation.type === 'rectangle'
    ? operation.start.x !== operation.end.x && operation.start.y !== operation.end.y
    : operation.type === 'line'
      ? operation.start.x !== operation.end.x || operation.start.y !== operation.end.y
      : true
  if (hasSize) {
    emit('commit', operation)
  }
  requestRepaint()
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
  requestRepaint()
}

function cancelPointer(event: PointerEvent) {
  if (event.pointerId === pointerId) cancel()
}

watch(() => props.operations, requestRepaint, { deep: true })
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
  cancelAnimationFrame(frame)
})
</script>

<template>
  <canvas
    ref="canvas"
    :width="WIDTH"
    :height="HEIGHT"
    class="drawing-canvas"
    role="img"
    :aria-label="tool === 'rectangle' ? 'Kéo để vẽ hình chữ nhật' : tool === 'line' ? 'Kéo để vẽ đường thẳng' : 'Kéo để vẽ nét tự do'"
    @pointerdown="start"
  />
</template>
