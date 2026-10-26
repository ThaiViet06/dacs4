import { ref } from 'vue'
import { defineStore } from 'pinia'

export const useDrawingStore = defineStore('drawing', () => {
  // Công cụ đang chọn được giữ trong Pinia để giao diện và canvas cùng dùng một trạng thái.
  const tool = ref<'freehand' | 'line' | 'rectangle'>('freehand')
  const color = ref('#263b53')
  const brushSize = ref(4)

  return { tool, color, brushSize }
})
