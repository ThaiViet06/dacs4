import type { Operation } from './model'

// Vẽ một thao tác theo hình học của nó; thao tác tẩy xóa pixel đã vẽ trước đó.
export function drawOperation(context: CanvasRenderingContext2D, operation: Operation) {
  context.save()
  // Tẩy xóa pixel của các nét trước đó; màu giấy nằm ở CSS nên không bị xóa theo.
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
    // Khoảng cách từ tâm đến điểm kéo là bán kính, nên kéo theo hướng nào cũng được.
    if (operation.type === 'circle') context.arc(start.x, start.y, Math.hypot(end.x - start.x, end.y - start.y), 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()
}

// Phát lại các thao tác theo thứ tự để hình và nét tẩy cho đúng kết quả cuối.
export function render(context: CanvasRenderingContext2D, operations: Operation[]) {
  for (const operation of operations) drawOperation(context, operation)
}
