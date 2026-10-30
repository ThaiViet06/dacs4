// Dùng chung một khóa đã bỏ khoảng trắng để plugin và giao diện nhận cùng trạng thái cấu hình.
export const clerkPublishableKey =
  (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined)?.trim() ?? ''
