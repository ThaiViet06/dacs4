export const WIDTH = 1600
export const HEIGHT = 900
export type Tool = 'freehand' | 'line' | 'rectangle' | 'circle' | 'eraser'
export interface Point {
  x: number
  y: number
}
interface Base {
  id: string
  width: number
  color: string
}
export type Operation =
  | (Base & { type: 'freehand' | 'eraser'; points: Point[] })
  | (Base & { type: 'line' | 'rectangle' | 'circle'; start: Point; end: Point })
export interface DrawingDocument {
  version: 1
  width: number
  height: number
  operations: Operation[]
}
export interface VisibilityEvent {
  id: string
  type: 'visibility'
  targetId: string
  visible: boolean
}
export type DrawingEvent = Operation | VisibilityEvent
export interface DrawingDocumentV2 {
  version: 2
  width: number
  height: number
  operations: DrawingEvent[]
}
export interface Room {
  id: string
  title: string
  ownerId: string
  sequence: number
  sharingEnabled: boolean
  hasCheckpoint: boolean
  updatedAt: string
}
export interface SavedDrawing {
  id: string
  title: string
  createdAt: string
  document: DrawingDocument
}
// Tạo tài liệu vẽ trống với kích thước và phiên bản chuẩn của ứng dụng.
export const emptyDocument = (): DrawingDocument => ({
  version: 1,
  width: WIDTH,
  height: HEIGHT,
  operations: [],
})

// Sao chép tài liệu đã được backend kiểm tra sang v2, giữ UUID/hình học/lịch sử và không sửa dữ liệu gốc.
export function normalizeDocument(
  document: DrawingDocument | DrawingDocumentV2,
): DrawingDocumentV2 {
  if (
    (document.version !== 1 && document.version !== 2) ||
    document.width !== WIDTH ||
    document.height !== HEIGHT ||
    !Array.isArray(document.operations)
  ) {
    throw new Error('Unsupported drawing document.')
  }
  return {
    version: 2,
    width: document.width,
    height: document.height,
    operations: document.operations.map((operation) => {
      if (operation.type === 'visibility') return { ...operation }
      if ('points' in operation) {
        return { ...operation, points: operation.points.map((point) => ({ ...point })) }
      }
      return { ...operation, start: { ...operation.start }, end: { ...operation.end } }
    }),
  }
}

// Lấy các nét có trạng thái cuối là hiện; nét được làm lại vẫn nằm ở thứ tự vẽ ban đầu, kể cả nét tẩy.
export function getVisibleOperations(document: DrawingDocument | DrawingDocumentV2): Operation[] {
  const events: DrawingEvent[] = document.operations
  const visibility = new Map<string, boolean>()
  for (const event of events) {
    if (event.type === 'visibility') visibility.set(event.targetId.toLowerCase(), event.visible)
  }
  return events.filter(
    (event): event is Operation =>
      event.type !== 'visibility' && visibility.get(event.id.toLowerCase()) !== false,
  )
}

// Đổi tọa độ màn hình thành tọa độ bản vẽ, giới hạn trong khung và làm tròn hai chữ số.
export function coordinates(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
): Point {
  return {
    x: Math.round(Math.max(0, Math.min(WIDTH, ((x - rect.left) * WIDTH) / rect.width)) * 100) / 100,
    y:
      Math.round(Math.max(0, Math.min(HEIGHT, ((y - rect.top) * HEIGHT) / rect.height)) * 100) /
      100,
  }
}
// Thêm điểm cho bút/tẩy, giảm mẫu khi đường quá dài; với hình thì đổi điểm cuối.
export function appendPoint(operation: Operation, point: Point): Operation {
  if ('points' in operation) {
    const points =
      operation.points.length >= 2048
        ? operation.points.filter((_, i) => i % 2 === 0)
        : operation.points
    return { ...operation, points: [...points, point] }
  }
  return { ...operation, end: point }
}
