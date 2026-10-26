export const WIDTH = 1600
export const HEIGHT = 900
export type Tool = 'freehand' | 'line' | 'rectangle' | 'circle' | 'eraser'
export interface Point { x: number; y: number }
interface Base { id: string; width: number; color: string }
export type Operation = (Base & { type: 'freehand' | 'eraser'; points: Point[] }) |
  (Base & { type: 'line' | 'rectangle' | 'circle'; start: Point; end: Point })
export interface DrawingDocument { version: 1; width: number; height: number; operations: Operation[] }
export interface Room { id: string; title: string; ownerId: string; sequence: number; hasCheckpoint: boolean; updatedAt: string }
export interface SavedDrawing { id: string; title: string; createdAt: string; document: DrawingDocument }
// Tạo tài liệu vẽ trống với kích thước và phiên bản chuẩn của ứng dụng.
export const emptyDocument = (): DrawingDocument => ({ version: 1, width: WIDTH, height: HEIGHT, operations: [] })
// Đổi tọa độ màn hình thành tọa độ bản vẽ, giới hạn trong khung và làm tròn hai chữ số.
export function coordinates(x: number, y: number, rect: { left: number; top: number; width: number; height: number }): Point {
  return {
    x: Math.round(Math.max(0, Math.min(WIDTH, (x - rect.left) * WIDTH / rect.width)) * 100) / 100,
    y: Math.round(Math.max(0, Math.min(HEIGHT, (y - rect.top) * HEIGHT / rect.height)) * 100) / 100,
  }
}
// Thêm điểm cho bút/tẩy, giảm mẫu khi đường quá dài; với hình thì đổi điểm cuối.
export function appendPoint(operation: Operation, point: Point): Operation {
  if ('points' in operation) {
    const points = operation.points.length >= 2048 ? operation.points.filter((_, i) => i % 2 === 0) : operation.points
    return { ...operation, points: [...points, point] }
  }
  return { ...operation, end: point }
}
