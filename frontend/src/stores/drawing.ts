import { ref } from 'vue'
import { defineStore } from 'pinia'

// Phase 2 uses a single freehand brush. Further tools are introduced in Phase 3.
export const useDrawingStore = defineStore('drawing', () => {
  const color = ref('#263b53')
  const brushSize = ref(8)

  return { color, brushSize }
})
