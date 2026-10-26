import type { Operation } from './model'

export function drawOperation(context: CanvasRenderingContext2D, operation: Operation) {
  context.save()
  context.globalCompositeOperation = operation.type === 'eraser' ? 'destination-out' : 'source-over'
  context.strokeStyle = operation.color
  context.fillStyle = operation.color
  context.lineWidth = operation.width
  context.lineCap = 'round'
  context.lineJoin = 'round'
  context.beginPath()
  if ('points' in operation) {
    const first = operation.points[0]
    if (first) {
      if (operation.points.length === 1) {
        context.arc(first.x, first.y, operation.width / 2, 0, Math.PI * 2)
        context.fill()
      } else {
        context.moveTo(first.x, first.y)
        for (const point of operation.points.slice(1)) context.lineTo(point.x, point.y)
        context.stroke()
      }
    }
  } else {
    const { start, end } = operation
    if (operation.type === 'line') { context.moveTo(start.x, start.y); context.lineTo(end.x, end.y) }
    // Chiều rộng/cao âm giúp hình chữ nhật hiện đúng khi kéo ngược sang trái hoặc lên trên.
    if (operation.type === 'rectangle') context.rect(start.x, start.y, end.x - start.x, end.y - start.y)
    if (operation.type === 'circle') context.arc(start.x, start.y, Math.hypot(end.x - start.x, end.y - start.y), 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()
}

export function render(context: CanvasRenderingContext2D, operations: Operation[]) {
  for (const operation of operations) drawOperation(context, operation)
}
