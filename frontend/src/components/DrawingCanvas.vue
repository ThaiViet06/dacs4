<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { coordinates, HEIGHT, WIDTH, type Operation } from '../drawing/model'
import { drawOperation, render } from '../drawing/renderer'
import { simplifyStroke } from '../drawing/simplify'

const props = withDefaults(
  defineProps<{
    operations: Operation[]
    snapshot?: ImageBitmap | null
    pending?: Operation[]
    remote?: Operation[]
    livePreview?: boolean
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

const emit = defineEmits<{
  commit: [operation: Operation]
  preview: [operation: Operation]
  cancelPreview: [id: string]
}>()
const canvas = ref<HTMLCanvasElement | null>(null)
const remoteCanvas = ref<HTMLCanvasElement | null>(null)
const previewCanvas = ref<HTMLCanvasElement | null>(null)
const active = shallowRef<Operation | null>(null)
let pointerId: number | null = null
let resizeObserver: ResizeObserver | undefined
let committedFrame = 0
let previewFrame = 0
let remoteFrame = 0
let drawnPoints = 0
let lastPreview = -Infinity
let painted: Operation[] = []
let paintedSource: Operation[] | undefined
let rasterVersion = 0
let checkpoints: { count: number; bitmap: ImageBitmap }[] = []
let checkpointPending = false

// Chỉ nối nét mới. Nếu thứ tự hoặc visibility đổi, phục hồi ảnh gần nhất thuộc cùng prefix.
function repaintCommitted() {
  const element = canvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  const last = painted.length - 1
  let prefix =
    paintedSource === props.operations && painted[last] === props.operations[last]
      ? painted.length
      : 0
  while (prefix < painted.length && painted[prefix] === props.operations[prefix]) prefix++
  let start = prefix
  if (prefix < painted.length || !painted.length) {
    rasterVersion++
    checkpoints = checkpoints.filter((checkpoint) => {
      if (checkpoint.count <= prefix) return true
      checkpoint.bitmap.close()
      return false
    })
    const checkpoint = checkpoints.at(-1)
    context.clearRect(0, 0, WIDTH, HEIGHT)
    const base = checkpoint?.bitmap ?? props.snapshot
    if (base) context.drawImage(base, 0, 0, WIDTH, HEIGHT)
    start = checkpoint?.count ?? 0
  }
  painted.length = prefix
  for (let index = start; index < props.operations.length; index++) {
    const operation = props.operations[index]!
    drawOperation(context, operation)
    painted[index] = operation
  }
  paintedSource = props.operations
  if (
    typeof createImageBitmap === 'function' &&
    !checkpointPending &&
    painted.length - (checkpoints.at(-1)?.count ?? 0) >= 64
  ) {
    const version = rasterVersion
    const count = painted.length
    checkpointPending = true
    void createImageBitmap(element)
      .then((bitmap) => {
        if (version !== rasterVersion) return bitmap.close()
        checkpoints.push({ count, bitmap })
        if (checkpoints.length > 2) checkpoints.shift()?.bitmap.close()
      })
      .catch(() => {})
      .finally(() => (checkpointPending = false))
  }
}

// Khi bitmap gốc hoặc DPR đổi, dọn checkpoint và phát lại trên bộ đệm mới.
function invalidateRaster() {
  rasterVersion++
  painted = []
  paintedSource = undefined
  for (const checkpoint of checkpoints) checkpoint.bitmap.close()
  checkpoints = []
}

// Lớp riêng chứa nét đang kéo. Bút và tẩy chỉ vẽ các đoạn mới giữa hai khung hình.
function repaintPreview() {
  const element = previewCanvas.value
  const context = element?.getContext('2d')
  if (!element || !context) return

  context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
  const operation = active.value
  if (!operation || !('points' in operation) || !drawnPoints) context.clearRect(0, 0, WIDTH, HEIGHT)
  if (!operation) {
    drawnPoints = 0
    return
  }
  if ('points' in operation && drawnPoints === operation.points.length) return
  const segment =
    'points' in operation
      ? { ...operation, points: operation.points.slice(Math.max(0, drawnPoints - 1)) }
      : operation
  if (operation.type === 'eraser') {
    const paperColor = getComputedStyle(canvas.value!.parentElement!).backgroundColor
    drawOperation(context, {
      ...segment,
      type: 'freehand',
      points: 'points' in segment ? segment.points : [],
      color: paperColor,
    })
  } else {
    drawOperation(context, segment)
  }
  drawnPoints = 'points' in operation ? operation.points.length : 0
}

// Ghép nét chờ của mình với preview của cộng tác viên. Tẩy từ xa hiện vòng công cụ.
function requestRemoteRepaint() {
  if (remoteFrame) return
  remoteFrame = requestAnimationFrame(() => {
    remoteFrame = 0
    const element = remoteCanvas.value
    const context = element?.getContext('2d')
    if (!element || !context) return
    context.setTransform(element.width / WIDTH, 0, 0, element.height / HEIGHT, 0, 0)
    context.clearRect(0, 0, WIDTH, HEIGHT)
    const paper = getComputedStyle(canvas.value!.parentElement!).backgroundColor
    for (const stroke of props.pending ?? [])
      drawOperation(
        context,
        stroke.type === 'eraser' ? { ...stroke, type: 'freehand', color: paper } : stroke,
      )
    render(
      context,
      (props.remote ?? []).filter((stroke) => stroke.type !== 'eraser'),
    )
    for (const stroke of props.remote ?? []) {
      if (stroke.type !== 'eraser' || !('points' in stroke)) continue
      const point = stroke.points.at(-1)
      if (!point) continue
      context.beginPath()
      context.strokeStyle = '#677584'
      context.lineWidth = 1
      context.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2)
      context.stroke()
    }
  })
}

// Tối đa 15 frame/giây. Mẫu hiển thị từ xa giữ điểm cuối và không sửa nét sẽ commit.
function relayPreview() {
  const operation = active.value
  const now = performance.now()
  if (!props.livePreview || !operation || now - lastPreview < 1000 / 15) return
  lastPreview = now
  if ('points' in operation && operation.points.length > 256) {
    const last = operation.points.length - 1
    emit('preview', {
      ...operation,
      points: Array.from(
        { length: 256 },
        (_, index) => operation.points[Math.round((index * last) / 255)]!,
      ),
    })
  } else emit('preview', operation)
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
    invalidateRaster()
  }
  // Hai canvas có cùng bộ đệm pixel để nét xem trước trùng khít với nét đã lưu ở mọi DPR.
  if (preview.width !== width || preview.height !== height) {
    preview.width = width
    preview.height = height
  }
  if (
    remoteCanvas.value &&
    (remoteCanvas.value.width !== width || remoteCanvas.value.height !== height)
  ) {
    remoteCanvas.value.width = width
    remoteCanvas.value.height = height
  }
  drawnPoints = 0
  requestCommittedRepaint()
  requestPreviewRepaint()
  requestRemoteRepaint()
}

// Đổi tọa độ con trỏ trên màn hình sang tọa độ cố định của bản vẽ.
function pointFrom(event: PointerEvent, bounds = canvas.value!.getBoundingClientRect()) {
  return coordinates(event.clientX, event.clientY, bounds)
}

// Bắt đầu một nét mới, lưu công cụ hiện tại và giữ quyền theo dõi con trỏ.
function start(event: PointerEvent) {
  if (!props.enabled || !event.isPrimary || event.button !== 0 || active.value || !canvas.value)
    return
  event.preventDefault()
  // Trả focus về Canvas để phím tắt không còn bị giữ trong ô nhập vừa chỉnh trước khi vẽ.
  canvas.value.focus({ preventScroll: true })
  pointerId = event.pointerId
  const point = pointFrom(event)
  // Chốt màu và độ dày lúc bắt đầu để đổi điều khiển giữa chừng chỉ ảnh hưởng nét kế tiếp.
  const common = { id: crypto.randomUUID(), width: props.brushSize, color: props.color }
  // Bút và tẩy lưu đường đi; các hình lưu hai điểm, trong đó điểm đầu của hình tròn là tâm.
  active.value =
    props.tool === 'freehand' || props.tool === 'eraser'
      ? { ...common, type: props.tool, points: [point] }
      : { ...common, type: props.tool, start: point, end: point }
  drawnPoints = 0
  lastPreview = -Infinity
  canvas.value.setPointerCapture(event.pointerId)
  // Theo dõi trên window để vẫn nhận pointerup nếu trình duyệt làm mất pointer capture ngoài canvas.
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', cancelPointer)
  requestPreviewRepaint()
  relayPreview()
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
    const bounds = canvas.value!.getBoundingClientRect()
    for (const sample of samples) {
      const operation = active.value
      if (!operation || !('points' in operation)) continue
      const point = pointFrom(sample, bounds)
      const last = operation.points.at(-1)
      if (point.x === last?.x && point.y === last?.y) continue
      if (operation.points.length >= 2048) {
        operation.points = operation.points.filter((_, index) => index % 2 === 0)
        drawnPoints = 0
      }
      operation.points.push(point)
    }
  }
  requestPreviewRepaint()
  relayPreview()
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
    emit('commit', simplifyStroke(operation))
  } else if (props.livePreview) emit('cancelPreview', operation.id)
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
  if (active.value && props.livePreview) emit('cancelPreview', active.value.id)
  active.value = null
  requestPreviewRepaint()
}

// Chỉ hủy nét khi trình duyệt báo hủy đúng con trỏ đang được theo dõi.
function cancelPointer(event: PointerEvent) {
  if (event.pointerId === pointerId) cancel()
}

// Khi danh sách thao tác thay đổi, vẽ lại lớp canvas đã lưu.
watch(() => props.operations, requestCommittedRepaint)
watch(() => props.operations.length, requestCommittedRepaint)
watch([() => props.pending, () => props.remote], requestRemoteRepaint)
// Nền từ lần đồng bộ khác không chia sẻ checkpoint ảnh với nền cũ.
watch(
  () => props.snapshot,
  () => {
    invalidateRaster()
    requestCommittedRepaint()
  },
)
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
  cancelAnimationFrame(remoteFrame)
  invalidateRaster()
})
</script>

<template>
  <div class="drawing-canvas-stack">
    <canvas
      ref="canvas"
      :width="WIDTH"
      :height="HEIGHT"
      class="drawing-canvas"
      tabindex="0"
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
      ref="remoteCanvas"
      :width="WIDTH"
      :height="HEIGHT"
      class="drawing-canvas-preview"
      aria-hidden="true"
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
