import { getToken as getClerkToken } from '@clerk/vue'
import { clerkPublishableKey } from './clerk'

// Phân biệt phiên đã kết thúc với lỗi mạng khi SDK tải token để không tự thử lại đăng nhập vô hạn.
export class SignInRequiredError extends Error {
  name = 'SignInRequiredError'
}

// Lấy token từ cùng phiên SDK mà giao diện sử dụng; fresh=true yêu cầu bỏ qua cache khi nối lại WebSocket.
export async function getToken(fresh = false) {
  if (!clerkPublishableKey) {
    throw new SignInRequiredError(
      'Sign-in is not configured. You can still use the personal Studio.',
    )
  }

  // SDK chờ Clerk sẵn sàng và quản lý token của phiên hiện tại; lỗi tải hoặc mất mạng được truyền cho nơi gọi.
  const token = await getClerkToken({ skipCache: fresh })

  // Không cho API/WebSocket gửi yêu cầu thiếu token khi chưa đăng nhập hoặc phiên đã kết thúc.
  if (!token) throw new SignInRequiredError('Sign in to access shared rooms and saved drawings.')
  return token
}
