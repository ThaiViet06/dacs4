import test from 'node:test'
import assert from 'node:assert/strict'
import { reactive } from 'vue'
import { emptyDocument, getVisibleOperations, normalizeDocument } from '../src/drawing/model.ts'
import { render } from '../src/drawing/renderer.ts'

// Tạo đủ năm công cụ, gồm hình kéo ngược và nét tẩy, để kiểm tra chuyển phiên bản không đổi hình học.
function legacyDocument() {
  const base = { width: 8, color: '#263b53' }
  return {
    ...emptyDocument(),
    operations: ['freehand', 'line', 'rectangle', 'circle', 'eraser'].map((type) => ({
      ...base,
      id: crypto.randomUUID(),
      type,
      ...(['freehand', 'eraser'].includes(type)
        ? {
            points: [
              { x: 10.25, y: 20.5 },
              { x: 30, y: 40 },
            ],
          }
        : { start: { x: 100, y: 150 }, end: { x: 50, y: 75 } }),
    })),
  }
}

// Tạo sự kiện ẩn/hiện tham chiếu UUID của nét, không sửa nội dung nét gốc.
function visibility(targetId, visible) {
  return { id: crypto.randomUUID(), type: 'visibility', targetId, visible }
}

test('v1 normalization preserves every tool, geometry, UUID and order without aliasing the source', () => {
  const original = legacyDocument()
  const before = structuredClone(original)
  const normalized = normalizeDocument(original)
  assert.deepEqual(normalized, { ...before, version: 2 })
  normalized.operations[0].points[0].x = 700
  normalized.operations[1].start.x = 800
  normalized.operations[2].end.y = 600
  assert.deepEqual(original, before)
})

test('v2 normalization keeps the complete event history and also accepts Vue reactive documents', () => {
  const source = normalizeDocument(legacyDocument())
  source.operations.push(visibility(source.operations[0].id, false))
  const before = structuredClone(source)
  const normalized = normalizeDocument(reactive(source))
  assert.deepEqual(normalized, before)
  assert.deepEqual(normalizeDocument(normalized), before)
  assert.notEqual(normalized.operations, source.operations)
  normalized.operations.at(-1).visible = true
  assert.deepEqual(source, before)
})

test('the latest visibility wins and redo retains the original drawing order', () => {
  const document = normalizeDocument(legacyDocument())
  const strokes = [...document.operations]
  document.operations.push(
    visibility(strokes[0].id, false),
    visibility(strokes[2].id.toUpperCase(), false),
    visibility(strokes[0].id, true),
    visibility(strokes[0].id, false),
    visibility(strokes[0].id, true),
  )
  const before = structuredClone(document)
  assert.deepEqual(
    getVisibleOperations(document),
    strokes.filter((_, index) => index !== 2),
  )
  assert.deepEqual(document, before)
})

test('hiding and restoring an eraser replays it at its original position', () => {
  const source = legacyDocument()
  const [stroke, line, , , eraser] = source.operations
  const document = normalizeDocument({ ...source, operations: [stroke, eraser, line] })
  document.operations.push(visibility(eraser.id, false))
  const calls = []
  const context = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) =>
          calls.push([name, ...args]),
      set: (_, name, value) => {
        calls.push([name, value])
        return true
      },
    },
  )
  render(context, getVisibleOperations(document))
  const hidden = [...calls]
  calls.length = 0
  render(context, [stroke, line])
  assert.deepEqual(hidden, calls)
  assert.ok(
    !calls.some(
      ([name, value]) => name === 'globalCompositeOperation' && value === 'destination-out',
    ),
  )

  document.operations.push(visibility(eraser.id, true))
  assert.deepEqual(getVisibleOperations(document), [stroke, eraser, line])
  calls.length = 0
  render(context, getVisibleOperations(document))
  assert.ok(
    calls.some(
      ([name, value]) => name === 'globalCompositeOperation' && value === 'destination-out',
    ),
  )
})

test('empty v1 and v2 documents normalize consistently and have no visible strokes', () => {
  const legacy = emptyDocument()
  const normalized = normalizeDocument(legacy)
  assert.deepEqual(normalized, { ...legacy, version: 2 })
  assert.deepEqual(normalizeDocument(normalized), normalized)
  assert.deepEqual(getVisibleOperations(legacy), [])
  assert.deepEqual(getVisibleOperations(normalized), [])
})

test('normalization refuses unsupported versions, dimensions and a missing operation list', () => {
  for (const values of [
    { version: 0 },
    { version: 3 },
    { width: 800 },
    { height: 450 },
    { operations: null },
  ]) {
    assert.throws(
      () => normalizeDocument({ ...emptyDocument(), ...values }),
      /Unsupported drawing document/,
    )
  }
})
