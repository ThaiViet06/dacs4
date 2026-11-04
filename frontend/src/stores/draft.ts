import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { emptyDocument, type Operation } from '../drawing/model'

// Bản nháp có dữ liệu/lịch sử riêng, không bị editor dự án hoặc WebSocket ghi đè.
export const useDraftStore = defineStore('draft', () => {
  const document = ref(emptyDocument())
  const redoStack = ref<Operation[]>([])
  const canUndo = computed(() => document.value.operations.length > 0)
  const canRedo = computed(() => redoStack.value.length > 0)

  // Thêm nét mới và bỏ nhánh làm lại của bản nháp trước đó.
  function commit(operation: Operation) {
    document.value.operations.push(operation)
    redoStack.value = []
  }

  // Chuyển nét cuối sang lịch sử làm lại, giữ nguyên UUID và thứ tự nét/tẩy.
  function undo() {
    const operation = document.value.operations.pop()
    if (operation) redoStack.value.push(operation)
  }

  // Khôi phục nét vừa hoàn tác vào cuối bản nháp.
  function redo() {
    const operation = redoStack.value.pop()
    if (operation) document.value.operations.push(operation)
  }

  // Chỉ thao tác Tạo trang mới mới xóa bản nháp và lịch sử của nó.
  function reset() {
    document.value = emptyDocument()
    redoStack.value = []
  }

  return { document, canUndo, canRedo, commit, undo, redo, reset }
})
