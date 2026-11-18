import { HEIGHT, WIDTH, type Operation, type Point, type Tool } from './model.ts'

const tools = [
  'freehand',
  'eraser',
  'line',
  'rectangle',
  'circle',
] as const satisfies readonly Tool[]
const header = 15

// Codec v1 khớp định dạng bytea của backend. Chỉ đóng gói khi đọc ra được đúng tọa độ gốc.
export function encodeStroke(operation: Operation): string | null {
  const points = 'points' in operation ? operation.points : [operation.start, operation.end]
  if (
    operation.id !== operation.id.toLowerCase() ||
    operation.color !== operation.color.toLowerCase() ||
    points.length > 2048
  )
    return null
  const bytes = new Uint8Array(header + points.length * 6)
  const view = new DataView(bytes.buffer)
  bytes[0] = 1
  bytes[1] = tools.indexOf(operation.type)
  const color = Number.parseInt(operation.color.slice(1), 16)
  bytes[2] = color >>> 16
  bytes[3] = color >>> 8
  bytes[4] = color
  view.setFloat64(5, operation.width, true)
  view.setUint16(13, points.length, true)
  let index = header
  let x = 0
  let y = 0
  for (const point of points) {
    const px = Math.round(point.x * 100)
    const py = Math.round(point.y * 100)
    if (px / 100 !== point.x || py / 100 !== point.y) return null
    for (const delta of [px - x, py - y]) {
      let value = delta < 0 ? -2 * delta - 1 : 2 * delta
      while (value >= 128) {
        bytes[index++] = (value & 127) | 128
        value >>>= 7
      }
      bytes[index++] = value
    }
    x = px
    y = py
  }
  return btoa(String.fromCharCode(...bytes.subarray(0, index)))
}

// Giải mã khung compact có giới hạn rồi đưa về kiểu hình học dùng chung của renderer.
export function decodeStroke(id: string, packed: string): Operation {
  if (packed.length > 16404) throw new Error('Invalid packed stroke')
  const bytes = Uint8Array.from(atob(packed), (char) => char.charCodeAt(0))
  const type = tools[bytes[1]!]
  if (bytes.length < header || bytes[0] !== 1 || !type) throw new Error('Invalid packed stroke')
  const view = new DataView(bytes.buffer)
  const count = view.getUint16(13, true)
  const width = view.getFloat64(5, true)
  const path = type === 'freehand' || type === 'eraser'
  if (!count || count > 2048 || (!path && count !== 2) || !(width >= 1 && width <= 50))
    throw new Error('Invalid packed stroke')
  let index = header
  // Delta nằm trong 3 byte do giới hạn khung logic.
  function delta() {
    let value = 0
    for (let shift = 0; shift <= 14 && index < bytes.length; shift += 7) {
      const byte = bytes[index++]!
      value |= (byte & 127) << shift
      if (byte < 128) return value & 1 ? -(value + 1) / 2 : value / 2
    }
    throw new Error('Invalid packed coordinate')
  }
  const points: Point[] = []
  let x = 0
  let y = 0
  for (let i = 0; i < count; i++) {
    x += delta()
    y += delta()
    if (x < 0 || x > WIDTH * 100 || y < 0 || y > HEIGHT * 100)
      throw new Error('Invalid packed coordinate')
    points.push({ x: x / 100, y: y / 100 })
  }
  if (index !== bytes.length) throw new Error('Invalid packed stroke')
  const color = '#' + (view.getUint32(1) & 0xffffff).toString(16).padStart(6, '0')
  const base = { id, width, color }
  return path ? { ...base, type, points } : { ...base, type, start: points[0]!, end: points[1]! }
}
