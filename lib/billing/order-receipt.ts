// Direct bill of an order: which scanned boxes fill which order lines (pure; screen and server).
//
// Same rule as the biller's scan window (owner, 23 Nov 2026): a box fills an order line with the
// same article and size; a line with a saved article code needs that exact code (SS0101C 11 is not
// SS0101S 11), otherwise the article name must match the box's code. Lines that share article and
// size are filled in order. A box that fits no line, or comes after its lines are full, is an
// extra: it is still billed.
// Colour (owner, 27 Nov 2026: a BLACK WHITE box was taken for a WHITE BLACK line): a line whose
// colour has a code in the article master needs a box of that colour code. A colour with no code
// yet falls back to article + size.

import { articlesMatch } from '../billing-verification'

export interface ReceiptItem { id: number; artNumber: string; artCode?: string | null; sizeNumber: string | null; quantityOrdered: number; colourCode?: string | null }
export interface ReceiptBox { articleCode: string; sizeLabel: string; colourCode?: string | null }

export interface OrderReceipt {
  /** Pairs received per order line (0 = none came). */
  received: Map<number, number>
  /** Lines with fewer pairs than ordered. */
  short: { itemId: number; artNumber: string; sizeNumber: string | null; ordered: number; got: number }[]
  /** Boxes not on the order (or more than ordered), per article + size. */
  extra: { label: string; qty: number }[]
}

const code = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

function fits(item: ReceiptItem, box: ReceiptBox): boolean {
  if (String(item.sizeNumber ?? '').trim().toUpperCase() !== box.sizeLabel.trim().toUpperCase()) return false
  if (item.colourCode && code(item.colourCode) !== code(box.colourCode ?? '')) return false
  return item.artCode ? code(item.artCode) === code(box.articleCode) : articlesMatch(item.artNumber.toUpperCase(), box.articleCode.toUpperCase())
}

export function matchBoxesToOrder(items: readonly ReceiptItem[], boxes: readonly ReceiptBox[]): OrderReceipt {
  const received = new Map<number, number>(items.map((i) => [i.id, 0]))
  const extras = new Map<string, number>()
  for (const box of boxes) {
    const line = items.find((i) => fits(i, box) && (received.get(i.id) ?? 0) < i.quantityOrdered)
    if (line) received.set(line.id, (received.get(line.id) ?? 0) + 1)
    else {
      const label = `${box.articleCode}${box.colourCode ? ` ${box.colourCode}` : ''} size ${box.sizeLabel}`
      extras.set(label, (extras.get(label) ?? 0) + 1)
    }
  }
  const short = items
    .filter((i) => (received.get(i.id) ?? 0) < i.quantityOrdered)
    .map((i) => ({ itemId: i.id, artNumber: i.artNumber, sizeNumber: i.sizeNumber, ordered: i.quantityOrdered, got: received.get(i.id) ?? 0 }))
  return { received, short, extra: [...extras].map(([label, qty]) => ({ label, qty })) }
}
