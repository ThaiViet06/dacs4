import type { Operation, Point } from './model'

// Khoảng cách bình phương đến đoạn thẳng, kể cả khi hai đầu đoạn trùng nhau.
function distanceSquared(point: Point, start: Point, end: Point) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = dx * dx + dy * dy
  const fraction = length
    ? Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length))
    : 0
  return (point.x - start.x - fraction * dx) ** 2 + (point.y - start.y - fraction * dy) ** 2
}

// Ramer–Douglas–Peucker dạng lặp giữ hai đầu nét và tránh đệ quy sâu.
export function simplifyStroke(operation: Operation): Operation {
  if (!('points' in operation) || operation.points.length < 3) return operation
  const points = operation.points
  const last = points.length - 1
  const keep = new Uint8Array(points.length)
  keep[0] = keep[last] = 1
  const threshold = Math.min(0.5, operation.width / 8) ** 2
  const stack = [0, last]
  while (stack.length) {
    const end = stack.pop()!
    const start = stack.pop()!
    let farthest = -1
    let max = threshold
    for (let index = start + 1; index < end; index++) {
      const distance = distanceSquared(points[index]!, points[start]!, points[end]!)
      if (distance > max) {
        farthest = index
        max = distance
      }
    }
    if (farthest >= 0) {
      keep[farthest] = 1
      stack.push(start, farthest, farthest, end)
    }
  }
  return { ...operation, points: points.filter((_, index) => keep[index]) }
}
