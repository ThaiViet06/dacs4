import { ref, computed } from 'vue'
import { defineStore } from 'pinia'

// Store mẫu của Vue lưu bộ đếm và giá trị gấp đôi.
export const useCounterStore = defineStore('counter', () => {
  const count = ref(0)
  // Tính giá trị gấp đôi mỗi khi bộ đếm thay đổi.
  const doubleCount = computed(() => count.value * 2)
  // Tăng bộ đếm thêm một đơn vị.
  function increment() {
    count.value++
  }

  return { count, doubleCount, increment }
})
