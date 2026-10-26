import test from 'node:test'
import assert from 'node:assert/strict'
import { appendPoint, coordinates, emptyDocument, HEIGHT, WIDTH } from '../src/drawing/model.ts'
import { drawOperation, render } from '../src/drawing/renderer.ts'

test('pointer coordinates use the logical canvas and clamp outside movement', () => {
  const rect = { left: 40, top: 20, width: 800, height: 450 }
  assert.deepEqual(coordinates(440, 245, rect), { x: WIDTH / 2, y: HEIGHT / 2 })
  assert.deepEqual(coordinates(10, 1000, rect), { x: 0, y: HEIGHT })
  assert.deepEqual(coordinates(840, 470, rect), { x: WIDTH, y: HEIGHT })
})

test('long freehand gestures retain endpoints within the point limit', () => {
  let operation = { id: crypto.randomUUID(), type: 'freehand', color: '#263b53', width: 8, points: [{ x: 0, y: 0 }] }
  for (let x = 1; x <= 3000; x++) operation = appendPoint(operation, { x: x / 2, y: 2 })
  assert.ok(operation.points.length <= 2048)
  assert.deepEqual(operation.points[0], { x: 0, y: 0 })
  assert.deepEqual(operation.points.at(-1), { x: 1500, y: 2 })
})

test('document replay uses the same ordered vector operations', () => {
  const calls = []
  const context = new Proxy({}, {
    get(_, key) {
      if (['save', 'restore', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill'].includes(key)) {
        return (...args) => calls.push([key, ...args])
      }
    },
    set(_, key, value) { calls.push([key, value]); return true },
  })
  const operation = { id: crypto.randomUUID(), type: 'freehand', color: '#263b53', width: 8, points: [{ x: 15, y: 25 }, { x: 65, y: 75 }] }
  const document = emptyDocument()
  document.operations.push(operation)
  drawOperation(context, operation)
  const once = [...calls]
  calls.length = 0
  render(context, document.operations)
  assert.deepEqual(calls, once)
  assert.ok(calls.some(([name, x, y]) => name === 'lineTo' && x === 65 && y === 75))
})

test('circles keep the same center and radius when dragged in four directions', () => {
  const calls = []
  const context = new Proxy({}, {
    get(_, key) {
      if (['save', 'restore', 'beginPath', 'arc', 'stroke'].includes(key)) {
        return (...args) => calls.push([key, ...args])
      }
    },
    set() { return true },
  })
  const center = { x: 800, y: 450 }
  for (const [dx, dy] of [[60, 80], [-60, 80], [-60, -80], [60, -80]]) {
    calls.length = 0
    drawOperation(context, {
      id: crypto.randomUUID(), type: 'circle', color: '#263b53', width: 4,
      start: center, end: { x: center.x + dx, y: center.y + dy },
    })
    assert.deepEqual(calls.find(([name]) => name === 'arc'), ['arc', 800, 450, 100, 0, Math.PI * 2])
    assert.ok(calls.some(([name]) => name === 'stroke'))
  }
})
