'use client'

import { playAlreadyScanned, playNewArticle, playScanOk } from '@/lib/scan-sound'
import jsQR from 'jsqr'
import {
  useCallback, useEffect, useId, useImperativeHandle, useMemo,
  useRef, useState, forwardRef,
} from 'react'
import { fuzzyFilter } from '@/lib/fuzzy'
import { useScanForwarder } from '@/lib/shortcuts'
import { buildInvoiceHtml } from '@/lib/bill-html'
import { getBillTemplate } from '@/app/actions/bill-template'
import type { BillTemplate } from '@/lib/bill-template'
import { SCAN_INTERVAL_MS, SCAN_MAX_DIM } from '@/components/scanner/constants'
import { Button } from '@/components/ui/button'
import { isValidWarehouseQr, parseQr, type ParsedQr } from '@/lib/qr-parser'
import { PageNav } from '@/components/page-nav'
import { NewArticleDialog } from '@/components/scanner/new-article-dialog'
import {
  discardDirectBillDraft, generateDirectBillFromDraft, getOpenDirectBillDrafts, openDirectBillDraft, openDirectBillForOrder,
  removeFromDirectBill, saveDirectBillDraft, scanIntoDirectBill, startDirectBillDraft,
} from '@/app/actions/billing'
import type { DraftDetail, DraftHeader, DraftSummary, GeneratedBill, MasterMatch, OrderForDirectBill } from '@/lib/billing/bill-stock'
import { matchBoxesToOrder } from '@/lib/billing/order-receipt'
import { readBoxLabel } from '@/lib/billing/box-label'
import { DialogKeys } from '@/components/dialog-keys'
import { askConfirm } from '@/components/confirm-dialog'
import { BillTypeChoice } from '@/components/bill-type-choice'
import { DEFAULT_BILL_RATES, computeBillTotals, ratePaise, ratesBp, toBp, type BillRates, type TaxType } from '@/lib/billing/bill-totals'
import { BillRatesFields, resolveRates, type RateEdits } from '@/components/bill-rates-fields'
import { CreditNote, useCreditStatus } from '@/components/payments/credit-note'
import { amountsFromTotals, billTotalRows, formatRs } from '@/lib/billing/bill-amounts'

function newUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}
const errMsg = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Network problem.')

// ── Vendor type ────────────────────────────────────────────────────────────────

export interface BillingVendor {
  id: string
  name: string
  code: string | null   // area
  phone: string | null
  address: string | null
  /** Bill type in the retailer master (the bill's default). */
  taxType: TaxType
}

// ── Bill line ──────────────────────────────────────────────────────────────────
// Key = artNumber__mrpCents — same article at different MRP → separate line.

interface BillLine {
  key: string       // artNumber__mrpCents
  artNumber: string
  mrp: number
  division: string
  qty: number
  boxCodes: string[]
  /** Boxes on this line that the warehouse never scanned into stock (Direct Billing). */
  notInStock: number
}

function lineKey(art: string, mrp: number) {
  return `${art}__${Math.round(mrp * 100)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchCombobox — identical to salesman-dashboard
// ─────────────────────────────────────────────────────────────────────────────

interface SearchComboboxProps<T> {
  id?: string
  label: string
  required?: boolean
  placeholder: string
  inputValue: string
  onInputChange: (v: string) => void
  onSelect: (item: T) => void
  onClear: () => void
  results: T[]
  loading: boolean
  renderOption: (item: T, active: boolean) => React.ReactNode
  getKey: (item: T) => string | number
  disabled?: boolean
  dropUp?: boolean
  /** Label for screen readers only (the placeholder says what to type). */
  hideLabel?: boolean
}

interface SearchComboboxHandle {
  focus: () => void
}

const SearchCombobox = forwardRef(function SearchComboboxInner<T>(
  {
    id, label, required, placeholder, inputValue, onInputChange,
    onSelect, onClear, results, loading, renderOption, getKey, disabled,
    dropUp = true, hideLabel = false,
  }: SearchComboboxProps<T>,
  ref: React.Ref<SearchComboboxHandle>,
) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()

  useImperativeHandle(ref, () => ({
    focus: () => { inputRef.current?.focus(); inputRef.current?.select() },
  }))

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  useEffect(() => {
    if (!open || !listRef.current) return
    const activeEl = listRef.current.children[activeIdx] as HTMLElement | undefined
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' })
  }, [activeIdx, open])

  useEffect(() => {
    if (results.length > 0) {
      setActiveIdx(0)
      if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [results])

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { setOpen(true); e.preventDefault() }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = results[activeIdx]
      if (item) { onSelect(item); setOpen(false); inputRef.current?.blur() }
    } else if (e.key === 'Escape') {
      setOpen(false); inputRef.current?.blur()
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className={hideLabel ? 'sr-only' : 'block text-xs font-medium text-muted-foreground mb-1.5'}>
        {label}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      <div className="relative flex items-center">
        <svg className="absolute left-3 w-4 h-4 text-muted-foreground pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          id={id}
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && results[activeIdx] ? `${listId}-${activeIdx}` : undefined}
          value={inputValue}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={e => { onInputChange(e.target.value); setOpen(true) }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKey}
          className={`w-full rounded-xl border border-border bg-background pl-9 pr-9 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed transition-colors ${hideLabel ? 'h-12' : 'py-2.5'}`}
        />
        {inputValue && !disabled && (
          <button
            type="button"
            aria-label="Clear"
            onClick={() => { onClear(); setOpen(false) }}
            className="absolute right-3 text-muted-foreground hover:text-foreground"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {open && (
        <ul
          id={listId}
          ref={listRef}
          role="listbox"
          aria-label={label}
          className={`absolute z-50 w-full rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-60 overflow-y-auto ${
            dropUp
              ? 'bottom-full mb-1 flex flex-col-reverse'
              : 'top-full mt-1'
          }`}
        >
          {loading && <li className="px-4 py-3 text-sm text-muted-foreground">Searching…</li>}
          {!loading && results.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No results found</li>
          )}
          {!loading && results.map((item, i) => (
            <li
              key={getKey(item)}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseEnter={() => setActiveIdx(i)}
              onMouseDown={e => { e.preventDefault(); onSelect(item); setOpen(false); inputRef.current?.blur() }}
              className={`px-4 py-2.5 text-sm cursor-pointer transition-colors ${i === activeIdx ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
            >
              {renderOption(item, i === activeIdx)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}) as <T>(props: SearchComboboxProps<T> & { ref?: React.Ref<SearchComboboxHandle> }) => React.ReactElement

/** Right-hand panel for things used now and then (box by hand, drafts). Esc or a tap outside closes it. */
function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Esc: <DialogKeys> (focus returns to the opener).
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <DialogKeys onClose={onClose} />
      <section role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <h2 className="flex-1 text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-9 w-9 items-center justify-center rounded-lg border border-border hover:bg-muted">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">{children}</div>
      </section>
    </div>
  )
}

// ── Props ──────────────────────────────────────────────────────────────────────

export type DirectBillGenerated = GeneratedBill & {
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
}

interface Props {
  vendors: BillingVendor[]
  /** Article numbers for manual-entry search combobox */
  articles?: string[]
  /**
   * Direct Billing mode (biller dashboard): every scan is saved to a server draft at once, so a
   * bill left by mistake stays as a draft. "Generate" creates the bill and takes its boxes out of
   * stock, then calls this.
   */
  onBillGenerated?: (data: DirectBillGenerated) => void
  /** Direct Billing: who can be named as the picker (owner, 23 Nov 2026: every Direct bill says who picked it). */
  pickers?: { id: string; name: string | null }[]
  /** Default bill discount and GST rates (Master → Bill template); a bill may change them. */
  rateDefaults?: BillRates
  /** Suppress the full-page chrome (header, sign-out) when embedded */
  embedded?: boolean
  /**
   * ⚡ Direct bill of an existing order (owner, 27 Nov 2026): the order's retailer is fixed, its
   * ordered pairs are shown against the scanned boxes, and the bill is made on that order.
   */
  orderId?: number
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function BillingScannerPage({ vendors, articles = [], onBillGenerated, pickers = [], rateDefaults = DEFAULT_BILL_RATES, embedded, orderId }: Props) {
  const forOrder = orderId != null

  // Guard: vendors may briefly be undefined during SSR/hydration
  const safeVendors = vendors ?? []

  // ── Vendor search ──────────────────────────────────────────────────────────
  const [skQuery, setSkQuery]               = useState('')
  const [selectedVendor, setSelectedVendor] = useState<BillingVendor | null>(null)
  // Direct Billing: who picked the goods (kept on this screen only; chosen again for a resumed draft).
  const [pickedBy, setPickedBy] = useState('')
  // Party balance / credit hold (payments, owner 22 Nov 2026): a held party needs an admin's "Allow".
  const credit = useCreditStatus(onBillGenerated && selectedVendor && !selectedVendor.id.startsWith('draft-') && !selectedVendor.id.startsWith('order-') ? { retailerId: selectedVendor.id } : null)
  const [allowHeld, setAllowHeld] = useState(false)
  useEffect(() => { setAllowHeld(false) }, [selectedVendor?.id])
  // Bill type (owner, 23 Nov 2026): from the retailer, changeable for this bill.
  const [taxType, setTaxType] = useState<TaxType>('intra_state')
  // Bill discount / GST typed on this bill (owner, 24 Nov 2026); empty = the defaults.
  const [rateEdits, setRateEdits] = useState<RateEdits>({})
  // Walk-in customer: name only, without GST, pays at once (cash / UPI), bill discount typed.
  const [walkIn, setWalkIn] = useState(false)
  const [walkName, setWalkName] = useState('')
  const [walkPhone, setWalkPhone] = useState('')
  const [walkPaid, setWalkPaid] = useState<'cash' | 'upi' | ''>('')
  const [walkDisc, setWalkDisc] = useState('0')
  function chooseVendor(v: BillingVendor | null) {
    setSelectedVendor(v)
    setSkQuery(v?.name ?? '')
    setTaxType(v?.taxType ?? 'intra_state')
  }
  function toggleWalkIn(on: boolean) {
    setWalkIn(on)
    if (on) chooseVendor(null)
    else { setWalkName(''); setWalkPhone(''); setWalkPaid(''); setWalkDisc('0') }
  }

  const skResults = useMemo<BillingVendor[]>(() => {
    if (!skQuery.trim()) return safeVendors.slice(0, 20)
    return fuzzyFilter(
      safeVendors,
      skQuery,
      v => [v.name, v.code, v.phone, v.address],
    ).slice(0, 20)
  }, [skQuery, safeVendors])

  // ── Bill lines ─────────────────────────────────────────────────────────────
  const [billLines, setBillLines] = useState<BillLine[]>([])
  // Synchronous copy, so rapid scans see each other before React re-renders.
  const billLinesRef = useRef<BillLine[]>([])
  function commitLines(next: BillLine[]) { billLinesRef.current = next; setBillLines(next) }

  // ── Direct Billing drafts (server) ─────────────────────────────────────────
  const directBill = !!onBillGenerated
  const [draftId, setDraftId] = useState<number | null>(null)
  const draftIdRef = useRef<number | null>(null)
  const draftPromiseRef = useRef<Promise<number> | null>(null)
  const [drafts, setDrafts] = useState<DraftSummary[]>([])
  const [pendingScans, setPendingScans] = useState(0)

  function refreshDrafts() {
    if (!directBill || forOrder) return
    getOpenDirectBillDrafts().then(setDrafts).catch(() => {})
  }
  useEffect(() => {
    refreshDrafts()
  }, [])

  // ── ⚡ Direct bill of an order: the order, its lines and its draft (left open = carried on) ──
  const [order, setOrder] = useState<OrderForDirectBill | null>(null)
  const [orderError, setOrderError] = useState('')
  const orderVendor = useMemo<BillingVendor | null>(() => order ? {
    id: order.order.retailerId ?? `order-${order.order.id}`, name: order.order.shopkeeperName, code: null,
    phone: order.order.shopkeeperPhone, address: order.order.shopkeeperAddress, taxType: order.order.taxType ?? 'intra_state',
  } : null, [order])
  useEffect(() => {
    if (orderId == null) return
    let live = true
    openDirectBillForOrder(orderId).then((r) => {
      if (!live) return
      setOrder(r)
      draftIdRef.current = r.draftId
      draftPromiseRef.current = Promise.resolve(r.draftId)
      setDraftId(r.draftId)
      applyDraft(r.draft, false)
      chooseVendor({
        id: r.order.retailerId ?? `order-${r.order.id}`, name: r.order.shopkeeperName, code: null,
        phone: r.order.shopkeeperPhone, address: r.order.shopkeeperAddress, taxType: r.order.taxType ?? 'intra_state',
      })
      setPickedBy(r.order.pickerId ?? '')
      if (r.draft.scans.length) showSuccess(`Carried on: ${r.draft.scans.length} box(es) already scanned for this order`)
    }).catch((e) => { if (live) setOrderError(errMsg(e)) })
    return () => { live = false }
  }, [orderId]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The server draft for this bill, created on first need (one request even if called twice). */
  function ensureDraft(): Promise<number> {
    if (draftIdRef.current) return Promise.resolve(draftIdRef.current)
    if (!draftPromiseRef.current) {
      draftPromiseRef.current = (orderId != null ? openDirectBillForOrder(orderId).then((r) => r.draftId) : startDirectBillDraft({}))
        .then((id) => { draftIdRef.current = id; setDraftId(id); return id })
        .catch((e) => { draftPromiseRef.current = null; throw e })
    }
    return draftPromiseRef.current
  }

  function dropBox(key: string, raw: string) {
    commitLines(billLinesRef.current
      .map((l) => (l.key === key ? { ...l, qty: l.qty - 1, boxCodes: l.boxCodes.filter((c) => c !== raw), notInStock: Math.min(l.notInStock, l.qty - 1) } : l))
      .filter((l) => l.qty > 0))
  }

  async function persistScan(key: string, raw: string, art: string) {
    setPendingScans((n) => n + 1)
    try {
      const id = await ensureDraft()
      const out = await scanIntoDirectBill(id, raw, newUuid())
      if (out.status === 'added') {
        if (!out.inStock) {
          commitLines(billLinesRef.current.map((l) => (l.key === key ? { ...l, notInStock: l.notInStock + 1 } : l)))
        }
        if (out.master.status !== 'known') noteNewArticle(raw, art, out.master, out.canCreateArticle)
        else if (!out.inStock) showWarning(`${art}: this box was not scanned into stock — it will go out as Unscanned dispatch.`)
      } else {
        dropBox(key, raw)
        showWarning(out.message)
        if (out.status === 'on_other_bill') playAlreadyScanned()
      }
    } catch (e) {
      dropBox(key, raw)
      showError(`Scan not saved (${errMsg(e)}) — scan the box again.`)
    } finally {
      setPendingScans((n) => n - 1)
    }
  }

  // ── New article detection (same form as the warehouse scanner) ────────────
  // The box is already on the bill. If its article/colour is not in the master, an admin gets the
  // New Article form (adds it to the master only; no stock scan); a biller gets a warning and the
  // box appears in Master → Articles → Missing articles. Asked once per article/colour per bill.
  const [articleDialog, setArticleDialog] = useState<{ rawQr: string; parsed: ParsedQr; mode: 'unknown' | 'new_colour'; existingName?: string } | null>(null)
  const articleDialogRef = useRef(false)
  const articleNotedRef = useRef<Set<string>>(new Set())

  function noteNewArticle(raw: string, art: string, master: Exclude<MasterMatch, { status: 'known' }>, canCreate: boolean) {
    const parsed = parseQr(raw)
    const key = `${parsed.articleCode}|${parsed.colorCode}`
    if (articleNotedRef.current.has(key)) return
    articleNotedRef.current.add(key)
    playNewArticle()
    if (canCreate && !articleDialogRef.current) {
      articleDialogRef.current = true
      scanPausedRef.current = true
      setArticleDialog({ rawQr: raw, parsed, mode: master.status, existingName: master.status === 'new_colour' ? master.artName : undefined })
      return
    }
    showWarning(master.status === 'new_colour'
      ? `${art}: new colour, not in the article master. It stays on the bill; an admin can add it in Master → Articles → Missing articles.`
      : `${art}: new article, not in the article master. It stays on the bill; an admin can add it in Master → Articles → Missing articles.`)
  }

  function closeArticleDialog(linked: boolean) {
    articleDialogRef.current = false
    setArticleDialog(null)
    if (linked) showSuccess('Article added to the master.')
    setTimeout(() => { if (!articleDialogRef.current) scanPausedRef.current = false }, 800)
  }

  function resetLocal() {
    articleNotedRef.current = new Set()
    commitLines([])
    setTouched({})
    // An order keeps its retailer and picker; a fresh Direct bill starts empty.
    if (forOrder) { chooseVendor(orderVendor); setPickedBy(order?.order.pickerId ?? '') }
    else { chooseVendor(null); setPickedBy('') }
    toggleWalkIn(false)
    setRateEdits({})
    setLineDiscPct(30)
    draftIdRef.current = null
    draftPromiseRef.current = null
    setDraftId(null)
    refreshDrafts()
  }

  async function resumeDraft(id: number) {
    if (pendingScans > 0) { showWarning('Still saving scans — try again in a moment.'); return }
    try {
      const d = await openDirectBillDraft(id)
      draftIdRef.current = id
      draftPromiseRef.current = Promise.resolve(id)
      setDraftId(id)
      applyDraft(d, true)
      showSuccess(`Draft resumed: ${d.scans.length} boxes`)
    } catch (e) {
      showError(errMsg(e))
      refreshDrafts()
    }
  }

  /** Put a saved draft on the screen: its boxes and hand-typed lines, retailer and discount. */
  function applyDraft(d: DraftDetail, setVendor: boolean) {
    {
      const id = d.id
      const lines: BillLine[] = []
      // Saved order of scans: the line scanned last shows first on screen.
      const ranks: Record<string, number> = {}
      let seq = 0
      const put = (art: string, mrp: number, division: string, qty: number, raw: string | null, inStock: boolean) => {
        const key = lineKey(art, mrp)
        ranks[key] = ++seq
        let l = lines.find((x) => x.key === key)
        if (!l) { l = { key, artNumber: art, mrp, division, qty: 0, boxCodes: [], notInStock: 0 }; lines.push(l) }
        l.qty += qty
        if (raw) { l.boxCodes.push(raw); if (!inStock) l.notInStock++ }
      }
      for (const sc of d.scans) {
        const p = isValidWarehouseQr(sc.raw) ? parseQr(sc.raw) : null
        put(p?.articleCode || sc.articleCode, p?.mrp ?? sc.mrp ?? 0, p?.division ?? '', 1, sc.raw, sc.inStock)
      }
      for (const m of d.manualLines) put(m.artNumber, m.mrp, '', m.qty, null, true)
      setTouched(ranks)
      commitLines(lines)
      if (setVendor) {
        const v = safeVendors.find((x) => x.name === d.shopkeeperName)
          ?? (d.shopkeeperName ? { id: `draft-${id}`, name: d.shopkeeperName, code: null, phone: d.shopkeeperPhone, address: d.shopkeeperAddress, taxType: 'intra_state' as const } : null)
        if (v) toggleWalkIn(false)
        chooseVendor(v)
      }
      setLineDiscPct(d.lineDiscPct)
    }
  }

  async function discardDraftById(id: number) {
    if (!(await askConfirm({ message: 'Discard this draft? Its boxes are freed; nothing is billed.', confirmLabel: 'Discard draft', destructive: true }))) return
    try {
      await discardDirectBillDraft(id)
      if (draftIdRef.current === id) resetLocal()
      else refreshDrafts()
    } catch (e) { showError(errMsg(e)) }
  }

  // ── Camera / scan refs ─────────────────────────────────────────────────────
  const videoRef            = useRef<HTMLVideoElement>(null)
  const canvasRef           = useRef<HTMLCanvasElement>(null)
  const scanCanvasRef       = useRef<HTMLCanvasElement | null>(null)
  const streamRef           = useRef<MediaStream | null>(null)
  const flashlightStreamRef = useRef<MediaStream | null>(null)
  const lastScanTimeRef     = useRef<number>(0)
  const scanningRef         = useRef(false)
  const scanPausedRef       = useRef(false)
  const fileInputRef        = useRef<HTMLInputElement>(null)

  const [isCameraActive, setIsCameraActive]     = useState(false)
  const [isFlashlightOn, setIsFlashlightOn]     = useState(false)
  const [qrDetected, setQrDetected]             = useState(false)
  const [uploadProcessing, setUploadProcessing] = useState(false)
  // ── Scan box: USB / Bluetooth scanners type the code + Enter. The Scan box keeps the cursor;
  // keys typed while nothing has the cursor are sent to it, so a scan is never lost.
  const scanInputRef = useRef<HTMLInputElement>(null)
  const [scanValue, setScanValue] = useState('')
  const [scanFocused, setScanFocused] = useState(false)
  const [lastAdded, setLastAdded] = useState<{ key: string; raw: string } | null>(null)
  function focusScan() { setTimeout(() => scanInputRef.current?.focus({ preventScroll: true }), 30) }
  function submitScan() {
    const code = scanValue.trim()
    setScanValue('')
    if (code) handleQrDecode(code)
  }
  // Keys typed while no text box has the cursor go to the Scan box (only while it is on screen).
  // It also tells the shortcut system this is a billing screen: plain-key shortcuts are off.
  useScanForwarder(scanInputRef, ch => setScanValue(v => v + ch), () => articleDialogRef.current)
  // On a computer the Scan box has the cursor from the start.
  // (The panel can mount hidden behind a tab: focus it again when it becomes visible.)
  useEffect(() => {
    if (window.matchMedia('(pointer: coarse)').matches) return
    focusScan()
    const input = scanInputRef.current
    if (!input || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting) && (document.activeElement === document.body || !document.activeElement)) focusScan()
    })
    io.observe(input)
    return () => io.disconnect()
  }, [])

  // ── Banners ────────────────────────────────────────────────────────────────
  const [lastResult, setLastResult] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null)

  // ── Manual entry ───────────────────────────────────────────────────────────
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [handOpen, setHandOpen] = useState(false)
  const closeHand = useCallback(() => { setHandOpen(false); focusScan() }, [])
  const closeDrafts = useCallback(() => { setDraftsOpen(false); focusScan() }, [])
  const [manualArt, setManualArt] = useState('')
  const [manualMrp, setManualMrp] = useState('')
  const [manualQty, setManualQty] = useState<number | ''>(1)

  // Article search for manual entry
  const [artQuery, setArtQuery] = useState('')
  const [artSelected, setArtSelected] = useState(false)

  const artResults = useMemo(() => {
    if (!artQuery.trim()) return articles.slice(0, 20)
    return fuzzyFilter(articles, artQuery, a => [a]).slice(0, 20)
  }, [artQuery, articles])

  // ── Bill number — timestamp-based (YYMMDDHHmmss), no state needed ─────────

  // ── Delete confirm ─────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  // ── Cleanup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      scanningRef.current = false
      if (flashlightStreamRef.current) flashlightStreamRef.current.getTracks().forEach(t => t.stop())
    }
  }, [])

  // ── Banner helpers ─────────────────────────────────────────────────────────

  function showSuccess(msg: string) { setLastResult({ tone: 'ok', text: msg }) }
  function showWarning(msg: string) { setLastResult({ tone: 'warn', text: msg }) }
  function showError(msg: string) { setLastResult({ tone: 'err', text: msg }) }

  // ── Undo / one box less ────────────────────────────────────────────────────
  async function undoLastScan() {
    const last = lastAdded
    if (!last) return
    setLastAdded(null)
    if (directBill && draftIdRef.current) {
      try { await removeFromDirectBill(draftIdRef.current, [last.raw]) }
      catch (e) { showError(`Could not undo: ${errMsg(e)}`); return }
    }
    dropBox(last.key, last.raw)
    showWarning('Last scan removed from the bill.')
    focusScan()
  }

  /** One box less on a line: a box added by hand first, else the last scanned box (freed on the server). */
  async function decrementLine(key: string) {
    const line = billLinesRef.current.find(l => l.key === key)
    if (!line) return
    if (line.qty > line.boxCodes.length) {
      commitLines(billLinesRef.current.map(l => (l.key === key ? { ...l, qty: l.qty - 1 } : l)).filter(l => l.qty > 0))
      return
    }
    const raw = line.boxCodes[line.boxCodes.length - 1]
    if (directBill && draftIdRef.current) {
      try { await removeFromDirectBill(draftIdRef.current, [raw]) }
      catch (e) { showError(`Could not remove: ${errMsg(e)}`); return }
    }
    if (lastAdded?.raw === raw) setLastAdded(null)
    dropBox(key, raw)
  }

  // ── Bill line management ───────────────────────────────────────────────────

  // When each line was last added to: the bill on screen shows the most recent scan first (owner, 21 Nov 2026).
  const [touched, setTouched] = useState<Record<string, number>>({})
  const touchSeq = useRef(1_000_000)
  function touchLine(key: string) { const seq = ++touchSeq.current; setTouched(t => ({ ...t, [key]: seq })) }

  function addScannedBox(art: string, mrp: number, division: string, rawQr: string) {
    const key = lineKey(art, mrp)
    const boxCode = rawQr.split('-').pop() ?? rawQr
    const prev = billLinesRef.current
    if (prev.some(l => l.boxCodes.some(c => (c.split('-').pop() ?? c) === boxCode))) {
      showWarning(`Box already scanned: ${art}`)
      playAlreadyScanned()
      return
    }
    const existing = prev.find(l => l.key === key)
    commitLines(existing
      ? prev.map(l => l.key === key ? { ...l, qty: l.qty + 1, boxCodes: [...l.boxCodes, rawQr] } : l)
      : [...prev, { key, artNumber: art, mrp, division, qty: 1, boxCodes: [rawQr], notInStock: 0 }])
    showSuccess(existing ? `+1 box: ${art} @ ₹${mrp.toFixed(2)} (now ${(existing.qty + 1)} boxes)` : `Added: ${art} @ ₹${mrp.toFixed(2)}`)
    setLastAdded({ key, raw: rawQr })
    touchLine(key)
    playScanOk()
    if (directBill) void persistScan(key, rawQr, art)
  }

  function addManualLine(art: string, mrp: number, division: string, qty: number) {
    const key = lineKey(art, mrp)
    const prev = billLinesRef.current
    const existing = prev.find(l => l.key === key)
    commitLines(existing
      ? prev.map(l => l.key === key ? { ...l, qty: l.qty + qty } : l)
      : [...prev, { key, artNumber: art, mrp, division, qty, boxCodes: [], notInStock: 0 }])
    touchLine(key)
    showSuccess(`Added ${qty}× ${art} @ ₹${mrp.toFixed(2)}`)
  }

  async function removeLine(key: string) {
    setDeleteTarget(null)
    const line = billLinesRef.current.find(l => l.key === key)
    if (directBill && draftIdRef.current && line && line.boxCodes.length) {
      try { await removeFromDirectBill(draftIdRef.current, line.boxCodes) }
      catch (e) { showError(`Could not remove: ${errMsg(e)}`); return }
    }
    commitLines(billLinesRef.current.filter(l => l.key !== key))
  }

  async function clearBill() {
    setDeleteTarget(null)
    // Direct Billing: "Clear All" discards the saved draft and frees its boxes.
    if (directBill && draftIdRef.current) {
      try { await discardDirectBillDraft(draftIdRef.current) }
      catch (e) { showError(`Could not clear: ${errMsg(e)}`); return }
      resetLocal()
      return
    }
    commitLines([])
  }

  // ── QR decode → bill ───────────────────────────────────────────────────────

  function handleQrDecode(raw: string) {
    if (articleDialogRef.current) {
      showWarning('Finish or close the New Article form first, then scan again.')
      return
    }
    if (!isValidWarehouseQr(raw)) {
      showWarning('QR code format not recognised — only warehouse box QR codes are accepted.')
      return
    }
    const p = parseQr(raw)
    addScannedBox(p.articleCode, p.mrp, p.division, raw)
  }

  // ── Camera helpers ─────────────────────────────────────────────────────────

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      })
      if (!videoRef.current) { stream.getTracks().forEach(t => t.stop()); return }
      videoRef.current.srcObject = stream
      streamRef.current = stream
      setIsCameraActive(true)
      scanningRef.current = true
      const video = videoRef.current
      const startLoop = () => scanLoop(video)
      if (video.readyState >= 2) startLoop()
      else video.addEventListener('loadeddata', startLoop, { once: true })
    } catch {
      showError('Camera permission denied or unavailable.')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopCamera() {
    scanningRef.current = false
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null }
    setIsCameraActive(false)
  }

  function scanLoop(video: HTMLVideoElement) {
    if (!scanningRef.current) return
    if (video.videoWidth === 0 || video.videoHeight === 0) { requestAnimationFrame(() => scanLoop(video)); return }
    if (scanPausedRef.current) { requestAnimationFrame(() => scanLoop(video)); return }

    const now = performance.now()
    if (now - lastScanTimeRef.current < SCAN_INTERVAL_MS) { requestAnimationFrame(() => scanLoop(video)); return }
    lastScanTimeRef.current = now

    let sc = scanCanvasRef.current
    const scale = Math.min(1, SCAN_MAX_DIM / Math.max(video.videoWidth, video.videoHeight))
    const sw = Math.round(video.videoWidth * scale)
    const sh = Math.round(video.videoHeight * scale)
    if (!sc || sc.width !== sw || sc.height !== sh) {
      sc = document.createElement('canvas'); sc.width = sw; sc.height = sh; scanCanvasRef.current = sc
    }
    const sctx = sc.getContext('2d', { willReadFrequently: true })
    if (!sctx) { requestAnimationFrame(() => scanLoop(video)); return }

    sctx.drawImage(video, 0, 0, sw, sh)
    try {
      const imageData = sctx.getImageData(0, 0, sw, sh)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (code) {
        scanPausedRef.current = true; setQrDetected(true)
        // Stays paused while the New Article form is open.
        setTimeout(() => { if (!articleDialogRef.current) scanPausedRef.current = false; setQrDetected(false) }, 2000)
        handleQrDecode(code.data)
      }
    } catch { /* ignore */ }
    requestAnimationFrame(() => scanLoop(video))
  }

  async function toggleFlashlight() {
    if (!isFlashlightOn) {
      try {
        let track: MediaStreamTrack | undefined
        if (streamRef.current) { track = streamRef.current.getVideoTracks()[0] }
        else {
          const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
          flashlightStreamRef.current = s; track = s.getVideoTracks()[0]
        }
        if (!track) return
        await track.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] })
        setIsFlashlightOn(true)
      } catch {
        if (flashlightStreamRef.current) { flashlightStreamRef.current.getTracks().forEach(t => t.stop()); flashlightStreamRef.current = null }
        showWarning('Flashlight not supported on this device.')
      }
    } else {
      const track = (streamRef.current ?? flashlightStreamRef.current)?.getVideoTracks()[0]
      if (track) track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] }).catch(() => {})
      if (flashlightStreamRef.current) { flashlightStreamRef.current.getTracks().forEach(t => t.stop()); flashlightStreamRef.current = null }
      setIsFlashlightOn(false)
    }
  }

  async function handleImageUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']
    if (!allowed.includes(file.type)) { showError('Invalid image file type.'); if (fileInputRef.current) fileInputRef.current.value = ''; return }
    setUploadProcessing(true)
    try {
      const bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')!; ctx.drawImage(bitmap, 0, 0); bitmap.close()
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (!code) { showError('No QR code found in image.'); return }
      handleQrDecode(code.data)
    } catch { showError('Could not process image.') }
    finally { setUploadProcessing(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  // ── Manual entry submit ────────────────────────────────────────────────────

  function handleManualAdd(e: React.FormEvent) {
    e.preventDefault()
    const art = manualArt.trim().toUpperCase()
    const mrp = parseFloat(manualMrp) || 0
    const qty = Number(manualQty) || 1
    if (!art) { showError('Article number is required.'); return }
    addManualLine(art, mrp, '', qty)
    setManualQty(1)
    setManualArt('')
    setArtQuery('')
    setArtSelected(false)
  }

  // On screen: most recently scanned / added line first; lines from a reopened draft follow, newest first.
  // (The printed bill keeps its article order.)
  const recentLines = useMemo(() => billLines
    .map((line, i) => ({ line, rank: touched[line.key] ?? i }))
    .sort((a, b) => b.rank - a.rank)
    .map(x => x.line), [billLines, touched])

  // ── Print (and optionally persist to DB as emergency bill) ─────────────────

  const [isSaving, setIsSaving] = useState(false)
  // Standalone billing prints here: load the Bill template once (Direct Billing prints from Receipts).
  const [billTemplate, setBillTemplate] = useState<BillTemplate | undefined>(undefined)
  useEffect(() => { if (!onBillGenerated) getBillTemplate().then(setBillTemplate).catch(() => {}) }, [onBillGenerated])

  async function handlePrint() {
    if (!selectedVendor && !walkIn) { showError('Please select a vendor first.'); return }
    if (billLines.length === 0) { showError('No items scanned yet.'); return }

    // Build MrpLine[] from billLines (each BillLine already has artNumber + mrp + qty)
    const lines = billLines.map(l => ({ artNumber: l.artNumber, mrp: l.mrp, qty: l.qty }))

    // Direct Billing: generate from the saved draft (takes the boxes out of stock), then Receipts.
    if (onBillGenerated) {
      if (pendingScans > 0) { showWarning('Still saving scans — try again in a moment.'); return }
      // ⚡ Order: different from the order → ask first (short pairs stay marked on the order).
      if (receipt && (receipt.short.length || receipt.extra.length)) {
        const parts = [
          receipt.short.length ? `${orderedPairs - receivedPairs} pair(s) short on ${receipt.short.length} line(s) — they stay marked on the order` : '',
          extraBoxes ? `${extraBoxes} box(es) not on the order — billed as extra` : '',
        ].filter(Boolean)
        if (!(await askConfirm({ message: `This bill differs from the order: ${parts.join('; ')}. Bill it like this?`, confirmLabel: 'Bill it' }))) return
      }
      setIsSaving(true)
      try {
        const id = await ensureDraft()
        const header = draftHeader()
        const res = await generateDirectBillFromDraft(id, header, walkIn
          ? { pickerId: pickedBy, walkIn: { name: walkName.trim(), phone: walkPhone.trim(), paidMode: walkPaid as 'cash' | 'upi', discountPct: walkDiscNum } }
          : { pickerId: pickedBy, taxType, ...(rated.changed ? { rates: rated.rates } : {}), overrideCredit: allowHeld })
        onBillGenerated(walkIn
          ? { ...res, shopkeeperName: walkName.trim(), shopkeeperPhone: walkPhone.trim() || null, shopkeeperAddress: null }
          : { ...res, shopkeeperName: header.shopkeeperName, shopkeeperPhone: header.shopkeeperPhone, shopkeeperAddress: header.shopkeeperAddress })
        if (forOrder) return // the order is billed; the screen closes
        resetLocal()
        if (res.stock.unscanned_dispatch > 0) showWarning(`Bill ${res.orderNumber} saved. ${res.stock.unscanned_dispatch} box(es) went out as Unscanned dispatch.`)
      } catch (e) {
        showError(`Bill not generated: ${errMsg(e)} It is still saved as a draft.`)
      } finally {
        setIsSaving(false)
      }
      return
    }

    // Standalone /billing page — open print window directly
    if (!selectedVendor) return
    const html = buildInvoiceHtml({
      vendor: {
        name:    selectedVendor.name,
        phone:   selectedVendor.phone,
        area:    selectedVendor.code,
        address: selectedVendor.address,
      },
      order:       { orderNumber: '', billedAt: new Date() },
      lines,
      lineDiscPct: LINE_DISC_PCT,
      template:    billTemplate,
    })

    const win = window.open('', '_blank', 'width=860,height=1000')
    if (!win) { showError('Pop-up blocked. Please allow pop-ups for this site.'); return }
    win.document.write(html); win.document.close(); win.focus()
    win.onload = () => win.print()
  }

  // Per-unit column discount — user-configurable via the Bill tab input
  const [lineDiscPct, setLineDiscPct] = useState<number | ''>(30)
  const LINE_DISC_PCT = lineDiscPct === '' ? 30 : Number(lineDiscPct)

  // ── Direct Billing: keep the draft's retailer, discount and hand-typed lines saved ──
  const manualLinesForServer = useMemo(
    () => billLines.map(l => ({ artNumber: l.artNumber, mrp: l.mrp, qty: l.qty - l.boxCodes.length })).filter(l => l.qty > 0),
    [billLines],
  )
  function draftHeader(): DraftHeader {
    return {
      shopkeeperName: selectedVendor?.name ?? '',
      shopkeeperPhone: selectedVendor?.phone ?? null,
      shopkeeperAddress: selectedVendor?.address ?? null,
      lineDiscPct: LINE_DISC_PCT,
      manualLines: manualLinesForServer,
    }
  }
  const headerKey = JSON.stringify(draftHeader())
  useEffect(() => {
    if (!directBill) return
    if (!draftIdRef.current && !selectedVendor && manualLinesForServer.length === 0) return
    const header = JSON.parse(headerKey) as DraftHeader
    const t = setTimeout(() => {
      ensureDraft().then((id) => saveDirectBillDraft(id, header)).catch(() => { /* retried on the next change; generate reports errors */ })
    }, 700)
    return () => clearTimeout(t)
  }, [headerKey])

  const totalQty   = billLines.reduce((s, l) => s + l.qty, 0)
  // Same arithmetic as the saved and printed bill (lib/billing/bill-totals.ts), for the chosen bill type.
  const walkDiscNum = Math.round(Number(walkDisc) * 100) / 100
  const walkDiscOk = walkDisc.trim() !== '' && Number.isFinite(walkDiscNum) && walkDiscNum >= 0 && walkDiscNum <= 100
  const billTax: TaxType = walkIn ? 'untaxed' : taxType
  const rated = resolveRates(taxType, rateDefaults, rateEdits)
  const amounts = amountsFromTotals(
    computeBillTotals(billLines, LINE_DISC_PCT, billTax, walkIn ? { discountBp: toBp(walkDiscOk ? walkDiscNum : 0) } : ratesBp(rated.rates)),
    billTax, walkIn,
  )
  const totalRows = billTotalRows(amounts)

  const otherDrafts = drafts.filter(d => d.id !== draftId)

  // ⚡ Order: ordered pairs against the boxes on the bill (same rule as the server, lib/billing/order-receipt.ts).
  const receipt = useMemo(() => {
    if (!order) return null
    const boxes = billLines.flatMap(l => l.boxCodes.flatMap(raw => {
      const b = readBoxLabel(raw)
      return b.ok ? [{ articleCode: b.box.articleCode, sizeLabel: b.box.sizeLabel, colourCode: b.box.colourCode }] : []
    }))
    return matchBoxesToOrder(order.items, boxes)
  }, [order, billLines])
  const orderedPairs = order ? order.items.reduce((t, i) => t + i.quantityOrdered, 0) : 0
  const receivedPairs = receipt ? [...receipt.received.values()].reduce((t, n) => t + n, 0) : 0
  const extraBoxes = receipt ? receipt.extra.reduce((t, e) => t + e.qty, 0) : 0

  // ── Render ─────────────────────────────────────────────────────────────────
  // Designed for the biller (owner, 20 Nov 2026): the Scan box keeps the cursor so a USB / Bluetooth
  // scanner always lands in the bill; the bill, totals and Generate stay in view while scanning.

  // Undo stays available while the last added box is still on the bill (also after a warning).
  const canUndo = !!lastAdded && billLines.some(l => l.boxCodes.includes(lastAdded.raw))
  const needsPicker = directBill && !pickedBy
  const partyHint = walkIn
    ? (!walkName.trim() ? 'Type the customer\'s name.' : !walkPaid ? 'Choose how the customer paid: cash or UPI.' : !walkDiscOk ? 'Bill discount must be 0 to 100 %.' : '')
    : forOrder && !order ? (orderError || 'Loading the order…')
    : forOrder && !order?.order.retailerId ? `"${order?.order.shopkeeperName}" is not in the retailer master. Add the party in Master → Retailers, then bill.`
    : (!selectedVendor ? 'Choose the retailer to generate the bill.'
      : credit?.blocked && !allowHeld ? (credit.canOverride ? 'Credit hold: tick "Allow anyway" to bill this party.' : 'Credit hold: this party must pay first, or ask an admin.')
      : rated.error)
  const canGenerate = !partyHint && !needsPicker && billLines.length > 0 && !isSaving && pendingScans === 0
  const generateHint = partyHint ? partyHint
    : needsPicker ? 'Choose who picked the goods.'
    : billLines.length === 0 ? 'Scan boxes to start the bill.'
    : pendingScans > 0 ? 'Saving scans…' : ''
  const TONE = {
    ok: 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/30 dark:text-green-200',
    warn: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200',
    err: 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200',
  }

  return (
    <div className={embedded ? 'space-y-3 pb-28 lg:pb-0' : 'min-h-screen bg-background p-3 sm:p-4 md:p-6 pb-28 lg:pb-6'}>
      <div className={embedded ? 'space-y-3' : 'mx-auto max-w-7xl space-y-3'}>

        {!embedded && (
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tight">Billing</h1>
            <PageNav />
          </div>
        )}

        {/* ── Strip: retailer · scan box · camera / QR photo / by hand (redesign, owner 21 Nov 2026) ── */}
        <section aria-label="Retailer and scanning" className="rounded-2xl border border-border bg-card p-3">
          <div className="flex flex-wrap items-stretch gap-2">
            <div className="min-w-0 flex-[1_1_240px]">
              {walkIn ? (
                <div className="grid h-12 grid-cols-[1fr_8rem] gap-2">
                  <label className="sr-only" htmlFor="walk-name">Customer name</label>
                  <input id="walk-name" value={walkName} onChange={e => setWalkName(e.target.value)} maxLength={200} autoComplete="off" autoFocus
                    placeholder="Walk-in customer — name"
                    className={`h-12 min-w-0 rounded-xl border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${walkName.trim() ? 'border-border' : 'border-amber-400'}`} />
                  <label className="sr-only" htmlFor="walk-phone">Phone (optional)</label>
                  <input id="walk-phone" value={walkPhone} onChange={e => setWalkPhone(e.target.value)} maxLength={40} inputMode="tel" autoComplete="off"
                    placeholder="Phone (optional)"
                    className="h-12 min-w-0 rounded-xl border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              ) : forOrder ? (
                <div className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-base text-amber-600 dark:text-amber-300" aria-hidden>⚡</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground" data-no-translate>{order?.order.shopkeeperName ?? (orderError ? '—' : 'Loading the order…')}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {order ? <><span className="font-mono" data-no-translate>{order.order.orderNumber}</span>{` · ${orderedPairs} pairs ordered`}</> : ''}
                    </span>
                  </span>
                </div>
              ) : !selectedVendor ? (
                <SearchCombobox<BillingVendor>
                  id="vendor-search"
                  label="Retailer"
                  hideLabel
                  dropUp={false}
                  required
                  placeholder="Retailer — type name, area or phone…"
                  inputValue={skQuery}
                  onInputChange={setSkQuery}
                  onSelect={v => { chooseVendor(v); focusScan() }}
                  onClear={() => chooseVendor(null)}
                  results={skResults}
                  loading={false}
                  getKey={v => v.id}
                  renderOption={(v, active) => (
                    <div className="flex items-center justify-between gap-4">
                      <span className={`font-medium ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{v.name}</span>
                      <span className={`text-xs font-mono ${active ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>{v.code ?? v.address ?? ''}</span>
                    </div>
                  )}
                />
              ) : (
                <div className="flex h-12 items-center gap-2.5 rounded-xl border border-border bg-muted/40 px-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-sm font-bold text-primary" data-no-translate>{selectedVendor.name[0].toUpperCase()}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-foreground" data-no-translate>{selectedVendor.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">{[selectedVendor.code, selectedVendor.phone].filter(Boolean).join(' · ') || selectedVendor.address || ''}</span>
                  </span>
                  <button type="button" onClick={() => chooseVendor(null)} className="shrink-0 rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-semibold hover:bg-muted">Change</button>
                </div>
              )}
            </div>

            {directBill && !walkIn && credit && (credit.blocked || credit.balancePaise !== 0) && (
              <div className="min-w-0 basis-full"><CreditNote compact info={credit} allow={allowHeld} onAllow={setAllowHeld} /></div>
            )}

            {directBill && !forOrder && (
              <button type="button" aria-pressed={walkIn} onClick={() => toggleWalkIn(!walkIn)}
                title="Walk-in customer: name only, without GST, pays now"
                className={`h-12 shrink-0 rounded-xl border px-3 text-sm font-semibold ${walkIn ? 'border-amber-500 bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'border-border hover:bg-muted'}`}>
                {walkIn ? '✓ Walk-in' : 'Walk-in'}
              </button>
            )}

            {directBill && (
              <div className="min-w-0 flex-[0_1_200px]">
                <label htmlFor="picked-by" className="sr-only">Picked by</label>
                <select id="picked-by" value={pickedBy} onChange={e => { setPickedBy(e.target.value); focusScan() }} required
                  className={`h-12 w-full rounded-xl border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${pickedBy ? 'border-border' : 'border-amber-400 text-muted-foreground'}`}>
                  <option value="">Picked by — choose</option>
                  {pickers.map(p => <option key={p.id} value={p.id}>{`Picked by ${p.name ?? p.id}`}</option>)}
                </select>
              </div>
            )}

            <form onSubmit={e => { e.preventDefault(); submitScan() }} className="min-w-0 flex-[2_1_300px]">
              <label htmlFor="scan-box" className="sr-only">Scan box</label>
              <div className={`flex h-12 items-center gap-2.5 rounded-xl border-2 bg-background px-3 transition-colors ${scanFocused ? 'border-primary' : 'border-border'}`}>
                <button type="button" onClick={() => scanInputRef.current?.focus()} title={scanFocused ? 'Scanner ready' : 'Click to scan'}
                  aria-label={scanFocused ? 'Scanner ready' : 'Click here to scan'}
                  className={`h-2.5 w-2.5 shrink-0 rounded-full ${scanFocused ? 'bg-emerald-500 shadow-[0_0_0_4px_rgb(16_185_129/0.2)]' : 'bg-amber-500'}`} />
                <input
                  ref={scanInputRef}
                  id="scan-box"
                  value={scanValue}
                  onChange={e => setScanValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Tab' && scanValue.trim()) { e.preventDefault(); submitScan() } }}
                  onFocus={() => setScanFocused(true)}
                  onBlur={() => setScanFocused(false)}
                  autoComplete="off" autoCorrect="off" autoCapitalize="characters" spellCheck={false} enterKeyHint="done"
                  placeholder={scanFocused ? 'Scanner ready — scan a box, or type the code + Enter' : 'Click here, then scan a box'}
                  className="h-full min-w-0 flex-1 bg-transparent font-mono text-sm focus:outline-none"
                />
              </div>
            </form>

            <div className="flex flex-wrap gap-2">
              <button type="button" onClick={isCameraActive ? stopCamera : startCamera}
                className={`flex h-12 items-center gap-2 rounded-xl px-3.5 text-sm font-semibold ${isCameraActive ? 'border border-border hover:bg-muted' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="h-[18px] w-[18px]" aria-hidden><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
                {isCameraActive ? 'Stop camera' : 'Camera'}
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
              <button type="button" disabled={uploadProcessing || isCameraActive} onClick={() => fileInputRef.current?.click()}
                className="h-12 rounded-xl border border-border px-3.5 text-sm font-semibold hover:bg-muted disabled:opacity-50">
                {uploadProcessing ? 'Reading…' : 'QR photo'}
              </button>
              <button type="button" onClick={() => setHandOpen(true)}
                className="h-12 rounded-xl border border-dashed border-border px-3.5 text-sm font-semibold hover:bg-muted">
                + By hand
              </button>
              {isCameraActive && (
                <button type="button" onClick={toggleFlashlight} aria-pressed={isFlashlightOn}
                  className={`h-12 rounded-xl border px-3.5 text-sm font-medium ${isFlashlightOn ? 'border-yellow-400 bg-yellow-400/15 text-yellow-700 dark:text-yellow-200' : 'border-border hover:bg-muted'}`}>
                  {isFlashlightOn ? 'Light on' : 'Light'}
                </button>
              )}
            </div>
          </div>

          {lastResult && (
            <div className={`mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border px-3 py-2 ${TONE[lastResult.tone]}`} role="status" aria-live="polite">
              <p className="min-w-0 flex-1 text-sm font-semibold">{lastResult.text}</p>
              {canUndo && (
                <button type="button" onClick={undoLastScan} disabled={pendingScans > 0} className="text-xs font-semibold underline disabled:opacity-50">Undo last scan</button>
              )}
            </div>
          )}

          <div className={`relative mt-2 overflow-hidden rounded-xl bg-black aspect-[4/3] sm:aspect-video lg:max-w-xl ${isCameraActive ? '' : 'hidden'}`}>
            <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
            <canvas ref={canvasRef} className="hidden" />
            {isCameraActive && <div className={`pointer-events-none absolute inset-0 rounded-xl border-4 ${qrDetected ? 'border-green-400 animate-pulse' : 'border-white/20'}`} />}
          </div>
        </section>

        {forOrder && orderError && (
          <p role="alert" className="rounded-xl border border-red-300 bg-red-50 px-3 py-2.5 text-sm font-medium text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-200">{orderError}</p>
        )}

        {/* ⚡ Order: what was ordered against what is scanned (owner, 27 Nov 2026). */}
        {order && receipt && (
          <details open className="group rounded-2xl border border-border bg-card">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              <h2 className="text-base font-bold">Ordered vs scanned</h2>
              <span className="text-sm tabular-nums text-muted-foreground">{`${receivedPairs} of ${orderedPairs} pairs`}</span>
              {extraBoxes > 0 && <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">{`+${extraBoxes} not on the order`}</span>}
              <span className="flex-1" />
              <span className="text-xs text-muted-foreground group-open:hidden">Show</span>
              <span className="hidden text-xs text-muted-foreground group-open:inline">Hide</span>
              <span className="basis-full">
                <span className="block h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                  <span className={`block h-full rounded-full ${receivedPairs >= orderedPairs ? 'bg-emerald-500' : 'bg-primary'}`}
                    style={{ width: `${orderedPairs ? Math.min(100, Math.round((receivedPairs / orderedPairs) * 100)) : 0}%` }} />
                </span>
              </span>
            </summary>
            <div className="max-h-64 overflow-y-auto border-t border-border">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-4 py-1.5 text-left font-medium">Article</th>
                    <th className="px-2 py-1.5 text-left font-medium">Colour</th>
                    <th className="px-2 py-1.5 text-left font-medium">Size</th>
                    <th className="px-4 py-1.5 text-right font-medium">Scanned</th>
                  </tr>
                </thead>
                <tbody>
                  {order.items.map(i => {
                    const got = receipt.received.get(i.id) ?? 0
                    const tone = got >= i.quantityOrdered ? 'text-emerald-600 dark:text-emerald-400' : got > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'
                    return (
                      <tr key={i.id} className="border-t border-border/50">
                        <td className="px-4 py-1.5 font-semibold" data-no-translate>{i.artNumber}</td>
                        <td className="px-2 py-1.5 text-xs uppercase text-muted-foreground" data-no-translate>{i.colorNumber ?? '—'}</td>
                        <td className="px-2 py-1.5 tabular-nums">{i.sizeNumber ?? '—'}</td>
                        <td className={`px-4 py-1.5 text-right font-bold tabular-nums ${tone}`}>{`${got} / ${i.quantityOrdered}`}</td>
                      </tr>
                    )
                  })}
                  {receipt.extra.map(e => (
                    <tr key={e.label} className="border-t border-border/50 bg-amber-500/5">
                      <td colSpan={3} className="px-4 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400" data-no-translate>{`${e.label} — not on the order`}</td>
                      <td className="px-4 py-1.5 text-right font-bold tabular-nums text-amber-700 dark:text-amber-400">{`+${e.qty}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}

        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start">
          {/* ════════ The bill ════════ */}
          <section aria-labelledby="bill-heading" className="min-w-0 rounded-2xl border border-border bg-card">
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <h2 id="bill-heading" className="text-base font-bold">Bill</h2>
              <span className="text-xs text-muted-foreground">{`${billLines.length} line(s) · ${totalQty} box(es)`}</span>
              <span className="flex-1" />
              {directBill && draftId != null && (
                <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${pendingScans > 0 ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300' : 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'}`}>
                  {pendingScans > 0 ? `Draft #${draftId} · saving…` : `Draft #${draftId} · saved`}
                </span>
              )}
              {directBill && !forOrder && (
                <button type="button" onClick={() => setDraftsOpen(true)} className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted">
                  Drafts{otherDrafts.length > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary">{otherDrafts.length}</span>}
                </button>
              )}
            </div>

            {billLines.length === 0 ? (
              <div className="px-4 py-14 text-center">
                <p className="text-sm font-medium text-foreground">No boxes yet</p>
                <p className="mt-1 text-xs text-muted-foreground">{selectedVendor ? 'Scan a box — it appears here at once.' : 'Choose the retailer, then scan boxes.'}</p>
              </div>
            ) : (
              <div className="max-h-[55vh] overflow-y-auto lg:max-h-[calc(100dvh-300px)]">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 z-10 bg-card">
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="w-8 px-3 py-2 text-left font-medium">#</th>
                      <th className="px-2 py-2 text-left font-medium">Article</th>
                      <th className="px-2 py-2 text-right font-medium">MRP</th>
                      <th className="px-2 py-2 text-center font-medium">Boxes</th>
                      <th className="px-2 py-2 text-right font-medium">Rate</th>
                      <th className="whitespace-nowrap px-2 py-2 text-right font-medium">Amount</th>
                      <th className="w-8 px-2 py-2"><span className="sr-only">Remove</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentLines.map((line, n) => {
                      const rate = ratePaise(line.mrp, LINE_DISC_PCT) / 100
                      const isLast = lastAdded?.key === line.key
                      return (
                        <tr key={line.key} className={`border-b border-border/50 ${isLast ? 'bg-primary/10' : ''}`}>
                          <td className="px-3 py-2.5 align-top text-xs text-muted-foreground tabular-nums">{recentLines.length - n}</td>
                          <td className="px-2 py-2.5 align-top">
                            <span className="whitespace-nowrap text-sm font-bold text-foreground" data-no-translate>{line.artNumber}</span>
                            {isLast && <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">just scanned</span>}
                            {line.notInStock > 0 && <span className="block whitespace-nowrap text-[11px] text-amber-700 dark:text-amber-400" title="Not scanned into stock: goes out as Unscanned dispatch">{`${line.notInStock} not in stock`}</span>}
                            {line.qty > line.boxCodes.length && <span className="block text-[11px] text-muted-foreground">{`${line.qty - line.boxCodes.length} added by hand`}</span>}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right text-muted-foreground tabular-nums">{line.mrp.toFixed(2)}</td>
                          <td className="px-2 py-2.5">
                            <div className="flex items-center justify-center gap-1.5">
                              <button type="button" onClick={() => decrementLine(line.key)} disabled={pendingScans > 0} aria-label={`One box less of ${line.artNumber}`}
                                className="flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-40">−</button>
                              <span className="w-7 text-center text-base font-bold tabular-nums">{line.qty}</span>
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{rate.toFixed(2)}</td>
                          <td className="whitespace-nowrap px-2 py-2.5 text-right font-semibold tabular-nums">₹{(rate * line.qty).toFixed(2)}</td>
                          <td className="px-2 py-2.5 text-right">
                            <button type="button" onClick={() => setDeleteTarget(line.key)} aria-label={`Remove ${line.artNumber}`} className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-destructive">✕</button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ════════ Totals ════════ */}
          <aside aria-label="Totals" className="rounded-2xl border border-border bg-card p-4 lg:sticky lg:top-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-base font-bold">Total</h2>
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                Disc %
                <input type="number" min="0" max="100" step="0.5" value={lineDiscPct}
                  onChange={e => setLineDiscPct(e.target.value === '' ? '' : Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                  onBlur={() => { if (lineDiscPct === '') setLineDiscPct(30) }}
                  className="h-8 w-16 rounded-lg border border-input bg-background px-1.5 text-center text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring" />
              </label>
            </div>
            {directBill && (walkIn ? (
              <div className="mb-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-2.5 dark:border-amber-800 dark:bg-amber-950/30">
                <p className="text-xs font-semibold text-amber-900 dark:text-amber-200">Walk-in · without GST · paid now</p>
                <div className="flex items-center gap-2">
                  <div role="radiogroup" aria-label="Paid by" className="flex flex-1 gap-1">
                    {(['cash', 'upi'] as const).map(m => (
                      <button key={m} type="button" role="radio" aria-checked={walkPaid === m} onClick={() => setWalkPaid(m)}
                        className={`h-8 flex-1 rounded-lg border text-xs font-semibold ${walkPaid === m ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background hover:bg-muted'}`}>
                        {m === 'cash' ? 'Cash' : 'UPI'}
                      </button>
                    ))}
                  </div>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    Bill disc %
                    <input type="number" min="0" max="100" step="0.5" value={walkDisc} onChange={e => setWalkDisc(e.target.value)}
                      className={`h-8 w-14 rounded-lg border bg-background px-1 text-center text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring ${walkDiscOk ? 'border-input' : 'border-red-500'}`} />
                  </label>
                </div>
              </div>
            ) : (
              <div className="mb-3">
                <BillTypeChoice value={taxType} onChange={setTaxType} partyDefault={selectedVendor?.taxType ?? null} />
                <div className="mt-2">
                  <BillRatesFields taxType={taxType} defaults={rateDefaults} edits={rateEdits} onChange={setRateEdits} />
                </div>
              </div>
            ))}
            <div className="space-y-1.5 text-sm tabular-nums">
              {totalRows.map(r => (
                <div key={r.key} className="flex justify-between text-muted-foreground">
                  <span>{r.label}</span>
                  <span className={r.tone === 'minus' ? 'text-red-600 dark:text-red-400' : 'text-foreground'}>{r.value}</span>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-baseline justify-between rounded-xl border-2 border-foreground/80 px-3 py-2.5">
              <span className="text-sm font-bold">Net payable</span>
              <span className="font-display text-2xl font-bold tabular-nums">{formatRs(amounts.grandTotalPaise)}</span>
            </div>
            <div className="mt-3 hidden lg:block">
              {generateHint && <p className="mb-2 text-xs text-amber-700 dark:text-amber-400">{generateHint}</p>}
              <button type="button" onClick={() => { void handlePrint().then(focusScan) }} disabled={!canGenerate}
                className="h-12 w-full rounded-xl bg-primary px-4 text-sm font-bold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {isSaving ? 'Generating…' : forOrder ? 'Bill this order' : onBillGenerated ? 'Generate bill → Receipts' : 'Generate & print bill'}
              </button>
            </div>
            {billLines.length > 0 && (
              <button type="button" onClick={() => setDeleteTarget('__all__')} className="mt-2 w-full rounded-lg px-3 py-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-destructive">
                {directBill ? 'Clear the bill (discard draft)' : 'Clear all'}
              </button>
            )}
          </aside>
        </div>

        {/* Phones: totals and Generate stay at the bottom, just above the app's bottom menu bar (4rem). */}
        {/* ⚡ Order: the screen covers the app (and its menu bar), so the bar sits at the very bottom. */}
        <div className={`fixed inset-x-0 z-30 border-t border-border bg-background/95 px-3 py-2 backdrop-blur md:bottom-0 lg:hidden ${forOrder ? 'bottom-0 pb-[max(0.5rem,env(safe-area-inset-bottom))]' : 'bottom-[calc(4rem+env(safe-area-inset-bottom))]'}`}>
          <div className="mx-auto flex max-w-3xl items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] text-muted-foreground">{`Net payable · ${totalQty} box(es)`}</p>
              <p className="font-display text-lg font-bold tabular-nums text-foreground">{formatRs(amounts.grandTotalPaise)}</p>
              {generateHint && <p className="truncate text-[11px] text-amber-700 dark:text-amber-400">{generateHint}</p>}
            </div>
            <button type="button" onClick={() => { void handlePrint() }} disabled={!canGenerate}
              className="h-12 shrink-0 rounded-xl bg-primary px-5 text-sm font-bold text-primary-foreground disabled:opacity-50">
              {isSaving ? 'Generating…' : forOrder ? 'Bill this order' : 'Generate bill'}
            </button>
          </div>
        </div>

        {/* ── Side panel: box without QR, added by hand ── */}
        {handOpen && (
          <SidePanel title="Add a box by hand" onClose={closeHand}>
            <p className="mb-4 text-sm text-muted-foreground">For a box whose QR is damaged or missing. It is billed as an unscanned box.</p>
            <form onSubmit={e => { handleManualAdd(e); closeHand() }} className="space-y-3">
              <div className="relative">
                <label htmlFor="b-art" className="text-sm font-medium">Article</label>
                <input id="b-art" type="text" autoComplete="off" value={artQuery} placeholder="Search article…" autoFocus
                  onChange={e => { setArtQuery(e.target.value); setManualArt(e.target.value.toUpperCase()); setArtSelected(false) }}
                  onFocus={() => setArtSelected(false)}
                  className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                {artQuery && !artSelected && artResults.length > 0 && (
                  <ul className="absolute left-0 right-0 top-full z-30 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border bg-popover shadow-xl">
                    {artResults.map(a => (
                      <li key={a} onMouseDown={e => { e.preventDefault(); setArtQuery(a); setManualArt(a.toUpperCase()); setArtSelected(true) }}
                        className="cursor-pointer px-3 py-2 font-mono text-sm hover:bg-muted">{a}</li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="text-sm font-medium">MRP (₹)
                  <input type="number" min="0" step="0.01" value={manualMrp} onChange={e => setManualMrp(e.target.value)} placeholder="0.00"
                    className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </label>
                <label className="text-sm font-medium">Boxes
                  <input type="number" min="1" value={manualQty} onChange={e => setManualQty(e.target.value === '' ? '' : parseInt(e.target.value) || 1)}
                    className="mt-1 h-11 w-full rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                </label>
              </div>
              <button type="submit" className="h-12 w-full rounded-xl bg-primary text-sm font-bold text-primary-foreground hover:bg-primary/90">Add to bill</button>
            </form>
          </SidePanel>
        )}

        {/* ── Side panel: saved drafts ── */}
        {draftsOpen && directBill && (
          <SidePanel title="Draft bills" onClose={closeDrafts}>
            <p className="mb-4 text-sm text-muted-foreground">Bills that were started and not generated. Every scan is saved as it happens.</p>
            {draftId != null && (
              <div className="mb-3 rounded-xl border-2 border-primary/60 px-3 py-2.5">
                <p className="text-sm font-semibold"><span data-no-translate>{selectedVendor?.name || 'No retailer yet'}</span> <span className="text-muted-foreground">· #{draftId}</span></p>
                <p className="text-xs text-muted-foreground">{`Open now · ${billLines.length} line(s) · ${totalQty} box(es)`}</p>
                {billLines.length > 0 && (
                  <button type="button" onClick={() => { resetLocal(); closeDrafts() }} disabled={pendingScans > 0}
                    className="mt-2 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold hover:bg-muted disabled:opacity-50">
                    Start a new bill (keep this as draft)
                  </button>
                )}
              </div>
            )}
            {otherDrafts.length === 0 && <p className="text-sm text-muted-foreground">No other saved drafts.</p>}
            {otherDrafts.length > 0 && (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {otherDrafts.map(d => (
                  <li key={d.id} className="flex items-center gap-2 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium"><span data-no-translate>{d.shopkeeperName || 'No retailer yet'}</span> <span className="text-muted-foreground">· #{d.id}</span></p>
                      <p className="text-[11px] text-muted-foreground">
                        {d.boxes} box{d.boxes === 1 ? '' : 'es'}{d.manualPairs ? ` + ${d.manualPairs} typed` : ''} · {d.billerName || '—'} · {new Date(d.updatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                    <button type="button" onClick={() => { setDraftsOpen(false); void resumeDraft(d.id).then(focusScan) }} className="rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground">Open</button>
                    <button type="button" onClick={() => discardDraftById(d.id)} className="rounded-lg border border-border px-2.5 py-1.5 text-xs text-destructive hover:bg-muted">Discard</button>
                  </li>
                ))}
              </ul>
            )}
          </SidePanel>
        )}

        {articleDialog && (
          <NewArticleDialog
            rawQr={articleDialog.rawQr}
            parsed={articleDialog.parsed}
            mode={articleDialog.mode}
            existingName={articleDialog.existingName}
            saveScan={false}
            closeLabel="Close (the box stays on the bill)"
            onClose={() => { closeArticleDialog(false); focusScan() }}
            onSaveLater={async () => { closeArticleDialog(false); focusScan(); return true }}
            onLinked={async () => { closeArticleDialog(true); focusScan() }}
          />
        )}

        {/* ── Confirm dialog ── */}
        {deleteTarget && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
            <DialogKeys onClose={() => { setDeleteTarget(null); focusScan() }} />
            <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-background p-6 shadow-xl">
              <h3 className="text-base font-semibold">{deleteTarget === '__all__' ? 'Clear all items?' : 'Remove this line?'}</h3>
              <p className="text-sm text-muted-foreground">
                {deleteTarget === '__all__'
                  ? directBill ? 'The draft is discarded and its boxes are freed. Nothing is billed.' : 'All scanned items will be removed from the bill.'
                  : 'All boxes of this line are removed from the bill.'}
              </p>
              <div className="flex gap-2 pt-1">
                <Button data-primary data-destructive variant="destructive" className="flex-1" onClick={() => { void (deleteTarget === '__all__' ? clearBill() : removeLine(deleteTarget)).then(focusScan) }}>
                  {deleteTarget === '__all__' ? 'Clear all' : 'Remove'}
                </Button>
                <Button data-autofocus variant="outline" className="flex-1" onClick={() => { setDeleteTarget(null); focusScan() }}>Cancel</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
