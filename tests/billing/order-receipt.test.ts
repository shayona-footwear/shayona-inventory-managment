import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { matchBoxesToOrder } from '../../lib/billing/order-receipt'

// ⚡ Direct bill of an order (owner, 27 Nov 2026): scanned boxes against the ordered lines.
describe('order receipt: boxes against the order', () => {
  const items = [
    { id: 1, artNumber: 'PUG-N42', artCode: 'PUGN42G', sizeNumber: '6', quantityOrdered: 2 },
    { id: 2, artNumber: 'PUG-N42', artCode: 'PUGN42G', sizeNumber: '7', quantityOrdered: 1 },
    { id: 3, artNumber: 'SS-101', artCode: 'SS0101C', sizeNumber: '11', quantityOrdered: 1 },
  ]
  test('boxes fill their lines; short lines and extras are reported', () => {
    const r = matchBoxesToOrder(items, [
      { articleCode: 'PUGN42G', sizeLabel: '6' }, { articleCode: 'PUGN42G', sizeLabel: '6' },
      { articleCode: 'PUGN42G', sizeLabel: '6' }, // a third size 6: more than ordered
      { articleCode: 'PUGN42G', sizeLabel: '8' }, // not on the order
    ])
    assert.deepEqual([...r.received], [[1, 2], [2, 0], [3, 0]])
    assert.deepEqual(r.short.map(s => [s.itemId, s.ordered, s.got]), [[2, 1, 0], [3, 1, 0]])
    assert.deepEqual(r.extra, [{ label: 'PUGN42G size 6', qty: 1 }, { label: 'PUGN42G size 8', qty: 1 }])
  })
  test('a line with an article code needs that exact code (SS0101S 11 is not SS0101C 11)', () => {
    const r = matchBoxesToOrder(items, [{ articleCode: 'SS0101S', sizeLabel: '11' }, { articleCode: 'SS0101C', sizeLabel: '11' }])
    assert.equal(r.received.get(3), 1)
    assert.deepEqual(r.extra, [{ label: 'SS0101S size 11', qty: 1 }])
  })
  test('lines that share article and size fill in order', () => {
    const two = [
      { id: 1, artNumber: 'FL-02', artCode: null, sizeNumber: '7', quantityOrdered: 1 },
      { id: 2, artNumber: 'FL-02', artCode: null, sizeNumber: '7', quantityOrdered: 2 },
    ]
    const r = matchBoxesToOrder(two, [{ articleCode: 'FL0002G', sizeLabel: '7' }, { articleCode: 'FL0002G', sizeLabel: '7' }])
    assert.deepEqual([...r.received], [[1, 1], [2, 1]])
  })
})
