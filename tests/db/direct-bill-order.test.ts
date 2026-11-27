// ⚡ Direct bill of an order on the Direct Billing screen (owner, 27 Nov 2026): the order itself is
// billed from its draft; what did not come stays marked on the order; no new order is made.

import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { createHarness, harnessEnabled, type Harness } from './_harness'
import { addDraftScan, generateDirectBill, listOpenDrafts, openOrderDraft } from '../../lib/billing/bill-stock'
import type { Actor } from '../../lib/db/types'

// Real labels: PUG-N42 White, MRP 339.50 — two boxes of size 6 and one of size 8.
const BOX = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-Z76BA-1006101722'
const BOX_2 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-LE69Q-1006101721'
const BOX_SIZE_8 = 'A1PUGN42G-WHWH0008-0726R10MA0-339.50-1010-CJASC-1006106444'

describe('direct bill of an order from its draft (integration)', { skip: !harnessEnabled() && 'set TEST_DB_ENV_FILE=.env.local to run' }, () => {
  let h: Harness
  const admin: Actor = { id: 'u-admin', name: 'Admin' }
  let orderId = 0
  const items: number[] = []
  const q = async <T extends Record<string, unknown>>(s: ReturnType<typeof sql>) => (await h.db.execute<T>(s)).rows

  before(async () => {
    h = await createHarness()
    await h.db.execute(sql`INSERT INTO retailers (id, "partyName") VALUES ('V901', 'Test Shop')`)
    await h.db.execute(sql`INSERT INTO "user" (id, name, email, role) VALUES ('u-admin','Admin','a@test.local','admin')`)
    const art = await q<{ id: number }>(sql`INSERT INTO articles ("artName","artCode",color,"colorCode") VALUES ('PUG-N42','PUGN42G','White','WHWH') RETURNING id`)
    await h.db.execute(sql`INSERT INTO article_sizes ("articleId","sizeLabel","sortOrder") VALUES (${art[0].id},'6',1),(${art[0].id},'7',2)`)
    orderId = Number((await q<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", status) VALUES ('ORD-T1', 'Test Shop', 'pending') RETURNING id`))[0].id)
    for (const r of await q<{ id: number }>(sql`
      INSERT INTO order_items ("orderId", "artNumber", "artCode", "colorNumber", "sizeNumber", "quantityOrdered") VALUES
        (${orderId}, 'PUG-N42', 'PUGN42G', 'White', '6', 2), (${orderId}, 'PUG-N42', 'PUGN42G', 'White', '7', 1) RETURNING id`)) items.push(Number(r.id))
  })
  after(async () => { await h?.close() })

  test('the order\'s draft: one per order, carried on, kept out of the Direct Billing drafts list', async () => {
    const a = await openOrderDraft(h.db, admin, orderId)
    assert.equal(a.order.retailerId, 'V901')
    assert.deepEqual(a.items.map(i => [i.sizeNumber, i.quantityOrdered]), [['6', 2], ['7', 1]])
    const b = await openOrderDraft(h.db, admin, orderId)
    assert.equal(b.draftId, a.draftId)
    assert.equal((await listOpenDrafts(h.db)).some(d => d.id === a.draftId), false)
  })

  test('billing bills the order itself; received pairs per line; extras billed; no new order', async () => {
    const { draftId } = await openOrderDraft(h.db, admin, orderId)
    for (const raw of [BOX, BOX_2, BOX_SIZE_8]) assert.equal((await addDraftScan(h.db, admin, draftId, raw, randomUUID())).status, 'added')
    await assert.rejects(generateDirectBill(h.db, admin, draftId, { shopkeeperName: 'Test Shop' }), /picked/)
    await assert.rejects(generateDirectBill(h.db, admin, draftId, { shopkeeperName: 'Test Shop' }, { pickerId: 'u-admin', walkIn: { name: 'X', phone: '', paidMode: 'cash', discountPct: 0 } }), /walk-in/)
    const bill = await generateDirectBill(h.db, admin, draftId, { shopkeeperName: 'Anything typed', lineDiscPct: 30 }, { pickerId: 'u-admin' })
    assert.equal(bill.id, orderId)
    assert.equal(bill.orderNumber, 'ORD-T1')
    assert.equal(bill.lines.reduce((t, l) => t + l.qty, 0), 3) // the extra size 8 is billed too
    const [o] = await q<{ status: string; isEmergency: boolean; pickerId: string; retailerId: string; shopkeeperName: string }>(sql`
      SELECT status, "isEmergency", "pickerId", "retailerId", "shopkeeperName" FROM orders WHERE id = ${orderId}`)
    assert.deepEqual(o, { status: 'billed', isEmergency: true, pickerId: 'u-admin', retailerId: 'V901', shopkeeperName: 'Test Shop' })
    const lines = await q<{ quantityPacked: number; status: string }>(sql`SELECT "quantityPacked", status FROM order_items WHERE "orderId" = ${orderId} ORDER BY id`)
    assert.deepEqual(lines.map(l => [Number(l.quantityPacked), l.status]), [[2, 'packed'], [0, 'out_of_stock']])
    assert.equal(Number((await q<{ n: number }>(sql`SELECT count(*)::int n FROM orders`))[0].n), 1)
    assert.equal(Number((await q<{ n: number }>(sql`SELECT count(*)::int n FROM sale_bills WHERE "orderId" = ${orderId} AND status = 'active'`))[0].n), 1)
    assert.equal(Number((await q<{ n: number }>(sql`SELECT count(*)::int n FROM bill_scans WHERE "orderId" = ${orderId} AND status = 'active'`))[0].n), 3)
    const [d] = await q<{ status: string; orderId: number }>(sql`SELECT status, "orderId" FROM direct_bill_drafts WHERE id = ${draftId}`)
    assert.deepEqual([d.status, Number(d.orderId)], ['billed', orderId])
  })

  test('a billed order cannot be Direct billed again', async () => {
    await assert.rejects(openOrderDraft(h.db, admin, orderId), /billed/)
  })

  test('an order already sent to the biller (old ⚡) is billed on the same screen; billers cannot open pending ones', async () => {
    const biller: Actor = { id: 'u-admin', name: 'Biller' }
    const sent = Number((await q<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", status, "isEmergency", "pickerId", "packedAt") VALUES ('ORD-T2', 'Test Shop', 'packed', true, 'u-admin', now()) RETURNING id`))[0].id)
    const pending = Number((await q<{ id: number }>(sql`
      INSERT INTO orders ("orderNumber", "shopkeeperName", status) VALUES ('ORD-T3', 'Test Shop', 'pending') RETURNING id`))[0].id)
    await h.db.execute(sql`INSERT INTO order_items ("orderId", "artNumber", "artCode", "sizeNumber", "quantityOrdered") VALUES (${sent}, 'PUG-N42', 'PUGN42G', '6', 1)`)
    await assert.rejects(openOrderDraft(h.db, biller, pending, { allowOpen: false }), /admin/)
    const s = await openOrderDraft(h.db, biller, sent, { allowOpen: false })
    assert.equal(s.order.pickerId, 'u-admin')
    // The boxes of the first test are on its bill now; a size-6 box from a fresh label is needed.
    const BOX_3 = 'A1PUGN42G-WHWH0006-0726R10MA0-339.50-1010-QX12P-1006101799'
    assert.equal((await addDraftScan(h.db, biller, s.draftId, BOX_3, randomUUID())).status, 'added')
    const bill = await generateDirectBill(h.db, biller, s.draftId, { shopkeeperName: 'Test Shop' }, { pickerId: 'u-admin' })
    assert.equal(bill.id, sent)
    const [o] = await q<{ status: string }>(sql`SELECT status FROM orders WHERE id = ${sent}`)
    assert.equal(o.status, 'billed')
    const [line] = await q<{ quantityPacked: number }>(sql`SELECT "quantityPacked" FROM order_items WHERE "orderId" = ${sent}`)
    assert.equal(Number(line.quantityPacked), 1)
  })
})
