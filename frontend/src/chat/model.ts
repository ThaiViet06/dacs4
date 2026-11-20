export interface ChatMessage {
  id: string
  roomId: string
  authorId: string
  sequence: number
  text: string
  createdAt: string
}

export interface ChatProfile {
  userId: string
  name: string | null
  avatarUrl: string | null
}

// Chỉ nhận tin hợp lệ của đúng dự án; thông điệp chat hỏng không được ảnh hưởng Canvas.
export function isChatMessage(value: unknown, roomId: string): value is ChatMessage {
  if (!value || typeof value !== 'object') return false
  const message = value as ChatMessage
  return (
    typeof message.id === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(message.id) &&
    message.roomId === roomId &&
    typeof message.authorId === 'string' &&
    message.authorId.length > 0 &&
    message.authorId.length <= 256 &&
    Number.isSafeInteger(message.sequence) &&
    message.sequence > 0 &&
    typeof message.text === 'string' &&
    message.text.trim().length > 0 &&
    message.text.length <= 1000 &&
    typeof message.createdAt === 'string' &&
    Number.isFinite(Date.parse(message.createdAt))
  )
}

// Ghép lịch sử HTTP và tin WebSocket theo UUID/thứ tự chat, chỉ giữ 50 tin gần nhất trên giao diện.
export function mergeChatMessages(current: ChatMessage[], incoming: unknown, roomId: string) {
  if (!Array.isArray(incoming) || !incoming.every((message) => isChatMessage(message, roomId)))
    throw new Error('Invalid chat history.')
  return [...new Map([...current, ...incoming].map((message) => [message.id, message])).values()]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-50)
}
