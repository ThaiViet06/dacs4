import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { decodeStroke, encodeStroke } from '../src/drawing/codec.ts'
import { simplifyStroke } from '../src/drawing/simplify.ts'

const require = createRequire(import.meta.url)
const { packStroke, unpackWire } = require('../../backend/src/stroke-codec.js')

test('browser and server agree on compact strokes for all tools and signed coordinate deltas', () => {
  const start = { x: 1599.04, y: 840.12 }
  const end = { x: 20.55, y: 3.21 }
  for (const type of ['freehand', 'eraser', 'line', 'rectangle', 'circle']) {
    const operation = {
      id: crypto.randomUUID(),
      color: '#f73508',
      width: 3.5,
      type,
      ...(type === 'freehand' || type === 'eraser'
        ? { points: [start, end, start] }
        : { start, end }),
    }
    const packed = encodeStroke(operation)
    assert.equal(packed, packStroke(operation).toString('base64'))
    assert.deepEqual(decodeStroke(operation.id, packed), operation)
    assert.deepEqual(unpackWire(operation.id, packed), operation)
  }
})

test('stroke simplification keeps endpoints and a corner while removing collinear points', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 6 },
    { x: 10, y: 10 },
  ]
  const stroke = { id: crypto.randomUUID(), type: 'freehand', color: '#123456', width: 5, points }
  assert.deepEqual(simplifyStroke(stroke).points, [points[0], points[2], points[4]])
  assert.equal(stroke.points.length, 5)
})
