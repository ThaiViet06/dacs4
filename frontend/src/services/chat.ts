import { api } from './api'
import type { ChatMessage, ChatProfile } from '../chat/model'

// Mỗi lần mở/nối lại đều lấy lịch sử có kiểm tra quyền từ backend.
export function getChatMessages(roomId: string) {
  return api<{ messages: ChatMessage[] }>(`/rooms/${encodeURIComponent(roomId)}/messages`)
}

// Nạp tên và ảnh đại diện sau khi có lịch sử, tách nhịp tải hồ sơ khỏi việc gửi tin.
export function getChatProfiles(roomId: string) {
  return api<{ profiles: ChatProfile[] }>(`/rooms/${encodeURIComponent(roomId)}/messages/profiles`)
}

// Giữ UUID khi thử lại để trường hợp mất phản hồi không tạo hai tin giống nhau.
export function postChatMessage(roomId: string, message: { id: string; text: string }) {
  return api<{ message: ChatMessage }>(
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    'POST',
    message,
  )
}
