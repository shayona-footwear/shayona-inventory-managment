// Billing takes stock out (server only). See db/migrations/0006_bill_scans.sql.
//
// A biller's scan reserves the box (one active bill per box label). When the bill is generated,
// every box leaves stock in one set-based step:
//   1. the warehouse scanned this exact box in            → −1 'scanned'   (stockSource 'scanned')
//   2. else its size has carton stock (received cartons)   → −1 'carton'    (stockSource 'carton')
//   3. else its size has hand-counted (unscanned) stock    → −1 'unscanned' (stockSource 'unscanned')
//   4. else stock is not touched                           → stockSource 'unscanned_dispatch'
// Cancelling a bill / sending it back releases its boxes and reverses their movements.
// Statements per action do not grow with the number of boxes.

import { stampBillLineHsn } from './bill-number'
import { cleanWalkIn, freezeSaleBill, notInMasterMessage, type TaxType, type WalkIn } from './sale-bill'
import type { BillRates } from './bill-totals'
import { applyAdvance } from '@/lib/payments/payments'
import { enforceCredit } from '@/lib/payments/credit'
import type { BillTotalsPaise } from './bill-totals'
import { and, eq, sql } from 'drizzle-orm'
import { billLines, billScans, directBillDrafts, orders, type BillStockSource, type DraftManualLine } from '@/lib/db/schema'
import type { Actor, Db, DbOrTx, Tx } from '@/lib/db/types'
import { audit } from '@/lib/audit'
import { readBoxLabel, type BoxLabel } from './box-label'
import { normalizeArticleValue } from '@/lib/article-utils'
import { mainLocationId } from '@/lib/inventory/ledger'
import { assertPickerChoice } from '@/lib/orders/pickers'
import { nextOrderNumber } from '@/lib/orders/order-number'
import { matchBoxesToOrder, type ReceiptItem } from './order-receipt'
import { recordReceivedPairs } from './received-pairs'
import { billingPartyFor } from './sale-bill'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NORM = (col: unknown) => sql`upper(regexp_replace(btrim(${col}), '\\s+', ' ', 'g'))`
const J = (v: unknown) => JSON.stringify(v)

// ── Box labels ────────────────────────────────────────────────────────────────

// readBoxLabel lives in ./box-label (pure, also used by the Edit bill screen).
export { readBoxLabel, type BoxLabel } from './box-label'

// ── Direct Bill drafts ────────────────────────────────────────────────────────

export interface DraftHeader {
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
  lineDiscPct: number
  manualLines: DraftManualLine[]
}

export interface DraftSummary {
  id: number
  billerName: string
  shopkeeperName: string
  boxes: number
  manualPairs: number
  updatedAt: string
}

export interface DraftScan { id: number; clientEventId: string; raw: string; articleCode: string; mrp: number | null; inStock: boolean }

export interface DraftDetail extends DraftHeader { id: number; billerName: string; scans: DraftScan[] }

function cleanHeader(h: Partial<DraftHeader>): DraftHeader {
  const pct = Number(h.lineDiscPct ?? 30)
  const lines = Array.isArray(h.manualLines) ? h.manualLines : []
  return {
    shopkeeperName: String(h.shopkeeperName ?? '').trim().slice(0, 200),
    shopkeeperPhone: h.shopkeeperPhone ? String(h.shopkeeperPhone).trim().slice(0, 40) : null,
    shopkeeperAddress: h.shopkeeperAddress ? String(h.shopkeeperAddress).trim().slice(0, 500) : null,
    lineDiscPct: Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 30,
    manualLines: lines.slice(0, 500).map((l) => {
      // Size and colour of a box added by hand: optional, kept as typed (owner, 28 Nov 2026).
      const size = normalizeArticleValue(String(l.size ?? '')).slice(0, 20)
      const colour = normalizeArticleValue(String(l.colour ?? '')).slice(0, 40)
      return {
        artNumber: normalizeArticleValue(String(l.artNumber ?? '')).slice(0, 60),
        mrp: Math.max(0, Math.round(Number(l.mrp) * 100) / 100 || 0),
        qty: Math.max(0, Math.floor(Number(l.qty) || 0)),
        ...(size ? { size } : {}),
        ...(colour ? { colour } : {}),
      }
    }).filter((l) => l.artNumber && l.qty > 0),
  }
}

export async function createDraft(db: DbOrTx, actor: Actor, header: Partial<DraftHeader> = {}, orderId: number | null = null): Promise<number> {
  const h = cleanHeader(header)
  const [row] = await db.insert(directBillDrafts).values({
    billerId: actor.id, billerName: actor.name, ...h, lineDiscPct: String(h.lineDiscPct), orderId,
  }).returning({ id: directBillDrafts.id })
  return row.id
}

/**
 * An order's lines with the colour code of each line's colour (article master: same article code,
 * or same name when the line has no code; same colour name). None when the colour has no code yet.
 * One query. Used to check a box's colour against the line (lib/billing/order-receipt.ts).
 */
async function orderLinesWithColour(db: DbOrTx, orderId: number): Promise<OrderForDirectBill['items']> {
  const r = await db.execute<{ id: number; artNumber: string; artCode: string | null; colorNumber: string | null; sizeNumber: string | null; quantityOrdered: number; colourCode: string | null }>(sql`
    SELECT i.id, i."artNumber", i."artCode", i."colorNumber", i."sizeNumber", i."quantityOrdered",
      (SELECT nullif(btrim(a."colorCode"), '') FROM articles a
        WHERE (CASE WHEN nullif(btrim(i."artCode"), '') IS NOT NULL THEN upper(a."artCode") = upper(btrim(i."artCode"))
                    ELSE upper(a."artName") = upper(btrim(i."artNumber")) END)
          AND upper(btrim(a.color)) = upper(btrim(i."colorNumber")) AND btrim(a."colorCode") <> ''
        ORDER BY a.active DESC, a.id LIMIT 1) AS "colourCode"
    FROM order_items i WHERE i."orderId" = ${orderId} ORDER BY i.id`)
  return r.rows.map((x) => ({ ...x, id: Number(x.id), quantityOrdered: Number(x.quantityOrdered) }))
}

export interface OrderForDirectBill {
  draftId: number
  order: { id: number; orderNumber: string; shopkeeperName: string; shopkeeperPhone: string | null; shopkeeperAddress: string | null; pickerId: string | null; retailerId: string | null; taxType: TaxType | null }
  items: (ReceiptItem & { colorNumber: string | null; colourCode: string | null })[]
}

/**
 * ⚡ Direct bill on an order (owner, 27 Nov 2026: bill it right there, on the Direct Billing screen).
 * The order's open draft, or a new one tied to the order (drafts with an order stay out of the
 * Direct Billing drafts list). Only pending or assigned orders. 3–4 statements.
 */
export async function openOrderDraft(db: DbOrTx, actor: Actor, orderId: number, opts: { allowOpen?: boolean } = { allowOpen: true }): Promise<OrderForDirectBill> {
  const [o] = await db.select({
    id: orders.id, orderNumber: orders.orderNumber, status: orders.status, isEmergency: orders.isEmergency, shopkeeperName: orders.shopkeeperName,
    shopkeeperPhone: orders.shopkeeperPhone, shopkeeperAddress: orders.shopkeeperAddress, pickerId: orders.pickerId,
    // The order's retailer (else the exact name match, as billing does) and the bill type to start from.
    retailerId: sql<string | null>`(SELECT x.id FROM retailers x
      WHERE x.id = ${orders.retailerId} OR (${orders.retailerId} IS NULL AND lower(btrim(x."partyName")) = lower(btrim(${orders.shopkeeperName})))
      ORDER BY (x.id = ${orders.retailerId}) DESC NULLS LAST LIMIT 1)`,
    taxType: sql<TaxType | null>`(SELECT x."taxType" FROM retailers x
      WHERE x.id = ${orders.retailerId} OR (${orders.retailerId} IS NULL AND lower(btrim(x."partyName")) = lower(btrim(${orders.shopkeeperName})))
      ORDER BY (x.id = ${orders.retailerId}) DESC NULLS LAST LIMIT 1)`,
  }).from(orders).where(eq(orders.id, orderId)).limit(1)
  if (!o) throw new Error('Order not found.')
  // Pending / assigned (⚡ on the order, admins), or already sent to the biller as a Direct bill
  // (packed + isEmergency, the earlier ⚡; owner 27 Nov 2026: billed on this screen too).
  const sent = o.status === 'packed' && o.isEmergency
  const notSent = o.status === 'pending' || o.status === 'assigned'
  if (!sent && !(notSent && opts.allowOpen)) {
    throw new Error(notSent ? 'Only an admin can Direct bill an order that is not sent to billing.' : `This order is ${o.status} — it cannot be Direct billed now.`)
  }
  const items = await orderLinesWithColour(db, orderId)
  const [open] = await db.select({ id: directBillDrafts.id }).from(directBillDrafts)
    .where(and(eq(directBillDrafts.orderId, orderId), eq(directBillDrafts.status, 'open'))).orderBy(directBillDrafts.id).limit(1)
  const draftId = open?.id ?? await createDraft(db, actor, {
    shopkeeperName: o.shopkeeperName, shopkeeperPhone: o.shopkeeperPhone, shopkeeperAddress: o.shopkeeperAddress,
  }, orderId)
  const { status: _status, isEmergency: _sent, ...order } = o
  return { draftId, order, items }
}

/** Open drafts of every biller, newest first. One query. */
export async function listOpenDrafts(db: DbOrTx): Promise<DraftSummary[]> {
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT d.id, d."billerName", d."shopkeeperName", d."updatedAt",
           (SELECT count(*) FROM bill_scans b WHERE b."draftId" = d.id AND b.status = 'active')::int AS boxes,
           (SELECT coalesce(sum((l->>'qty')::int), 0) FROM jsonb_array_elements(d."manualLines") l)::int AS manual
    FROM direct_bill_drafts d WHERE d.status = 'open' AND d."orderId" IS NULL ORDER BY d."updatedAt" DESC LIMIT 50`)
  return r.rows.map((x) => ({
    id: Number(x.id), billerName: String(x.billerName ?? ''), shopkeeperName: String(x.shopkeeperName ?? ''),
    boxes: Number(x.boxes), manualPairs: Number(x.manual), updatedAt: new Date(x.updatedAt as string).toISOString(),
  }))
}

/** One open draft with its boxes. Two queries. */
export async function loadDraft(db: DbOrTx, draftId: number): Promise<DraftDetail> {
  const [d] = await db.select().from(directBillDrafts).where(eq(directBillDrafts.id, draftId)).limit(1)
  if (!d || d.status !== 'open') throw new Error('This draft was already generated or discarded.')
  const r = await db.execute<Record<string, unknown>>(sql`
    SELECT b.id, b."clientEventId", b."rawInput", b."articleCode", b.mrp,
           EXISTS (SELECT 1 FROM scan_events e WHERE e."dedupeKey" = b."dedupeKey" AND e.status = 'active' AND e.resolution = 'resolved') AS "inStock"
    FROM bill_scans b WHERE b."draftId" = ${draftId} AND b.status = 'active' ORDER BY b.id`)
  return {
    id: d.id, billerName: d.billerName, shopkeeperName: d.shopkeeperName, shopkeeperPhone: d.shopkeeperPhone,
    shopkeeperAddress: d.shopkeeperAddress, lineDiscPct: Number(d.lineDiscPct), manualLines: d.manualLines,
    scans: r.rows.map((x) => ({
      id: Number(x.id), clientEventId: String(x.clientEventId), raw: String(x.rawInput), articleCode: String(x.articleCode ?? ''),
      mrp: x.mrp != null ? Number(x.mrp) : null, inStock: Boolean(x.inStock),
    })),
  }
}

/** Save the retailer, discount and hand-typed lines of an open draft. One statement. */
export async function saveDraftHeader(db: DbOrTx, draftId: number, header: Partial<DraftHeader>): Promise<void> {
  const h = cleanHeader(header)
  const r = await db.update(directBillDrafts).set({ ...h, lineDiscPct: String(h.lineDiscPct), updatedAt: sql`now()` })
    .where(and(eq(directBillDrafts.id, draftId), eq(directBillDrafts.status, 'open'))).returning({ id: directBillDrafts.id })
  if (!r.length) throw new Error('This draft was already generated or discarded.')
}

/** Is the box's article (code + colour) in the active article master? Same rule as the warehouse scanner. */
export type MasterMatch = { status: 'known' } | { status: 'unknown' } | { status: 'new_colour'; artName: string }

export type AddScanOutcome =
  | { status: 'added'; id: number; articleCode: string; mrp: number | null; inStock: boolean; master: MasterMatch }
  | { status: 'on_other_bill'; message: string }
  | { status: 'rejected'; message: string }

/**
 * Reserve one box on an open draft. One statement (insert + stock check + article-master check);
 * a retried clientEventId is a no-op.
 */
export async function addDraftScan(db: DbOrTx, actor: Actor, draftId: number, rawInput: string, clientEventId: string): Promise<AddScanOutcome> {
  if (!UUID_RE.test(clientEventId)) throw new Error('Invalid request.')
  const label = readBoxLabel(rawInput)
  if (!label.ok) return { status: 'rejected', message: label.message }
  const b = label.box
  const r = await db.execute<Record<string, unknown>>(sql`
    WITH ins AS (
      INSERT INTO bill_scans ("clientEventId", "draftId", "rawInput", "dedupeKey", "articleCode", "colourCode", "sizeLabel", mrp, "userId", "userName")
      SELECT ${clientEventId}::uuid, ${draftId}, ${b.raw}, ${b.dedupeKey}, ${b.articleCode}, ${b.colourCode || null}, ${b.sizeLabel || null}, ${b.mrp}, ${actor.id}, ${actor.name}
      WHERE EXISTS (SELECT 1 FROM direct_bill_drafts WHERE id = ${draftId} AND status = 'open')
      ON CONFLICT DO NOTHING
      RETURNING id
    ), touch AS (
      UPDATE direct_bill_drafts SET "updatedAt" = now() WHERE id = ${draftId} AND EXISTS (SELECT 1 FROM ins)
    ), mrp AS (
      -- An article can sell at several MRPs: remember each one seen on a billed box (known articles only).
      -- (lastSeenAt: the shop shows the latest MRP — migration 0015)
      INSERT INTO article_mrps ("artCode", mrp, "lastSeenAt")
      SELECT ${b.articleCode}, ${b.mrp}::numeric, now()
      WHERE ${b.mrp}::numeric IS NOT NULL AND EXISTS (SELECT 1 FROM ins)
        AND EXISTS (SELECT 1 FROM articles a WHERE ${NORM(sql`a."artCode"`)} = ${b.articleCode})
      ON CONFLICT ("artCode", mrp) DO UPDATE SET "lastSeenAt" = now()
    )
    SELECT (SELECT id FROM ins) AS id,
      ${b.unique} AND EXISTS (SELECT 1 FROM scan_events e WHERE e."dedupeKey" = ${b.dedupeKey} AND e.status = 'active' AND e.resolution = 'resolved') AS "inStock",
      (SELECT json_build_object('id', h.id, 'clientEventId', h."clientEventId", 'draftId', h."draftId", 'orderNumber', h."orderNumber", 'userName', h."userName")
         FROM bill_scans h WHERE h.status = 'active' AND (h."dedupeKey" = ${b.dedupeKey} OR h."clientEventId" = ${clientEventId}::uuid) LIMIT 1) AS holder,
      (SELECT status FROM direct_bill_drafts WHERE id = ${draftId}) AS "draftStatus",
      (SELECT json_build_object('known', bool_or(${NORM(sql`a."colorCode"`)} = ${b.colourCode}), 'artName', min(a."artName"), 'n', count(*))
         FROM articles a WHERE a.active AND ${NORM(sql`a."artCode"`)} = ${b.articleCode}) AS master`)
  const x = r.rows[0] ?? {}
  const inStock = Boolean(x.inStock)
  const m = (x.master ?? {}) as { known: boolean | null; artName: string | null; n: number }
  const master: MasterMatch = !Number(m.n) ? { status: 'unknown' } : m.known ? { status: 'known' } : { status: 'new_colour', artName: m.artName ?? '' }
  if (x.id != null) return { status: 'added', id: Number(x.id), articleCode: b.articleCode, mrp: b.mrp, inStock, master }
  const holder = x.holder as { id: number; clientEventId: string; draftId: number | null; orderNumber: string | null; userName: string } | null
  if (holder && holder.clientEventId === clientEventId) return { status: 'added', id: Number(holder.id), articleCode: b.articleCode, mrp: b.mrp, inStock, master }
  if (holder) {
    const where = holder.orderNumber ? `bill ${holder.orderNumber}` : holder.draftId === draftId ? 'this bill' : `another draft (${holder.userName || 'a biller'})`
    return { status: 'on_other_bill', message: `This box is already on ${where}.` }
  }
  if (x.draftStatus !== 'open') throw new Error('This draft was already generated or discarded.')
  throw new Error('The box could not be added. Try again.')
}

/** Take boxes off an open draft (by their labels). One statement. */
export async function removeDraftScans(db: DbOrTx, draftId: number, rawInputs: string[], reason: string): Promise<number> {
  const keys = rawInputs.map(readBoxLabel).filter((l): l is { ok: true; box: BoxLabel } => l.ok).map((l) => l.box.dedupeKey)
  if (!keys.length) return 0
  const r = await db.execute(sql`
    UPDATE bill_scans SET status = 'released', "releasedAt" = now(), "releasedReason" = ${reason}
    WHERE "draftId" = ${draftId} AND status = 'active' AND "postedAt" IS NULL
      AND "dedupeKey" IN (SELECT json_array_elements_text(${J(keys)}::json))`)
  return r.rowCount ?? 0
}

/** Discard an open draft and free its boxes. One transaction, two statements. */
export async function discardDraft(db: Db, actor: Actor, draftId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.update(directBillDrafts).set({ status: 'discarded', closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(directBillDrafts.id, draftId), eq(directBillDrafts.status, 'open'))).returning({ id: directBillDrafts.id })
    if (!r.length) throw new Error('This draft was already generated or discarded.')
    const freed = await tx.execute(sql`UPDATE bill_scans SET status = 'released', "releasedAt" = now(), "releasedReason" = 'draft discarded'
      WHERE "draftId" = ${draftId} AND status = 'active'`)
    await audit(tx, { actor, action: 'direct_bill.draft_discarded', entityType: 'direct_bill_draft', entityId: draftId, after: { boxesFreed: freed.rowCount ?? 0 } })
  })
}

// ── Taking stock out ─────────────────────────────────────────────────────────

export interface StockOutCounts { scanned: number; carton: number; unscanned: number; unscanned_dispatch: number }

/**
 * Post every active, not-yet-posted box of an order. Set-based: resolve, lock the SKUs (in id
 * order, no deadlocks), read their balances, allocate, insert movements, update the rows.
 */
export async function postOrderScans(tx: Tx, actor: Actor, orderId: number, orderNumber: string): Promise<StockOutCounts> {
  const counts: StockOutCounts = { scanned: 0, carton: 0, unscanned: 0, unscanned_dispatch: 0 }
  const scans = (await tx.execute<{ id: number; stockEventId: number | null; stockSku: number | null; sku: number | null }>(sql`
    SELECT b.id,
           e.id AS "stockEventId", e."skuId" AS "stockSku",
           (SELECT s.id FROM articles a JOIN article_sizes s ON s."articleId" = a.id AND s."sizeLabel" = b."sizeLabel" AND s.active
             WHERE ${NORM(sql`a."artCode"`)} = b."articleCode" AND ${NORM(sql`a."colorCode"`)} = b."colourCode" AND a.active LIMIT 1) AS sku
    FROM bill_scans b
    LEFT JOIN LATERAL (
      SELECT id, "skuId" FROM scan_events e
      WHERE e."dedupeKey" = b."dedupeKey" AND b."dedupeKey" NOT LIKE 'raw:%' AND e.status = 'active'
        AND e.resolution = 'resolved' AND e."entryType" = 'scan' AND e.purpose = 'stocktake'
      LIMIT 1) e ON TRUE
    WHERE b."orderId" = ${orderId} AND b.status = 'active' AND b."postedAt" IS NULL
    ORDER BY b.id`)).rows
  if (!scans.length) return counts

  const skuOf = (s: (typeof scans)[number]) => (s.stockSku != null ? Number(s.stockSku) : s.sku != null ? Number(s.sku) : null)
  const skus = [...new Set(scans.map(skuOf).filter((x): x is number => x != null))].sort((a, b) => a - b)
  const loc = await mainLocationId(tx)
  const avail = new Map<number, { scanned: number; carton: number; unscanned: number }>()
  if (skus.length) {
    // Same per-SKU lock as hand corrections (lib/inventory/adjust.ts).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7301, x::int) FROM json_array_elements_text(${J(skus)}::json) x ORDER BY x::int`)
    const bal = await tx.execute<{ skuId: number; provenance: string; quantity: number }>(sql`
      SELECT "skuId", provenance, quantity FROM stock_balances
      WHERE "locationId" = ${loc} AND "skuId" IN (SELECT json_array_elements_text(${J(skus)}::json)::int)`)
    for (const s of skus) avail.set(s, { scanned: 0, carton: 0, unscanned: 0 })
    for (const b of bal.rows) {
      const a = avail.get(Number(b.skuId))!
      if (b.provenance === 'scanned') a.scanned = Number(b.quantity)
      if (b.provenance === 'unscanned') a.unscanned = Number(b.quantity)
      if (b.provenance === 'carton') a.carton = Number(b.quantity)
    }
  }

  const plan = scans.map((s) => {
    const sku = skuOf(s)
    let source: BillStockSource = 'unscanned_dispatch'
    if (sku != null) {
      const a = avail.get(sku)!
      if (s.stockEventId != null && a.scanned >= 1) { source = 'scanned'; a.scanned-- }
      else if (a.carton >= 1) { source = 'carton'; a.carton-- }
      else if (a.unscanned >= 1) { source = 'unscanned'; a.unscanned-- }
    }
    counts[source]++
    return { id: Number(s.id), sku, source, stockEventId: source === 'scanned' ? Number(s.stockEventId) : null }
  })

  const moving = plan.filter((p) => p.source !== 'unscanned_dispatch')
  const movementIds = new Map<number, number>()
  if (moving.length) {
    const ins = await tx.execute<{ id: number; sourceId: string }>(sql`
      INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "userId", reason)
      SELECT x.sku, ${loc}, x.source, -1, 'dispatch', 'bill_scan', x.id::text, 'bill_scan:' || x.id || ':out', ${actor.id}, ${`Bill ${orderNumber}`}
      FROM json_to_recordset(${J(moving)}::json) AS x(id bigint, sku int, source text)
      ON CONFLICT ("idempotencyKey") DO NOTHING
      RETURNING id, "sourceId"`)
    for (const m of ins.rows) movementIds.set(Number(m.sourceId), Number(m.id))
  }
  await tx.execute(sql`
    UPDATE bill_scans b SET "skuId" = x.sku, "stockSource" = x.source, "stockScanEventId" = x."stockEventId",
           "movementId" = x."movementId", "postedAt" = now(), "orderNumber" = ${orderNumber}
    FROM json_to_recordset(${J(plan.map((p) => ({ ...p, movementId: movementIds.get(p.id) ?? null })))}::json)
         AS x(id bigint, sku int, source text, "stockEventId" bigint, "movementId" bigint)
    WHERE b.id = x.id`)
  return counts
}

/**
 * Free every box of an order: reverse its stock movements (set-based) and mark the rows released.
 * Used when a bill is deleted, sent back for editing, or moved back before "billed". `only` (box
 * dedupe keys) frees just those boxes (Edit bill: boxes scanned off the bill).
 */
export async function releaseOrderScans(tx: Tx, actor: Actor, orderId: number, reason: string, only?: string[]): Promise<number> {
  if (only && !only.length) return 0
  const pick = only ? sql`AND b."dedupeKey" IN (SELECT json_array_elements_text(${J(only)}::json))` : sql``
  await tx.execute(sql`
    INSERT INTO stock_movements ("skuId", "locationId", provenance, quantity, "movementType", "sourceType", "sourceId", "idempotencyKey", "reversalOfId", "userId", reason)
    SELECT m."skuId", m."locationId", m.provenance, -m.quantity, 'reversal', m."sourceType", m."sourceId", 'bill_scan:' || b.id || ':back:' || m.id, m.id, ${actor.id}, ${reason}
    FROM bill_scans b JOIN stock_movements m ON m.id = b."movementId"
    WHERE b."orderId" = ${orderId} AND b.status = 'active' ${pick}
      AND NOT EXISTS (SELECT 1 FROM stock_movements r WHERE r."reversalOfId" = m.id)`)
  const r = await tx.execute(sql`
    UPDATE bill_scans b SET status = 'released', "releasedAt" = now(), "releasedReason" = ${reason}, "orderId" = NULL
    WHERE b."orderId" = ${orderId} AND b.status = 'active' ${pick}`)
  const n = r.rowCount ?? 0
  if (n) await audit(tx, { actor, action: 'bill.boxes_released', entityType: 'order', entityId: orderId, after: { boxes: n }, reason })
  return n
}

/** Group boxes into bill lines (article code + MRP), then add the hand-typed lines. */
function buildLines(scans: { articleCode: string | null; mrp: string | null }[], manual: DraftManualLine[]): DraftManualLine[] {
  const m = new Map<string, DraftManualLine>()
  const add = (artNumber: string, mrp: number, qty: number) => {
    const k = `${artNumber}__${mrp.toFixed(2)}`
    const cur = m.get(k)
    if (cur) cur.qty += qty
    else m.set(k, { artNumber, mrp, qty })
  }
  for (const s of scans) add(s.articleCode ?? '', Number(s.mrp ?? 0), 1)
  for (const l of manual) add(l.artNumber, l.mrp, l.qty)
  return [...m.values()]
}


export interface GeneratedBill {
  id: number; orderNumber: string; billNo: string; lines: DraftManualLine[]; stock: StockOutCounts; billedAt: string
  taxType: TaxType; totals: BillTotalsPaise; retailerId: string | null
}

/**
 * Generate a Direct Bill from an open draft: create the order and its lines, freeze the amounts
 * (sale_bills + ledger entry, lib/billing/sale-bill.ts), move the boxes onto it and take them out of
 * stock. The party must be in the retailer master, or the bill is for a walk-in customer (name only,
 * not taxed, paid at once). One transaction; ~12 statements whatever the number of boxes.
 */
export async function generateDirectBill(
  db: Db, actor: Actor, draftId: number, header: Partial<DraftHeader>, bill: { taxType?: TaxType; walkIn?: WalkIn; pickerId?: string; rates?: BillRates; credit?: { allowed: boolean; requested: boolean } } = {},
): Promise<GeneratedBill> {
  const walk = bill.walkIn ? cleanWalkIn(bill.walkIn) : null
  const h = cleanHeader(walk ? { ...header, shopkeeperName: walk.name, shopkeeperPhone: walk.phone || null } : header)
  if (!h.shopkeeperName) throw new Error('Select a retailer first.')
  return db.transaction(async (tx) => {
    const [d] = await tx.select({ status: directBillDrafts.status, orderId: directBillDrafts.orderId }).from(directBillDrafts).where(eq(directBillDrafts.id, draftId)).for('update')
    if (!d || d.status !== 'open') throw new Error('This draft was already generated or discarded.')
    if (d.orderId != null) {
      if (walk) throw new Error('An order is billed to its retailer, not as a walk-in.')
      return billOrderFromDraft(tx, actor, draftId, d.orderId, h, bill)
    }
    const r = walk ? null : (await tx.execute<{ id: string; taxType: TaxType }>(sql`
      SELECT id, "taxType" FROM retailers WHERE lower(btrim("partyName")) = lower(btrim(${h.shopkeeperName})) ORDER BY id LIMIT 1`)).rows[0]
    if (!walk && !r) throw new Error(notInMasterMessage(h.shopkeeperName))
    // Credit hold (owner, 22 Nov 2026): unpaid past the party's credit days → no Direct bill unless an admin allows it.
    const held = r ? await enforceCredit(tx, { retailerId: r.id }, bill.credit ?? { allowed: false, requested: false }) : null
    if (held) {
      await audit(tx, { actor, action: 'direct_bill.credit_override', entityType: 'direct_bill_draft', entityId: draftId,
        after: { retailerId: r!.id, overduePaise: held.overduePaise, creditDays: held.creditDays, oldest: held.overdue[0] ?? null } })
    }
    // Every Direct bill names who picked the goods (owner, 23 Nov 2026).
    const pickerId = await assertPickerChoice(tx, bill.pickerId)
    const scans = await tx.select({ articleCode: billScans.articleCode, mrp: billScans.mrp }).from(billScans)
      .where(and(eq(billScans.draftId, draftId), eq(billScans.status, 'active')))
    const lines = buildLines(scans, h.manualLines)
    if (!lines.length) throw new Error('No items on this bill yet.')
    const number = await nextOrderNumber(tx) // ORD-1, ORD-2 … (lib/orders/order-number.ts)
    const [order] = await tx.insert(orders).values({
      orderNumber: number, shopkeeperName: h.shopkeeperName, shopkeeperPhone: h.shopkeeperPhone, shopkeeperAddress: h.shopkeeperAddress,
      retailerId: r?.id ?? null, billerId: actor.id, pickerId, status: 'billed', isEmergency: true, billedAt: sql`now()`,
    }).returning({ id: orders.id, billedAt: orders.billedAt })
    await tx.insert(billLines).values(lines.map((l) => ({ orderId: order.id, artNumber: l.artNumber, mrp: String(l.mrp), qty: l.qty, lineDiscPct: String(h.lineDiscPct) })))
    // Official bill number, frozen amounts, ledger entry; HSN on each line — same transaction.
    const frozen = await freezeSaleBill(tx, actor, {
      orderId: order.id, source: 'direct', lines, lineDiscPct: h.lineDiscPct,
      party: walk ? { walkIn: walk } : { retailerId: r!.id, taxType: bill.taxType ?? r!.taxType },
      rates: bill.rates,
    })
    if (frozen.retailerId) await applyAdvance(tx, actor, frozen.retailerId, frozen.saleBillId) // the party's advance goes to this bill
    await stampBillLineHsn(tx, order.id)
    await tx.execute(sql`UPDATE bill_scans SET "orderId" = ${order.id}, "orderNumber" = ${number} WHERE "draftId" = ${draftId} AND status = 'active'`)
    const stock = await postOrderScans(tx, actor, order.id, number)
    await tx.update(directBillDrafts).set({ ...h, lineDiscPct: String(h.lineDiscPct), status: 'billed', orderId: order.id, closedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(directBillDrafts.id, draftId))
    await audit(tx, { actor, action: 'direct_bill.generated', entityType: 'order', entityId: order.id, after: { orderNumber: number, billNo: frozen.billNo, draftId, pickerId, boxes: scans.length, stock } })
    return {
      id: order.id, orderNumber: number, billNo: frozen.billNo, lines, stock, billedAt: new Date(order.billedAt ?? Date.now()).toISOString(),
      taxType: frozen.taxType, totals: frozen.totals, retailerId: frozen.retailerId,
    }
  })
}

/**
 * ⚡ Direct bill of an existing order from its draft (owner, 27 Nov 2026): the order itself is
 * billed (no new order): its retailer, the boxes scanned on the draft and any hand-typed lines.
 * Pairs received per order line are saved on the order (what did not come stays marked), worked out
 * here from the boxes (lib/billing/order-receipt.ts). One transaction, ~15 statements.
 */
async function billOrderFromDraft(
  tx: Tx, actor: Actor, draftId: number, orderId: number, h: DraftHeader,
  bill: { taxType?: TaxType; pickerId?: string; rates?: BillRates; credit?: { allowed: boolean; requested: boolean } },
): Promise<GeneratedBill> {
  const o = await billingPartyFor(tx, orderId) // locks the order
  if (!o) throw new Error('Order not found.')
  const sent = o.status === 'packed' && o.isEmergency
  if (o.status !== 'pending' && o.status !== 'assigned' && !sent) throw new Error(`This order is ${o.status} — it cannot be Direct billed now.`)
  if (!o.retailerId || !o.taxType) throw new Error(notInMasterMessage(o.shopkeeperName))
  const held = await enforceCredit(tx, { retailerId: o.retailerId }, bill.credit ?? { allowed: false, requested: false })
  if (held) {
    await audit(tx, { actor, action: 'direct_bill.credit_override', entityType: 'order', entityId: orderId,
      after: { retailerId: o.retailerId, overduePaise: held.overduePaise, creditDays: held.creditDays, oldest: held.overdue[0] ?? null } })
  }
  const pickerId = await assertPickerChoice(tx, bill.pickerId)
  const scans = await tx.select({ articleCode: billScans.articleCode, mrp: billScans.mrp, raw: billScans.rawInput }).from(billScans)
    .where(and(eq(billScans.draftId, draftId), eq(billScans.status, 'active')))
  const lines = buildLines(scans, h.manualLines)
  if (!lines.length) throw new Error('No items on this bill yet.')
  const [row] = await tx.update(orders).set({
    status: 'billed', isEmergency: true, pickerId, billerId: actor.id, retailerId: o.retailerId,
    packedAt: sql`coalesce(${orders.packedAt}, now())`, billedAt: sql`now()`, updatedAt: sql`now()`,
  }).where(eq(orders.id, orderId)).returning({ billedAt: orders.billedAt })
  await tx.delete(billLines).where(eq(billLines.orderId, orderId))
  await tx.insert(billLines).values(lines.map((l) => ({ orderId, artNumber: l.artNumber, mrp: String(l.mrp), qty: l.qty, lineDiscPct: String(h.lineDiscPct) })))
  const frozen = await freezeSaleBill(tx, actor, {
    orderId, source: 'direct', lines, lineDiscPct: h.lineDiscPct,
    party: { retailerId: o.retailerId, taxType: bill.taxType ?? o.taxType }, rates: bill.rates,
  })
  await applyAdvance(tx, actor, o.retailerId, frozen.saleBillId)
  await stampBillLineHsn(tx, orderId)
  await tx.execute(sql`UPDATE bill_scans SET "orderId" = ${orderId}, "orderNumber" = ${o.orderNumber} WHERE "draftId" = ${draftId} AND status = 'active'`)
  const stock = await postOrderScans(tx, actor, orderId, o.orderNumber)
  // Pairs received per order line, from the boxes on the bill.
  const items = await orderLinesWithColour(tx, orderId)
  const boxes = scans.flatMap((sc) => { const l = readBoxLabel(sc.raw); return l.ok ? [{ articleCode: l.box.articleCode, sizeLabel: l.box.sizeLabel, colourCode: l.box.colourCode }] : [] })
  const receipt = matchBoxesToOrder(items, boxes)
  await recordReceivedPairs(tx, actor, orderId, items.map((i) => ({ itemId: i.id, qty: receipt.received.get(i.id) ?? 0 })))
  await tx.update(directBillDrafts).set({ ...h, shopkeeperName: o.shopkeeperName, lineDiscPct: String(h.lineDiscPct), status: 'billed', closedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(directBillDrafts.id, draftId))
  await audit(tx, { actor, action: 'direct_bill.generated', entityType: 'order', entityId: orderId,
    after: { orderNumber: o.orderNumber, billNo: frozen.billNo, draftId, pickerId, boxes: scans.length, stock, fromOrder: true, extra: receipt.extra } })
  return {
    id: orderId, orderNumber: o.orderNumber, billNo: frozen.billNo, lines, stock, billedAt: new Date(row?.billedAt ?? Date.now()).toISOString(),
    taxType: frozen.taxType, totals: frozen.totals, retailerId: frozen.retailerId,
  }
}

// ── Order invoices (Invoices tab) ─────────────────────────────────────────────

/**
 * Record the boxes scanned for an order invoice and take them out of stock. Re-billing the same
 * order first releases its earlier boxes. Refuses (rolls back) if a box is already on another bill.
 */
export async function recordOrderScans(tx: Tx, actor: Actor, orderId: number, orderNumberText: string, rawInputs: string[]): Promise<StockOutCounts & { skipped: number }> {
  await releaseOrderScans(tx, actor, orderId, 'order billed again')
  const seen = new Set<string>()
  const boxes: BoxLabel[] = []
  let skipped = 0
  for (const raw of rawInputs.slice(0, 5000)) {
    const l = readBoxLabel(raw)
    if (!l.ok || seen.has(l.box.dedupeKey)) { skipped++; continue }
    seen.add(l.box.dedupeKey)
    boxes.push(l.box)
  }
  await insertOrderBoxes(tx, actor, orderId, orderNumberText, boxes)
  const counts = await postOrderScans(tx, actor, orderId, orderNumberText)
  return { ...counts, skipped }
}

/**
 * Put boxes on a billed order (not yet out of stock: postOrderScans does that). Refuses (throws) if a
 * box is already on another bill or draft, naming where. 1 statement (+1 to name the held boxes).
 */
export async function insertOrderBoxes(tx: Tx, actor: Actor, orderId: number, orderNumberText: string, boxes: BoxLabel[]): Promise<void> {
  if (boxes.length) {
    const rows = boxes.map((b) => ({ clientEventId: crypto.randomUUID(), raw: b.raw, key: b.dedupeKey, art: b.articleCode, colour: b.colourCode || null, size: b.sizeLabel || null, mrp: b.mrp }))
    const ins = await tx.execute<{ dedupeKey: string }>(sql`
      WITH mrp AS (
        -- Remember each MRP seen on a billed box (known articles only); an article can have several.
        INSERT INTO article_mrps ("artCode", mrp, "lastSeenAt")
        SELECT DISTINCT m.art, m.mrp, now() FROM json_to_recordset(${J(rows)}::json) AS m(art text, mrp numeric)
        WHERE m.mrp IS NOT NULL AND EXISTS (SELECT 1 FROM articles a WHERE ${NORM(sql`a."artCode"`)} = m.art)
        ON CONFLICT ("artCode", mrp) DO UPDATE SET "lastSeenAt" = now()
      )
      INSERT INTO bill_scans ("clientEventId", "orderId", "orderNumber", "rawInput", "dedupeKey", "articleCode", "colourCode", "sizeLabel", mrp, "userId", "userName")
      SELECT x."clientEventId"::uuid, ${orderId}, ${orderNumberText}, x.raw, x.key, x.art, x.colour, x.size, x.mrp, ${actor.id}, ${actor.name}
      FROM json_to_recordset(${J(rows)}::json) AS x("clientEventId" text, raw text, key text, art text, colour text, size text, mrp numeric)
      ON CONFLICT DO NOTHING
      RETURNING "dedupeKey"`)
    if (ins.rows.length !== boxes.length) {
      const got = new Set(ins.rows.map((r) => r.dedupeKey))
      const missing = boxes.filter((b) => !got.has(b.dedupeKey)).map((b) => b.dedupeKey)
      const held = await tx.execute<{ articleCode: string; sizeLabel: string; orderNumber: string | null; draftId: number | null }>(sql`
        SELECT "articleCode", "sizeLabel", "orderNumber", "draftId" FROM bill_scans
        WHERE status = 'active' AND "dedupeKey" IN (SELECT json_array_elements_text(${J(missing)}::json)) LIMIT 5`)
      const list = held.rows.map((h) => `${h.articleCode} size ${h.sizeLabel} (${h.orderNumber ? `bill ${h.orderNumber}` : 'a Direct Bill draft'})`).join(', ')
      throw new Error(`${missing.length} box${missing.length === 1 ? ' is' : 'es are'} already on another bill: ${list}. Undo ${missing.length === 1 ? 'that scan' : 'those scans'} and save again.`)
    }
  }
}
