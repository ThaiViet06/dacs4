import { ref } from 'vue'
import { defineStore } from 'pinia'

// Store giữ công cụ, màu và kích thước để thanh công cụ và canvas dùng chung.
export const useDrawingStore = defineStore('drawing', () => {
  // Công cụ đang chọn được giữ trong Pinia để giao diện và canvas cùng dùng một trạng thái.
  const tool = ref<'freehand' | 'line' | 'rectangle' | 'circle' | 'eraser'>('freehand')
  const color = ref('#263b53')
  const brushSize = ref(4)
  // Tẩy có độ rộng riêng để xóa trọn nét bút mảnh ngay cả khi canvas được vẽ lại.
  const eraserSize = ref(24)

  return { tool, color, brushSize, eraserSize }
})
