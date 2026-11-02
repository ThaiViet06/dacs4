import type { Room } from '../drawing/model'
import { api } from './api'

interface CreateRoomResponse {
  room: Room
  inviteToken: string
}

// Chỉ gửi tên phòng; backend lấy chủ phòng từ token Clerk và lưu phòng/thành viên trong cùng giao dịch.
export function createRoom(title: string): Promise<CreateRoomResponse> {
  return api<CreateRoomResponse>('/rooms', 'POST', { title: title.trim() })
}
