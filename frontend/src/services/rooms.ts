import type { Room } from '../drawing/model'
import { api } from './api'

interface CreateRoomResponse {
  room: Room
}

export interface SharingState {
  enabled: boolean
  inviteToken?: string
}

export interface SharingResult extends SharingState {
  room: Room
}

// Đọc chế độ và token HMAC hiện có cho chủ; GET không tạo hoặc thay link mời cũ.
export function getRoomSharing(roomId: string): Promise<SharingState> {
  return api<SharingState>(`/rooms/${encodeURIComponent(roomId)}/sharing`)
}

// Server xác nhận đổi chế độ/thu quyền trước khi frontend cập nhật nhãn và link.
export function setRoomSharing(roomId: string, enabled: boolean): Promise<SharingResult> {
  return api<SharingResult>(`/rooms/${encodeURIComponent(roomId)}/sharing`, 'PATCH', { enabled })
}

// Tạo dự án Cá nhân; backend lấy chủ từ token Clerk và chỉ trả metadata, chưa có link chia sẻ.
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

// Đổi tên qua API đã xác thực; backend kiểm tra quyền chủ và chỉ trả kết quả sau khi lưu thành công.
export function renameRoom(roomId: string, title: string): Promise<{ room: Room }> {
  return api<{ room: Room }>(`/rooms/${encodeURIComponent(roomId)}`, 'PATCH', {
    title: title.trim(),
  })
}

// Chỉ gọi sau xác nhận đổi link cũ; server giữ nét/thành viên và trả cùng token nếu gửi lại.
export function upgradeRoomInvitation(roomId: string): Promise<SharingResult> {
  return api<SharingResult>(`/rooms/${encodeURIComponent(roomId)}/sharing/upgrade`, 'POST', {
    confirmed: true,
  })
}

// Gửi token lời mời; backend lấy người tham gia từ phiên Clerk và thêm thành viên không trùng lặp.
export function joinRoom(token: string): Promise<{ room: Room }> {
  return api<{ room: Room }>('/rooms/join', 'POST', { token })
}
