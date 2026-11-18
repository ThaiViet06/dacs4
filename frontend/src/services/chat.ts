import { api } from './api'
import type { ChatMessage } from '../chat/model'

// Mỗi lần mở/nối lại đều lấy lịch sử có kiểm tra quyền từ backend.
export function getChatMessages(roomId: string) {
  return api<{ messages: ChatMessage[] }>(`/rooms/${encodeURIComponent(roomId)}/messages`)
}

// Giữ UUID khi thử lại để trường hợp mất phản hồi không tạo hai tin giống nhau.
export function postChatMessage(roomId: string, message: { id: string; text: string }) {
  return api<{ message: ChatMessage }>(
    `/rooms/${encodeURIComponent(roomId)}/messages`,
    'POST',
    message,
  )
}
