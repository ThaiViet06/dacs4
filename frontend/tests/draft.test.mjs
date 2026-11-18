import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'
import * as model from '../src/drawing/model.ts'
import * as codec from '../src/drawing/codec.ts'
import * as chatModel from '../src/chat/model.ts'

const require = createRequire(import.meta.url)

// Dùng store thật, chỉ thay API dự án để bản nháp không phụ thuộc Clerk hoặc mạng.
function setup(context) {
  setActivePinia(createPinia())
  const dependencies = {
    '../drawing/model': model,
    '../drawing/codec': codec,
    '../chat/model': chatModel,
    '../services/auth': { getToken: async () => 'unused' },
    '../services/api': { WS_URL: 'ws://test.invalid' },
  }
  // Biên dịch các store TypeScript bằng compiler đã có trong frontend.
  function loadStore(filename) {
    const source = readFileSync(new URL('../src/stores/' + filename, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', code)(
      (name) => dependencies[name] ?? require(name),
      module,
      module.exports,
    )
    return module.exports
  }
  const draft = loadStore('draft.ts').useDraftStore()
  const board = loadStore('board.ts').useBoardStore()
  context.after(() => {
    board.reset()
    draft.reset()
  })
  return { draft, board }
}

// Dữ liệu nhỏ dùng để kiểm tra thứ tự và UUID khi hoàn tác/làm lại.
const operation = (id, type = 'freehand') => ({
  id,
  type,
  color: '#123456',
  width: 4,
  points: [{ x: 10, y: 20 }],
})

test('draft strokes and redo survive switching through project sessions and sign out', (context) => {
  const { draft, board } = setup(context)
  const first = operation('draft-first')
  const erased = operation('draft-eraser', 'eraser')
  draft.commit(first)
  draft.commit(erased)
  draft.undo()
  board.setAccount('owner-a')
  board.prepareRoom('project-a')
  board.document.operations.push(operation('project-stroke'))
  board.leaveRoom()
  board.prepareRoom('project-b')
  board.leaveRoom()
  board.setAccount('')
  assert.deepEqual(draft.document.operations, [first])
  assert.equal(draft.canRedo, true)
  draft.redo()
  assert.deepEqual(draft.document.operations, [first, erased])
})

test('new draft strokes clear redo while resetting draft leaves project cache intact', (context) => {
  const { draft, board } = setup(context)
  draft.commit(operation('one'))
  draft.undo()
  draft.commit(operation('two'))
  assert.equal(draft.canRedo, false)
  board.prepareRoom('project-a')
  const saved = operation('saved-project-stroke')
  board.document.operations.push(saved)
  board.leaveRoom()
  draft.reset()
  assert.equal(draft.canUndo, false)
  assert.equal(draft.canRedo, false)
  board.prepareRoom('project-a')
  assert.deepEqual(board.document.operations, [saved])
})
