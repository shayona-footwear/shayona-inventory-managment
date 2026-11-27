'use client'

import { playAlreadyScanned, playScanOk } from '@/lib/scan-sound'
import { useState, useTransition, useRef, useCallback, useEffect } from 'react'
import jsQR from 'jsqr'
import { StatusPill, fmt, PageHeader, StatCard } from '../_components/shared'
import { getOrderWithItems, getBillLines, getBillsForPrint } from '@/app/actions/orders'
import { billOrder, cancelBill } from '@/app/actions/billing'
import { PageNav } from '@/components/page-nav'
import { parseQr, isValidWarehouseQr, normalizeQr } from '@/lib/qr-parser'
import { SCAN_INTERVAL_MS } from '@/components/scanner/constants'
import { articlesMatch } from '@/lib/billing-verification'
import { openPrintWindow, printInvoices, type MrpLine, type PageSize, type PrintConfig } from '@/lib/bill-html'
import { BillPreviewDialog } from '@/components/bill-preview-dialog'
import { BillMailDialog } from '@/components/bill-mail-dialog'
import { getBillTemplate } from '@/app/actions/bill-template'
import type { BillTemplate } from '@/lib/bill-template'
import { BillingScannerPage, type BillingVendor } from '@/components/billing-scanner-page'
import { useShortcut } from '@/lib/shortcuts'
import { useListKeys } from '@/lib/shortcuts/list'
import { tablistKeyDown, tabProps, useTabKeys } from '@/lib/shortcuts/tabs'
import { DialogKeys } from '@/components/dialog-keys'
import { EditBillDialog } from '@/components/billing/edit-bill-dialog'
import { BillDetailCard, PaidBadge } from '@/components/bill-detail-card'
import { BillTypeChoice } from '@/components/bill-type-choice'
import { DEFAULT_BILL_RATES, computeBillTotals, ratesBp, type TaxType } from '@/lib/billing/bill-totals'
import { BillRatesFields, resolveRates, type RateEdits } from '@/components/bill-rates-fields'
import { templateRates } from '@/lib/bill-template'
import { amountsFromLines, formatRs, type BillAmounts } from '@/lib/billing/bill-amounts'

// Two tabs (owner, 23 Nov 2026): Bills (orders to bill, incl. orders the admin sent straight to
// billing) and Receipts. A bill without an order opens from the Direct bill button in the corner
// (view 'emergency', kept mounted so its scans survive switching back and forth).
const BILLER_TABS: { value: BillerTab; label: string }[] = [
  { value: 'verify', label: 'Bills' }, { value: 'generated', label: 'Receipts' },
]

type BillerTab = 'verify' | 'emergency' | 'generated'

interface BillerOrder {
  id: number
  orderNumber: string
  /** Official bill number once billed (migration 0016). */
  billNo?: string | null
  shopkeeperName: string
  shopkeeperPhone: string | null
  shopkeeperAddress: string | null
  status: string
  packedAt: Date | null
  billedAt: Date | null
  billerId: string | null
  salesmanId: string | null
  /** Who picked it; none when nobody claimed it or was assigned (the biller names them when billing). */
  pickerId?: string | null
  isEmergency: boolean
  /** Pairs on the bill (billed orders; from the bill lines). */
  billedPairs?: number | null
  /** The retailer's bill type (the bill's default; getBillerQueue). */
  taxType?: TaxType | null
  /** Saved bill total and what is still unpaid on it (getBillerQueue; payments). */
  billTotalPaise?: number | null
  unpaidPaise?: number | null
}

interface Props {
  orders: BillerOrder[]
  currentBillerId?: string
  embedded?: boolean
  vendors?: BillingVendor[]
  articles?: string[]
  /** Direct bill: who picked the goods (pickers and admins). */
  pickers?: { id: string; name: string | null }[]
}

interface DetailItem {
  id: number
  artNumber: string
  colorNumber: string | null
  sizeNumber: string | null
  /** Exact article code when the order saved it (one name can cover several codes with the same sizes). */
  artCode?: string | null
  quantityOrdered: number
  quantityPacked: number
  status: string
}

// Per-item scan tally key: artNumber|sizeNumber|artCode (code empty on older orders)
function itemKey(artNumber: string, sizeNumber: string | null, artCode?: string | null) {
  return `${artNumber}|${sizeNumber ?? ''}|${(artCode ?? '').toUpperCase()}`
}

export function BillerDashboard({ orders: initialOrders, currentBillerId = '', embedded, vendors = [], articles = [], pickers = [] }: Props) {
  const [orders, setOrders] = useState(initialOrders)
  const [isPending, startTransition] = useTransition()
  const [activeId, setActiveId] = useState<number | null>(null)

  // ── Tab state ────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<BillerTab>('verify')
  // Keyboard (docs/architecture/keyboard.md): tabs Alt+1…3 (Alt+Shift inside the Orders hub), lists, Direct bill action.
  const rootRef = useRef<HTMLDivElement>(null)
  const verifyListRef = useRef<HTMLDivElement>(null)
  const receiptsListRef = useRef<HTMLDivElement>(null)
  const switchTab = (tab: string) => { setActiveTab(tab as BillerTab); setPrintSelectedIds(new Set()) }
  useTabKeys(BILLER_TABS, switchTab, { nested: embedded, within: rootRef, group: 'Biller tabs' })
  useShortcut([], () => switchTab('emergency'), { label: 'Direct bill', group: 'Biller', action: true, within: rootRef })
  useListKeys(verifyListRef, { label: 'Invoices list' })
  useListKeys(receiptsListRef, { label: 'Receipts list', tickable: true })
  // Shop / bank / QR details for printed bills (Master → Bill template). One query on open.
  const [billTemplate, setBillTemplate] = useState<BillTemplate | undefined>(undefined)
  // Receipts: the bill being previewed (click a bill; print from the preview — owner, 21 Nov 2026)
  const [previewOrder, setPreviewOrder] = useState<BillerOrder | null>(null)
  // Receipts → Mail: the bills being emailed (PDF from the shop's Gmail)
  const [mailOrderIds, setMailOrderIds] = useState<number[] | null>(null)
  useEffect(() => { getBillTemplate().then((t) => { setBillTemplate(t); setPrintConfig(c => ({ ...c, pageSize: t.defaultPageSize })) }).catch(() => {}) }, [])

  // ── Print Bills state ────────────────────────────────────────────────────────
  const [printSelectedIds, setPrintSelectedIds] = useState<Set<number>>(new Set())
  const [printItemsMap, setPrintItemsMap] = useState<Record<number, DetailItem[]>>({})
  const [printLoadingIds, setPrintLoadingIds] = useState<Set<number>>(new Set())
  // mrpLinesMap: orderId → MrpLine[] built from scannedQrs at save time
  const [mrpLinesMap, setMrpLinesMap] = useState<Record<number, MrpLine[]>>({})
  // Per-bill line discount % (configurable in scanner, used at print time)
  const [lineDiscPct, setLineDiscPct] = useState<number | ''>(30)
  // Print config modal
  const [printConfigOpen, setPrintConfigOpen] = useState(false)
  const [printConfig, setPrintConfig] = useState<PrintConfig>({ pageSize: 'A4', billType: 'city' })
  // Pending orders to print (set when modal opens, consumed on confirm)
  const [pendingPrintOrders, setPendingPrintOrders] = useState<typeof initialOrders>([])

  // Detail panel state
  const [detailOrder, setDetailOrder] = useState<BillerOrder | null>(null)
  const [editBillOrder, setEditBillOrder] = useState<BillerOrder | null>(null)
  const [detailItems, setDetailItems] = useState<DetailItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  // DB-fetched bill lines for detail panel (fallback when mrpLinesMap has no entry)
  // The billed order's lines and SAVED amounts (getBillsForPrint — the same numbers the printed bill shows).
  const [detailBill, setDetailBill] = useState<{ lines: MrpLine[]; lineDiscPct: number; amounts: BillAmounts; unpaidPaise: number | null } | null>(null)
  const [detailBillLinesLoading, setDetailBillLinesLoading] = useState(false)

  // ── Scanner modal ────────────────────────────────────────────────────────────
  const [scanOrder, setScanOrder] = useState<BillerOrder | null>(null)
  // A Direct bill sent by an admin (isEmergency): billed on the Direct Billing screen, as ⚡ on the
  // Orders list does (owner, 27 Nov 2026: the old scan window was the old version).
  const [directOrder, setDirectOrder] = useState<BillerOrder | null>(null)
  const openOrder = (o: BillerOrder) => (o.isEmergency ? setDirectOrder(o) : openScanner(o))
  // Bill type of the bill being made (owner, 23 Nov 2026): starts from the retailer, changeable here.
  const [billType, setBillType] = useState<TaxType>('intra_state')
  // Bill discount / GST typed on this bill (owner, 24 Nov 2026); empty = the Master defaults.
  const [rateEdits, setRateEdits] = useState<RateEdits>({})
  useEffect(() => { if (scanOrder) { setBillType(scanOrder.taxType ?? 'intra_state'); setRateEdits({}); setBillPicker('') } }, [scanOrder?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  // No picker on the order: the biller chooses who picked it before saving (owner, 27 Nov 2026).
  const [billPicker, setBillPicker] = useState('')
  const needsBillPicker = !!scanOrder && !scanOrder.pickerId
  const [scanItems, setScanItems] = useState<DetailItem[]>([])
  // scannedMap: itemKey → scanned count
  const [scannedMap, setScannedMap] = useState<Record<string, number>>({})
  const [scannedQrs, setScannedQrs] = useState<string[]>([])
  const [showDevTracking, setShowDevTracking] = useState(false)
  const [expandedArticle, setExpandedArticle] = useState<string | null>(null)
  const [scanMsg, setScanMsg] = useState<{ type: 'ok' | 'warn' | 'err'; text: string } | null>(null)
  const [lastScannedMsg, setLastScannedMsg] = useState<string | null>(null)
  const scanMsgTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── Manual verification entries: itemKey → { qty, mrp }[] ───────────────────
  // Accumulates manual overrides that fill the remaining gap after QR scans.
  const [manualEntries, setManualEntries] = useState<Record<string, { qty: number; mrp: number }[]>>({})

  // ── Undo history: stack of actions (QR scan, manual add, manual edit) ─────────
  type ScanAction =
    | { type: 'qr'; key: string; raw: string; label: string }
    | { type: 'manual_add'; key: string; entry: { qty: number; mrp: number }; label: string }
    | { type: 'manual_edit'; key: string; prevEntries: { qty: number; mrp: number }[]; prevKeyScannedQty: number; label: string }

  const [scanHistory, setScanHistory] = useState<ScanAction[]>([])

  // ── Manual verify modal state ────────────────────────────────────────────────
  interface ManualVerifyTarget {
    item: DetailItem
    artNumber: string
    color: string
    remaining: number      // slots still free (0 when editing an already-full row)
    isEdit?: boolean       // true = replacing existing manual entries
    editMaxQty?: number    // max qty allowed when editing (= totalPkd - scannedQrCount)
  }
  const [manualTarget, setManualTarget] = useState<ManualVerifyTarget | null>(null)
  const [manualQty,   setManualQty]   = useState<number | ''>(1)
  const [manualPrice, setManualPrice] = useState<number | ''>('')

  const videoRef            = useRef<HTMLVideoElement>(null)
  const canvasRef           = useRef<HTMLCanvasElement>(null)
  const scanCanvasRef       = useRef<HTMLCanvasElement | null>(null)
  const streamRef           = useRef<MediaStream | null>(null)
  const flashlightStreamRef = useRef<MediaStream | null>(null)
  const lastScanTimeRef     = useRef<number>(0)
  const scanningRef         = useRef(false)
  const scanPausedRef       = useRef(false)
  const fileInputRef        = useRef<HTMLInputElement>(null)

  // Scanner states refs to bypass Next.js/React stale closure issues inside startCamera/scanLoop callbacks
  const scanItemsRef        = useRef<DetailItem[]>([])
  const scannedMapRef       = useRef<Record<string, number>>({})
  const scannedQrsRef       = useRef<string[]>([])
  const showDevTrackingRef  = useRef<boolean>(false)

  // Synchronize refs with the latest state values across render cycles
  useEffect(() => { scanItemsRef.current = scanItems }, [scanItems])
  useEffect(() => { scannedMapRef.current = scannedMap }, [scannedMap])
  useEffect(() => { scannedQrsRef.current = scannedQrs }, [scannedQrs])
  useEffect(() => { showDevTrackingRef.current = showDevTracking }, [showDevTracking])

  const [isCameraActive, setIsCameraActive] = useState(false)
  const [isFlashlightOn, setIsFlashlightOn] = useState(false)
  const [qrDetected, setQrDetected]         = useState(false)
  const [uploadProcessing, setUploadProcessing] = useState(false)

  // cleanup on unmount
  useEffect(() => () => {
    scanningRef.current = false
    if (scanMsgTimer.current) clearTimeout(scanMsgTimer.current)
    streamRef.current?.getTracks().forEach(t => t.stop())
    flashlightStreamRef.current?.getTracks().forEach(t => t.stop())
  }, [])

  // ── LocalStorage State Restoration on Mount ──
  useEffect(() => {
    try {
      const savedDetailOrder = localStorage.getItem('biller_detailOrder')
      if (savedDetailOrder) {
        const parsed = JSON.parse(savedDetailOrder)
        setDetailOrder(parsed)
        setDetailLoading(true)
        getOrderWithItems(parsed.id).then(({ items }) => {
          setDetailItems(items as DetailItem[])
        }).catch(() => {}).finally(() => setDetailLoading(false))
      }

      const savedScanOrder = localStorage.getItem('biller_scanOrder')
      if (savedScanOrder) {
        const parsed = JSON.parse(savedScanOrder)
        setScanOrder(parsed)

        const savedScanItems = localStorage.getItem('biller_scanItems')
        if (savedScanItems) setScanItems(JSON.parse(savedScanItems))

        const savedScannedMap = localStorage.getItem('biller_scannedMap')
        if (savedScannedMap) setScannedMap(JSON.parse(savedScannedMap))

        const savedScannedQrs = localStorage.getItem('biller_scannedQrs')
        if (savedScannedQrs) setScannedQrs(JSON.parse(savedScannedQrs))

        const savedManualEntries = localStorage.getItem('biller_manualEntries')
        if (savedManualEntries) setManualEntries(JSON.parse(savedManualEntries))

        const savedScanHistory = localStorage.getItem('biller_scanHistory')
        if (savedScanHistory) setScanHistory(JSON.parse(savedScanHistory))

        const savedExpandedArticle = localStorage.getItem('biller_expandedArticle')
        if (savedExpandedArticle) setExpandedArticle(savedExpandedArticle)

        const savedShowDev = localStorage.getItem('biller_showDevTracking')
        if (savedShowDev) setShowDevTracking(savedShowDev === 'true')

        const savedLastScan = localStorage.getItem('biller_lastScannedMsg')
        if (savedLastScan) setLastScannedMsg(savedLastScan)
      }

      // Restore saved MRP lines map (built at save-bill time)
      const savedMrpLines = localStorage.getItem('biller_mrpLinesMap')
      if (savedMrpLines) setMrpLinesMap(JSON.parse(savedMrpLines))

      // Restore discount %
      const savedDisc = localStorage.getItem('biller_lineDiscPct')
      if (savedDisc) setLineDiscPct(parseFloat(savedDisc))
    } catch (e) {
      console.error('Failed to restore biller local storage state', e)
    }
  }, [])

  // ── LocalStorage State Syncing on Change ──
  useEffect(() => {
    if (detailOrder) {
      localStorage.setItem('biller_detailOrder', JSON.stringify(detailOrder))
    } else {
      localStorage.removeItem('biller_detailOrder')
    }
  }, [detailOrder])

  useEffect(() => {
    if (scanOrder) {
      localStorage.setItem('biller_scanOrder', JSON.stringify(scanOrder))
      localStorage.setItem('biller_scanItems', JSON.stringify(scanItems))
      localStorage.setItem('biller_scannedMap', JSON.stringify(scannedMap))
      localStorage.setItem('biller_scannedQrs', JSON.stringify(scannedQrs))
      localStorage.setItem('biller_manualEntries', JSON.stringify(manualEntries))
      localStorage.setItem('biller_scanHistory', JSON.stringify(scanHistory))
      if (expandedArticle) {
        localStorage.setItem('biller_expandedArticle', expandedArticle)
      } else {
        localStorage.removeItem('biller_expandedArticle')
      }
      localStorage.setItem('biller_showDevTracking', String(showDevTracking))
      if (lastScannedMsg) {
        localStorage.setItem('biller_lastScannedMsg', lastScannedMsg)
      } else {
        localStorage.removeItem('biller_lastScannedMsg')
      }
    } else {
      localStorage.removeItem('biller_scanOrder')
      localStorage.removeItem('biller_scanItems')
      localStorage.removeItem('biller_scannedMap')
      localStorage.removeItem('biller_scannedQrs')
      localStorage.removeItem('biller_manualEntries')
      localStorage.removeItem('biller_scanHistory')
      localStorage.removeItem('biller_expandedArticle')
      localStorage.removeItem('biller_showDevTracking')
      localStorage.removeItem('biller_lastScannedMsg')
    }
  }, [scanOrder, scanItems, scannedMap, scannedQrs, manualEntries, scanHistory, expandedArticle, showDevTracking, lastScannedMsg])

  useEffect(() => {
    localStorage.setItem('biller_mrpLinesMap', JSON.stringify(mrpLinesMap))
  }, [mrpLinesMap])

  useEffect(() => {
    localStorage.setItem('biller_lineDiscPct', String(lineDiscPct === '' ? 30 : lineDiscPct))
  }, [lineDiscPct])

  // ── banner helpers ───────────────────────────────────────────────────────────
  function showMsg(type: 'ok' | 'warn' | 'err', text: string) {
    if (scanMsgTimer.current) clearTimeout(scanMsgTimer.current)
    setScanMsg({ type, text })
    scanMsgTimer.current = setTimeout(() => setScanMsg(null), 3000)
  }

  // ── Direct bill from an order: extra boxes (not ordered / more than ordered) are billed too ──
  const scanDirect = !!scanOrder?.isEmergency
  const scanDirectRef = useRef(false)
  useEffect(() => { scanDirectRef.current = scanDirect }, [scanDirect])
  function addExtraScan(raw: string, art: string, size: string, why: string) {
    setScannedQrs(prev => [...prev, raw])
    // key "extra:…": Undo removes the box without touching the per-line counts.
    setScanHistory(prev => [...prev, { type: 'qr', key: `extra:${art}|${size}`, raw, label: `${art} / SZ(${size}) — extra` }])
    playScanOk()
    showMsg('warn', `${art} Sz ${size} — ${why}; billed as an extra`)
  }

  /** Order vs scanned for a Direct bill: pairs received per order line, short lines, extra boxes. */
  function directDiff() {
    const groups = new Map<string, DetailItem[]>()
    for (const i of scanItems) { const k = itemKey(i.artNumber, i.sizeNumber, i.artCode); groups.set(k, [...(groups.get(k) ?? []), i]) }
    const packed: { itemId: number; qty: number }[] = []
    const short: { label: string; ordered: number; got: number }[] = []
    for (const [k, items] of groups) {
      let left = scannedMap[k] ?? 0
      const ordered = items.reduce((t, i) => t + i.quantityOrdered, 0)
      const got = Math.min(left, ordered)
      for (const i of items) { const q = Math.min(left, i.quantityOrdered); left -= q; packed.push({ itemId: i.id, qty: q }) }
      if (got < ordered) short.push({ label: `${items[0].artNumber} size ${items[0].sizeNumber ?? '—'}`, ordered, got })
    }
    const extraMap = new Map<string, number>()
    for (const a of scanHistory) {
      if (a.type !== 'qr' || !a.key.startsWith('extra:')) continue
      const label = a.key.slice(6).replace('|', ' size ')
      extraMap.set(label, (extraMap.get(label) ?? 0) + 1)
    }
    return { packed, short, extra: [...extraMap].map(([label, qty]) => ({ label, qty })) }
  }
  const [directDiffShown, setDirectDiffShown] = useState<ReturnType<typeof directDiff> | null>(null)
  /** Save a Direct bill: when it differs from the order, ask first (keep the changes or adjust). */
  function handleDirectSave() {
    const d = directDiff()
    if (d.short.length || d.extra.length) setDirectDiffShown(d)
    else handleSaveBill()
  }

  // ── handle a decoded QR string ───────────────────────────────────────────────
  function handleQrDecode(raw: string) {
    const devSuffix = showDevTrackingRef.current ? ` (${raw})` : ''
    
    if (!isValidWarehouseQr(raw)) {
      showMsg('warn', 'Unrecognised QR code format' + devSuffix)
      return
    }
    const parsed = parseQr(raw)
    const art    = parsed.articleCode.toUpperCase()
    const size   = String(parsed.size).toUpperCase()

    // TODO: Add color code validation once color codes are stored on order items.
    // Currently colorNumber on DetailItem is not reliably populated, so we only
    // validate article + size. The fix below ensures that when multiple items share
    // the same article + size (e.g. one in-stock and one OOS variant), we always
    // prefer the item that still has scan capacity rather than blindly taking the
    // first match (which could be the OOS variant, causing false "not in order" alerts).

    // Collect all candidates matching article + size
    const candidates = scanItemsRef.current.filter(i => {
      const iArt  = i.artNumber.toUpperCase()
      const iSize = (i.sizeNumber ?? '').toUpperCase()
      // A line with a saved article code must match the box's code exactly (SS0101C 11 ≠ SS0101S 11).
      const sameArticle = i.artCode ? i.artCode.toUpperCase().replace(/[^A-Z0-9]/g, '') === art.replace(/[^A-Z0-9]/g, '') : articlesMatch(iArt, art)
      return sameArticle && iSize === size
    })

    if (candidates.length === 0) {
      if (scanDirectRef.current) {
        if (scannedQrsRef.current.some(q => normalizeQr(q) === parsed.normalized)) { showMsg('warn', `${art} Sz ${size} — Duplicate QR, already scanned` + devSuffix); playAlreadyScanned(); return }
        addExtraScan(raw, art, size, 'not in this order')
        return
      }
      showMsg('warn', `${art} Sz ${size} — Not in this order` + devSuffix)
      return
    }

    // Duplicate QR check — compare full normalized QR string to avoid false
    // positives from boxes that share a common last segment suffix.
    // Normalised payload: a URL-wrapped phone scan and a plain scan of one box are the same box.
    const normalizedRaw = parsed.normalized
    const alreadyScanned = scannedQrsRef.current.some(
      q => normalizeQr(q) === normalizedRaw
    )
    if (alreadyScanned) {
      showMsg('warn', `${art} Sz ${size} — Duplicate QR, already scanned` + devSuffix)
      playAlreadyScanned()
      return
    }

    // TODO: Add color code validation once color codes are stored on order items.
    // When colorNumber is reliably populated, narrow candidates by color here so
    // each color slot is verified independently.

    // Without color validation, all same-article+size candidates share the same
    // itemKey (artNumber|sizeNumber), so scannedMap[key] is already a pooled
    // counter for all of them. Compute total packed capacity across the pool so
    // that e.g. FL02 RED sz:7 (packed=1) + FL02 GREY sz:7 (packed=1) allows 2
    // scans total — color is irrelevant until color validation is added.
    const sharedKey  = itemKey(candidates[0].artNumber, candidates[0].sizeNumber, candidates[0].artCode)
    const current    = scannedMapRef.current[sharedKey] ?? 0
    const totalCap   = candidates.reduce((sum, i) => sum + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)

    if (current >= totalCap && scanDirectRef.current) { addExtraScan(raw, art, size, `more than ordered (${totalCap})`); return }
    if (current >= totalCap) {
      showMsg('warn', `${art} Size : ${size} — Already fully scanned (${totalCap} pkd)` + devSuffix)
      return
    }

    const key    = sharedKey
    const packed = totalCap

    const extArt   = parsed.articleCode.toUpperCase()
    const extColor = parsed.colorCode.toUpperCase()
    const extSize  = String(parsed.size).toUpperCase()
    const successText = `${extArt} / ${extColor} / SZ(${extSize}) — ${current + 1}/${packed}`
    setScannedMap(prev => ({ ...prev, [key]: current + 1 }))
    setScannedQrs(prev => [...prev, raw])
    setScanHistory(prev => [
      ...prev,
      { type: 'qr', key, raw, label: `${extArt} / SZ(${extSize})` }
    ])
    setLastScannedMsg(successText)
    playScanOk()
    showMsg('ok', successText + devSuffix)
  }

  // ── camera ───────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      setScanMsg(null)
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
      showMsg('err', 'Camera permission denied or unavailable.')
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function stopCamera() {
    scanningRef.current = false
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setIsCameraActive(false)
    setQrDetected(false)
  }

  function scanLoop(video: HTMLVideoElement) {
    if (!scanningRef.current) return
    if (video.videoWidth === 0 || video.videoHeight === 0) { requestAnimationFrame(() => scanLoop(video)); return }
    if (scanPausedRef.current) { requestAnimationFrame(() => scanLoop(video)); return }

    const now = performance.now()
    if (now - lastScanTimeRef.current < SCAN_INTERVAL_MS) { requestAnimationFrame(() => scanLoop(video)); return }
    lastScanTimeRef.current = now

    let sc = scanCanvasRef.current
    // Use 1080px max dimension instead of 480px to retain 4x more detail for small/dense QR barcodes
    const scale = Math.min(1, 1080 / Math.max(video.videoWidth, video.videoHeight))
    const sw = Math.round(video.videoWidth * scale)
    const sh = Math.round(video.videoHeight * scale)
    if (!sc || sc.width !== sw || sc.height !== sh) {
      sc = document.createElement('canvas'); sc.width = sw; sc.height = sh
      scanCanvasRef.current = sc
    }
    const sctx = sc.getContext('2d', { willReadFrequently: true })
    if (!sctx) { requestAnimationFrame(() => scanLoop(video)); return }

    sctx.drawImage(video, 0, 0, sw, sh)
    try {
      const imageData = sctx.getImageData(0, 0, sw, sh)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (code) {
        scanPausedRef.current = true; setQrDetected(true)
        setTimeout(() => { scanPausedRef.current = false; setQrDetected(false) }, 1800)
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
        flashlightStreamRef.current?.getTracks().forEach(t => t.stop())
        flashlightStreamRef.current = null
        showMsg('warn', 'Flashlight not supported on this device.')
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
    if (!allowed.includes(file.type)) { showMsg('err', 'Invalid image file type.'); if (fileInputRef.current) fileInputRef.current.value = ''; return }
    setUploadProcessing(true)
    try {
      const bitmap = await createImageBitmap(file)
      const cv = document.createElement('canvas'); cv.width = bitmap.width; cv.height = bitmap.height
      const ctx2 = cv.getContext('2d')!; ctx2.drawImage(bitmap, 0, 0); bitmap.close()
      const imageData = ctx2.getImageData(0, 0, cv.width, cv.height)
      const code = jsQR(imageData.data, imageData.width, imageData.height)
      if (!code) { showMsg('err', 'No QR code found in image.'); return }
      handleQrDecode(code.data)
    } catch { showMsg('err', 'Could not process image.') }
    finally { setUploadProcessing(false); if (fileInputRef.current) fileInputRef.current.value = '' }
  }

  // ── open scanner modal ───────────────────────────────────────────────────────
  async function openScanner(order: BillerOrder) {
    // close detail panel if open
    setDetailOrder(null)

    const isSameOrder = scanOrder?.id === order.id

    setScanOrder(order)
    // Only reset verification state when opening a DIFFERENT order
    if (!isSameOrder) {
      setScannedMap({})
      setScannedQrs([])
      setManualEntries({})
      setScanHistory([])
      setShowDevTracking(false)
      setExpandedArticle(null)
      setScanMsg(null)
      setLastScannedMsg(null)
    }

    // load items if not already loaded for this order
    if (!isSameOrder || scanItems.length === 0) {
      try {
        const data = await getOrderWithItems(order.id)
        const items = data.items as DetailItem[]
        // Direct bill from an order (no picker): scans count against the ORDERED pairs.
        setScanItems(order.isEmergency ? items.map(i => ({ ...i, quantityPacked: i.quantityOrdered, status: 'packed' })) : items)
      } catch {
        setScanItems([])
      }
    }
  }

  function closeScanner() {
    stopCamera()
    setScanOrder(null)
    setScanItems([])
    setScannedMap({})
    setScannedQrs([])
    setManualEntries({})
    setScanHistory([])
    setShowDevTracking(false)
    setExpandedArticle(null)
    setScanMsg(null)
    setLastScannedMsg(null)
  }

  // ── manual verify confirm ────────────────────────────────────────────────────
  function handleManualConfirm() {
    if (!manualTarget) return
    const qty   = typeof manualQty   === 'number' && manualQty   > 0 ? manualQty   : 0
    const price = typeof manualPrice === 'number' && manualPrice > 0 ? manualPrice : 0
    if (qty <= 0 || price <= 0) return

    const key = itemKey(manualTarget.item.artNumber, manualTarget.item.sizeNumber, manualTarget.item.artCode)

    if (manualTarget.isEdit) {
      // Edit mode: replace all existing manual entries for this key with new single entry.
      // Max allowed = totalPkd - QR-scanned count (scanned by camera, not manual)
      const maxQty = manualTarget.editMaxQty ?? manualTarget.remaining
      const clamped = Math.min(qty, maxQty)
      if (clamped <= 0) return

      // Previous total manual qty for this key (to adjust scannedMap delta)
      const prevEntries = manualEntries[key] ?? []
      const prevManualQty = prevEntries.reduce((s, e) => s + e.qty, 0)
      const prevKeyScannedQty = scannedMap[key] ?? 0

      setManualEntries(prev => ({ ...prev, [key]: [{ qty: clamped, mrp: price }] }))

      // Adjust scannedMap: remove old manual contribution, add new
      setScannedMap(prev => ({
        ...prev,
        [key]: Math.max(0, (prev[key] ?? 0) - prevManualQty + clamped),
      }))

      setScanHistory(prev => [
        ...prev,
        {
          type: 'manual_edit',
          key,
          prevEntries,
          prevKeyScannedQty,
          label: `${manualTarget.artNumber} / SZ(${manualTarget.item.sizeNumber ?? '?'}) (edit)`
        }
      ])

      const msg = `${manualTarget.artNumber} / MANUAL / SZ(${manualTarget.item.sizeNumber ?? '?'}) — updated to ${clamped}`
      setLastScannedMsg(msg)
      showMsg('ok', msg)
    } else {
      // Add mode: clamp to remaining capacity
      const clamped = Math.min(qty, manualTarget.remaining)
      if (clamped <= 0) return

      setManualEntries(prev => {
        const existing = prev[key] ?? []
        return { ...prev, [key]: [...existing, { qty: clamped, mrp: price }] }
      })

      setScannedMap(prev => ({ ...prev, [key]: (prev[key] ?? 0) + clamped }))

      setScanHistory(prev => [
        ...prev,
        {
          type: 'manual_add',
          key,
          entry: { qty: clamped, mrp: price },
          label: `${manualTarget.artNumber} / SZ(${manualTarget.item.sizeNumber ?? '?'}) (+${clamped})`
        }
      ])

      const msg = `${manualTarget.artNumber} / MANUAL / SZ(${manualTarget.item.sizeNumber ?? '?'}) — ${clamped} verified`
      setLastScannedMsg(msg)
      showMsg('ok', msg)
    }

    setManualTarget(null)
  }

  // ── undo last operation ──────────────────────────────────────────────────────
  function handleUndo() {
    if (scanHistory.length === 0) return

    const lastAction = scanHistory[scanHistory.length - 1]
    setScanHistory(prev => prev.slice(0, -1))

    if (lastAction.type === 'qr') {
      // Revert QR scan
      setScannedMap(prev => {
        const next = { ...prev }
        const current = next[lastAction.key] ?? 0
        if (current <= 1) {
          delete next[lastAction.key]
        } else {
          next[lastAction.key] = current - 1
        }
        return next
      })

      // Remove the exact scanned QR (remove the last occurrence)
      setScannedQrs(prev => {
        const idx = prev.lastIndexOf(lastAction.raw)
        if (idx !== -1) {
          const next = [...prev]
          next.splice(idx, 1)
          return next
        }
        return prev.slice(0, -1)
      })

      showMsg('warn', `Undid QR scan: ${lastAction.label}`)
      setLastScannedMsg(`Undid: ${lastAction.label}`)
    } else if (lastAction.type === 'manual_add') {
      // Revert manual add: remove the added entry & deduct qty from scannedMap
      const { key, entry, label } = lastAction
      setManualEntries(prev => {
        const list = prev[key] ?? []
        // Find and remove the matching entry from the end of the list
        const idx = list.map(e => `${e.qty}_${e.mrp}`).lastIndexOf(`${entry.qty}_${entry.mrp}`)
        const nextList = idx !== -1 ? list.filter((_, i) => i !== idx) : list.slice(0, -1)
        const next = { ...prev }
        if (nextList.length === 0) {
          delete next[key]
        } else {
          next[key] = nextList
        }
        return next
      })

      setScannedMap(prev => {
        const next = { ...prev }
        const current = next[key] ?? 0
        const rem = current - entry.qty
        if (rem <= 0) {
          delete next[key]
        } else {
          next[key] = rem
        }
        return next
      })

      showMsg('warn', `Undid manual entry: ${label}`)
      setLastScannedMsg(`Undid: ${label}`)
    } else if (lastAction.type === 'manual_edit') {
      // Revert manual edit: restore previous manualEntries and previous scannedMap count
      const { key, prevEntries, prevKeyScannedQty, label } = lastAction
      setManualEntries(prev => {
        const next = { ...prev }
        if (prevEntries.length === 0) {
          delete next[key]
        } else {
          next[key] = prevEntries
        }
        return next
      })

      setScannedMap(prev => {
        const next = { ...prev }
        if (prevKeyScannedQty <= 0) {
          delete next[key]
        } else {
          next[key] = prevKeyScannedQty
        }
        return next
      })

      showMsg('warn', `Undid manual edit: ${label}`)
      setLastScannedMsg(`Undid: ${label}`)
    }
  }

  /** The bill lines the scans and manual entries make (canonical article names, one line per article + MRP). */
  function buildScannedLines(qrs: string[], items: DetailItem[]): MrpLine[] {
    // Build MrpLine[] from scannedQrs before clearing scanner state.
    // Use the canonical article name from scanItems (matched via articlesMatch)
    // so that QR code variants (e.g. "SF0204G") are normalised to the registered
    // article name (e.g. "SFG-204") on the invoice — raw code matching is unchanged.
    // Stable map key: canonical-article-name + MRP rounded to 2dp (avoids float string mismatches)
    const mrpKey = (art: string, mrp: number) => `${art}__${mrp.toFixed(2)}`

    const mrpMap   = new Map<string, MrpLine>()

    // ── QR scans → resolve canonical article name from DB order items ──────────
    for (const raw of qrs) {
      if (!isValidWarehouseQr(raw)) continue
      const p = parseQr(raw)
      const canonicalItem = items.find(i =>
        articlesMatch(i.artNumber.toUpperCase(), p.articleCode.toUpperCase())
      )
      const artName = canonicalItem ? canonicalItem.artNumber.toUpperCase() : p.articleCode.toUpperCase()
      const key = mrpKey(artName, p.mrp)
      if (mrpMap.has(key)) {
        mrpMap.get(key)!.qty++
      } else {
        mrpMap.set(key, { artNumber: artName, mrp: p.mrp, qty: 1 })
      }
    }

    // ── Manual entries → artNumber already comes from DB (canonical) ───────────
    for (const [iKey, entries] of Object.entries(manualEntries)) {
      const artNumber = iKey.split('|')[0].toUpperCase()
      for (const e of entries) {
        const key = mrpKey(artNumber, e.mrp)
        if (mrpMap.has(key)) {
          mrpMap.get(key)!.qty += e.qty
        } else {
          mrpMap.set(key, { artNumber, mrp: e.mrp, qty: e.qty })
        }
      }
    }
    // ── Post-build merge: collapse any residual article-name variants ──────────
    // If two entries share the same MRP and one article matches the other via
    // articlesMatch (e.g. "SF0204G" vs "SFG-204"), merge qty into the canonical
    // DB name and drop the QR-code variant.
    const raw2 = Array.from(mrpMap.values())
    const merged: MrpLine[] = []
    for (const line of raw2) {
      const existing = merged.find(
        m => m.mrp === line.mrp && (
          m.artNumber === line.artNumber ||
          articlesMatch(m.artNumber, line.artNumber) ||
          articlesMatch(line.artNumber, m.artNumber)
        )
      )
      if (existing) {
        // Keep the DB canonical name (prefer the one that has a dash or matches scanItems)
        const canonicalItem = items.find(i =>
          articlesMatch(i.artNumber.toUpperCase(), existing.artNumber) ||
          articlesMatch(i.artNumber.toUpperCase(), line.artNumber)
        )
        if (canonicalItem) existing.artNumber = canonicalItem.artNumber.toUpperCase()
        existing.qty += line.qty
      } else {
        merged.push({ ...line })
      }
    }

    return merged
  }

  // ── save bill ────────────────────────────────────────────────────────────────
  function handleSaveBill() {
    if (!scanOrder) return
    const orderId  = scanOrder.id
    const qrsCopy  = [...scannedQrs]
    // Direct bill from an order: pairs received per order line (scans fill lines in order).
    const packedForSave = scanOrder.isEmergency ? directDiff().packed : null
    const builtLines = buildScannedLines(qrsCopy, scanItemsRef.current)
    setMrpLinesMap(prev => ({ ...prev, [orderId]: builtLines }))

    const discPct = typeof lineDiscPct === 'number' ? lineDiscPct : 30
    const pickerChoice = !scanOrder.pickerId ? billPicker : ''
    if (!scanOrder.pickerId && !pickerChoice) { showMsg('err', 'Choose who picked the goods.'); return }
    setActiveId(orderId)
    startTransition(async () => {
      // Bills the order, saves its lines and takes the scanned boxes out of stock (one transaction).
      // On failure (e.g. a box is already on another bill) the scanner stays open with its scans.
      let billed: Awaited<ReturnType<typeof billOrder>>
      try {
        const rated = resolveRates(billType, billTemplate ? templateRates(billTemplate) : DEFAULT_BILL_RATES, rateEdits)
        if (rated.error) { setActiveId(null); showMsg('err', rated.error); return }
        billed = await billOrder(orderId, qrsCopy, builtLines, discPct, { taxType: billType, ...(rated.changed ? { rates: rated.rates } : {}), ...(packedForSave ? { packed: packedForSave } : {}), ...(pickerChoice ? { pickerId: pickerChoice } : {}) })
      } catch (e) {
        setActiveId(null)
        showMsg('err', e instanceof Error ? e.message : 'Could not save the bill. Try again.')
        return
      }
      closeScanner()
      setOrders(prev =>
        prev.map(o => o.id === orderId ? { ...o, status: 'billed', billNo: billed.billNo, billerId: currentBillerId, billedAt: new Date(), pickerId: o.pickerId ?? (pickerChoice || null) } : o)
      )
      setActiveId(null)
      // After saving, switch to Generated Bills tab
      setActiveTab('generated')
    })
  }

  // ── Print Bills: toggle selection & lazily load items ───────────────────────
  async function handleTogglePrintBill(order: BillerOrder) {
    const id = order.id
    setPrintSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else { next.add(id) }
      return next
    })
    if (!printItemsMap[id]) {
      // Emergency bills have no orderItems rows — mark as loaded with empty array.
      // Their actual bill lines come from mrpLinesMap (already in-memory or fetched on view).
      if (order.isEmergency) {
        setPrintItemsMap(prev => ({ ...prev, [id]: [] }))
        // If bill lines not yet in session, fetch them now so confirmPrint can use them
        if (!mrpLinesMap[id]) {
          getBillLines(id).then(rows => {
            if (rows.length > 0) setMrpLinesMap(prev => ({ ...prev, [id]: rows }))
          }).catch(() => {})
        }
      } else {
        setPrintLoadingIds(prev => new Set(prev).add(id))
        try {
          const { items } = await getOrderWithItems(id)
          setPrintItemsMap(prev => ({ ...prev, [id]: items as DetailItem[] }))
        } finally {
          setPrintLoadingIds(prev => { const s = new Set(prev); s.delete(id); return s })
        }
      }
    }
  }

  // ── Open a print window for selected bills (Shayona invoice format) ──────────
  function handlePrintBills(selectedOrders: BillerOrder[]) {
    // Open the config modal; store pending orders so we can print after confirm
    setPendingPrintOrders(selectedOrders)
    setPrintConfigOpen(true)
  }

  async function confirmPrint() {
    const LINE_DISC = lineDiscPct === '' ? 30 : Number(lineDiscPct)
    const orders = pendingPrintOrders
    setPrintConfigOpen(false)
    // Open the window inside the click: browsers block windows opened after a wait (owner reported
    // Print not working, 21 Nov 2026). Then load every selected bill's saved lines and amounts (ONE
    // query) — the saved bill is what prints, with its own discount, GST and total — and fill the window.
    const win = openPrintWindow()
    if (!win) return
    try {
      const saved = await getBillsForPrint(orders.map(o => o.id))
      const bills = orders.map((o) => {
        const s = saved[o.id]
        const lines = s && s.lines.length > 0 ? s.lines : (mrpLinesMap[o.id] ?? [])
        return {
          vendor: { name: o.shopkeeperName, phone: o.shopkeeperPhone ?? null, address: o.shopkeeperAddress ?? null },
          order:  { orderNumber: o.orderNumber, billNo: o.billNo, billedAt: o.billedAt },
          lines,
          lineDiscPct: s?.lineDiscPct ?? LINE_DISC,
          amounts: s?.amounts ?? undefined,
        }
      })
      const empty = bills.filter(b => b.lines.length === 0).map(b => b.order.orderNumber)
      const printable = bills.filter(b => b.lines.length > 0)
      if (printable.length === 0) { win.close(); window.alert(`No bill lines found for ${empty.join(', ')}.`); return }
      if (empty.length) window.alert(`Not printed (no bill lines): ${empty.join(', ')}`)
      await printInvoices(printable, printConfig, billTemplate, win)
    } catch (e) {
      win.close()
      window.alert(`Could not prepare the bill: ${e instanceof Error ? e.message : 'network problem'}. Try again.`)
    }
  }

  // ── Mail selected bills: PDF each, from the shop's Gmail (owner, 21 Nov 2026) ──
  function handleMailBills(selectedOrders: BillerOrder[]) {
    if (selectedOrders.length) setMailOrderIds(selectedOrders.map(o => o.id))
  }

  // Cancel bill (bills are never deleted, owner 23 Nov 2026): asks why, then 1 server call.
  // Returns false when the biller backs out, so the caller keeps its panel open.
  function confirmCancelBill(order: BillerOrder): boolean {
    const id = order.id
    const reason = window.prompt(`Cancel bill ${order.billNo ?? order.orderNumber}? Its boxes go back to stock and the party no longer owes it.

Why is it cancelled?`)
    if (reason === null) return false
    if (reason.trim().length < 3) { window.alert('Type why the bill is cancelled.'); return false }
    startTransition(async () => {
      try {
        await cancelBill(id, reason)
        setOrders(prev => prev.filter(o => o.id !== id))
        setMrpLinesMap(prev => { const next = { ...prev }; delete next[id]; return next })
      } catch (e) {
        window.alert(`Could not cancel the bill: ${e instanceof Error ? e.message : 'network problem'}`)
      }
    })
    return true
  }

  // ── detail panel ─────────────────────────────────────────────────────────────
  async function handleViewOrder(order: BillerOrder) {
    setDetailOrder(order)
    setDetailItems([])
    setDetailError('')
    setDetailBill(null)
    setDetailLoading(true)
    const billed = order.status === 'billed'
    setDetailBillLinesLoading(billed)
    // The order's items and (billed) its saved bill, side by side.
    const items = getOrderWithItems(order.id)
      .then(({ items }) => setDetailItems(items as DetailItem[]))
      .catch((e: unknown) => setDetailError(e instanceof Error ? e.message : 'Failed to load order details.'))
      .finally(() => setDetailLoading(false))
    if (billed) {
      try {
        const bill = (await getBillsForPrint([order.id]))[order.id]
        if (bill && bill.lines.length > 0) {
          const disc = bill.lineDiscPct ?? 30
          // Cache into mrpLinesMap so print/mail also picks it up
          setMrpLinesMap(prev => ({ ...prev, [order.id]: bill.lines }))
          setDetailBill({ lines: bill.lines, lineDiscPct: disc, amounts: bill.amounts ?? amountsFromLines(bill.lines, disc, 'intra_state'), unpaidPaise: bill.unpaidPaise })
        }
      } catch { /* shown as "Bill data not available" */ } finally {
        setDetailBillLinesLoading(false)
      }
    }
    await items
  }

  // ── scan validation ──────────────────────────────────────────────────────────
  // An order is fully verified when every packed item has been scanned ≥ quantityPacked
  const allVerified = scanItems.length > 0 && (() => {
    // Group by key and check pooled scanned count >= total packed for that key.
    // Using per-item packed (old logic) would fire too early when multiple items
    // share the same artNumber|sizeNumber (e.g. two color variants of same size).
    const keyTotals = new Map<string, number>()
    for (const item of scanItems) {
      if (item.status === 'out_of_stock') continue
      const key = itemKey(item.artNumber, item.sizeNumber, item.artCode)
      keyTotals.set(key, (keyTotals.get(key) ?? 0) + item.quantityPacked)
    }
    for (const [key, totalPacked] of keyTotals) {
      if (totalPacked === 0) continue
      if ((scannedMap[key] ?? 0) < totalPacked) return false
    }
    return true
  })()

  // ── build article groups for detail panel ────────────────────────────────────
  const articleGroups = (() => {
    const artMap = new Map<string, Map<string, DetailItem[]>>()
    for (const item of detailItems) {
      if (!artMap.has(item.artNumber)) artMap.set(item.artNumber, new Map())
      const colorKey = item.colorNumber ?? '—'
      if (!artMap.get(item.artNumber)!.has(colorKey)) artMap.get(item.artNumber)!.set(colorKey, [])
      artMap.get(item.artNumber)!.get(colorKey)!.push(item)
    }
    return Array.from(artMap.entries()).map(([artNumber, colorMap]) => ({
      artNumber,
      colorGroups: Array.from(colorMap.entries()).map(([color, items]) => ({ color, items })),
    }))
  })()

  // ── scan item grouping: artNumber → sizeNumber → items[] ────────────────────
  // Grouped by size (color ignored — no color validation yet).
  // Each size bucket is one row; totals are summed across all same-size items.
  const scanArticleGroups = (() => {
    const artMap = new Map<string, Map<string, DetailItem[]>>()
    for (const item of scanItems) {
      if (!artMap.has(item.artNumber)) artMap.set(item.artNumber, new Map())
      const sizeKey = `${item.sizeNumber ?? '—'}|${(item.artCode ?? '').toUpperCase()}`
      if (!artMap.get(item.artNumber)!.has(sizeKey)) artMap.get(item.artNumber)!.set(sizeKey, [])
      artMap.get(item.artNumber)!.get(sizeKey)!.push(item)
    }
    return Array.from(artMap.entries()).map(([artNumber, sizeMap]) => {
      const groups = Array.from(sizeMap.entries()).map(([k, items]) => ({ label: k.split('|')[0], code: k.split('|')[1], items }))
      return {
        artNumber,
        sizeGroups: groups.map(g => ({
          size: groups.filter(x => x.label === g.label).length > 1 && g.code ? `${g.label} (${g.code})` : g.label,
          items: g.items,
        })),
      }
    })
  })()

  // ── Derived lists ────────────────────────────────────────────────────────────
  const verifyOrders = orders.filter(o => o.status === 'packed')
  // Newest bill first (owner, 24 Nov 2026).
  const billedOrders = orders.filter(o => o.status === 'billed')
    .sort((a, b) => (b.billedAt ? new Date(b.billedAt).getTime() : 0) - (a.billedAt ? new Date(a.billedAt).getTime() : 0) || b.id - a.id)

  const counts = {
    total:   orders.length,
    packed:  verifyOrders.length,
    billed:  billedOrders.length,
    myBills: billedOrders.filter(o => o.billerId === currentBillerId).length,
  }

  return (
    // Room for the ticked-bills bar so it never covers the last bills (phone menu room is kept by the menu itself).
    <div ref={rootRef} className={`${embedded ? '' : 'min-h-screen bg-background'}${activeTab === 'generated' && printSelectedIds.size > 0 ? ' pb-20 md:pb-24' : ''}`}>
      {/* Direct Billing needs room for the bill beside the scanner: wider page on that tab. */}
      <div className={embedded ? '' : `${activeTab === 'emergency' ? 'max-w-6xl' : 'max-w-2xl'} mx-auto px-4 py-6`}>
        {!embedded && (
          <div className="flex items-center justify-between mb-6">
            <PageHeader title="Biller Dashboard" subtitle="Verify packed orders and generate bills" />
            <PageNav />
          </div>
        )}

        {/* Counts are hidden while making a direct bill: only the bill matters then (owner, 21 Nov 2026). */}
        <div className={`grid grid-cols-4 gap-3 mb-6 ${activeTab === 'emergency' ? 'hidden' : ''}`}>
          <StatCard label="Total"     value={counts.total} />
          <StatCard label="To Verify" value={counts.packed}  color="text-purple-600 dark:text-purple-400" />
          <StatCard label="Billed"    value={counts.billed}  color="text-blue-600 dark:text-blue-400" />
          <StatCard label="My Bills"  value={counts.myBills} color="text-blue-600 dark:text-blue-400" />
        </div>

        {/* ── Tabs + Direct bill (corner) ── */}
        {activeTab === 'emergency' ? (
          <div className="mb-4 flex items-center justify-between gap-2">
            <button type="button" onClick={() => switchTab('verify')} className="rounded-lg border border-border px-3 py-1.5 text-xs font-semibold hover:bg-muted">← Bills</button>
            <p className="text-sm font-bold">⚡ Direct bill <span className="font-normal text-muted-foreground">(no order)</span></p>
          </div>
        ) : (
        <div className="mb-4 flex items-stretch gap-2">
        <div role="tablist" aria-label="Biller" onKeyDown={tablistKeyDown} className="flex flex-1 rounded-xl border border-border bg-muted/40 p-1 gap-1">
          {(['verify', 'generated'] as BillerTab[]).map(tab => (
            <button
              key={tab}
              type="button"
              {...tabProps(activeTab === tab)}
              onClick={() => switchTab(tab)}
              className={`flex-1 flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-semibold transition-colors ${
                activeTab === tab
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {tab === 'verify' ? 'Bills' : 'Receipts'}
              {
                <span className={`inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums ${
                  activeTab === tab ? 'bg-primary-foreground/25 text-primary-foreground' : 'bg-muted-foreground/20 text-muted-foreground'
                }`}>
                  {tab === 'verify' ? counts.packed : counts.billed}
                </span>
              }
            </button>
          ))}
        </div>
          <button type="button" onClick={() => switchTab('emergency')} title="Direct bill — a bill without an order"
            aria-label="Direct bill (a bill without an order)"
            className="shrink-0 inline-flex items-center gap-1 rounded-xl border border-border bg-card px-3 text-xs font-semibold hover:bg-muted">
            <span aria-hidden>⚡</span><span className="hidden sm:inline">Direct bill</span>
          </button>
        </div>
        )}

        {/* ── Bills tab (orders to bill) ── */}
        {activeTab === 'verify' && (
          <div ref={verifyListRef} className="space-y-3">
            {verifyOrders.length === 0 && (
              <div className="text-center py-12 text-muted-foreground text-sm">No orders to bill 🎉</div>
            )}
            {verifyOrders.map(order => {
              const isProcessing = isPending && activeId === order.id
              return (
                <div
                  key={order.id}
                  data-list-row
                  onClick={() => handleViewOrder(order)}
                  className="w-full text-left rounded-xl border border-border bg-card p-4 hover:bg-muted/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <button type="button" data-row-open onClick={e => { e.stopPropagation(); handleViewOrder(order) }} className="rounded text-left font-medium text-sm hover:underline">{order.shopkeeperName}</button>
                      <p className="font-mono text-xs text-muted-foreground mt-0.5">{order.orderNumber}</p>
                    </div>
                    <div className="flex items-center gap-1.5">
                      {order.isEmergency && <DirectBillBadge />}
                      <StatusPill status={order.status} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">{order.isEmergency ? 'Sent to billing' : 'Packed'}: {fmt(order.packedAt)}</p>
                    </div>
                    <div onClick={e => e.stopPropagation()}>
                      <button
                        type="button"
                        onClick={() => openOrder(order)}
                        disabled={isProcessing}
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        {isProcessing ? '…' : order.isEmergency ? 'Direct bill' : 'Scan Items'}
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* ── Direct Billing tab (formerly Emergency) — always mounted to preserve scan state across tab switches ── */}
        <div className={activeTab === 'emergency' ? '' : 'hidden'}>
          <div>
            <div>
              <BillingScannerPage
                vendors={vendors}
                articles={articles}
                pickers={pickers}
                rateDefaults={billTemplate ? templateRates(billTemplate) : undefined}
                embedded
                onBillGenerated={(data) => {
                  const newOrder: BillerOrder = {
                    id:                data.id,
                    orderNumber:       data.orderNumber,
                    billNo:            data.billNo,
                    shopkeeperName:    data.shopkeeperName,
                    shopkeeperPhone:   data.shopkeeperPhone,
                    shopkeeperAddress: data.shopkeeperAddress,
                    status:            'billed',
                    packedAt:          null,
                    billedAt:          new Date(data.billedAt),
                    billerId:          currentBillerId,
                    salesmanId:        null,
                    isEmergency:       true,
                  }
                  setOrders(prev => [newOrder, ...prev])
                  setMrpLinesMap(prev => ({ ...prev, [data.id]: data.lines }))
                  // Pre-mark as loaded (no orderItems for Direct Bills) and auto-select for print
                  setPrintItemsMap(prev => ({ ...prev, [data.id]: [] }))
                  setPrintSelectedIds(prev => new Set([...prev, data.id]))
                  setActiveTab('generated')
                }}
              />
            </div>
          </div>
        </div>

        {/* ── Print Bills tab ── */}
        {activeTab === 'generated' && (() => {
          const allSelected = billedOrders.length > 0 && billedOrders.every(o => printSelectedIds.has(o.id))
          const selectedOrders = billedOrders.filter(o => printSelectedIds.has(o.id))
          const allLoaded = selectedOrders.every(o => !!printItemsMap[o.id])

          function toggleAll() {
            if (allSelected) {
              setPrintSelectedIds(new Set())
              setPrintItemsMap({})
            } else {
              billedOrders.forEach(o => { if (!printSelectedIds.has(o.id)) handleTogglePrintBill(o) })
            }
          }

          return (
            <div className="space-y-3">

              {/* ── Empty state ── */}
              {billedOrders.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-medium">No bills generated yet</p>
                    <p className="text-xs mt-0.5 text-muted-foreground">Bills appear here after scanning and saving orders.</p>
                  </div>
                </div>
              )}

              {/* ── Selection card ── */}
              {billedOrders.length > 0 && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">

                  {/* Card header */}
                  <div className="px-3 py-3 sm:px-4 sm:py-3.5 bg-muted/30 border-b border-border">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                        </svg>
                        <h2 className="text-sm font-semibold text-foreground">Receipts</h2>
                        <span className="hidden text-xs text-muted-foreground sm:inline">· click a bill to see and print it</span>
                        {printSelectedIds.size > 0 && (
                          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-foreground">
                            {printSelectedIds.size}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={toggleAll}
                        className="text-xs font-medium text-primary hover:underline shrink-0"
                      >
                        {allSelected ? 'Clear all' : 'Select all'}
                      </button>
                    </div>
                  </div>

                  {/* Rows */}
                  <div ref={receiptsListRef} className="divide-y divide-border">
                    {billedOrders.map(order => {
                      const checked = printSelectedIds.has(order.id)
                      const loading = printLoadingIds.has(order.id)
                      // For emergency bills: use qty from mrpLinesMap (no orderItems); for normal bills: use packed qty from printItemsMap
                      // Pairs on the bill, shown on every row (owner, 24 Nov 2026); the bill lines are the record.
                      const pairs = order.billedPairs ?? (order.isEmergency
                        ? (mrpLinesMap[order.id]?.reduce((s, l) => s + l.qty, 0) ?? null)
                        : (printItemsMap[order.id]?.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0) ?? null))

                      return (
                        <div
                          key={order.id}
                          data-list-row
                          onClick={() => setPreviewOrder(order)}
                          className={`flex items-center gap-3 px-3 py-3 sm:px-4 cursor-pointer transition-colors ${
                            checked ? 'bg-primary/5' : 'hover:bg-muted/30 active:bg-muted/50'
                          }`}
                        >
                          {/* Checkbox — click is independent from row, does NOT open preview */}
                          <button
                            type="button"
                            aria-label={checked ? 'Deselect for mail' : 'Select for mail'}
                            aria-pressed={checked}
                            data-row-tick
                            onClick={e => { e.stopPropagation(); handleTogglePrintBill(order) }}
                            className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                              checked ? 'border-primary bg-primary' : 'border-border bg-background hover:border-primary/60'
                            }`}
                          >
                            {checked && (
                              <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>

                          {/* Text — clicking opens detail preview */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <button type="button" data-row-open onClick={e => { e.stopPropagation(); setPreviewOrder(order) }} className="min-w-0 truncate rounded text-left text-sm font-medium text-foreground leading-snug hover:underline">{order.shopkeeperName}</button>
                              {order.isEmergency && <DirectBillBadge />}
                            </div>
                            <div className="flex items-center gap-2 mt-0.5">
                              {order.billNo && <span className="text-[11px] font-bold text-foreground">{`Bill ${order.billNo}`}</span>}
                              <span className="font-mono text-[11px] text-muted-foreground">{order.orderNumber}</span>
                              <span className="text-[11px] text-muted-foreground">·</span>
                              <span className="text-[11px] text-muted-foreground">{fmt(order.billedAt)}</span>
                            </div>
                          </div>

                          {/* Right side */}
                          <div className="flex items-center gap-2 shrink-0">
                            {loading && (
                              <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                              </svg>
                            )}
                            {!loading && pairs !== null && (
                              <span className="inline-flex items-center rounded-full bg-blue-100 dark:bg-blue-900/30 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-blue-700 dark:text-blue-400">
                                {`${pairs} ${pairs === 1 ? 'pair' : 'pairs'}`}
                              </span>
                            )}
                            {/* No status label: every bill in Receipts is billed (owner, 24 Nov 2026). Paid / part-paid / unpaid instead. */}
                            {!loading && <PaidBadge total={order.billTotalPaise} unpaid={order.unpaidPaise} />}
                            {/* Chevron hint */}
                            <svg className="w-3.5 h-3.5 text-muted-foreground/50 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                            </svg>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Summary strip — shown when at least one selected */}
                  {selectedOrders.length > 0 && (
                    <div className="border-t border-border px-3 py-2.5 sm:px-4 bg-muted/20 flex items-center gap-4 flex-wrap">
                      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                        <span><span className="font-semibold text-foreground">{selectedOrders.length}</span> bill{selectedOrders.length !== 1 ? 's' : ''} selected</span>
                      </div>
                      {!allLoaded && (
                        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                          <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                          </svg>
                          Loading items…
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* ── Order detail panel ── */}
      {detailOrder && (
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end sm:flex-row sm:justify-end bg-black/40 backdrop-blur-sm"
          onClick={() => setDetailOrder(null)}
        >
          <DialogKeys onClose={() => setDetailOrder(null)} />
          <div
            className="relative w-full sm:max-w-md bg-background sm:border-l border-t sm:border-t-0 border-border sm:h-full max-h-[85dvh] sm:max-h-none overflow-y-auto pb-[env(safe-area-inset-bottom)] shadow-2xl rounded-t-2xl sm:rounded-none"
            onClick={e => e.stopPropagation()}
          >
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>
            <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-4 bg-background border-b border-border">
              <div>
                <p className="font-semibold text-sm text-foreground">{detailOrder.shopkeeperName}</p>
                <p className="font-mono text-xs text-muted-foreground mt-0.5">{detailOrder.orderNumber}</p>
              </div>
              <button type="button" onClick={() => setDetailOrder(null)}
                className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-muted transition-colors">
                <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="p-5 space-y-5">
              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusPill status={detailOrder.status} />
                  {detailOrder.isEmergency && (
                    <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-900/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-red-700 dark:text-red-400">
                      Direct Bill
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <span className="text-muted-foreground">Packed</span>
                  <span className="text-foreground">{fmt(detailOrder.packedAt)}</span>
                  {detailOrder.billedAt && (
                    <>
                      <span className="text-muted-foreground">Billed</span>
                      <span className="text-blue-600 dark:text-blue-400 font-medium">{fmt(detailOrder.billedAt)}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <div className="px-4 py-3 bg-muted/30 border-b border-border">
                  <p className="text-sm font-semibold text-foreground">Order Items</p>
                </div>
                {detailLoading && <p className="px-4 py-6 text-sm text-muted-foreground text-center">Loading items…</p>}
                {detailError  && <p role="alert" className="px-4 py-4 text-sm text-red-600 dark:text-red-400">{detailError}</p>}
                {!detailLoading && !detailError && detailItems.length === 0 && (
                  <p className="px-4 py-6 text-sm text-muted-foreground text-center">No items found.</p>
                )}
                {!detailLoading && detailItems.length > 0 && (
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-muted/20 border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground w-24">Article</th>
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground w-28">Color</th>
                        <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">
                          Size
                          <span className="ml-1 text-[10px] font-normal text-muted-foreground/50">→</span>
                          <span className="text-[10px] font-semibold text-muted-foreground/70">ord</span>
                          <span className="mx-0.5 text-[10px] text-muted-foreground/40">→</span>
                          <span className="text-[10px] font-semibold text-green-600 dark:text-green-400">pkd</span>
                          {detailOrder?.status === 'billed' && (
                            <>
                              <span className="mx-0.5 text-[10px] text-muted-foreground/40">→</span>
                              <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">ver</span>
                            </>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {articleGroups.map(({ artNumber, colorGroups }) =>
                        colorGroups.map(({ color, items }, ci) => {
                          const allItems = colorGroups.flatMap(cg => cg.items)
                          const allOrd   = allItems.reduce((s, i) => s + i.quantityOrdered, 0)
                          const allPkd   = allItems.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                          const isBilled = detailOrder?.status === 'billed'
                          const allVer   = isBilled ? allPkd : 0
                          return (
                            <tr key={`${artNumber}-${color}`} className="border-b border-border hover:bg-muted/20">
                              {ci === 0 && (
                                <td className="px-4 py-2.5 font-semibold text-xs align-top border-r border-border" rowSpan={colorGroups.length}>
                                  {artNumber}
                                  {/* ord = salesman → muted */}
                                  <span className="block font-normal text-muted-foreground tabular-nums mt-0.5">{allOrd} ord</span>
                                  {/* pkd = picker → always green */}
                                  <span className="block font-semibold tabular-nums text-green-600 dark:text-green-400">{allPkd} pkd</span>
                                  {/* ver = biller → always blue, only when billed */}
                                  {isBilled && <span className="block font-semibold tabular-nums text-blue-600 dark:text-blue-400">{allVer} ver</span>}
                                </td>
                              )}
                              <td className="px-3 py-2.5 text-xs font-medium text-foreground align-top w-28 border-r border-border">{color}</td>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex flex-wrap gap-x-2 gap-y-1">
                                  {items.map(item => {
                                    const isOOS    = item.status === 'out_of_stock'
                                    const pkd      = isOOS ? 0 : item.quantityPacked
                                    const verified = isBilled ? pkd : 0
                                    return (
                                      <span key={item.id} className="inline-flex items-baseline gap-0.5 tabular-nums whitespace-nowrap">
                                        <span className="text-xs text-muted-foreground">{item.sizeNumber ?? '—'}</span>
                                        <span className="text-[10px] text-muted-foreground/50 mx-px">/</span>
                                        {/* ord = salesman → always muted */}
                                        <span className="text-xs font-bold text-muted-foreground">{item.quantityOrdered}</span>
                                        <span className="text-[10px] text-muted-foreground/40">→</span>
                                        {/* pkd = picker → always green (red if OOS) */}
                                        <span className={`text-xs font-bold ${isOOS ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                                          {isOOS ? 'OOS' : pkd}
                                        </span>
                                        {/* verified = biller → always blue, only when billed */}
                                        {isBilled && !isOOS && (
                                          <>
                                            <span className="text-[10px] text-muted-foreground/40">→</span>
                                            <span className="text-xs font-bold text-blue-600 dark:text-blue-400">{verified}</span>
                                          </>
                                        )}
                                      </span>
                                    )
                                  })}
                                </div>
                              </td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                    <tfoot className="border-t-2 border-border bg-muted/20">
                      <tr>
                        <td colSpan={2} className="px-4 py-2.5 text-xs font-medium text-muted-foreground text-right">Total</td>
                        <td className="px-3 py-2.5 text-xs">
                          {(() => {
                            const isBilled = detailOrder?.status === 'billed'
                            const totalOrd = detailItems.reduce((s, i) => s + i.quantityOrdered, 0)
                            const totalPkd = detailItems.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                            const totalVer = isBilled ? totalPkd : 0
                            return (
                              <>
                                {/* ord = salesman → muted */}
                                <span className="font-bold tabular-nums text-muted-foreground">{totalOrd}</span>
                                <span className="text-muted-foreground mx-1">ord /</span>
                                {/* pkd = picker → green */}
                                <span className="font-bold tabular-nums text-green-600 dark:text-green-400">{totalPkd}</span>
                                <span className="text-muted-foreground mx-1">pkd</span>
                                {/* ver = biller → blue, only when billed */}
                                {isBilled && (
                                  <>
                                    <span className="text-muted-foreground mx-0.5">/</span>
                                    <span className="font-bold tabular-nums text-blue-600 dark:text-blue-400">{totalVer}</span>
                                    <span className="text-muted-foreground ml-1">ver</span>
                                  </>
                                )}
                              </>
                            )
                          })()}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>

              {/* ── Bill Details ── shown when billed */}
              {detailOrder.status === 'billed' && (() => {

                // Still loading from DB
                if (detailBillLinesLoading) return (
                  <div className="rounded-xl border border-border bg-card overflow-hidden">
                    <div className="px-4 py-3 bg-muted/30 border-b border-border">
                      <p className="text-sm font-semibold text-foreground">Bill Items</p>
                    </div>
                    <div className="px-4 py-6 flex items-center justify-center gap-2 text-xs text-muted-foreground">
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                      </svg>
                      Loading bill data…
                    </div>
                  </div>
                )

                // No saved bill lines
                if (!detailBill) return (
                  <div className="rounded-xl border border-border bg-card overflow-hidden">
                    <div className="px-4 py-3 bg-muted/30 border-b border-border">
                      <p className="text-sm font-semibold text-foreground">Bill Items</p>
                    </div>
                    <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                      Bill data not available for this order.
                    </div>
                  </div>
                )

                return <BillDetailCard lines={detailBill.lines} lineDiscPct={detailBill.lineDiscPct} amounts={detailBill.amounts} unpaidPaise={detailBill.unpaidPaise} />
              })()}

              {detailOrder.status === 'packed' && (
                <button
                  type="button"
                  disabled={isPending && activeId === detailOrder.id}
                  onClick={() => { const o = detailOrder; setDetailOrder(null); openOrder(o) }}
                  className="w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  Scan Items
                </button>
              )}

              {/* Print Bill — available for any billed order */}
              {detailOrder.status === 'billed' && (
                <button
                  type="button"
                  onClick={() => {
                    const order = detailOrder
                    setDetailOrder(null)
                    handlePrintBills([order])
                  }}
                  className="w-full rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  Print Bill
                </button>
              )}

              {/* Edit bill by scanning boxes on / off (owner, 24 Nov 2026): same number and date */}
              {detailOrder.status === 'billed' && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => { const o = detailOrder; setDetailOrder(null); setEditBillOrder(o) }}
                  className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                >
                  Edit bill (scan boxes on / off)
                </button>
              )}

              {/* Cancel bill (bills are never deleted, owner 23 Nov 2026): boxes back to stock, ledger entry reversed */}
              {detailOrder.status === 'billed' && (
                <button
                  type="button"
                  disabled={isPending}
                  onClick={() => { if (confirmCancelBill(detailOrder)) setDetailOrder(null) }}
                  className="w-full rounded-xl border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/20 px-4 py-2.5 text-sm font-semibold text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/40 disabled:opacity-50 transition-colors"
                >
                  {isPending ? 'Cancelling…' : 'Cancel bill (boxes go back to stock)'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Edit bill (scan boxes on / off) ── */}
      {editBillOrder && (
        <EditBillDialog
          orderId={editBillOrder.id}
          onClose={() => setEditBillOrder(null)}
          onSaved={(r) => {
            const o = editBillOrder
            setMrpLinesMap(prev => ({ ...prev, [o.id]: r.lines.map(l => ({ artNumber: l.artNumber, mrp: l.mrp, qty: l.qty, hsn: l.hsn ?? null })) }))
            setOrders(prev => prev.map(x => x.id === o.id ? { ...x, billNo: r.billNo, billedPairs: r.totals.totalQty } : x))
            setEditBillOrder(null)
            // Show the edited bill as it prints (reloads its saved lines and amounts: 1 query).
            setPreviewOrder({ ...o, billNo: r.billNo, billedPairs: r.totals.totalQty })
          }}
        />
      )}

      {/* ── Scan & verify modal ── */}
      {/* ── Direct bill on the Direct Billing screen (orders sent with ⚡) ── */}
      {directOrder && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background" role="dialog" aria-modal="true" aria-label={`Direct bill ${directOrder.orderNumber}`}>
          <DialogKeys onClose={() => setDirectOrder(null)} />
          <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-4">
            <button type="button" onClick={() => setDirectOrder(null)} aria-label="Back to bills"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border hover:bg-muted">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold">⚡ Direct bill</p>
              <p className="truncate text-xs text-muted-foreground">Scans are saved as you go — closing keeps them for this order.</p>
            </div>
          </div>
          <div className="mx-auto max-w-6xl px-3 py-3 sm:px-4">
            <BillingScannerPage
              key={directOrder.id}
              orderId={directOrder.id}
              vendors={[]}
              articles={articles}
              pickers={pickers}
              rateDefaults={billTemplate ? templateRates(billTemplate) : undefined}
              embedded
              onBillGenerated={(res) => {
                const id = directOrder.id
                setOrders(prev => prev.map(o => o.id === id ? { ...o, status: 'billed', billNo: res.billNo, billerId: currentBillerId, billedAt: new Date(res.billedAt) } : o))
                setDirectOrder(null)
                showMsg('ok', `${res.orderNumber} billed · bill ${res.billNo}`)
                setActiveTab('generated')
              }}
            />
          </div>
        </div>
      )}

      {scanOrder && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background">
          <DialogKeys onClose={closeScanner} />

          {/* ── Top header ── */}
          <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-background">
            <button
              type="button"
              onClick={closeScanner}
              className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg border border-border bg-card hover:bg-muted transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm text-foreground truncate">{scanOrder.shopkeeperName}</p>
              <p className="font-mono text-[11px] text-muted-foreground">{scanOrder.orderNumber}</p>
            </div>
            {/* Progress pill */}
            <span className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${
              allVerified
                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300'
                : 'bg-muted text-muted-foreground'
            }`}>
              {Object.values(scannedMap).reduce((a, b) => a + b, 0)}&nbsp;/&nbsp;{scanItems.filter(i => i.status !== 'out_of_stock').reduce((s, i) => s + i.quantityPacked, 0)}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto">

            {/* ── Camera section ── */}
            <div className="px-4 pt-4 space-y-3">
              <button type="button" onClick={isCameraActive ? stopCamera : startCamera}
                  className={`w-full rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors ${isCameraActive ? 'border border-border hover:bg-muted' : 'bg-foreground text-background hover:opacity-90'}`}>
                  {isCameraActive ? 'Stop camera' : 'Scan with camera'}
                </button>
              <div className={`relative bg-black w-full rounded-2xl overflow-hidden ${isCameraActive ? '' : 'hidden'}`} style={{ aspectRatio: '4/3', maxHeight: '44vh' }}>
                <video
                  ref={videoRef}
                  autoPlay playsInline muted
                  className="w-full h-full object-cover"
                />
                <canvas ref={canvasRef} className="hidden" />

                {/* QR lock-on highlight */}
                {qrDetected && (
                  <div className="absolute inset-0 rounded-2xl ring-4 ring-green-400 pointer-events-none" />
                )}

                {/* Scanning reticle — shown when camera active */}
                {isCameraActive && !qrDetected && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-44 h-44 relative">
                      {/* corner marks */}
                      <span className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-white/70 rounded-tl" />
                      <span className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-white/70 rounded-tr" />
                      <span className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-white/70 rounded-bl" />
                      <span className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-white/70 rounded-br" />
                    </div>
                  </div>
                )}

                {/* Flash — shown when camera active */}
                {isCameraActive && (
                  <div className="absolute bottom-3 right-3">
                    <button
                      type="button"
                      onClick={toggleFlashlight}
                      className={`rounded-lg border px-3 py-1.5 text-xs font-medium backdrop-blur-sm transition-colors ${
                        isFlashlightOn
                          ? 'border-yellow-400/80 bg-yellow-400/20 text-yellow-300'
                          : 'border-white/25 bg-black/55 text-white hover:bg-black/70'
                      }`}
                    >
                      {isFlashlightOn ? '⚡ Flash On' : '⚡ Flash'}
                    </button>
                  </div>
                )}
              </div>

              {/* Controls row below camera */}
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] text-muted-foreground">
                  {isCameraActive
                    ? 'Point at a warehouse box QR code'
                    : 'Tap Scan with camera, use a USB / Bluetooth scanner, or upload an image'}
                </p>
                <label className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer">
                  {uploadProcessing
                    ? <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                    : <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                  }
                  Upload Image
                  <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageUpload} />
                </label>
              </div>
            </div>

            {/* ── Scan result banner ── */}
            {scanMsg && (
              <div className={`mx-4 mt-3 flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs font-medium ${
                scanMsg.type === 'ok'
                  ? 'bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-400 border border-green-200 dark:border-green-800'
                  : scanMsg.type === 'warn'
                  ? 'bg-yellow-50 dark:bg-yellow-950/30 text-yellow-700 dark:text-yellow-400 border border-yellow-200 dark:border-yellow-800'
                  : 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800'
              }`}>
                <span className="mt-px shrink-0">
                  {scanMsg.type === 'ok' ? '✓' : scanMsg.type === 'warn' ? '⚠' : '✕'}
                </span>
                <span>{scanMsg.text}</span>
              </div>
            )}

            {/* ── Persistent Last Scanned display ── */}
            {lastScannedMsg && (
              <div className="mx-4 mt-3 flex items-center justify-between gap-3 rounded-xl bg-card border border-border px-3.5 py-3 text-xs select-none shadow-sm">
                <div className="shrink-0 flex items-center">
                  <span className="bg-emerald-500 text-white font-bold px-2.5 py-1 rounded-md text-[10px] tracking-wide uppercase shadow-sm shadow-emerald-500/10">
                    Last Scanned
                  </span>
                </div>
                <span className="font-bold text-foreground font-mono text-right text-xs sm:text-sm pl-2">{lastScannedMsg}</span>
              </div>
            )}

            {/* ── Item verification checklist ── */}
            <div className="px-4 pt-4 pb-28 space-y-3">
              <div className="flex items-center justify-between mb-3 select-none">
                <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  Order items
                </p>
                <div className="flex items-center gap-2">
                  {/* Reset verification — clears all scanned + manual state */}
                  {(Object.keys(scannedMap).length > 0 || scannedQrs.length > 0 || Object.keys(manualEntries).length > 0) && (
                    <button
                      type="button"
                      onClick={() => {
                        setScannedMap({})
                        setScannedQrs([])
                        setManualEntries({})
                        setScanHistory([])
                        setLastScannedMsg(null)
                        setScanMsg(null)
                      }}
                      className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-semibold border border-red-200 dark:border-red-800 bg-red-50/50 dark:bg-red-950/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-950/20 transition-all"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                      Reset
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowDevTracking(!showDevTracking)}
                    className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[10px] font-semibold transition-all border ${
                      showDevTracking
                        ? 'bg-blue-500/10 border-blue-500/30 text-blue-600 dark:text-blue-400 shadow-sm'
                        : 'bg-muted/50 border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full transition-colors ${showDevTracking ? 'bg-blue-500 animate-pulse' : 'bg-muted-foreground/40'}`} />
                    Developer Mode
                  </button>
                  {/* Undo last scan or manual operation */}
                  <button
                    type="button"
                    disabled={scanHistory.length === 0}
                    onClick={handleUndo}
                    title={scanHistory.length > 0 ? `Undo ${scanHistory[scanHistory.length - 1].label}` : 'No actions to undo'}
                    className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-[10px] font-semibold transition-all border ${
                      scanHistory.length > 0
                        ? 'border-amber-300 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/20 text-amber-700 dark:text-amber-400 hover:bg-amber-100 dark:hover:bg-amber-950/40 active:scale-95 shadow-sm'
                        : 'border-border/50 bg-muted/30 text-muted-foreground/40 cursor-not-allowed'
                    }`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2m0 0l-4-4m4 4l4-4M3 10l4-4m-4 4l4 4" />
                    </svg>
                    Undo
                  </button>
                </div>
              </div>

              {scanArticleGroups.map(({ artNumber, sizeGroups }) => {
                const allItems      = sizeGroups.flatMap(sg => sg.items)
                const totalPackedPairs   = allItems.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                // Verified = sum of min(scannedMap[key], totalPackedForKey) per unique key
                const totalVerifiedPairs = sizeGroups.reduce((s, { items }) => {
                  const key        = itemKey(items[0].artNumber, items[0].sizeNumber, items[0].artCode)
                  const totalPacked = items.reduce((p, i) => p + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                  return s + Math.min(scannedMap[key] ?? 0, totalPacked)
                }, 0)
                const artDone    = totalVerifiedPairs >= totalPackedPairs && totalPackedPairs > 0
                const isExpanded = expandedArticle === artNumber

                return (
                  <div key={artNumber} className={`rounded-xl border transition-all duration-200 overflow-hidden ${
                    artDone
                      ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/5 dark:bg-emerald-950/5'
                      : isExpanded
                      ? 'border-blue-300 dark:border-blue-700 shadow-md shadow-blue-500/5'
                      : 'border-border bg-card'
                  }`}>
                    {/* Article header */}
                    <div
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onClick={() => setExpandedArticle(isExpanded ? null : artNumber)}
                      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setExpandedArticle(isExpanded ? null : artNumber) } }}
                      className={`px-4 py-3.5 border-b cursor-pointer transition-colors select-none ${
                        artDone
                          ? 'border-emerald-100/60 dark:border-emerald-900/40 bg-emerald-50/20 dark:bg-emerald-950/10 hover:bg-emerald-50/40'
                          : isExpanded
                          ? 'border-blue-100 dark:border-blue-900/40 bg-blue-50/10 dark:bg-blue-950/5 hover:bg-blue-50/20'
                          : 'border-border bg-muted/20 hover:bg-muted/30'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-4">
                        <div className="flex items-center gap-2 min-w-0">
                          <svg
                            className={`w-3.5 h-3.5 text-muted-foreground transition-transform duration-200 shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor"
                          >
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                          </svg>
                          <span className="text-xs font-bold font-mono text-foreground truncate">{artNumber}</span>
                        </div>
                        <div className="flex items-center gap-1.5 font-mono text-xs shrink-0">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-extrabold tracking-tight leading-none ${
                            artDone
                              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300'
                              : totalVerifiedPairs > 0
                              ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                              : 'bg-muted text-muted-foreground'
                          }`}>
                            {totalVerifiedPairs}&thinsp;/&thinsp;{totalPackedPairs}
                          </span>
                          {artDone && (
                            <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Table — one row per size */}
                    {isExpanded && (
                      <div className="overflow-x-auto bg-card border-t border-border/50 scrollbar-none touch-pan-x">
                        <table className="w-full text-xs text-left border-collapse table-auto">
                          <thead className="bg-muted/10 border-b border-border text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                            <tr>
                              <th className="px-3.5 py-2.5 text-center min-w-[48px] w-12 whitespace-nowrap text-muted-foreground">Size</th>
                              <th className="px-2 py-2.5 text-center min-w-[56px] w-14 whitespace-nowrap text-muted-foreground">ORD</th>
                              <th className="px-2 py-2.5 text-center min-w-[56px] w-14 text-green-600 dark:text-green-400 font-bold whitespace-nowrap">PKD</th>
                              <th className="px-2 py-2.5 text-center min-w-[64px] w-16 text-blue-600 dark:text-blue-400 font-bold whitespace-nowrap">Verified</th>
                              <th className="px-3.5 py-2.5 text-right min-w-[80px] w-24 whitespace-nowrap text-muted-foreground">Price</th>
                              {showDevTracking && (
                                <th className="px-3.5 py-2.5 text-left min-w-[280px] whitespace-nowrap text-muted-foreground">rawCode</th>
                              )}
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-border bg-card/40">
                            {sizeGroups.map(({ size, items: sizeItems }) => {
                              const key        = itemKey(sizeItems[0].artNumber, sizeItems[0].sizeNumber, sizeItems[0].artCode)
                              const totalOrd   = sizeItems.reduce((s, i) => s + i.quantityOrdered, 0)
                              const totalPkd   = sizeItems.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                              const verified   = Math.min(scannedMap[key] ?? 0, totalPkd)
                              const remaining  = Math.max(0, totalPkd - verified)
                              const done       = totalPkd === 0 || verified >= totalPkd
                              const partial    = !done && verified > 0
                              const allOOS     = sizeItems.every(i => i.status === 'out_of_stock')

                              // Prices from QR scans for this size
                              const priceCounts: Record<number, number> = {}
                              scannedQrs.forEach(raw => {
                                if (!isValidWarehouseQr(raw)) return
                                const p = parseQr(raw)
                                if (articlesMatch(p.articleCode, sizeItems[0].artNumber) &&
                                    String(p.size).toUpperCase() === (sizeItems[0].sizeNumber ?? '').toUpperCase()) {
                                  priceCounts[p.mrp] = (priceCounts[p.mrp] ?? 0) + 1
                                }
                              })
                              // Merge manual entries
                              ;(manualEntries[key] ?? []).forEach(e => {
                                priceCounts[e.mrp] = (priceCounts[e.mrp] ?? 0) + e.qty
                              })
                              const priceEntries = Object.entries(priceCounts)

                              // For dev tracking: all QR codes for this size
                              const sizeScans = showDevTracking ? scannedQrs.filter(raw => {
                                if (!isValidWarehouseQr(raw)) return false
                                const p = parseQr(raw)
                                return articlesMatch(p.articleCode, sizeItems[0].artNumber) &&
                                       String(p.size).toUpperCase() === (sizeItems[0].sizeNumber ?? '').toUpperCase()
                              }) : []

                              // QR-only scanned count (excludes manual) — used to cap edit qty
                              const qrScannedCount = (() => {
                                let c = 0
                                scannedQrs.forEach(raw => {
                                  if (!isValidWarehouseQr(raw)) return
                                  const p = parseQr(raw)
                                  if (articlesMatch(p.articleCode, sizeItems[0].artNumber) &&
                                      String(p.size).toUpperCase() === (sizeItems[0].sizeNumber ?? '').toUpperCase()) c++
                                })
                                return c
                              })()
                              const hasManual   = (manualEntries[key] ?? []).length > 0
                              const canEdit     = !allOOS && hasManual && remaining <= 0
                              const canAdd      = !allOOS && remaining > 0
                              const isClickable = canAdd || canEdit

                              return (
                                <tr
                                  key={size}
                                  tabIndex={isClickable ? 0 : undefined}
                                  onKeyDown={isClickable ? e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); e.currentTarget.click() } } : undefined}
                                  onClick={isClickable ? () => {
                                    const repItem = sizeItems.find(i => i.status !== 'out_of_stock') ?? sizeItems[0]
                                    if (canEdit) {
                                      // Edit mode: pre-fill with existing manual total + last MRP
                                      const entries = manualEntries[key] ?? []
                                      const totalManualQty = entries.reduce((s, e) => s + e.qty, 0)
                                      const lastMrp = entries[entries.length - 1]?.mrp ?? ''
                                      // Max allowed = packed - QR scanned (manual slots only)
                                      const editMaxQty = Math.max(0, totalPkd - qrScannedCount)
                                      setManualTarget({ item: repItem, artNumber, color: '', remaining: 0, isEdit: true, editMaxQty })
                                      setManualQty(totalManualQty)
                                      setManualPrice(lastMrp)
                                    } else {
                                      setManualTarget({ item: repItem, artNumber, color: '', remaining })
                                      setManualQty(remaining)
                                      setManualPrice('')
                                    }
                                  } : undefined}
                                  className={`transition-colors select-none ${
                                    allOOS
                                      ? 'bg-red-50/10 dark:bg-red-950/5'
                                      : canEdit
                                      ? 'bg-blue-50/10 dark:bg-blue-950/5 hover:bg-blue-100/20 cursor-pointer active:bg-blue-100/30'
                                      : done
                                      ? 'bg-blue-50/10 dark:bg-blue-950/5'
                                      : remaining > 0
                                      ? 'hover:bg-amber-50/30 dark:hover:bg-amber-950/10 odd:bg-card/30 even:bg-muted/5 cursor-pointer active:bg-amber-100/40'
                                      : 'hover:bg-muted/10 odd:bg-card/30 even:bg-muted/5'
                                  }`}
                                >
                                  <td className="px-3.5 py-2.5 font-mono text-center text-foreground text-xs sm:text-sm font-semibold">
                                    {size}
                                  </td>
                                  <td className="px-2 py-2.5 font-mono text-center text-muted-foreground text-xs sm:text-sm">{totalOrd}</td>
                                  <td className="px-2 py-2.5 font-mono text-center text-xs sm:text-sm font-bold">
                                    {allOOS
                                      ? <span className="text-red-500 font-normal text-[10px] bg-red-50 dark:bg-red-950/30 px-1.5 py-0.5 rounded">OOS</span>
                                      : <span className="text-green-600 dark:text-green-400">{totalPkd}</span>
                                    }
                                  </td>
                                  <td className="px-2 py-2.5 font-mono text-center text-xs sm:text-sm">
                                    {allOOS ? (
                                      <span className="text-muted-foreground font-normal text-[10px]">—</span>
                                    ) : (
                                      <span className={`inline-flex items-center justify-center min-w-8 px-2.5 py-0.5 rounded-full text-xs font-bold leading-none ${
                                        done
                                          ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200/50 dark:border-blue-800/50 shadow-xs'
                                          : partial
                                          ? 'bg-blue-50 text-blue-600 dark:bg-blue-950/20 dark:text-blue-400 border border-blue-100/50 dark:border-blue-900/10'
                                          : 'bg-muted text-muted-foreground/80'
                                      }`}>
                                        {verified}
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-3.5 py-2.5 text-right font-mono text-foreground text-xs sm:text-sm font-semibold whitespace-nowrap">
                                    {!allOOS && priceEntries.length > 0 ? (
                                      <div className="flex flex-wrap gap-1 justify-end max-w-[140px] ml-auto">
                                        {priceEntries.map(([mrp, qty]) => (
                                          <span key={mrp} className="bg-muted px-1.5 py-0.5 rounded text-[10px] font-semibold text-foreground border border-border/30 shadow-xs">
                                            ₹{parseFloat(mrp).toFixed(2)}*{qty}
                                          </span>
                                        ))}
                                      </div>
                                    ) : (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </td>
                                  {showDevTracking && (
                                    <td className="px-3.5 py-2.5 font-mono text-[9px] text-muted-foreground min-w-[350px]">
                                      {sizeScans.length > 0 ? (
                                        <div className="flex flex-col gap-1 max-h-[100px] overflow-y-auto pr-1 items-start">
                                          {sizeScans.map((raw, rIdx) => (
                                            <span key={rIdx} className="bg-muted/80 px-2 py-0.5 rounded select-all inline-block w-fit border border-border/40 text-[8.5px] whitespace-nowrap" title={raw}>
                                              {raw}
                                            </span>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-muted-foreground">—</span>
                                      )}
                                    </td>
                                  )}
                                </tr>
                              )
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          {/* ── Sticky bottom Save Bill button ── */}
          <div className="shrink-0 bg-background/95 backdrop-blur-sm border-t border-border px-4 py-3 safe-area-inset-bottom">
            {/* Disc %, bill type and the bill's total — same arithmetic as the saved bill */}
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor="biller-line-disc" className="text-[11px] text-muted-foreground whitespace-nowrap">Disc %</label>
              <input
                id="biller-line-disc"
                type="number"
                min="0"
                max="100"
                step="0.5"
                placeholder="30"
                value={lineDiscPct}
                onChange={e => setLineDiscPct(e.target.value === '' ? '' : Math.min(100, Math.max(0, parseFloat(e.target.value) || 0)))}
                onBlur={() => { if (lineDiscPct === '') setLineDiscPct(30) }}
                className="w-16 h-7 rounded-lg border border-input bg-background px-2 text-xs text-center focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>
            {needsBillPicker && (
              <label className="flex min-w-[200px] flex-1 items-center gap-2 text-xs font-medium">
                <span className="shrink-0">Who picked it?</span>
                <select value={billPicker} onChange={e => setBillPicker(e.target.value)} required disabled={isPending}
                  className={`h-9 w-full rounded-lg border bg-background px-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${billPicker ? 'border-input' : 'border-amber-400 text-muted-foreground'}`}>
                  <option value="">Choose the picker…</option>
                  {pickers.map(p => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
                </select>
              </label>
            )}
            <div className="min-w-[220px] flex-1">
              <BillTypeChoice compact value={billType} onChange={setBillType} partyDefault={scanOrder.taxType ?? null} disabled={isPending} />
            </div>
            <BillRatesFields compact taxType={billType} defaults={billTemplate ? templateRates(billTemplate) : DEFAULT_BILL_RATES} edits={rateEdits} onChange={setRateEdits} disabled={isPending} />
            {(() => {
              const live = buildScannedLines(scannedQrs, scanItems)
              if (!live.length) return null
              const t = computeBillTotals(live, typeof lineDiscPct === 'number' ? lineDiscPct : 30, billType,
                ratesBp(resolveRates(billType, billTemplate ? templateRates(billTemplate) : DEFAULT_BILL_RATES, rateEdits).rates))
              return (
                <p className="ml-auto text-right text-xs text-muted-foreground">
                  {`Net payable · ${t.totalQty} pairs `}
                  <b className="text-base tabular-nums text-foreground">{formatRs(t.grandTotalPaise)}</b>
                </p>
              )
            })()}
            </div>
            <button
              type="button"
              onClick={scanDirect ? handleDirectSave : handleSaveBill}
              disabled={(scanDirect ? scannedQrs.length === 0 && Object.keys(manualEntries).length === 0 : !allVerified) || isPending || (needsBillPicker && !billPicker)}
              className={`w-full rounded-xl py-3.5 text-sm font-semibold transition-all shadow-sm ${
                allVerified || (scanDirect && scannedQrs.length + Object.keys(manualEntries).length > 0)
                  ? 'bg-blue-600 hover:bg-blue-700 active:scale-[0.98] text-white'
                  : 'bg-muted text-muted-foreground cursor-not-allowed'
              }`}
            >
              {isPending
                ? 'Saving…'
                : scanDirect
                ? (allVerified ? '✓ Save Direct bill' : 'Save Direct bill (check differences)')
                : allVerified
                ? '✓ Save Bill'
                : `Scan all items to enable Save (${Object.values(scannedMap).reduce((a, b) => a + b, 0)} / ${scanItems.filter(i => i.status !== 'out_of_stock').reduce((s, i) => s + i.quantityPacked, 0)})`
              }
            </button>
          </div>
        </div>
      )}

      {/* ── Direct bill differs from the order: keep the changes or adjust ── */}
      {directDiffShown && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 px-4" role="dialog" aria-modal="true" aria-labelledby="direct-diff-title">
          <DialogKeys onClose={() => setDirectDiffShown(null)} />
          <div className="w-full max-w-md rounded-2xl border border-border bg-background p-5 shadow-lg">
            <h2 id="direct-diff-title" className="text-base font-bold">⚠ The bill is different from the order</h2>
            <div className="mt-3 max-h-[50vh] space-y-3 overflow-y-auto text-sm">
              {directDiffShown.short.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not received (marked on the order)</p>
                  <ul className="mt-1 space-y-0.5">
                    {directDiffShown.short.map(x => <li key={x.label} className="flex justify-between gap-3"><span>{x.label}</span><span className="tabular-nums text-red-600 dark:text-red-400">{x.got} of {x.ordered}</span></li>)}
                  </ul>
                </div>
              )}
              {directDiffShown.extra.length > 0 && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not ordered / more than ordered (billed)</p>
                  <ul className="mt-1 space-y-0.5">
                    {directDiffShown.extra.map(x => <li key={x.label} className="flex justify-between gap-3"><span>{x.label}</span><span className="tabular-nums text-amber-700 dark:text-amber-400">+{x.qty}</span></li>)}
                  </ul>
                </div>
              )}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Keep: the bill has exactly what was scanned. Adjust: go back and scan more or undo.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setDirectDiffShown(null)} className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-muted">Adjust</button>
              <button type="button" autoFocus onClick={() => { setDirectDiffShown(null); handleSaveBill() }} className="flex-1 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700">Keep these changes</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Manual verify bottom sheet ── */}
      {manualTarget && (
        <div
          className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/50 backdrop-blur-sm"
          onClick={() => setManualTarget(null)}
        >
          <DialogKeys onClose={() => setManualTarget(null)} />
          <div
            className="bg-background rounded-t-2xl border-t border-border shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>

            {/* Header */}
            <div className="px-5 pt-2 pb-3 border-b border-border">
              <p className="text-sm font-bold text-foreground">
                {manualTarget.isEdit ? 'Edit Manual Verify' : 'Manual Verify'} — <span className="font-mono">{manualTarget.artNumber}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Size {manualTarget.item.sizeNumber ?? '—'}
                {manualTarget.isEdit
                  ? <span className="ml-1 text-blue-600 dark:text-blue-400 font-semibold">· editing manual qty (max {manualTarget.editMaxQty})</span>
                  : <> · <span className="text-amber-600 dark:text-amber-400 font-semibold">{manualTarget.remaining} remaining</span></>
                }
              </p>
              {manualTarget.isEdit && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Scanned (QR) qty is locked — only manual qty &amp; price can be changed.
                </p>
              )}
            </div>

            {/* Inputs */}
            <div className="px-5 py-4 space-y-4">

              {/* Price */}
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-foreground">
                  MRP Price <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground font-semibold">₹</span>
                  <input
                    type="number"
                    min="1"
                    step="0.01"
                    placeholder="e.g. 499"
                    value={manualPrice}
                    onChange={e => setManualPrice(e.target.value === '' ? '' : parseFloat(e.target.value) || '')}
                    autoFocus
                    className="w-full h-11 rounded-xl border border-input bg-background pl-7 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
              </div>

              {/* Qty */}
              {(() => {
                const maxQty = manualTarget.isEdit ? (manualTarget.editMaxQty ?? 0) : manualTarget.remaining
                return (
                  <div className="space-y-1.5">
                    <label className="text-xs font-semibold text-foreground">
                      {manualTarget.isEdit ? 'Manual Qty' : 'Qty to Verify'} <span className="text-red-500">*</span>
                      <span className="ml-1.5 text-muted-foreground font-normal">(max {maxQty})</span>
                    </label>
                    <input
                      type="number"
                      min="1"
                      max={maxQty}
                      step="1"
                      value={manualQty}
                      onChange={e => {
                        const v = parseInt(e.target.value)
                        setManualQty(isNaN(v) ? '' : Math.min(v, maxQty))
                      }}
                      className="w-full h-11 rounded-xl border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                )
              })()}
            </div>

            {/* Actions */}
            <div className="px-5 pb-6 flex gap-3">
              <button
                type="button"
                onClick={() => setManualTarget(null)}
                className="flex-1 h-11 rounded-xl border border-border bg-card text-sm font-semibold text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={!manualPrice || !manualQty || Number(manualPrice) <= 0 || Number(manualQty) <= 0}
                onClick={handleManualConfirm}
                className="flex-1 h-11 rounded-xl bg-blue-600 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {manualTarget.isEdit ? 'Update' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Sticky bottom bar — Mail the ticked bills (on phones above the bottom menu bar) ── */}
      {activeTab === 'generated' && printSelectedIds.size > 0 && (() => {
        const selectedOrders = billedOrders.filter(o => printSelectedIds.has(o.id))
        const allLoaded = selectedOrders.every(o => !!printItemsMap[o.id])
        const noneSelected = selectedOrders.length === 0
        return (
          <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] left-0 right-0 z-30 bg-background/95 backdrop-blur-sm border-t border-border md:bottom-0">
            <div className="max-w-2xl mx-auto px-3 sm:px-4 py-2.5 flex items-center gap-2">

              {/* Selection badge + loading */}
              {selectedOrders.length > 0 && (
                <div className="flex items-center gap-2 mr-auto min-w-0">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground shrink-0">
                    <svg className="w-3 h-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    {selectedOrders.length} bill{selectedOrders.length !== 1 ? 's' : ''}
                  </span>
                  {!allLoaded && (
                    <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin shrink-0" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  )}
                </div>
              )}

              {/* Mail button */}
              <button
                type="button"
                disabled={noneSelected}
                onClick={() => handleMailBills(selectedOrders)}
                className={`flex items-center justify-center gap-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0 ${
                  noneSelected ? 'hidden' : ''
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Mail
              </button>

            </div>
          </div>
        )
      })()}

      {mailOrderIds && <BillMailDialog orderIds={mailOrderIds} onClose={() => setMailOrderIds(null)} />}

      {previewOrder && (
        <BillPreviewDialog
          bill={previewOrder}
          template={billTemplate}
          defaultPageSize={printConfig.pageSize}
          fallbackLines={mrpLinesMap[previewOrder.id]}
          fallbackDiscPct={lineDiscPct === '' ? 30 : Number(lineDiscPct)}
          onClose={() => setPreviewOrder(null)}
          onEdit={previewOrder.status === 'billed' ? () => { const o = previewOrder; setPreviewOrder(null); setEditBillOrder(o) } : undefined}
          onCancelBill={previewOrder.status === 'billed' ? () => { if (confirmCancelBill(previewOrder)) setPreviewOrder(null) } : undefined}
        />
      )}

      {/* ── Print Config Modal ── */}
      {printConfigOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogKeys onClose={() => setPrintConfigOpen(false)} />
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/50 backdrop-blur-sm"
            onClick={() => setPrintConfigOpen(false)}
          />

          {/* Modal card */}
          <div className="relative z-10 w-full max-w-sm rounded-2xl bg-background border border-border shadow-xl overflow-hidden">

            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                <h2 className="text-sm font-semibold text-foreground">Print Options</h2>
              </div>
              <button
                type="button"
                onClick={() => setPrintConfigOpen(false)}
                className="text-muted-foreground hover:text-foreground transition-colors"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-5">

              {/* Page Size */}
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Bill size</p>
                <div className="flex gap-2">
                  {(['A4', 'A5'] as PageSize[]).map(size => (
                    <button
                      key={size}
                      type="button"
                      onClick={() => setPrintConfig(c => ({ ...c, pageSize: size }))}
                      className={`flex-1 py-2.5 rounded-xl border text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                        printConfig.pageSize === size
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border bg-card text-foreground hover:bg-muted'
                      }`}
                    >
                      {size === 'A4' ? 'Big bill (A4)' : 'Small bill (A5)'}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1.5">
                  {printConfig.pageSize === 'A4' ? 'Full sheet, 210 × 297 mm' : 'Half sheet, 148 × 210 mm'}
                </p>
              </div>

            </div>

            {/* Footer actions */}
            <div className="flex gap-2 px-5 pb-5">
              <button
                type="button"
                onClick={() => setPrintConfigOpen(false)}
                className="flex-1 h-11 rounded-xl border border-border bg-card text-sm font-semibold text-foreground hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
              <button data-primary
                type="button"
                onClick={confirmPrint}
                className="flex-1 h-11 rounded-xl bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Print
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  )
}

/** Small mark for a bill made without the picker (Direct bill). */
function DirectBillBadge() {
  return (
    <span title="Direct bill (no picker)" className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">
      ⚡ Direct
    </span>
  )
}
