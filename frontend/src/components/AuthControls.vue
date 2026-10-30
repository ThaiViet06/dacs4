<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { SignInButton, UserButton, useUser } from '@clerk/vue'

// SDK tự cập nhật trạng thái khi tải phiên, đăng nhập hoặc đăng xuất từ menu tài khoản.
const { isLoaded, isSignedIn, user } = useUser()
const connectionDelayed = ref(false)

// Sau 15 giây chưa tải được phiên, báo kết nối chậm để người dùng có thể tiếp tục dùng Studio.
const loadingTimer = setTimeout(() => {
  if (!isLoaded.value) connectionDelayed.value = true
}, 15000)

// Hủy bộ hẹn giờ khi nhóm tài khoản bị tháo khỏi giao diện.
onBeforeUnmount(() => clearTimeout(loadingTimer))

// Ưu tiên tên hiển thị; tài khoản chưa đặt tên vẫn có nhãn dễ hiểu trên thanh điều hướng.
const displayName = computed(() => user.value?.fullName || user.value?.username || 'Tài khoản')
</script>

<template>
  <div class="auth-controls" :aria-busy="!isLoaded && !connectionDelayed">
    <span v-if="!isLoaded" class="auth-status" role="status">{{
      connectionDelayed ? 'Kết nối tài khoản đang chậm' : 'Đang kết nối tài khoản…'
    }}</span>
    <!-- Chỉ hiện menu sau khi SDK xác nhận có phiên; menu Clerk có quản lý tài khoản và đăng xuất. -->
    <div v-else-if="isSignedIn" class="auth-user-menu" role="group" aria-label="Tài khoản của bạn">
      <span class="auth-user-name" :title="displayName">{{ displayName }}</span>
      <UserButton :appearance="{ elements: { userButtonTrigger: 'auth-user-trigger' } }" />
    </div>
    <!-- Nút theo giao diện ứng dụng mở hộp đăng nhập do Clerk quản lý trên trang hiện tại. -->
    <SignInButton v-else mode="modal">
      <button class="auth-sign-in" type="button">Đăng nhập</button>
    </SignInButton>
  </div>
</template>
