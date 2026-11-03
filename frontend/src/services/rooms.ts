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

// Backend chỉ trả các phòng tài khoản hiện tại là thành viên; frontend không tự lọc theo chủ phòng.
export function listRooms(): Promise<{ rooms: Room[] }> {
  return api<{ rooms: Room[] }>('/rooms')
}

// Lấy thông tin theo ID; backend chỉ trả phòng nếu token hiện tại thuộc một thành viên của phòng.
export function getRoom(roomId: string): Promise<{ room: Room }> {
  return api<{ room: Room }>(`/rooms/${encodeURIComponent(roomId)}`)
}

// Chỉ chủ phòng được phát link mời mới; backend thay hash của link trước sau khi kiểm tra quyền.
export function createInvitation(roomId: string): Promise<{ inviteToken: string }> {
  return api<{ inviteToken: string }>(`/rooms/${encodeURIComponent(roomId)}/invitation`, 'POST')
}

// Gửi token lời mời; backend lấy người tham gia từ phiên Clerk và thêm thành viên không trùng lặp.
export function joinRoom(token: string): Promise<{ room: Room }> {
  return api<{ room: Room }>('/rooms/join', 'POST', { token })
}
