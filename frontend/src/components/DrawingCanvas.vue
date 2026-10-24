<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { appendPoint, coordinates, HEIGHT, WIDTH, type Operation } from '../drawing/model'
import { render } from '../drawing/renderer'

const props = withDefaults(defineProps<{
  operations: Operation[]
  color?: string
  brushSize?: number
  enabled?: boolean
}>(), {
  color: '#263b53',
  brushSize: 8,
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
  active.value = {
    id: crypto.randomUUID(),
    type: 'freehand',
    width: props.brushSize,
    color: props.color,
    points: [pointFrom(event)],
  }
  canvas.value.setPointerCapture(event.pointerId)
  requestRepaint()
}

function move(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  event.preventDefault()
  const coalesced = event.getCoalescedEvents?.()
  const samples = coalesced?.length ? coalesced : [event]
  for (const sample of samples) {
    const point = pointFrom(sample)
    const last = active.value && 'points' in active.value ? active.value.points.at(-1) : undefined
    if (point.x !== last?.x || point.y !== last?.y) active.value = appendPoint(active.value!, point)
  }
  requestRepaint()
}

function finish(event: PointerEvent) {
  if (!active.value || event.pointerId !== pointerId) return
  move(event)
  const operation = active.value
  active.value = null
  pointerId = null
  if (canvas.value?.hasPointerCapture(event.pointerId)) canvas.value.releasePointerCapture(event.pointerId)
  emit('commit', operation)
  requestRepaint()
}

function cancel() {
  if (pointerId !== null && canvas.value?.hasPointerCapture(pointerId)) {
    canvas.value.releasePointerCapture(pointerId)
  }
  pointerId = null
  active.value = null
  requestRepaint()
}

watch(() => props.operations, requestRepaint, { deep: true })
watch(() => props.enabled, (enabled) => { if (!enabled) cancel() })

onMounted(() => {
  resizeObserver = new ResizeObserver(resize)
  resizeObserver.observe(canvas.value!)
  window.addEventListener('blur', cancel)
  resize()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  window.removeEventListener('blur', cancel)
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
    aria-label="Drawing canvas. Drag with a mouse, pen, or finger to draw a freehand stroke."
    @pointerdown="start"
    @pointermove="move"
    @pointerup="finish"
    @pointercancel="cancel"
    @lostpointercapture="cancel"
  />
</template>
