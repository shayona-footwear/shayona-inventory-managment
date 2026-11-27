'use server'

import { stampBillLineHsn } from '@/lib/billing/bill-number'
import { billingPartyFor, cancelSaleBill, freezeSaleBill, isTaxType, notInMasterMessage, type TaxType, type WalkIn } from '@/lib/billing/sale-bill'
import type { BillRates } from '@/lib/billing/bill-totals'
import { applyAdvance } from '@/lib/payments/payments'
import type { BillTotalsPaise } from '@/lib/billing/bill-totals'
import { audit } from '@/lib/audit'
import { recordReceivedPairs } from '@/lib/billing/received-pairs'
import { assertPickerChoice } from '@/lib/orders/pickers'
import { editBillByScan, loadBillForEdit, type BillForEdit, type EditedBill } from '@/lib/billing/edit-bill'
import { and, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { billLines, orders } from '@/lib/db/schema'
import { requireAnyRole } from '@/lib/authz'
import { hasPermission } from '@/lib/permissions'
import {
  addDraftScan, createDraft, discardDraft, generateDirectBill, listOpenDrafts, loadDraft, openOrderDraft, recordOrderScans, releaseOrderScans, removeDraftScans, saveDraftHeader,
  type AddScanOutcome, type DraftDetail, type DraftHeader, type DraftSummary, type GeneratedBill, type OrderForDirectBill, type StockOutCounts,
} from '@/lib/billing/bill-stock'

// Direct Billing (formerly "Emergency Bill") and order invoices. Every box a biller scans is
// saved at once; generating a bill takes its boxes out of stock (lib/billing/bill-stock.ts).

const biller = async () => {
  const u = await requireAnyRole('biller', 'admin')
  return { id: u.id, name: u.name, isAdmin: u.roles.includes('admin') }
}

export async function getOpenDirectBillDrafts(): Promise<DraftSummary[]> {
  await biller()
  return listOpenDrafts(db)
}

export async function startDirectBillDraft(header: Partial<DraftHeader> = {}): Promise<number> {
  return createDraft(db, await biller(), header)
}

/**
 * ⚡ Direct bill on an order (owner 27 Nov 2026: bill it right there on the Direct Billing screen).
 * Admins: any pending / assigned order (⚡ on the Orders list). Billers: orders already sent to them
 * as a Direct bill (Bills tab). The order's draft (new or the one left open), its lines and picker.
 */
export async function openDirectBillForOrder(orderId: number): Promise<OrderForDirectBill & { draft: DraftDetail }> {
  const u = await requireAnyRole('biller', 'admin')
  const out = await openOrderDraft(db, { id: u.id, name: u.name }, Math.floor(Number(orderId)), { allowOpen: u.roles.includes('admin') })
  return { ...out, draft: await loadDraft(db, out.draftId) }
}

export async function openDirectBillDraft(draftId: number): Promise<DraftDetail> {
  await biller()
  return loadDraft(db, draftId)
}

export async function saveDirectBillDraft(draftId: number, header: Partial<DraftHeader>): Promise<void> {
  await biller()
  await saveDraftHeader(db, draftId, header)
}

/**
 * Save one scanned box on the draft. Also says whether its article is in the master and whether
 * this user may add it there (admins get the New Article form; billers a warning).
 */
export async function scanIntoDirectBill(draftId: number, rawInput: string, clientEventId: string): Promise<AddScanOutcome & { canCreateArticle: boolean }> {
  const u = await requireAnyRole('biller', 'admin')
  const out = await addDraftScan(db, { id: u.id, name: u.name }, draftId, rawInput, clientEventId)
  return { ...out, canCreateArticle: hasPermission(u.roles, 'articles.create_from_scan') }
}

export async function removeFromDirectBill(draftId: number, rawInputs: string[]): Promise<number> {
  await biller()
  return removeDraftScans(db, draftId, rawInputs.slice(0, 2000), 'removed from bill')
}

export async function discardDirectBillDraft(draftId: number): Promise<void> {
  await discardDraft(db, await biller(), draftId)
}

/** Generate a Direct Bill: a master retailer (bill type from it unless chosen), or a walk-in customer. */
export async function generateDirectBillFromDraft(
  draftId: number, header: Partial<DraftHeader>, bill: { taxType?: TaxType; walkIn?: WalkIn; pickerId?: string; rates?: BillRates; overrideCredit?: boolean } = {},
): Promise<GeneratedBill> {
  const { isAdmin, ...actor } = await biller()
  if (bill.taxType !== undefined && !isTaxType(bill.taxType)) throw new Error('Unknown bill type.')
  const { overrideCredit, ...rest } = bill
  return generateDirectBill(db, actor, draftId, header, { ...rest, credit: { allowed: isAdmin, requested: overrideCredit === true } })
}

/**
 * Bill an order (Invoices tab): status → billed, bill lines replaced, amounts frozen (sale_bills +
 * the party ledger), scanned boxes recorded and taken out of stock. One transaction; refuses if a box
 * is already on another bill or the party is not in the retailer master. Billing an already billed
 * order cancels its earlier bill first (same number unless the series changes).
 *
 * Direct bill from an order (owner, 23 Nov 2026): an order the admin sent straight to billing
 * (isEmergency, no picker) is billed as scanned; `packed` gives the pairs received per order line,
 * saved on the order (0 = out of stock), so what was not received stays marked on the order.
 * Statements: ~12 whatever the number of lines or boxes.
 */
export async function billOrder(
  orderId: number,
  scannedQrs: string[],
  lines: { artNumber: string; mrp: number; qty: number }[],
  lineDiscPct: number,
  opts: { taxType?: TaxType; packed?: { itemId: number; qty: number }[]; rates?: BillRates; pickerId?: string } = {},
): Promise<StockOutCounts & { skipped: number; billNo: string; taxType: TaxType; totals: BillTotalsPaise }> {
  const actor = await biller()
  if (opts.taxType !== undefined && !isTaxType(opts.taxType)) throw new Error('Unknown bill type.')
  const pct = Number(lineDiscPct)
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('Line discount must be between 0 and 100 %.')
  return db.transaction(async (tx) => {
    const o = await billingPartyFor(tx, orderId)
    if (!o) throw new Error('Order not found.')
    if (['cancelled', 'dispatched', 'delivered'].includes(o.status)) throw new Error(`This order is ${o.status}.`)
    if (!o.retailerId || !o.taxType) throw new Error(notInMasterMessage(o.shopkeeperName))
    if (opts.packed && !o.isEmergency) throw new Error('Only orders sent straight to billing are billed as scanned.')
    // No picker on the order (nobody claimed it or was assigned): the biller names who picked it
    // (owner, 27 Nov 2026). An order that has a picker keeps it.
    const pickerId = o.pickerId ?? await assertPickerChoice(tx, opts.pickerId)
    if (o.status === 'billed') await cancelSaleBill(tx, actor, orderId, 'billed again')
    // isEmergency is kept: true = billed without the picker (Direct bill icon on Receipts).
    await tx.update(orders).set({ status: 'billed', billerId: actor.id, pickerId, billedAt: sql`now()`, retailerId: o.retailerId, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId)))
    // Pairs received per order line; what was not received stays marked on the order.
    if (opts.packed?.length) await recordReceivedPairs(tx, actor, orderId, opts.packed)
    await tx.delete(billLines).where(eq(billLines.orderId, orderId))
    const clean = lines
      .map((l) => ({ artNumber: String(l.artNumber ?? '').trim(), mrp: Math.max(0, Math.round(Number(l.mrp) * 100) / 100 || 0), qty: Math.floor(Number(l.qty)) }))
      .filter((l) => l.artNumber && l.qty > 0)
    if (!clean.length) throw new Error('No items on this bill.')
    await tx.insert(billLines).values(clean.map((l) => ({ orderId, artNumber: l.artNumber, mrp: String(l.mrp), qty: l.qty, lineDiscPct: String(pct) })))
    // Official bill number, frozen amounts and the ledger entry; HSN on each line — same transaction.
    const bill = await freezeSaleBill(tx, actor, { orderId, source: 'invoice', lines: clean, lineDiscPct: pct, party: { retailerId: o.retailerId, taxType: opts.taxType ?? o.taxType }, rates: opts.rates })
    await applyAdvance(tx, actor, o.retailerId, bill.saleBillId) // the party's advance goes to this bill (owner, 22 Nov 2026)
    await stampBillLineHsn(tx, orderId)
    const counts = await recordOrderScans(tx, actor, orderId, o.orderNumber, Array.isArray(scannedQrs) ? scannedQrs : [])
    return { ...counts, billNo: bill.billNo, taxType: bill.taxType, totals: bill.totals }
  })
}

/**
 * Cancel a bill (replaces deleting it, owner 23 Nov 2026): the order is kept as cancelled with its
 * bill number, its boxes go back into stock, the frozen bill is marked cancelled and its ledger
 * entry reversed (money already paid against it becomes advance). Billers cancel billed orders;
 * admins also dispatched / delivered ones. One transaction, ~8 statements.
 */
export async function cancelBill(orderId: number, reason: string): Promise<{ orderId: number; billNo: string | null }> {
  const u = await requireAnyRole('biller', 'admin')
  const actor = { id: u.id, name: u.name }
  const why = String(reason ?? '').trim()
  if (why.length < 3) throw new Error('Type why the bill is cancelled.')
  return db.transaction(async (tx) => {
    const [o] = await tx.select({ status: orders.status, billNo: orders.billNo }).from(orders).where(eq(orders.id, orderId)).for('update')
    if (!o) throw new Error('Order not found.')
    const allowed = u.roles.includes('admin') ? ['billed', 'dispatched', 'delivered'] : ['billed']
    if (!allowed.includes(o.status)) throw new Error(o.status === 'cancelled' ? 'This bill is already cancelled.' : `Only ${allowed.join(' / ')} bills can be cancelled here (this order is ${o.status}).`)
    await releaseOrderScans(tx, actor, orderId, `bill cancelled: ${why}`)
    const sb = await cancelSaleBill(tx, actor, orderId, why)
    await tx.update(orders).set({ status: 'cancelled', updatedAt: sql`now()` }).where(eq(orders.id, orderId))
    await audit(tx, { actor, action: 'bill.cancelled', entityType: 'order', entityId: orderId, before: { status: o.status }, after: { status: 'cancelled', billNo: sb?.billNo ?? o.billNo }, reason: why })
    return { orderId, billNo: sb?.billNo ?? o.billNo }
  })
}

/** Edit bill by scanning (owner, 24 Nov 2026): the bill's lines and boxes. 1 query. */
export async function getBillForEdit(orderId: number): Promise<BillForEdit> {
  await biller()
  const b = await loadBillForEdit(db, Number(orderId))
  if (!b) throw new Error('This bill has no saved amounts (made before 23 Nov). Cancel it and bill again.')
  if (b.status !== 'billed') throw new Error(`Only bills not yet dispatched can be edited (this one is ${b.status}).`)
  return b
}

/**
 * Save an edit: boxes scanned on (raw labels) and off (box keys). Same number and date; stock,
 * bill lines, frozen amounts, ledger and money set against the bill follow. One transaction, ~18 statements.
 */
export async function saveBillEdit(orderId: number, add: string[], remove: string[]): Promise<EditedBill> {
  const actor = await biller()
  return editBillByScan(db, actor, Number(orderId), { add, remove })
}
