'use client'

import { sizeWithCode } from '@/lib/orders/size-label'
import { columnsFor, pickListHtml } from '@/lib/orders/pick-list-print'
import { mergeMatrix, matrixPairs } from '@/lib/orders/order-lines'
import { PaperEstimate } from '@/components/orders/paper-estimate'
import { useState, useTransition, useRef, useEffect, useMemo, useId, useCallback, forwardRef, useImperativeHandle, Fragment } from 'react'
import { useAutoRefresh } from '@/lib/use-auto-refresh'
import { StatusPill, ChangeTag, fmt, PageHeader, StatButton, SegTabs, SidePanel, isInProgress, type SegTab } from '../_components/shared'
import { createOrder, updateOrder, cancelOrder, getOlderSalesmanOrders, getSalesmanOrderWithItems, salesmanAssignPicker } from '@/app/actions/orders'
import { BillingScannerPage } from '@/components/billing-scanner-page'
import { getBillTemplate } from '@/app/actions/bill-template'
import { templateRates } from '@/lib/bill-template'
import type { BillRates } from '@/lib/billing/bill-totals'
import { PageNav } from '@/components/page-nav'
import { useShowMore } from '@/components/show-more'
import { fuzzyFilter } from '@/lib/fuzzy'
import type { ArticleDetail, CatalogueData } from '@/app/actions/catalogue'
import { useShortcut, useShortcutHelp, type ShortcutHelp } from '@/lib/shortcuts'
import { useListKeys } from '@/lib/shortcuts/list'
import { openKeyboardHelp } from '@/components/keyboard-help'
import type { OrderSet } from '@/app/actions/sets'
import { DialogKeys } from '@/components/dialog-keys'
import { CreditNote, isCreditHold, useCreditStatus } from '@/components/payments/credit-note'
import {
  deleteDraft, draftArticles, draftHasContent, draftPairs, draftStorageKey, readDrafts, saveDraft,
  type OrderDraft, type OrderLine, type SizeEntry,
} from '@/lib/orders/drafts'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ExistingOrder {
  id: number
  orderNumber: string
  shopkeeperName: string
  shopkeeperAddress?: string | null
  status: string
  notes: string | null
  orderedAt: Date
  updatedAt: Date
  salesmanName?: string | null
}

// Statuses the salesman can still edit or cancel
// packed and billed are included so the salesman can edit after biller sends back
const EDITABLE_STATUSES = ['pending', 'assigned', 'packed', 'billed']

interface Props {
  orders: ExistingOrder[]
  userName: string
  /** Whose drafts on this phone (falls back to the name). */
  userId?: string
  embedded?: boolean
  catalogue: CatalogueData
  sets: OrderSet[]
  pickers: { id: string; name: string | null }[]
  /** Admin: each open order also has ⚡ Direct bill (skip the picking screen, straight to the biller). */
  canDirectBill?: boolean
}

/** Orders a picker can still be given, or that can be sent straight to billing. */
const OPEN_FOR_PICKING = ['pending', 'assigned']

// Alias types that were previously imported from catalogue actions
type ShopkeeperResult = CatalogueData['vendors'][number]
type ArticleResult = { artNumber: string }

// OrderLine (article + colour + per-size quantities; size key = size, or "CODE:size" when a colour
// spans several codes) and SizeEntry live in lib/orders/drafts.ts, shared with the drafts.
const sizeKey = (s: SizeEntry) => s.key ?? s.sizeLabel
const isMultiCode = (sizes: SizeEntry[]) => sizes.some(s => sizeKey(s) !== s.sizeLabel)

/** A set (size → pairs) onto this colour's keys: the first size with that label gets it. */
function toKeyed(q: Record<string, number>, sizes: SizeEntry[]): Record<string, number> {
  if (!isMultiCode(sizes)) return { ...q }
  const out: Record<string, number> = {}
  for (const [label, n] of Object.entries(q)) {
    const hit = sizes.find(s => s.sizeLabel === label && !(sizeKey(s) in out))
    if (hit) out[sizeKey(hit)] = n
  }
  return out
}
/** Keys back to plain sizes (for "Last Used" sets). */
function toLabelled(q: Record<string, number>, sizes: SizeEntry[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, n] of Object.entries(q)) {
    const label = sizes.find(s => sizeKey(s) === k)?.sizeLabel ?? k
    if (!(label in out)) out[label] = n
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour swatch
// ─────────────────────────────────────────────────────────────────────────────

const SWATCHES: Record<string, string> = {
  brown: '#8B5E3C', black: '#1a1a1a', tan: '#D2A679', white: '#F0EDE8',
  red: '#C0392B', navy: '#1B3A6B', grey: '#6B7280', gray: '#6B7280',
  blue: '#2563EB', green: '#16A34A', yellow: '#CA8A04', pink: '#DB2777',
  orange: '#EA580C', purple: '#9333EA', beige: '#E8D8C0', cream: '#FFF8E7',
}
function swatch(hex: string | null, name: string) {
  return hex ?? SWATCHES[name.toLowerCase()] ?? '#9CA3AF'
}

// ─────────────────────────────────────────────────────────────────────────────
// SearchCombobox — generic, accessible, debounced
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
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  pattern?: string
}

export interface SearchComboboxHandle {
  focus: () => void
}

const SearchCombobox = forwardRef(function SearchComboboxInner<T>(
  {
    id, label, required, placeholder, inputValue, onInputChange,
    onSelect, onClear, results, loading, renderOption, getKey, disabled,
    inputMode, pattern,
  }: SearchComboboxProps<T>,
  ref: React.Ref<SearchComboboxHandle>,
) {
  const [open, setOpen] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const listId = useId()
  // Focus placed by the page (cursor ready for typing) must not pop the list open; the list
  // opens on typing, ↑/↓ or a click.
  const quietFocus = useRef(false)

  useImperativeHandle(ref, () => ({
    focus: () => {
      quietFocus.current = true
      inputRef.current?.focus()
      inputRef.current?.select()
      quietFocus.current = false
    },
  }))

  useEffect(() => {
    function outside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => document.removeEventListener('mousedown', outside)
  }, [])

  // Auto-scroll the active item into view when activeIdx changes or list opens
  useEffect(() => {
    if (!open || !listRef.current) return
    const activeEl = listRef.current.children[activeIdx] as HTMLElement | undefined
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' })
    }
  }, [activeIdx, open])

  // In a dropup popup (bottom-full), the items visually flow upward from the input:
  // Item 0 (most accurate / best match) sits right above the input (at the bottom of the list box).
  // Thus, when results change or list opens, default active selection is item 0 (bottom).
  // ArrowUp moves towards less accurate items (index increases, visually moving upward).
  // ArrowDown moves towards more accurate items (index decreases, visually moving downward towards input).
  const displayedResults = results

  useEffect(() => {
    if (displayedResults.length > 0) {
      setActiveIdx(0)
      if (listRef.current) {
        listRef.current.scrollTop = listRef.current.scrollHeight
      }
    }
  }, [displayedResults])

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { setOpen(true); e.preventDefault() }
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, displayedResults.length - 1))
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      // Ctrl+Enter is left to the page shortcut (create the order).
      e.preventDefault()
      const item = displayedResults[activeIdx]
      if (item) { onSelect(item); setOpen(false); inputRef.current?.blur() }
    } else if (e.key === 'Escape') { setOpen(false); inputRef.current?.blur() }
  }

  return (
    <div ref={containerRef} className="relative">
      <label htmlFor={id} className="block text-xs font-medium text-muted-foreground mb-1.5">
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
          inputMode={inputMode}
          pattern={pattern}
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={open && displayedResults[activeIdx] ? `${listId}-${activeIdx}` : undefined}
          value={inputValue}
          placeholder={placeholder}
          autoComplete="off"
          disabled={disabled}
          onChange={e => { onInputChange(e.target.value); setOpen(true) }}
          onFocus={() => { if (!quietFocus.current) setOpen(true) }}
          onClick={() => setOpen(true)}
          onKeyDown={handleKey}
          className="w-full rounded-xl border border-border bg-background pl-9 pr-9 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
          className="absolute z-50 bottom-full mb-1 w-full rounded-xl border border-border bg-card shadow-xl overflow-hidden max-h-60 overflow-y-auto flex flex-col-reverse"
        >
          {loading && <li className="px-4 py-3 text-sm text-muted-foreground">Searching…</li>}
          {!loading && displayedResults.length === 0 && (
            <li className="px-4 py-3 text-sm text-muted-foreground">No results found</li>
          )}
          {!loading && displayedResults.map((item, i) => (
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

// ─────────────────────────────────────────────────────────────────────────────
// OrderItemsCard — consolidated table view matching the screenshot layout
// Article | Color | Size/Qty — article name only on first row of its group
// ─────────────────────────────────────────────────────────────────────────────

interface OrderItemsCardProps {
  lines: OrderLine[]
  editingLineId: string | null
  onEdit: (line: OrderLine) => void
  onDeselect: () => void
}

function OrderItemsCard({ lines, editingLineId, onEdit, onDeselect }: OrderItemsCardProps) {
  // Group lines by artNumber, most recently added first (owner, 24 Nov 2026): the article just added
  // is on top, its newest colour first. Display only — the saved order keeps the entry order.
  const groups: { artNumber: string; lines: OrderLine[] }[] = []
  const seen = new Map<string, OrderLine[]>()
  for (const line of [...lines].reverse()) {
    if (!seen.has(line.artNumber)) {
      const group: OrderLine[] = []
      seen.set(line.artNumber, group)
      groups.push({ artNumber: line.artNumber, lines: group })
    }
    seen.get(line.artNumber)!.push(line)
  }

  const totalPairs = lines.reduce((s, l) => s + Object.values(l.quantities).reduce((a, b) => a + b, 0), 0)
  let serial = 0 // line number, 1, 2, 3… down the table

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        {/* Header */}
        <thead>
          <tr className="border-b border-border/50 bg-muted/20">
            <th className="w-8 px-2 py-2 text-right text-xs font-medium text-muted-foreground border-r border-border/40">#</th>
            <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground border-r border-border/40 whitespace-nowrap">Article</th>
            <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground border-r border-border/40 whitespace-nowrap">Color</th>
            <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Size / Qty</th>
          </tr>
        </thead>

        <tbody>
          {groups.map(group =>
            group.lines.map((line, lineIdx) => {
              const isFirst = lineIdx === 0
              const isEditing = editingLineId === line.id
              const sizeCols = line.sizes
                .filter((sz, i, arr) => arr.findIndex(s => sizeKey(s) === sizeKey(sz)) === i)
                .filter(sz => (line.quantities[sizeKey(sz)] ?? 0) > 0)
              const showCode = isMultiCode(sizeCols)

              return (
                <tr
                  key={line.id}
                  tabIndex={0}
                  aria-label={`${isEditing ? 'Stop editing' : 'Edit'} ${group.artNumber} ${line.colorName}`}
                  onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (isEditing) onDeselect(); else onEdit(line) } }}
                  onClick={() => isEditing ? onDeselect() : onEdit(line)}
                  className={`border-b border-border/40 transition-colors cursor-pointer ${
                    isEditing ? 'bg-amber-50/40 dark:bg-amber-900/10' : 'hover:bg-primary/5'
                  }`}
                >
                  {/* Line number, 1, 2, 3… top to bottom (owner, 24 Nov 2026) */}
                  <td className="w-8 px-2 py-2.5 align-top text-right text-xs tabular-nums text-muted-foreground border-r border-border/40">{++serial}</td>
                  {/* Article cell — only shown on first row of group */}
                  <td className="px-3 py-2.5 align-top border-r border-border/40 whitespace-nowrap">
                    {isFirst && (
                      <span className="font-bold text-xs text-foreground">{group.artNumber}</span>
                    )}
                  </td>

                  {/* Color */}
                  <td className="px-3 py-2.5 align-middle border-r border-border/40 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span
                        className="w-2.5 h-2.5 rounded-full border border-border/60 flex-shrink-0"
                        style={{ background: swatch(line.colorHex, line.colorName) }}
                        aria-hidden
                      />
                      <span className="font-medium text-foreground uppercase tracking-wide text-xs">
                        {line.colorName}
                      </span>
                    </div>
                  </td>

                  {/* Size / Qty */}
                  <td className="px-3 py-2.5 align-middle">
                    <span className="flex flex-wrap gap-x-2 gap-y-0.5">
                      {sizeCols.map(sz => (
                        <span key={sizeKey(sz)} className="text-xs text-muted-foreground whitespace-nowrap">
                          {sz.sizeLabel}{showCode && sz.artCode ? <span className="text-[10px]" data-no-translate>{` (${sz.artCode})`}</span> : null}/<span className="font-bold text-foreground">{line.quantities[sizeKey(sz)]}</span>
                        </span>
                      ))}
                    </span>
                  </td>
                </tr>
              )
            })
          )}

          {/* Total row */}
          <tr className="border-t border-border/60 bg-muted/20">
            <td colSpan={3} className="px-3 py-2 text-right text-xs text-muted-foreground border-r border-border/40">Total</td>
            <td className="px-3 py-2 text-sm font-bold text-foreground">{totalPairs}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// SizeMatrix — single color, quick buttons + manual input
// ─────────────────────────────────────────────────────────────────────────────

const QUICK_QTYS = [1, 2, 3, 4, 5]

interface SizeMatrixProps {
  sizes: SizeEntry[]
  quantities: Record<string, number>
  onChange: (quantities: Record<string, number>) => void
  /** Keyboard: Enter (shift = add and stay on this article), Shift+1…9 (colour N), Esc. */
  onEnter?: (shift: boolean) => void
  onColour?: (n: number) => void
  onEscape?: () => void
}

export interface SizeMatrixHandle { focus: () => void }

// The New Order keyboard flow: keys the focused control handles itself (search boxes, colour chips,
// size matrix, Next Article / Add buttons). Listed in the global "?" cheat sheet from the registry;
// Ctrl+Enter (create the order) is a real shortcut registered below.
const NEW_ORDER_KEYS: ShortcutHelp[] = [
  { keys: 'enter', label: 'Go to the next step: vendor → article → colour → sizes' },
  { keys: 'enter', label: 'On sizes: next size; after the last size, go to Next Article / Add to Order' },
  { keys: ['arrowleft', 'arrowright'], label: 'On the buttons: switch between Next Article and Add to Order (Enter presses, ↑ or Esc back to sizes)' },
  { keys: ['arrowup', 'arrowdown'], label: 'Move in a list (vendors, articles) or between sizes' },
  { display: '1, 2, 3…', label: 'On colours: pick colour 1, 2, 3…' },
  { keys: ['arrowleft', 'arrowright'], label: 'On colours: move · On sizes: quantity −1 / +1' },
  { display: 'Numbers', label: 'On sizes: type the quantity (1 then 0 = 10)' },
  { keys: 'backspace', label: 'On sizes: remove the last digit' },
  { keys: 'shift+enter', label: 'Add this colour and stay on the article' },
  { display: 'Shift 1, 2…', label: 'From the sizes: switch to colour 1, 2…' },
  { keys: 'escape', label: 'On Next Article / Add to Order or a size button: back to the sizes. On the sizes: skip this article (nothing added)' },
  { keys: 'enter', label: 'On an empty article search: go to Create Order' },
]

/** Keyboard help on New Order (computers only): the "?" button (or the ? key) opens the global cheat sheet. */
function ShortcutGuide() {
  useShortcutHelp(NEW_ORDER_KEYS, { group: 'New order' })
  return (
    <div className="relative hidden justify-end [@media(pointer:fine)]:flex">
      <button type="button" onClick={openKeyboardHelp} aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)"
        className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-card text-sm font-bold hover:bg-muted">?</button>
    </div>
  )
}

// Keyboard (laptop / Bluetooth keyboard): ↑↓ size · ←→ quantity −1/+1 · type a number (1 then 0 = 10)
// · Backspace removes a digit · Enter next size (after the last: Next Article / Add buttons, ←→) · Shift+Enter add, stay ·
// Shift+1…9 colour N · Esc next article without adding. Touch use is unchanged.
const SizeMatrix = forwardRef<SizeMatrixHandle, SizeMatrixProps>(function SizeMatrix({ sizes, quantities, onChange, onEnter, onColour, onEscape }, ref) {
  // manualActive[size] = true means manual input controls it
  const [manualActive, setManualActive] = useState<Record<string, boolean>>({})
  const [row, setRow] = useState(0)
  const [kbd, setKbd] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  // Digits typed on the current size (cleared when the size changes): 1 then 0 = 10.
  const typed = useRef<{ row: number; text: string }>({ row: -1, text: '' })

  useImperativeHandle(ref, () => ({ focus: () => { setKbd(true); boxRef.current?.focus({ preventScroll: false }) } }), [])

  function setQty(sizeLabel: string, qty: number) {
    onChange({ ...quantities, [sizeLabel]: Math.max(0, qty) })
  }

  function handleQuickClick(sizeLabel: string, qty: number) {
    const current = quantities[sizeLabel] ?? 0
    // Double-tap: clicking the already-active chip deselects it (sets to 0)
    const next = !manualActive[sizeLabel] && current === qty ? 0 : qty
    setManualActive(prev => ({ ...prev, [sizeLabel]: false }))
    setQty(sizeLabel, next)
  }

  function handleManualChange(sizeLabel: string, raw: string) {
    setManualActive(prev => ({ ...prev, [sizeLabel]: true }))
    const n = parseInt(raw)
    setQty(sizeLabel, isNaN(n) || n < 0 ? 0 : n)
  }

  function handleKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const inInput = (e.target as HTMLElement).tagName === 'INPUT'
    // A focused chip: Enter / Space press it (the box's Enter = next size; Shift+Enter still adds).
    if ((e.target as HTMLElement).tagName === 'BUTTON' && !e.shiftKey && (e.key === 'Enter' || e.key === ' ')) return
    const digit = /^(Digit|Numpad)([0-9])$/.exec(e.code)?.[2]
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      // Enter: next size; on the last size, add this colour and go to the next article.
      // Shift+Enter: add this colour now and stay on the article.
      const last = sizes.length - 1
      const at = Math.min(row, last)
      if (!e.shiftKey && at < last) { setKbd(true); setRow(at + 1); typed.current = { row: -1, text: '' }; return }
      onEnter?.(e.shiftKey)
      return
    }
    // Esc on a size chip or quantity box: back to the size bar (the matrix). Esc on the size bar: skip the article.
    if (e.key === 'Escape') { e.preventDefault(); if (e.target !== boxRef.current) { setKbd(true); boxRef.current?.focus() } else onEscape?.(); return }
    if (e.shiftKey && digit && digit !== '0') { e.preventDefault(); onColour?.(Number(digit)); return }
    if (inInput || e.ctrlKey || e.metaKey || e.altKey || !sizes.length) return
    // On a focused chip the arrows move between chips (page arrow navigation); digits still type.
    if ((e.target as HTMLElement).tagName === 'BUTTON' && e.key.startsWith('Arrow')) return
    const r = Math.min(row, sizes.length - 1)
    const label = sizeKey(sizes[r])
    const current = quantities[label] ?? 0
    setKbd(true)
    if (e.key === 'ArrowDown') { e.preventDefault(); setRow(Math.min(sizes.length - 1, r + 1)); typed.current.text = ''; return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setRow(Math.max(0, r - 1)); typed.current.text = ''; return }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      setManualActive(prev => ({ ...prev, [label]: false }))
      setQty(label, current + (e.key === 'ArrowRight' ? 1 : -1))
      typed.current.text = ''
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      const t = typed.current
      const text = t.row === r && e.key === 'Backspace' ? t.text.slice(0, -1) : ''
      typed.current = { row: r, text }
      setQty(label, text ? parseInt(text, 10) : 0)
      return
    }
    if (digit && !e.shiftKey) {
      e.preventDefault()
      const t = typed.current
      // Keep adding digits on the same size (max 3); a 4th digit starts a new number.
      const text = t.row === r && t.text && t.text.length < 3 ? (t.text === '0' ? digit : t.text + digit) : digit
      typed.current = { row: r, text }
      setManualActive(prev => ({ ...prev, [label]: false }))
      setQty(label, parseInt(text, 10))
    }
  }

  const colorTotal = sizes.reduce((s, sz) => s + (quantities[sizeKey(sz)] ?? 0), 0)
  const multi = isMultiCode(sizes)

  // Responsive column sizes: on very small screens chips shrink to 2rem, on sm+ stay 2.5rem
  const gridCols = 'minmax(2rem,auto) repeat(5, minmax(0,2.5rem)) minmax(0,3.5rem) 2.5rem'

  return (
    <div ref={boxRef} tabIndex={0} onKeyDown={handleKey} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setKbd(false) }}
      className="space-y-1 rounded-lg outline-none" aria-label="Size matrix">
      {/* Header row */}
      <div className="grid items-center gap-y-0 gap-x-1" style={{ gridTemplateColumns: gridCols }}>
        <span className="text-xs font-medium text-muted-foreground leading-tight">Size</span>
        {QUICK_QTYS.map(q => (
          <span key={q} className="text-xs font-medium text-muted-foreground text-center">{q}</span>
        ))}
        <span className="text-xs font-medium text-muted-foreground text-center">Qty</span>
        <span className="text-xs font-medium text-muted-foreground text-center">=</span>
      </div>

      {/* Size rows */}
      {sizes.map((sz, i) => {
        const k = sizeKey(sz)
        const current = quantities[k] ?? 0
        const isManual = manualActive[k]
        const focused = kbd && i === Math.min(row, sizes.length - 1)
        // One colour, several article codes: a heading per code (SS0101C 11–1 · SS0101G 6–10 · SS0101S 11–12).
        const groupStart = multi && (i === 0 || sizes[i - 1].artCode !== sz.artCode)
        const group = groupStart ? sizes.filter(x => x.artCode === sz.artCode) : []
        return (
          <Fragment key={sz.id}>
          {groupStart && (
            <div className="mt-1.5 flex items-center gap-2 border-t border-border pt-1.5 text-[11px] font-semibold text-muted-foreground">
              <span className="font-mono text-foreground" data-no-translate>{sz.artCode}</span>
              <span>{`Sizes ${group[0].sizeLabel}–${group[group.length - 1].sizeLabel}`}</span>
            </div>
          )}
          <div
            onClick={() => setRow(i)}
            className={`grid items-center gap-y-0 gap-x-1 rounded-lg py-0.5 ${focused ? 'bg-[var(--focus-tint)] shadow-[0_0_14px_1px_var(--focus-glow)]' : ''}`}
            style={{ gridTemplateColumns: gridCols }}
          >
            <span className="text-sm font-medium text-foreground truncate pr-1 leading-tight">{sz.sizeLabel}</span>
            {QUICK_QTYS.map(q => {
              const isActive = !isManual && current === q
              // Active chip = green outline only. All other chips = normal grey.
              const chipClass = isActive
                ? 'border-green-400 bg-background text-green-700 dark:text-green-400 dark:border-green-600'
                : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
              return (
                <button
                  key={q}
                  type="button"
                  onFocus={() => { setKbd(true); setRow(i) }}
                  aria-label={`Set ${sz.sizeLabel}${multi ? ` ${sz.artCode}` : ''} to ${q}`}
                  aria-pressed={isActive}
                  onClick={() => handleQuickClick(k, q)}
                  className={`h-8 w-full rounded-lg text-sm font-semibold border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${chipClass}`}
                >
                  {q}
                </button>
              )
            })}
            <input
              type="number"
              min={0}
              aria-label={`Manual quantity for size ${sz.sizeLabel}${multi ? ` ${sz.artCode}` : ''}`}
              value={isManual ? (current === 0 ? '' : current) : (current > 5 ? current : '')}
              placeholder="0"
              onChange={e => handleManualChange(k, e.target.value)}
              onFocus={() => { setManualActive(prev => ({ ...prev, [k]: true })); setKbd(true); setRow(i) }}
              className={`h-8 w-full rounded-lg border text-xs text-center font-medium bg-background focus:outline-none focus:ring-2 focus:ring-ring transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                (isManual && current > 0) || current > 5
                  ? 'border-green-400 text-green-700 dark:text-green-400 dark:border-green-600'
                  : 'border-border text-muted-foreground'
              }`}
            />
            <span className={`text-xs font-bold text-center ${current > 0 ? 'text-foreground' : 'text-muted-foreground'}`}>
              {current}
            </span>
          </div>
          </Fragment>
        )
      })}

      {/* Color total row */}
      <div className="flex items-center justify-end gap-3 pt-2 border-t border-border">
        <span className="text-sm text-muted-foreground">Total pairs for this color</span>
        <span className="text-xl font-bold text-foreground">{colorTotal}</span>
      </div>
    </div>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// ConfirmDialog
// ─────────────────────────────────────────────────────────────────────────────

function ConfirmDialog({
  title, message, confirmLabel, onCancel, onConfirm,
}: {
  title: string
  message: React.ReactNode
  confirmLabel: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <DialogKeys onClose={onCancel} />
      <div className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl space-y-4">
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="text-sm text-muted-foreground">{message}</div>
        <div className="flex gap-3 pt-1">
          {/* Every use loses work (replace quantities, start over, discard, cancel order): Cancel has the focus first. */}
          <button type="button" onClick={onCancel} data-autofocus
            className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors">
            Cancel
          </button>
          <button type="button" onClick={onConfirm} data-primary data-destructive
            className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors">
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Returns 'new' if created within 24 h and never edited, 'updated' if edited after creation, else null */
function orderTag(order: ExistingOrder): 'new' | 'updated' | null {
  const now = Date.now()
  const created = new Date(order.orderedAt).getTime()
  const updated = new Date(order.updatedAt).getTime()
  if (Math.abs(updated - created) > 5000) return 'updated'          // edited >5 s after creation
  if (now - created < 24 * 60 * 60 * 1000) return 'new'             // created within last 24 h
  return null
}

function linePairs(line: OrderLine) {
  return Object.values(line.quantities).reduce((s, n) => s + n, 0)
}

function uid() {
  return Math.random().toString(36).slice(2, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
// LiveBadge — shows last-refreshed time and a manual refresh button
// ─────────────────────────────────────────────────────────────────────────────

function LiveBadge({ lastRefreshed, onRefresh }: { lastRefreshed: Date; onRefresh: () => void }) {
  const [, tick] = useState(0)

  // Re-render every 30 s so the "X min ago" text stays accurate
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  function ago(d: Date) {
    const diff = Math.floor((Date.now() - d.getTime()) / 1000)
    if (diff < 10) return 'just now'
    if (diff < 60) return `${diff}s ago`
    const m = Math.floor(diff / 60)
    return `${m}m ago`
  }

  return (
    <div className="flex items-center justify-between text-[11px] text-muted-foreground px-0.5">
      <span className="flex items-center gap-1.5">
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
        Live · updated {ago(lastRefreshed)}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        title="Refresh now"
      >
        <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582M20 20v-5h-.581M4.582 9A8 8 0 0120 15M19.418 15A8 8 0 014 9" />
        </svg>
        Refresh
      </button>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dashboard component
// ─────────────────────────────────────────────────────────────────────────────

// ── Detail view types ──
interface DetailItem {
  id: number
  artNumber: string
  colorNumber: string | null
  sizeNumber: string | null
  artCode?: string | null
  quantityOrdered: number
  quantityPacked: number
  status: string
}

type View = 'list' | 'new' | 'detail' | 'print'
/** All Orders filter: one status, or the "In progress" group (same rule as its card). */
type StatusFilter = 'all' | 'pending' | 'in_progress' | 'dispatched' | 'delivered' | 'cancelled'
const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'dispatched', label: 'Dispatched' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
]
const matchesStatus = (status: string, f: StatusFilter) =>
  f === 'all' ? true : f === 'in_progress' ? isInProgress(status) : status === f

export function SalesmanDashboard({ orders: recentOrders, userName, userId, embedded, catalogue: serverCatalogue, sets = [], pickers = [], canDirectBill = false }: Props) {
  // The page sends open orders + the last 60 days (max 2000). "Load older" adds 100 at a time
  // (keyset after the oldest shown); repeats are dropped, so the list never shows an order twice.
  const [older, setOlder] = useState<ExistingOrder[]>([])
  const [olderState, setOlderState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  // Orders this screen just saved, as the server returned them: shown at once, until the refreshed
  // list (same id, same or newer update time) takes over. Never a guess — always the saved row.
  const [saved, setSaved] = useState<ExistingOrder[]>([])
  const orders = useMemo(() => {
    const byId = new Map<number, ExistingOrder>()
    for (const o of [...recentOrders, ...older, ...saved]) {
      const p = byId.get(o.id)
      if (!p || new Date(o.updatedAt).getTime() > new Date(p.updatedAt).getTime()) byId.set(o.id, o)
    }
    return [...byId.values()]
  }, [recentOrders, older, saved])
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 3000)
    return () => clearTimeout(t)
  }, [notice])
  const keepSaved = useCallback((row: ExistingOrder, salesmanName: string | null) => {
    setSaved(prev => [...prev.filter(o => o.id !== row.id), { ...row, salesmanName: row.salesmanName ?? salesmanName }])
  }, [])
  const loadOlder = useCallback(async () => {
    // Continue after the oldest order that is closed or recent (or already loaded as older). An open
    // order older than 60 days is on the first page too, but starting after it would skip history.
    const line = Date.now() - 60 * 86_400_000
    const from = [...recentOrders.filter(o => ['delivered', 'cancelled'].includes(o.status) || new Date(o.orderedAt).getTime() >= line), ...older]
      .sort((a, b) => new Date(a.orderedAt).getTime() - new Date(b.orderedAt).getTime() || a.id - b.id)[0]
    setOlderState('loading')
    try {
      const page = await getOlderSalesmanOrders(from?.id ?? null)
      setOlder(prev => [...prev, ...page])
      setOlderState(page.length < 100 ? 'done' : 'idle')
    } catch {
      setOlderState('error')
    }
  }, [recentOrders, older])
  // The catalogue as given: loaded on the server by the page, or by the admin hub from its browser
  // copy (lib/use-catalogue-cache.ts). Never swapped here for an older saved copy (24 Nov 2026).
  const catalogue = serverCatalogue

  const [view, setView] = useState<View>('new')
  // Keyboard: ↑↓ / j k orders, Enter opens, / search, n New order (lib/shortcuts/list.ts).
  const ordersListRef = useRef<HTMLDivElement>(null)
  useListKeys(ordersListRef, { label: 'Orders list', newLabel: 'New order', onNew: () => goTo('new') })

  // ── Auto-refresh (All Orders stays live) ──
  const [lastRefreshed, setLastRefreshed] = useState<Date>(() => new Date())
  const { refresh: rawRefresh } = useAutoRefresh(30_000)
  const refresh = useCallback(() => {
    rawRefresh()
    setLastRefreshed(new Date())
  }, [rawRefresh])
  // Update lastRefreshed whenever orders prop changes (server pushed new data)
  useEffect(() => { setLastRefreshed(new Date()) }, [orders])

  // ── Detail view state ──
  const [detailOrder, setDetailOrder] = useState<ExistingOrder | null>(null)
  const [detailItems, setDetailItems] = useState<DetailItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')

  // ── Filter + sort state ──
  const [filterStatus, setFilterStatus] = useState<StatusFilter>('all')
  const [filterSalesman, setFilterSalesman] = useState<string>(userName || 'all')
  const [search, setSearch] = useState('')
  const [sortBy, setSortBy] = useState<'date-desc' | 'date-asc' | 'order'>('date-desc')

  // ── SizeMatrix reset key — increment to force SizeMatrix remount after Add to Order ──
  const [matrixKey, setMatrixKey] = useState(0)

  // ── Shopkeeper state ──
  const [skQuery, setSkQuery] = useState('')
  const [skResults, setSkResults] = useState<ShopkeeperResult[]>([])
  const [skLoading, setSkLoading] = useState(false)
  const [selectedSk, setSelectedSk] = useState<ShopkeeperResult | null>(null)
  // Party balance / credit hold (payments, owner 22 Nov 2026): shown when the vendor is chosen.
  const credit = useCreditStatus(selectedSk ? { name: selectedSk.name } : null)
  const [allowHeld, setAllowHeld] = useState(false)
  useEffect(() => { setAllowHeld(false) }, [selectedSk?.name])
  // Why the last Create / Save failed (shown above the bottom bar, whatever section is open).
  const [submitError, setSubmitError] = useState('')

  // ── Article entry state ──
  const [artQuery, setArtQuery] = useState('')
  const [artResults, setArtResults] = useState<ArticleResult[]>([])
  const [artLoading, setArtLoading] = useState(false)
  const [selectedArt, setSelectedArt] = useState<ArticleDetail | null>(null)
  const artSearchRef = useRef<SearchComboboxHandle>(null)
  const artSectionRef = useRef<HTMLElement>(null)
  const currentOrderSectionRef = useRef<HTMLElement>(null)

  // ── Per-color entry state ──
  // selectedColorId: which color chip is active
  const [selectedColorId, setSelectedColorId] = useState<number | null>(null)
  // Keyboard ordering: colour chips and the size matrix take focus in turn.
  const colourRefs = useRef<(HTMLButtonElement | null)[]>([])
  const matrixRef = useRef<SizeMatrixHandle>(null)
  const skSearchRef = useRef<SearchComboboxHandle>(null)
  const createOrderRef = useRef<HTMLButtonElement>(null)
  const nextArtBtnRef = useRef<HTMLButtonElement>(null)
  const addBtnRef = useRef<HTMLButtonElement>(null)
  const hasKeyboard = () => typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches
  // Keyboard start: on a computer the cursor begins in "Search vendor" (or the article search when
  // the vendor is already chosen) whenever New Order opens.
  useEffect(() => {
    if (view !== 'new' || !hasKeyboard()) return
    const t = setTimeout(() => (selectedSk ? artSearchRef.current : skSearchRef.current)?.focus(), 80)
    return () => clearTimeout(t)
  }, [view])

  // Ctrl+Enter anywhere on the new-order screen: place the order (opens the usual checks / confirmation).
  useShortcut('mod+enter', () => {
    const form = document.getElementById('new-order-form') as HTMLFormElement | null
    if (!form) return false
    form.requestSubmit()
  }, { label: 'Create the order', group: 'New order', action: true })
  // colorQuantities: preserved per-color quantities while user navigates
  // key = colorId, value = sizeLabel→qty
  const [colorQuantities, setColorQuantities] = useState<Record<number, Record<string, number>>>({})
  // lastUsedSet: the most recently added size quantities (any article/color)
  const [lastUsedSet, setLastUsedSet] = useState<Record<string, number> | null>(null)

  // ── Set picker dialog (replaces old Single / Set / Last Used buttons) ──
  const [setPickerOpen, setSetPickerOpen] = useState(false)
  // pendingSet: the quantities to apply; requires confirm if current has data
  const [pendingSetQties, setPendingSetQties] = useState<Record<string, number> | null>(null)
  const [setConfirm, setSetConfirm] = useState(false)

  // ── Edit state ──
  const [editingLineId, setEditingLineId] = useState<string | null>(null)
  // Ref mirror so event-handler callbacks always read the latest value without stale closure issues
  const editingLineIdRef = useRef<string | null>(null)
  useEffect(() => { editingLineIdRef.current = editingLineId }, [editingLineId])

  // ── Outside-click deselect: clear selection when clicking outside BOTH the
  //    Current Order card AND the Article section (user may be editing quantities there)
  useEffect(() => {
    if (!editingLineId) return
    function handleOutside(e: MouseEvent) {
      const inOrderCard  = currentOrderSectionRef.current?.contains(e.target as Node) ?? false
      const inArtSection = artSectionRef.current?.contains(e.target as Node) ?? false
      if (!inOrderCard && !inArtSection) {
        setEditingLineId(null)
        setSelectedColorId(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  // Only re-register when editingLineId transitions null ↔ non-null, not on every render
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingLineId != null])

  // ── Editing an existing order (vs creating new) ──
  const [editingOrderId, setEditingOrderId] = useState<number | null>(null)

  // ── Print Orders state ──
  const [printSelectedIds, setPrintSelectedIds] = useState<Set<number>>(new Set())
  const [printItemsMap, setPrintItemsMap] = useState<Record<number, DetailItem[]>>({})
  const [printLoadingIds, setPrintLoadingIds] = useState<Set<number>>(new Set())
  const [printConfigOpen, setPrintConfigOpen] = useState(false)
  const [printPageSize, setPrintPageSize] = useState<'A4' | 'A5'>('A5')
  const [printOrientation, setPrintOrientation] = useState<'portrait' | 'landscape'>('portrait')

  // Printing no longer assigns pickers (owner, 27 Nov 2026): pickers claim orders on their phone or are
  // assigned from the order's row; when an order has none, the biller names the picker when billing.
  // One order from the Orders list (owner, 23 Nov 2026): Assign a picker.
  const [rowAction, setRowAction] = useState<{ order: ExistingOrder; mode: 'assign' } | null>(null)
  // ⚡ Direct bill (admin; owner, 27 Nov 2026): the order is billed right here on the Direct Billing
  // screen (components/billing-scanner-page.tsx with orderId), not sent to the biller's queue.
  const [directOrder, setDirectOrder] = useState<ExistingOrder | null>(null)
  const [billRates, setBillRates] = useState<BillRates | undefined>(undefined)
  function openDirectBill(order: ExistingOrder) {
    setDirectOrder(order)
    if (!billRates) getBillTemplate().then(t => setBillRates(templateRates(t))).catch(() => {})
  }
  const [rowPicker, setRowPicker] = useState('')
  const [rowError, setRowError] = useState('')
  const [rowSaving, startRowSave] = useTransition()
  function openRowAction(order: ExistingOrder, mode: 'assign') {
    setRowPicker(''); setRowError(''); setRowAction({ order, mode })
  }
  function saveRowAction() {
    if (!rowAction) return
    if (!rowPicker) { setRowError('Choose a picker.'); return }
    const { order } = rowAction
    setRowError('')
    startRowSave(async () => {
      try {
        const row = await salesmanAssignPicker(order.id, rowPicker)
        keepSaved(row, order.salesmanName ?? null)
        const who = pickers.find(p => p.id === rowPicker)?.name ?? 'the picker'
        setNotice(`${order.orderNumber} assigned to ${who}.`)
        setRowAction(null)
      } catch (e) {
        setRowError(e instanceof Error ? e.message : 'Could not save. Check the connection and try again.')
      }
    })
  }

  // ── Cancel order confirm (existing orders list) ──
  const [cancelOrderId, setCancelOrderId] = useState<number | null>(null)
  const [cancellingOrder, startCancelTransition] = useTransition()
  const [orderActionError, setOrderActionError] = useState('')

  // ── Order cart ──
  const [lines, setLines] = useState<OrderLine[]>([])
  const [notes, setNotes] = useState('')

  // ── Submission ──
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  // ── Drafts (this phone only, lib/orders/drafts.ts) ──
  // A new order is saved as a draft on every change, so leaving New Order (or the app) never loses
  // it. Editing an existing order is never a draft. Creating the order removes its draft.
  const draftKey = draftStorageKey(userId || userName)
  const [drafts, setDrafts] = useState<OrderDraft[]>([])
  const draftIdRef = useRef<string | null>(null)
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null)
  const [openDraftId, setOpenDraftId] = useState<string | null>(null)
  const [draftsOpen, setDraftsOpen] = useState(false)
  const [draftStoreFailed, setDraftStoreFailed] = useState(false)
  const [deleteDraftId, setDeleteDraftId] = useState<string | null>(null)
  const [discardOpen, setDiscardOpen] = useState(false)
  // Read after the first render (the server has no localStorage).
  useEffect(() => { setDrafts(readDrafts(draftKey)) }, [draftKey])

  useEffect(() => {
    if (editingOrderId != null) return
    if (skipSaveRef.current) { skipSaveRef.current = false; return }
    const id = draftIdRef.current
    if (!draftHasContent({ vendor: selectedSk, lines })) {
      // Everything taken out of an open draft: the draft goes too.
      if (id) { setDrafts(deleteDraft(draftKey, id)); draftIdRef.current = null; setOpenDraftId(null); setDraftSavedAt(null) }
      return
    }
    const draft: OrderDraft = {
      id: id ?? uid(),
      savedAt: Date.now(),
      vendor: selectedSk ? { id: selectedSk.id, name: selectedSk.name, code: selectedSk.code, phone: selectedSk.phone, address: selectedSk.address } : null,
      lines,
      notes,
    }
    const next = saveDraft(draftKey, draft)
    if (!next) { setDraftStoreFailed(true); return }
    setDraftStoreFailed(false)
    draftIdRef.current = draft.id
    setOpenDraftId(draft.id)
    setDraftSavedAt(draft.savedAt)
    setDrafts(next)
  }, [selectedSk, lines, notes, editingOrderId, draftKey])

  // ── Preloaded catalogue lookup map (artNumber → ArticleDetail) ──
  const artCatalogueMap = useMemo(() => {
    const m = new Map<string, ArticleDetail>()
    for (const a of catalogue.articles) m.set(a.artNumber, a)
    return m
  }, [catalogue.articles])

  // ── Vendor name → address (location) lookup map ──
  const vendorAddressMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const v of catalogue.vendors) {
      if (v.address) m.set(v.name.toUpperCase(), v.address)
    }
    return m
  }, [catalogue.vendors])

  // ── Vendor search — purely client-side, instant ──
  useEffect(() => {
    setSkLoading(false)
    if (!skQuery.trim()) {
      setSkResults(catalogue.vendors.slice(0, 20))
      return
    }
    const results = fuzzyFilter(
      catalogue.vendors,
      skQuery,
      v => [v.name, v.code, v.phone, v.address],
    )
    setSkResults(results.slice(0, 20))
  }, [skQuery, catalogue.vendors])

  // ── Article search — purely client-side, instant ──
  useEffect(() => {
    setArtLoading(false)
    if (!artQuery.trim()) {
      setArtResults(catalogue.articles.slice(0, 20).map(a => ({ artNumber: a.artNumber })))
      return
    }
    const results = fuzzyFilter(
      catalogue.articles,
      artQuery,
      a => [a.artNumber],
    )
    setArtResults(results.slice(0, 20).map(a => ({ artNumber: a.artNumber })))
  }, [artQuery, catalogue.articles])

  // ── Derived: currently selected color object ──
  const selectedColor = useMemo(
    () => selectedArt?.colors.find(c => c.id === selectedColorId) ?? null,
    [selectedArt, selectedColorId],
  )

  // ── Current quantities for selected color ──
  const currentQties = selectedColorId != null
    ? (colorQuantities[selectedColorId] ?? {})
    : {}

  function setCurrentQties(q: Record<string, number>) {
    if (selectedColorId == null) return
    setColorQuantities(prev => ({ ...prev, [selectedColorId]: q }))
  }

  const matrixSizes: SizeEntry[] = useMemo(
    () => (selectedArt && selectedColor ? selectedArt.sizes.filter(s => s.articleId === selectedColor.articleId) : []),
    [selectedArt, selectedColor],
  )

  const currentColorTotal = useMemo(
    () => Object.values(currentQties).reduce((s, n) => s + n, 0),
    [currentQties],
  )

  // ── Select an article from search — instant Map lookup, no network ──
  function handleSelectArticle(art: ArticleResult) {
    setArtQuery(art.artNumber)
    const detail = artCatalogueMap.get(art.artNumber) ?? null
    setSelectedArt(detail)
    setSelectedColorId(null)
    setColorQuantities({})
    // Keyboard: continue on the colours (1, 2, 3… or arrows, then Enter).
    setTimeout(() => colourRefs.current[0]?.focus({ preventScroll: true }), 50)
  }

  // ── Choose a colour (chip tap, number key, or Shift+number in the matrix) ──
  function selectColour(c: { id: number }) {
    if (!selectedArt) return
    // Only seed from saved line if there are no working quantities
    // already — preserves any unsaved edits the user made before switching away.
    const hasWorking = Object.values(colorQuantities[c.id] ?? {}).some(v => v > 0)
    if (!hasWorking) {
      const savedLine = lines.find(l => l.articleId === selectedArt.id && l.colorId === c.id)
      if (savedLine) setColorQuantities(prev => ({ ...prev, [c.id]: { ...savedLine.quantities } }))
    }
    setSelectedColorId(c.id)
  }

  /** Keyboard on the colour chips: ←→↑↓ move, 1…9 pick colour N, Enter open its sizes, Esc skip. */
  function handleColourKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!selectedArt) return
    const colours = selectedArt.colors
    const at = colourRefs.current.findIndex(b => b === document.activeElement)
    const digit = /^(Digit|Numpad)([1-9])$/.exec(e.code)?.[2]
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
      colourRefs.current[(Math.max(0, at) + step + colours.length) % colours.length]?.focus()
    } else if (digit && !e.ctrlKey && !e.altKey) {
      const c = colours[Number(digit) - 1]
      if (!c) return
      e.preventDefault()
      selectColour(c)
      colourRefs.current[Number(digit) - 1]?.focus()
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      const c = colours[Math.max(0, at)]
      if (!c) return
      selectColour(c)
      setTimeout(() => matrixRef.current?.focus(), 50)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      skipArticle()
    }
  }

  /** Esc: next article without adding what is typed for this one. */
  function skipArticle() {
    setArtQuery('')
    setSelectedArt(null)
    setSelectedColorId(null)
    setColorQuantities({})
    setEditingLineId(null)
    setError('')
    setMatrixKey(k => k + 1)
    setTimeout(() => artSearchRef.current?.focus(), 50)
  }

  /** Enter in the matrix: add + next article. Shift+Enter: add this colour, stay on the article. */
  function handleMatrixEnter(stay: boolean) {
    // Enter after the last size: go to the buttons (Next Article / Add to Order), ←→ between them.
    if (!stay) { nextArtBtnRef.current?.focus(); return }
    if (currentColorTotal === 0) { setError('Add at least one pair before adding this item.'); return }
    handleAddToOrder()
    setTimeout(() => colourRefs.current[0]?.focus({ preventScroll: true }), 50)
  }

  /** Keyboard on Next Article / Add to Order: ←→ switch, ↑ back to the sizes, Esc skip. */
  function handleActionKey(e: React.KeyboardEvent<HTMLDivElement>) {
    const btns = [nextArtBtnRef.current, addBtnRef.current].filter((b): b is HTMLButtonElement => !!b && !b.disabled)
    const at = btns.findIndex(b => b === document.activeElement)
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      btns[(Math.max(0, at) + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length]?.focus()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault(); matrixRef.current?.focus()
    } else if (e.key === 'Escape') {
      // Esc on Next Article / Add to Order: back to the size bar (Esc there skips the article).
      e.preventDefault(); matrixRef.current?.focus()
    }
  }

  function handleMatrixColour(n: number) {
    const c = selectedArt?.colors[n - 1]
    if (!c) return
    selectColour(c)
    setTimeout(() => matrixRef.current?.focus(), 50)
  }

  function clearArticle() {
    setArtQuery('')
    setSelectedArt(null)
    setSelectedColorId(null)
    setColorQuantities({})
  }

  // ── Set picker: user picks a registered set (or Last Used) from a dialog ──

  /**
   * Called when user taps a set row in the picker dialog.
   * If the matrix already has quantities, show the replace-confirm dialog.
   * Otherwise, apply immediately.
   */
  function handlePickSet(labelled: Record<string, number>) {
    setSetPickerOpen(false)
    const qties = toKeyed(labelled, matrixSizes)
    const hasAny = Object.values(currentQties).some(v => v > 0)
    if (hasAny) {
      setPendingSetQties(qties)
      setSetConfirm(true)
    } else {
      setCurrentQties(qties)
    }
  }

  function confirmApplySet() {
    if (pendingSetQties) setCurrentQties(pendingSetQties)
    setPendingSetQties(null)
    setSetConfirm(false)
  }

  // ── Add / save current color to order ──
  // Always replaces: whether it's a brand-new color or re-editing one already in the order.
  function handleAddToOrder() {
    if (!selectedArt || selectedColorId == null || !selectedColor) return
    if (currentColorTotal === 0) {
      setError('Add at least one pair before adding this item.')
      return
    }
    setError('')

    const qties = { ...currentQties }
    const existingIdx = lines.findIndex(
      l => l.articleId === selectedArt.id && l.colorId === selectedColorId
    )
    const editIdx = editingLineId ? lines.findIndex(l => l.id === editingLineId) : -1

    if (editIdx !== -1) {
      // Came via "Edit" button from the cart — replace that specific line
      setLines(prev => prev.map(l =>
        l.id === editingLineId ? { ...l, quantities: qties } : l
      ))
      setEditingLineId(null)
    } else if (existingIdx !== -1) {
      // User re-selected this color from the chip — replace quantities (no merge)
      setLines(prev => prev.map((l, i) =>
        i !== existingIdx ? l : { ...l, quantities: qties }
      ))
    } else {
      // Brand new color
      const newLine: OrderLine = {
        id: uid(),
        articleId: selectedArt.id,
        artNumber: selectedArt.artNumber,
        colorId: selectedColorId,
        colorName: selectedColor.colorName,
        colorHex: selectedColor.colorHex,
        sizes: matrixSizes,
        quantities: qties,
      }
      setLines(prev => [...prev, newLine])
    }

    // Remember last used set globally (plain sizes, so it fits any article)
    setLastUsedSet(toLabelled(qties, matrixSizes))

    // Clear working quantities for this color and deselect
    setColorQuantities(prev => ({ ...prev, [selectedColorId]: {} }))
    setSelectedColorId(null)
    // Force SizeMatrix remount so manualActive state is cleared
    setMatrixKey(k => k + 1)
  }

  // ── Next Article — save ALL colors with qty > 0 for this article, then jump to article search ──
  function handleNextArticle() {
    const merged = mergeMatrix(lines, selectedArt, colorQuantities, editingLineId, uid)
    if (merged.added) setLines(merged.lines)
    if (merged.lastQuantities && selectedArt) setLastUsedSet(toLabelled(merged.lastQuantities, selectedArt.sizes))

    // Clear article and focus the search input
    setArtQuery('')
    setSelectedArt(null)
    setSelectedColorId(null)
    setColorQuantities({})
    setEditingLineId(null)
    setError('')
    setMatrixKey(k => k + 1)
    // Small timeout so the input is visible/enabled before focus
    setTimeout(() => artSearchRef.current?.focus(), 50)
  }

  // ── Deselect current line (clear editing state) ──
  const handleDeselectLine = useCallback(() => {
    setEditingLineId(null)
    setSelectedColorId(null)
  }, [])

  // ── Edit a line (open it in the matrix for modification) ──
  const handleEditLine = useCallback((line: OrderLine) => {
    const detail = artCatalogueMap.get(line.artNumber) ?? null
    // Set selectedArt + color + quantities atomically.
    // Do NOT call setArtQuery here — changing the search input value fires the article
    // search effect, populates the dropdown, and risks handleSelectArticle being triggered
    // which resets selectedColorId and colorQuantities. The article name is shown as a
    // heading inside the section so the search field can safely stay as-is.
    setSelectedArt(detail)
    setSelectedColorId(line.colorId)
    setColorQuantities(prev => ({ ...prev, [line.colorId]: { ...line.quantities } }))
    setEditingLineId(line.id)
    // Scroll the Article section into view after React has committed the state
    setTimeout(() => {
      artSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }, [artCatalogueMap])

  // ── Delete the currently selected line directly ──
  const handleDeleteSelectedLine = useCallback(() => {
    const id = editingLineIdRef.current
    if (!id) return
    setLines(prev => prev.filter(l => l.id !== id))
    setEditingLineId(null)
    setSelectedColorId(null)
    setSelectedArt(null)
    setArtQuery('')
    setColorQuantities({})
  }, [])

  // ── Reset everything ──
  // The open draft is only let go of here (it stays saved); deleting it is done by the caller.
  function resetForm() {
    draftIdRef.current = null
    setOpenDraftId(null)
    setDraftSavedAt(null)
    setSelectedSk(null); setSkQuery('')
    clearArticle()
    setLines([]); setNotes('')
    setError(''); setSuccess('')
    setEditingLineId(null)
    setEditingOrderId(null)
    // lastUsedSet is intentionally kept so it carries forward to the next new order
    setColorQuantities({})
    setDetailOrder(null)
    setDetailItems([])
    setDetailError('')
  }

  // ── Moving between tabs ──
  // The draft left by going to another tab; New Order opens it again (an empty form otherwise).
  const leftDraftRef = useRef<string | null>(null)
  const skipSaveRef = useRef(false)

  function goTo(next: View, filter?: StatusFilter) {
    if (filter) setFilterStatus(filter)
    if (next === view && next !== 'new') return
    // Keyboard: "New" while New Order is already open puts the cursor back in the form.
    if (next === 'new' && view === 'new' && hasKeyboard()) { setTimeout(() => (selectedSk ? artSearchRef.current : skSearchRef.current)?.focus(), 0); return }
    if (view === 'new' && next !== 'new') {
      if (editingOrderId == null && draftIdRef.current) {
        leftDraftRef.current = draftIdRef.current
        setNotice('Kept in Drafts')
      }
      resetForm()
    }
    if (next === 'new' && view !== 'new' && leftDraftRef.current) {
      const d = drafts.find(x => x.id === leftDraftRef.current)
      leftDraftRef.current = null
      if (d) { openDraft(d); return }
    }
    if (next === 'print') { setPrintSelectedIds(new Set()); setPrintItemsMap({}) }
    setView(next)
  }

  /** Put a draft back into the New Order form. */
  function openDraft(d: OrderDraft) {
    resetForm()
    const vendor = d.vendor
      ? (catalogue.vendors.find(v => v.name === d.vendor!.name) ?? (d.vendor as ShopkeeperResult))
      : null
    skipSaveRef.current = true // opening is not a change: keep its saved time
    setSelectedSk(vendor)
    setSkQuery(vendor?.name ?? '')
    setLines(d.lines)
    setNotes(d.notes)
    draftIdRef.current = d.id
    setOpenDraftId(d.id)
    setDraftSavedAt(d.savedAt)
    leftDraftRef.current = null
    setView('new')
  }

  /**
   * Pairs typed in the size grid but not added yet go into the order first, as "Add to Order" would
   * (owner, 27 Nov 2026: Create Order / Save / Save draft must not lose them). Returns the lines to save.
   */
  function takeMatrix(): OrderLine[] {
    const merged = mergeMatrix(lines, selectedArt, colorQuantities, editingLineId, uid)
    if (!merged.added) return lines
    setLines(merged.lines)
    if (merged.lastQuantities && selectedArt) setLastUsedSet(toLabelled(merged.lastQuantities, selectedArt.sizes))
    setColorQuantities({})
    setSelectedColorId(null)
    setEditingLineId(null)
    setMatrixKey(k => k + 1)
    return merged.lines
  }

  /** "Save draft": it is already saved — keep it in Drafts and start a fresh order here. */
  function handleSaveDraft() {
    // Pairs still in the size grid go into the draft before the form is cleared.
    const all = takeMatrix()
    if (all !== lines) {
      const saved = saveDraft(draftKey, {
        id: draftIdRef.current ?? uid(),
        savedAt: Date.now(),
        vendor: selectedSk ? { id: selectedSk.id, name: selectedSk.name, code: selectedSk.code, phone: selectedSk.phone, address: selectedSk.address } : null,
        lines: all,
        notes,
      })
      if (!saved) { setDraftStoreFailed(true); setError('Could not save the draft on this phone.'); return }
      setDrafts(saved)
    }
    leftDraftRef.current = null
    resetForm()
    setDraftsOpen(false)
    setNotice('Draft saved · new order started')
    setView('new')
    setTimeout(() => (hasKeyboard() ? skSearchRef.current?.focus() : undefined), 50)
  }

  function handleDiscardCurrent() {
    const id = draftIdRef.current
    resetForm()
    if (id) setDrafts(deleteDraft(draftKey, id))
    setDiscardOpen(false)
    setTimeout(() => (hasKeyboard() ? skSearchRef.current?.focus() : undefined), 50)
  }

  function handleDeleteDraft() {
    const id = deleteDraftId
    if (!id) return
    if (draftIdRef.current === id) resetForm()
    if (leftDraftRef.current === id) leftDraftRef.current = null
    setDrafts(deleteDraft(draftKey, id))
    setDeleteDraftId(null)
    setNotice('Draft discarded')
  }

  // ── Submit order (create new OR update existing) ──
  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setSubmitError('')
    if (!selectedSk) { setError('Please select a vendor.'); return }
    const all = takeMatrix()
    if (all.length === 0) { setError('Add at least one item to the order.'); return }

    const items = all.flatMap(l =>
      Object.entries(l.quantities)
        .filter(([, qty]) => qty > 0)
        .map(([k, qty]) => {
          const entry = l.sizes.find(s => sizeKey(s) === k)
          return {
            artNumber: l.artNumber,
            colorNumber: l.colorName,
            sizeNumber: entry?.sizeLabel ?? k,
            artCode: entry?.artCode,
            quantityOrdered: qty,
          }
        })
    )
    if (items.length === 0) { setError('All items have zero quantity.'); return }

    const payload = { shopkeeperName: selectedSk.name, notes, items, overrideCredit: allowHeld }

    startTransition(async () => {
      try {
        // The saved order goes into the list at once; the action also refreshes the page (or, in the
        // admin hub, the open tab), so no extra refresh and no waiting here.
        if (editingOrderId != null) {
          const row = await updateOrder(editingOrderId, payload)
          keepSaved(row, orders.find(o => o.id === row.id)?.salesmanName ?? null)
          setNotice('Order updated')
        } else {
          const row = await createOrder(payload)
          keepSaved(row, userName || null)
          setNotice('Order created')
          // Sent: its draft is done with.
          const id = draftIdRef.current
          if (id) setDrafts(deleteDraft(draftKey, id))
          leftDraftRef.current = null
        }
        resetForm()
        setView('list')
      } catch (err) {
        setSubmitError(isCreditHold(err) ? (err as Error).message
          : editingOrderId != null ? 'Failed to update order. Please try again.' : 'Failed to create order. Please try again.')
      }
    })
  }

  // ── Totals ──
  const totalPairs = useMemo(() => lines.reduce((s, l) => s + linePairs(l), 0), [lines])

  // Pairs still in the size grid count: Create Order takes them first.
  const gridPairs = useMemo(() => matrixPairs(selectedArt, colorQuantities), [selectedArt, colorQuantities])
  const canSubmit = !!selectedSk && (lines.length > 0 || gridPairs > 0) && !isPending

  // ── Edit existing order: load its items back into the new-order form ──
  async function handleEditOrder(order: ExistingOrder) {
    if (!EDITABLE_STATUSES.includes(order.status)) return
    setOrderActionError('')
    // Clear any stale form state first so the edit starts clean
    setLines([])
    setColorQuantities({})
    setEditingLineId(null)
    setError('')
    setSuccess('')
    try {
      const { order: o, items } = await getSalesmanOrderWithItems(order.id)

      // Use preloaded catalogue map — no extra DB round-trips
      const detailMap = artCatalogueMap

      // Build OrderLines with real articleId, colorId, colorHex, sizes
      const lineMap = new Map<string, OrderLine>()
      for (const item of items) {
        const key = `${item.artNumber}||${item.colorNumber ?? ''}`
        if (!lineMap.has(key)) {
          const detail = detailMap.get(item.artNumber)
          const colorMatch = detail?.colors.find(
            c => c.colorName.toLowerCase() === (item.colorNumber ?? '').toLowerCase()
          )
          lineMap.set(key, {
            id: uid(),
            articleId: detail?.id ?? 0,
            artNumber: item.artNumber,
            colorId: colorMatch?.id ?? 0,
            colorName: item.colorNumber ?? '',
            colorHex: colorMatch?.colorHex ?? null,
            sizes: (detail?.sizes ?? []).filter(s => !colorMatch || s.articleId === colorMatch.articleId),
            quantities: {},
          })
        }
        const line = lineMap.get(key)!
        if (item.sizeNumber) {
          const code = (item.artCode ?? '').toUpperCase()
          const entry = line.sizes.find(s => s.sizeLabel === item.sizeNumber && (!code || !s.artCode || s.artCode === code))
          line.quantities[entry ? sizeKey(entry) : item.sizeNumber] = item.quantityOrdered
        }
      }
      setLines(Array.from(lineMap.values()))
      setSelectedSk({ id: '', name: o.shopkeeperName, code: null, phone: null, address: null })
      setSkQuery(o.shopkeeperName)
      setNotes(o.notes ?? '')
      setEditingOrderId(order.id)
      // Close detail panel before showing the edit form
      setDetailOrder(null)
      setDetailItems([])
      setView('new')
    } catch (e: unknown) {
      setOrderActionError(e instanceof Error ? e.message : 'Failed to load order.')
    }
  }

  // ── Cancel existing order ──
  function handleCancelOrder() {
    if (cancelOrderId == null) return
    startCancelTransition(async () => {
      try {
        const row = await cancelOrder(cancelOrderId)
        keepSaved(row, orders.find(o => o.id === row.id)?.salesmanName ?? null)
        setNotice('Order cancelled')
        setCancelOrderId(null)
        // If we cancelled from the detail view, close it and go back to list
        setDetailOrder(null)
        setDetailItems([])
        setView('list')
      } catch (e: unknown) {
        setOrderActionError(e instanceof Error ? e.message : 'Failed to cancel order.')
        setCancelOrderId(null)
      }
    })
  }

  // ── Toggle selection of an order for printing ──
  async function handleTogglePrintOrder(order: ExistingOrder) {
    const id = order.id
    setPrintSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
    // Lazily load items if not yet loaded
    if (!printItemsMap[id]) {
      setPrintLoadingIds(prev => new Set(prev).add(id))
      try {
        const { items } = await getSalesmanOrderWithItems(id)
        setPrintItemsMap(prev => ({ ...prev, [id]: items as DetailItem[] }))
      } finally {
        setPrintLoadingIds(prev => { const s = new Set(prev); s.delete(id); return s })
      }
    }
  }

  // ── Transliterate English text to Hindi via Google Input Tools ──
  async function transliterateToHindi(text: string): Promise<string> {
    try {
      const words = text.trim().split(/\s+/)
      const results: string[] = []
      for (const word of words) {
        const url = `https://inputtools.google.com/request?text=${encodeURIComponent(word)}&itc=hi-t-i0-und&num=1`
        const res = await fetch(url)
        const data = await res.json()
        // Response shape: [status, [[word, [candidates]]]]
        const candidate = data?.[1]?.[0]?.[1]?.[0]
        results.push(candidate ?? word)
      }
      return results.join(' ')
    } catch {
      return text
    }
  }

  // ── Print the selected orders, compact (owner, 24 Nov 2026): lib/orders/pick-list-print.ts ──
  // Newspaper columns (as many as fit the paper), one line per colour, two-line header. Measured on 30
  // orders: A5 portrait 16 → 4 pages, A4 portrait 11 → 2. The order's own salesman is printed.
  async function handlePrintOrders(
    selectedOrders: ExistingOrder[],
    pageSize: 'A4' | 'A5',
    orientation: 'portrait' | 'landscape',
  ) {
    const addresses = selectedOrders.map(o => o.shopkeeperAddress || vendorAddressMap.get(o.shopkeeperName.toUpperCase()) || '')
    const hindiNames = await Promise.all(selectedOrders.map(o => transliterateToHindi(o.shopkeeperName)))
    const html = pickListHtml(selectedOrders.map((o, i) => ({
      orderNumber: o.orderNumber,
      shopkeeperName: o.shopkeeperName,
      hindiName: hindiNames[i],
      address: addresses[i],
      orderedAt: o.orderedAt,
      salesman: o.salesmanName ?? userName,
      sets,
      items: (printItemsMap[o.id] ?? []).map(it => ({ artNumber: it.artNumber, colorNumber: it.colorNumber ?? null, sizeNumber: it.sizeNumber ?? null, quantityOrdered: it.quantityOrdered })),
    })), pageSize, orientation)
    const mm = { A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 } }[pageSize]
    const [pageW, pageH] = orientation === 'landscape' ? [mm.h, mm.w] : [mm.w, mm.h]
    const w = window.open('', '_blank', `width=${Math.round(pageW * 3.7795) + 40},height=${Math.min(Math.round(pageH * 3.7795) + 80, screen.availHeight - 60)}`)
    if (w) {
      w.document.write(html)
      w.document.close()
    }
  }

  // ── Open detail view for an order ──
  async function handleViewOrder(order: ExistingOrder) {
    setDetailOrder(order)
    setDetailItems([])
    setDetailError('')
    setDetailLoading(true)
    setView('detail')
    try {
      const { items } = await getSalesmanOrderWithItems(order.id)
      setDetailItems(items as DetailItem[])
    } catch (e: unknown) {
      setDetailError(e instanceof Error ? e.message : 'Failed to load order details.')
    } finally {
      setDetailLoading(false)
    }
  }

  // ── Counts for stats ──
  // Counted once per list change; the cards and the status chips show the same numbers.
  const statusCounts = useMemo(() => {
    const c = Object.fromEntries(STATUS_CHIPS.map(s => [s.value, 0])) as Record<StatusFilter, number>
    for (const o of orders) for (const s of STATUS_CHIPS) if (matchesStatus(o.status, s.value)) c[s.value]++
    return c
  }, [orders])

  // ── Unique salesmen list for filter dropdown ──
  const uniqueSalesmen = useMemo(() => {
    const list = new Set<string>()
    if (userName) {
      list.add(userName)
    }
    orders.forEach(o => {
      if (o.salesmanName) {
        list.add(o.salesmanName)
      }
    })
    return Array.from(list).sort()
  }, [orders, userName])

  // ── Filtered + sorted orders ──
  const displayedOrders = useMemo(() => {
    let list = orders
    if (filterStatus !== 'all') {
      list = list.filter(o => matchesStatus(o.status, filterStatus))
    }
    if (filterSalesman !== 'all' && uniqueSalesmen.length > 1) {
      list = list.filter(o => o.salesmanName === filterSalesman)
    }
    const q = search.trim().toLowerCase()
    if (q) {
      list = list.filter(o => o.shopkeeperName.toLowerCase().includes(q) || o.orderNumber.toLowerCase().includes(q))
    }
    if (sortBy === 'date-desc') list = [...list].sort((a, b) => new Date(b.orderedAt).getTime() - new Date(a.orderedAt).getTime())
    if (sortBy === 'date-asc')  list = [...list].sort((a, b) => new Date(a.orderedAt).getTime() - new Date(b.orderedAt).getTime())
    if (sortBy === 'order')     list = [...list].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber))
    return list
  }, [orders, filterStatus, filterSalesman, uniqueSalesmen, search, sortBy])

  const TABS: SegTab<'new' | 'list' | 'print'>[] = [
    { value: 'new', label: 'New' },
    { value: 'list', label: 'Orders' },
    { value: 'print', label: 'Print' },
  ]
  const activeTab = view === 'detail' ? 'list' : view
  const otherDrafts = drafts.filter(d => d.id !== openDraftId)
  const listShowing = view === 'list' || view === 'detail'
  // Draws 100 rows at a time (filters and search still cover every order).
  const { visible: shownOrders, more: moreOrders } = useShowMore(displayedOrders, 100, [filterStatus, filterSalesman, search, sortBy])

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────

  return (
    <div className={embedded ? '' : 'min-h-screen bg-background'}>
      <div className={embedded ? 'pb-40 md:pb-28' : 'max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-40 md:pb-28'}>
        {!embedded && (
        <div className="flex items-center justify-between mb-4">
          <PageHeader title="My Orders" subtitle={`Welcome, ${userName}`} />
          <PageNav />
        </div>
        )}

        {/* Cards open their list: Pending → All Orders · Pending, In progress → All Orders · In progress. */}
        <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3">
          <StatButton label="All" value={statusCounts.all}
            active={listShowing && filterStatus === 'all'} onClick={() => goTo('list', 'all')} />
          <StatButton label="Pending" value={statusCounts.pending} color="text-yellow-600 dark:text-yellow-400"
            active={listShowing && filterStatus === 'pending'} onClick={() => goTo('list', 'pending')} />
          <StatButton label="In progress" value={statusCounts.in_progress} color="text-blue-600 dark:text-blue-400"
            hint="With the picker or biller, not dispatched yet"
            active={listShowing && filterStatus === 'in_progress'} onClick={() => goTo('list', 'in_progress')} />
        </div>

        {/* Tab bar */}
        <div className="mb-4">
          <SegTabs label="Orders" tabs={TABS} active={activeTab} onChange={v => goTo(v)} />
        </div>

        {/* Messages shown on every tab (saved, cancelled, draft kept…) */}
        {notice && (
          <p role="status" className="mb-3 text-sm font-medium text-green-700 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-xl px-3 py-2">{`✓ ${notice}`}</p>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            ALL ORDERS LIST
        ════════════════════════════════════════════════════════════════ */}
        {view === 'list' && (
          <div className="space-y-2.5">
            {orderActionError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-xl px-3 py-2">{orderActionError}</p>
            )}

            {/* Search + sort on one line */}
            <div className="flex items-center gap-2">
              <div className="relative min-w-0 flex-1">
                <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input type="search" data-list-search value={search} onChange={e => setSearch(e.target.value)} aria-label="Search orders"
                  placeholder="Shop or order number"
                  className="h-10 w-full rounded-xl border border-border bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
              </div>
              <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)} aria-label="Sort"
                className="h-10 w-[7.5rem] shrink-0 rounded-xl border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
                <option value="date-desc">Newest</option>
                <option value="date-asc">Oldest</option>
                <option value="order">Order no.</option>
              </select>
            </div>

            {/* Status chips — scroll sideways on a phone */}
            <div className="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 sm:mx-0 sm:flex-wrap sm:px-0 [scrollbar-width:none]" role="group" aria-label="Status">
              {STATUS_CHIPS.map(s => {
                const on = filterStatus === s.value
                return (
                  <button key={s.value} type="button" aria-pressed={on} onClick={() => setFilterStatus(s.value)}
                    className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${
                      on ? 'border-foreground bg-foreground text-background' : 'border-border bg-card text-muted-foreground hover:text-foreground'
                    }`}>
                    {s.label}
                    <span className={`tabular-nums ${on ? 'opacity-70' : 'opacity-60'}`}>{statusCounts[s.value]}</span>
                  </button>
                )
              })}
            </div>

            {/* Only when there is more than one salesman in the list (admin) */}
            {uniqueSalesmen.length > 1 && (
              <label className="flex items-center gap-2 text-xs">
                <span className="shrink-0 font-semibold uppercase tracking-wide text-muted-foreground">Salesman</span>
                <select value={filterSalesman} onChange={e => setFilterSalesman(e.target.value)}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-2 text-xs font-medium text-foreground focus:outline-none focus:ring-2 focus:ring-ring">
                  <option value="all">All Salesmen</option>
                  {uniqueSalesmen.map(name => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            )}

            <LiveBadge lastRefreshed={lastRefreshed} onRefresh={refresh} />

            {orders.length === 0 && (
              <div className="text-center py-12 text-muted-foreground">
                <p className="text-sm">No open orders and none in the last 60 days.</p>
                <button type="button" onClick={() => goTo('new')}
                  className="mt-2 text-sm text-primary hover:underline">
                  Create your first order →
                </button>
              </div>
            )}
            {displayedOrders.length === 0 && orders.length > 0 && (
              <div className="py-8 text-center">
                <p className="text-sm text-muted-foreground">No orders match this filter.</p>
                {(filterStatus !== 'all' || search) && (
                  <button type="button" onClick={() => { setFilterStatus('all'); setSearch('') }} className="mt-2 text-sm font-medium text-primary hover:underline">
                    Show all orders
                  </button>
                )}
              </div>
            )}
            <div ref={ordersListRef} className="space-y-2">
              {shownOrders.map(order => {
                const tag = orderTag(order)
                const canPick = pickers.length > 0 && OPEN_FOR_PICKING.includes(order.status)
                return (
                  <div key={order.id} data-list-row className="flex items-stretch rounded-xl border border-border bg-card">
                  {/* The order opens it; Assign and ⚡ Direct bill sit beside it (no button inside a button). */}
                  <button
                    type="button"
                    data-row-open
                    onClick={() => handleViewOrder(order)}
                    className="min-w-0 flex-1 text-left rounded-xl px-3.5 py-3 hover:bg-muted/30 active:bg-muted/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 flex-1 truncate font-semibold text-sm text-foreground">{order.shopkeeperName}</p>
                      <StatusPill status={order.status} />
                    </div>
                    <div className="mt-1 flex items-center gap-x-2 gap-y-0.5 flex-wrap text-xs text-muted-foreground">
                      <span className="font-mono" data-no-translate>{order.orderNumber}</span>
                      <span aria-hidden>·</span>
                      <span>{tag === 'updated' ? fmt(order.updatedAt) : fmt(order.orderedAt)}</span>
                      <ChangeTag tag={tag} />
                      {uniqueSalesmen.length > 1 && order.salesmanName && (
                        <span className="truncate">{`· ${order.salesmanName}`}</span>
                      )}
                    </div>
                    {order.notes && <p className="mt-1 line-clamp-1 text-xs italic text-muted-foreground">{order.notes}</p>}
                  </button>
                  {canPick && (
                    <div className="flex shrink-0 items-center gap-1.5 py-2 pr-2.5">
                      <button type="button" onClick={() => openRowAction(order, 'assign')}
                        aria-label={`Assign a picker to ${order.orderNumber}`}
                        className="h-9 rounded-lg border border-border bg-background px-3 text-xs font-semibold hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        {order.status === 'assigned' ? 'Reassign' : 'Assign'}
                      </button>
                      {canDirectBill && (
                        <button type="button" onClick={() => openDirectBill(order)}
                          title="Direct bill — skip picking, straight to the biller"
                          aria-label={`Direct bill ${order.orderNumber}`}
                          className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-300 bg-amber-50 text-base text-amber-700 hover:bg-amber-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:hover:bg-amber-950/60">
                          <span aria-hidden>⚡</span>
                        </button>
                      )}
                    </div>
                  )}
                  </div>
                )
              })}
            </div>
            {moreOrders}
            {/* Also when the list is empty: all of a salesman's orders may be older than 60 days. */}
            {olderState !== 'done' && (
              <button type="button" onClick={loadOlder} disabled={olderState === 'loading'}
                className="w-full rounded-xl border border-dashed border-border py-2.5 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-60">
                {olderState === 'loading' ? 'Loading…' : olderState === 'error' ? 'Could not load — try again' : 'Load older orders'}
              </button>
            )}
            {olderState === 'done' && <p className="text-center text-xs text-muted-foreground">No older orders.</p>}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            ORDER DETAIL VIEW
        ════════════════════════════════════════════════════════════════ */}
        {view === 'detail' && detailOrder && (
          <div className="space-y-4">
            {/* Back + header */}
            <button type="button" onClick={() => setView('list')}
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              Back to All Orders
            </button>

            {/* Order summary card */}
            <div className="rounded-xl border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold text-base text-foreground">{detailOrder.shopkeeperName}</p>
                  <p className="font-mono text-xs text-muted-foreground mt-0.5">{detailOrder.orderNumber}</p>
                </div>
                <StatusPill status={detailOrder.status} />
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {detailOrder.salesmanName && (
                  <>
                    <span className="text-muted-foreground">Created by</span>
                    <span className="text-foreground font-medium">{detailOrder.salesmanName}</span>
                  </>
                )}
                <span className="text-muted-foreground">Ordered</span>
                <span className="text-foreground">{fmt(detailOrder.orderedAt)}</span>
                {Math.abs(new Date(detailOrder.updatedAt).getTime() - new Date(detailOrder.orderedAt).getTime()) > 5000 && (
                  <>
                    <span className="text-muted-foreground">Last updated</span>
                    <span className="text-foreground">{fmt(detailOrder.updatedAt)}</span>
                  </>
                )}
                {detailOrder.notes && (
                  <>
                    <span className="text-muted-foreground">Notes</span>
                    <span className="text-foreground italic">{detailOrder.notes}</span>
                  </>
                )}
              </div>
            </div>

            {/* Items */}
            <div className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="px-4 py-3 bg-muted/30 border-b border-border">
                <h2 className="text-sm font-semibold text-foreground">Order Items</h2>
              </div>
              {detailLoading && (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">Loading items…</p>
              )}
              {detailError && (
                <p role="alert" className="px-4 py-4 text-sm text-red-600 dark:text-red-400">{detailError}</p>
              )}
              {!detailLoading && !detailError && detailItems.length === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">No items found.</p>
              )}
              {!detailLoading && detailItems.length > 0 && (() => {
                const showPacked = ['packed', 'billed', 'dispatched', 'delivered'].includes(detailOrder.status)
                const isBilled   = ['billed', 'dispatched', 'delivered'].includes(detailOrder.status)
                // Group: artNumber → colorNumber → items
                const artMap = new Map<string, Map<string, DetailItem[]>>()
                for (const item of detailItems) {
                  if (!artMap.has(item.artNumber)) artMap.set(item.artNumber, new Map())
                  const colorKey = item.colorNumber ?? '—'
                  if (!artMap.get(item.artNumber)!.has(colorKey)) artMap.get(item.artNumber)!.set(colorKey, [])
                  artMap.get(item.artNumber)!.get(colorKey)!.push(item)
                }
                const articleGroups = Array.from(artMap.entries()).map(([artNumber, colorMap]) => ({
                  artNumber,
                  colorGroups: Array.from(colorMap.entries()).map(([color, items]) => ({ color, items })),
                }))
                let serial = 0 // line number, 1, 2, 3… down the table
                return (
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm border-collapse">
                    <thead className="bg-muted/20 border-b border-border">
                      <tr>
                        <th className="w-8 px-2 py-2 text-right text-xs font-medium text-muted-foreground">#</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Article</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Color</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">
                          {showPacked ? (
                            <>
                              Size
                              <span className="ml-1 text-[10px] font-normal text-muted-foreground/50">→</span>
                              <span className="text-[10px] font-semibold text-muted-foreground/70">ord</span>
                              <span className="mx-0.5 text-[10px] text-muted-foreground/40">→</span>
                              <span className="text-[10px] font-semibold text-green-600 dark:text-green-400">pkd</span>
                              {isBilled && (
                                <>
                                  <span className="mx-0.5 text-[10px] text-muted-foreground/40">→</span>
                                  <span className="text-[10px] font-semibold text-blue-600 dark:text-blue-400">ver</span>
                                </>
                              )}
                            </>
                          ) : (
                            'Size / Qty'
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {articleGroups.map(({ artNumber, colorGroups }) =>
                        colorGroups.map(({ color, items }, ci) => {
                          const allOrd = colorGroups.flatMap(cg => cg.items).reduce((s, i) => s + i.quantityOrdered, 0)
                          const allPkd = colorGroups.flatMap(cg => cg.items).reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                          const allVer = isBilled ? allPkd : 0
                          return (
                            <tr key={`${artNumber}-${color}`} className="border-b border-border hover:bg-muted/20">
                              <td className="w-8 px-2 py-2.5 text-right text-xs tabular-nums text-muted-foreground align-top border-r border-border">{++serial}</td>
                              {ci === 0 && (
                                <td
                                  className="px-4 py-2.5 font-semibold text-xs align-top border-r border-border"
                                  rowSpan={colorGroups.length}
                                >
                                  {artNumber}
                                  {showPacked && (
                                    <>
                                      <span className="block font-normal text-muted-foreground tabular-nums mt-0.5">{allOrd} ord</span>
                                      <span className="block font-semibold tabular-nums text-green-600 dark:text-green-400">{allPkd} pkd</span>
                                      {isBilled && <span className="block font-semibold tabular-nums text-blue-600 dark:text-blue-400">{allVer} ver</span>}
                                    </>
                                  )}
                                </td>
                              )}
                              <td className="px-3 py-2.5 text-xs font-medium text-foreground align-top w-28 border-r border-border">{color}</td>
                              <td className="px-3 py-2.5 align-top">
                                <div className="flex flex-wrap gap-x-2 gap-y-1">
                                  {items.map(item => {
                                    if (!showPacked) return (
                                      <span key={item.id} className="text-xs tabular-nums whitespace-nowrap">
                                        <span className="text-muted-foreground">{sizeWithCode(item, items)}</span>
                                        <span className="mx-0.5 text-muted-foreground">/</span>
                                        <span className="font-semibold text-foreground">{item.quantityOrdered}</span>
                                      </span>
                                    )
                                    const isOOS    = item.status === 'out_of_stock'
                                    const pkd      = isOOS ? 0 : item.quantityPacked
                                    const verified = isBilled ? pkd : 0
                                    return (
                                      <span key={item.id} className="inline-flex items-baseline gap-0.5 tabular-nums whitespace-nowrap">
                                        <span className="text-xs text-muted-foreground">{sizeWithCode(item, items)}</span>
                                        <span className="text-[10px] text-muted-foreground/50 mx-px">/</span>
                                        <span className="text-xs font-bold text-muted-foreground">{item.quantityOrdered}</span>
                                        <span className="text-[10px] text-muted-foreground/40">→</span>
                                        <span className={`text-xs font-bold ${isOOS ? 'text-red-500' : 'text-green-600 dark:text-green-400'}`}>
                                          {isOOS ? 'OOS' : pkd}
                                        </span>
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
                        <td colSpan={3} className="px-4 py-2.5 text-xs font-medium text-muted-foreground text-right">Total</td>
                        <td className="px-3 py-2.5 text-xs">
                          {showPacked ? (() => {
                            const totalOrd = detailItems.reduce((s, i) => s + i.quantityOrdered, 0)
                            const totalPkd = detailItems.reduce((s, i) => s + (i.status === 'out_of_stock' ? 0 : i.quantityPacked), 0)
                            const totalVer = isBilled ? totalPkd : 0
                            return (
                              <>
                                <span className="font-bold tabular-nums text-muted-foreground">{totalOrd}</span>
                                <span className="text-muted-foreground mx-1">ord /</span>
                                <span className="font-bold tabular-nums text-green-600 dark:text-green-400">{totalPkd}</span>
                                <span className="text-muted-foreground mx-1">pkd</span>
                                {isBilled && (
                                  <>
                                    <span className="text-muted-foreground mx-0.5">/</span>
                                    <span className="font-bold tabular-nums text-blue-600 dark:text-blue-400">{totalVer}</span>
                                    <span className="text-muted-foreground ml-1">ver</span>
                                  </>
                                )}
                              </>
                            )
                          })() : (
                            <span className="font-bold tabular-nums">{detailItems.reduce((s, i) => s + i.quantityOrdered, 0)}</span>
                          )}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                  </div>
                )
              })()}
            </div>

            {/* Actions */}
            {(() => {
              const canAct = EDITABLE_STATUSES.includes(detailOrder.status)
              const reason = !canAct ? `Only pending or assigned orders can be edited` : undefined
              return (
                <div className="space-y-2 pt-1">
                  <div className="flex gap-3">
                    <button
                      type="button"
                      disabled={!canAct}
                      title={reason}
                      onClick={() => handleEditOrder(detailOrder)}
                      className="flex-1 rounded-xl border border-primary text-primary px-4 py-2.5 text-sm font-semibold hover:bg-primary/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      Edit Order
                    </button>
                    <button
                      type="button"
                      disabled={!canAct}
                      title={reason}
                      onClick={() => { setOrderActionError(''); setCancelOrderId(detailOrder.id) }}
                      className="flex-1 rounded-xl border border-red-300 dark:border-red-500/30 text-red-500 px-4 py-2.5 text-sm font-semibold hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
                    >
                      Cancel Order
                    </button>
                  </div>
                  {!canAct && (
                    <p className="text-center text-xs text-muted-foreground">
                      This order is <span className="font-medium text-foreground">{detailOrder.status}</span> and cannot be edited or cancelled.
                    </p>
                  )}
                </div>
              )
            })()}
            {orderActionError && (
              <p role="alert" className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-xl px-3 py-2">{orderActionError}</p>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            NEW ORDER FORM
        ════════════════════════════════════════════════════════════════ */}
        {view === 'new' && (
          <form id="new-order-form" onSubmit={handleSubmit} className="space-y-3 sm:space-y-4" noValidate>
            {/* Status line: editing / draft saved · Start over · keyboard help */}
            <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1">
              {editingOrderId != null ? (
                <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
                  {`Editing order ${orders.find(o => o.id === editingOrderId)?.orderNumber ?? ''}`.trim()}
                </span>
              ) : draftSavedAt != null ? (
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300" role="status">
                  {`Draft · saved ${new Date(draftSavedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">Saved as a draft while you work</span>
              )}
              {draftStoreFailed && editingOrderId == null && (
                <span className="text-xs font-medium text-red-600 dark:text-red-400">This phone could not save the draft</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                {editingOrderId == null && (selectedSk || lines.length > 0) && (
                  <button type="button" onClick={() => setDiscardOpen(true)}
                    className="h-8 rounded-lg px-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20">
                    Start over
                  </button>
                )}
                {editingOrderId == null && (
                  <button type="button" onClick={() => setDraftsOpen(true)}
                    className="flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-semibold hover:bg-muted">
                    Drafts
                    {otherDrafts.length > 0 && <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-bold text-primary">{otherDrafts.length}</span>}
                  </button>
                )}
                <ShortcutGuide />
              </div>
            </div>

            {/* ── 1. SHOPKEEPER ── */}
            <section aria-labelledby="sk-heading" className="rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b border-border rounded-t-2xl">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  <h2 id="sk-heading" className="text-sm font-semibold text-foreground">Vendor</h2>
                </div>
                {selectedSk && (
                  <button type="button" onClick={() => { setSelectedSk(null); setSkQuery('') }}
                    className="text-xs text-primary hover:underline font-medium">
                    Change
                  </button>
                )}
              </div>

              <div className="p-4">
                {!selectedSk ? (
                  <SearchCombobox<ShopkeeperResult>
                    ref={skSearchRef}
                    id="sk-search"
                    label="Search Vendor"
                    required
                    placeholder="Search vendor..."
                    inputValue={skQuery}
                    onInputChange={setSkQuery}
                    onSelect={sk => { setSelectedSk(sk); setSkQuery(sk.name); setTimeout(() => artSearchRef.current?.focus(), 50) }}
                    onClear={() => { setSelectedSk(null); setSkQuery('') }}
                    results={skResults}
                    loading={skLoading}
                    getKey={r => r.name}
                    renderOption={(r, active) => (
                      <div className="flex items-center justify-between gap-4">
                        <span className={`font-medium ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{r.name}</span>
                        <span className={`text-xs font-mono ${active ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                          {r.code ?? r.address ?? ''}
                        </span>
                      </div>
                    )}
                  />
                ) : (
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary font-bold text-sm flex-shrink-0">
                      {selectedSk.name[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="font-semibold text-foreground text-sm">{selectedSk.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {[selectedSk.code, selectedSk.phone, selectedSk.address].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                )}
                {selectedSk && editingOrderId == null && (
                  <div className="mt-3"><CreditNote info={credit} allow={allowHeld} onAllow={setAllowHeld} /></div>
                )}
              </div>
            </section>

            {/* ── 2. ARTICLE ENTRY ── */}
            <section ref={artSectionRef} aria-labelledby="art-heading" className="rounded-2xl border border-border bg-card">
              <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b border-border rounded-t-2xl">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" /></svg>
                  <h2 id="art-heading" className="text-sm font-semibold text-foreground">Article</h2>
                </div>
                <span className="hidden sm:block text-xs text-muted-foreground">Search article and set color-wise quantities</span>
              </div>

              <div className="p-4 space-y-4">
                {/* Article search — Enter with nothing typed goes to Create Order */}
                <div onKeyDownCapture={e => {
                  // Runs before the search box: with nothing typed, Enter must not pick an article.
                  if (e.key !== 'Enter' || e.ctrlKey || e.metaKey || artQuery.trim()) return
                  e.preventDefault()
                  e.stopPropagation()
                  if (lines.length) createOrderRef.current?.focus()
                }}>
                <SearchCombobox<ArticleResult>
                  ref={artSearchRef}
                  id="art-search"
                  label="Search Article Number"
                  required
                  placeholder="Search article number..."
                  inputValue={artQuery}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  onInputChange={setArtQuery}
                  onSelect={handleSelectArticle}
                  onClear={clearArticle}
                  results={artResults}
                  loading={artLoading}
                  getKey={r => r.artNumber}
                  renderOption={(r, active) => (
                    <div className="flex items-center justify-between gap-4">
                      <span className={`font-semibold ${active ? 'text-primary-foreground' : 'text-foreground'}`}>{r.artNumber}</span>
                    </div>
                  )}
                />
                </div>

                {selectedArt && (
                  <>
                    {/* Article header */}
                    <div className="flex items-baseline gap-3 flex-wrap">
                      <span className="text-lg font-bold text-foreground">{selectedArt.artNumber}</span>
                      {editingLineId && (
                        <span className="ml-auto text-xs text-amber-600 dark:text-amber-400 font-medium bg-amber-50 dark:bg-amber-900/20 rounded-full px-2 py-0.5">
                          Editing line
                        </span>
                      )}
                    </div>

                    {/* Color chips */}
                    {selectedArt.colors.length > 0 ? (
                      <div>
                        <p className="text-xs font-medium text-muted-foreground mb-2">Available Colors</p>
                        <div className="flex flex-wrap gap-2" onKeyDown={handleColourKey}>
                          {selectedArt.colors.map((c, i) => {
                            const active = selectedColorId === c.id
                            const hasData = Object.values(colorQuantities[c.id] ?? {}).some(v => v > 0)
                            const savedLine = lines.find(l => l.articleId === selectedArt.id && l.colorId === c.id)
                            const inOrder = !!savedLine
                            // Dirty = in order but working quantities differ from what's saved
                            const isDirty = inOrder && hasData && savedLine
                              ? Object.keys({ ...colorQuantities[c.id], ...savedLine.quantities }).some(
                                  k => (colorQuantities[c.id]?.[k] ?? 0) !== (savedLine.quantities[k] ?? 0)
                                )
                              : false
                            return (
                              <button
                                key={c.id}
                                ref={el => { colourRefs.current[i] = el }}
                                type="button"
                                aria-pressed={active}
                                aria-keyshortcuts={i < 9 ? String(i + 1) : undefined}
                                onClick={() => selectColour(c)}
                                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                                  active
                                    ? 'border-primary bg-primary/10 text-foreground ring-1 ring-primary'
                                    : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                                }`}
                              >
                                {i < 9 && <span className="hidden text-[10px] font-bold text-muted-foreground [@media(pointer:fine)]:inline" aria-hidden>{i + 1}</span>}
                                <span className="w-3.5 h-3.5 rounded-full border border-white/30 flex-shrink-0"
                                  style={{ background: swatch(c.colorHex, c.colorName) }} aria-hidden />
                                {c.colorName}
                                {inOrder && !isDirty && !active && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" aria-label="added to order" />
                                )}
                                {inOrder && isDirty && !active && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-orange-400 flex-shrink-0" aria-label="unsaved changes" />
                                )}
                                {hasData && !inOrder && !active && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" aria-label="has quantities" />
                                )}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-muted-foreground">No colors configured for this article. Add them in Master.</p>
                    )}

                    {/* Size matrix for selected color — filtered to this color's articleId */}
                    {selectedColor && selectedArt.sizes.filter(s => s.articleId === selectedColor.articleId).length > 0 && (
                      <div className="rounded-xl border border-border bg-background p-3 space-y-3">
                        {/* Color header — name left, set-buttons right; on narrow screens buttons wrap below */}
                        <div className="flex items-center gap-2 flex-wrap">
                          <div className="flex items-center gap-2 min-w-0 flex-1">
                            <span className="w-4 h-4 rounded-full border border-border flex-shrink-0"
                              style={{ background: swatch(selectedColor.colorHex, selectedColor.colorName) }} aria-hidden />
                            <span className="text-sm font-semibold text-foreground truncate">Color: {selectedColor.colorName}</span>
                          </div>

                          {/* Set + Last Used buttons */}
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button
                              type="button"
                              onClick={() => setSetPickerOpen(true)}
                              disabled={sets.length === 0}
                              className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-40"
                            >
                              Set
                            </button>
                            <button
                              type="button"
                              onClick={() => lastUsedSet && handlePickSet({ ...lastUsedSet })}
                              disabled={!lastUsedSet}
                              title={lastUsedSet
                                ? Object.entries(lastUsedSet).filter(([,v])=>v>0).map(([k,v])=>`${k}×${v}`).join(', ')
                                : 'No previous set'}
                              className="rounded-lg border border-border bg-background px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Last Used
                            </button>
                          </div>
                        </div>

                        <SizeMatrix
                          key={matrixKey}
                          ref={matrixRef}
                          sizes={selectedArt.sizes.filter(s => s.articleId === selectedColor.articleId)}
                          quantities={currentQties}
                          onChange={setCurrentQties}
                          onEnter={handleMatrixEnter}
                          onColour={handleMatrixColour}
                          onEscape={skipArticle}
                        />

                        {/* Error for this section */}
                        {error && (
                          <p role="alert" className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded-lg px-3 py-2">{error}</p>
                        )}

                        {/* Add to Order + Next Article — full-width on mobile, auto-width on wider */}
                        <div className="flex items-center gap-2 pt-1" onKeyDown={handleActionKey}>
                          <button
                            ref={nextArtBtnRef}
                            type="button"
                            onClick={handleNextArticle}
                            className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-4 py-2.5 text-sm font-semibold text-foreground hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                            </svg>
                            Next Article
                          </button>
                          {/* One colour only: Next Article saves it, so it is the only button. */}
                          {selectedArt.colors.length > 1 && (
                            <button
                              ref={addBtnRef}
                              type="button"
                              onClick={e => {
                                handleAddToOrder()
                                // From the keyboard (Enter), continue on this article's colours.
                                if (e.detail === 0) setTimeout(() => colourRefs.current[0]?.focus({ preventScroll: true }), 50)
                              }}
                              disabled={currentColorTotal === 0}
                              className="flex-1 sm:flex-none flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            >
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                              {(editingLineId || lines.some(l => l.articleId === selectedArt.id && l.colorId === selectedColorId))
                                ? 'Save Changes'
                                : 'Add to Order'}
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            </section>

            {/* ── 3. CURRENT ORDER ── */}
            {lines.length > 0 && (
              <section
                ref={currentOrderSectionRef}
                aria-labelledby="order-heading"
                className="rounded-2xl border border-border bg-card overflow-hidden"
              >
                <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center gap-2">
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                  <h2 id="order-heading" className="text-sm font-semibold text-foreground">Current Order</h2>
                  <span className="ml-auto text-xs text-muted-foreground">{lines.length} line{lines.length !== 1 ? 's' : ''}</span>
                  {editingLineId && (
                    <button
                      type="button"
                      onClick={handleDeleteSelectedLine}
                      className="flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-500/30 bg-red-50 dark:bg-red-900/20 px-2.5 py-1 text-xs font-medium text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                      aria-label="Delete selected line"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                      Delete
                    </button>
                  )}
                </div>
                <OrderItemsCard
                  lines={lines}
                  editingLineId={editingLineId}
                  onEdit={handleEditLine}
                  onDeselect={handleDeselectLine}
                />
              </section>
            )}

            {/* Notes */}
            <div className="rounded-2xl border border-border bg-card p-4 space-y-2">
              <label htmlFor="order-notes" className="block text-xs font-medium text-muted-foreground">Notes (optional)</label>
              <textarea id="order-notes" value={notes} onChange={e => setNotes(e.target.value)} rows={2}
                placeholder="Any special instructions…"
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none" />
            </div>

            {success && (
              <p className="text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 rounded-xl px-3 py-2">{success}</p>
            )}
          </form>
        )}

        {/* ═══════════════════════════════════════════════════════════════
            PRINT ORDERS
        ════════════════════════════════════════════════════════════════ */}
        {view === 'print' && (() => {
          const assignedOrders = orders.filter(o => o.status === 'assigned' || o.status === 'pending')
          const selectedOrders = assignedOrders.filter(o => printSelectedIds.has(o.id))
          const allLoaded = selectedOrders.every(o => !!printItemsMap[o.id])
          const allSelected = assignedOrders.length > 0 && assignedOrders.every(o => printSelectedIds.has(o.id))
          const totalSelectedPairs = selectedOrders.reduce(
            (s, o) => s + (printItemsMap[o.id] ?? []).reduce((ss, i) => ss + i.quantityOrdered, 0), 0
          )

          function toggleAll() {
            if (allSelected) {
              setPrintSelectedIds(new Set())
              setPrintItemsMap({})
            } else {
              assignedOrders.forEach(o => { if (!printSelectedIds.has(o.id)) handleTogglePrintOrder(o) })
            }
          }

          return (
            <div className="space-y-3">

              {/* ── Empty state ── */}
              {assignedOrders.length === 0 && (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <svg className="w-10 h-10 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  <div className="text-center">
                    <p className="text-sm font-medium">No pending or assigned orders</p>
                    <p className="text-xs mt-0.5">Orders must be in <span className="font-semibold text-foreground">pending</span> or <span className="font-semibold text-foreground">assigned</span> status to appear here.</p>
                  </div>
                </div>
              )}

              {/* ── Selection card ── */}
              {assignedOrders.length > 0 && (
                <div className="rounded-xl border border-border bg-card overflow-hidden">

                  {/* Card header */}
                  <div className="px-3 py-3 sm:px-4 sm:py-3.5 bg-muted/30 border-b border-border">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <svg className="w-4 h-4 text-muted-foreground shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                        </svg>
                        <h2 className="text-sm font-semibold text-foreground">Select Orders to Print</h2>
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
                  <div className="divide-y divide-border">
                    {assignedOrders.map(order => {
                      const checked = printSelectedIds.has(order.id)
                      const loading = printLoadingIds.has(order.id)
                      const pairs = printItemsMap[order.id]?.reduce((s, i) => s + i.quantityOrdered, 0) ?? null

                      return (
                        <label
                          key={order.id}
                          className={`flex items-center gap-3 px-3 py-3 sm:px-4 cursor-pointer select-none transition-colors ${
                            checked ? 'bg-primary/5' : 'hover:bg-muted/30 active:bg-muted/50'
                          }`}
                        >
                          {/* Custom checkbox */}
                          <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-colors ${
                            checked ? 'border-primary bg-primary' : 'border-border bg-background'
                          }`}>
                            {checked && (
                              <svg className="w-3 h-3 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </span>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleTogglePrintOrder(order)}
                            className="sr-only"
                          />

                          {/* Text */}
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate leading-snug">{order.shopkeeperName}</p>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="font-mono text-[11px] text-muted-foreground">{order.orderNumber}</span>
                              <span className="text-[11px] text-muted-foreground">·</span>
                              <span className="text-[11px] text-muted-foreground">{fmt(order.orderedAt)}</span>
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
                            {checked && !loading && pairs !== null && (
                              <span className="inline-flex items-center rounded-full bg-green-100 dark:bg-green-900/30 px-2 py-0.5 text-[10px] font-semibold text-green-700 dark:text-green-400">
                                {pairs} pairs
                              </span>
                            )}
                            <StatusPill status={order.status} />
                          </div>
                        </label>
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
                        <span><span className="font-semibold text-foreground">{selectedOrders.length}</span> order{selectedOrders.length !== 1 ? 's' : ''} selected</span>
                      </div>
                      {allLoaded && totalSelectedPairs > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a2 2 0 014-4z" />
                          </svg>
                          <span><span className="font-semibold text-foreground">{totalSelectedPairs}</span> pairs total</span>
                        </div>
                      )}
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

      {/* ── Sticky bottom actions (new order only) ── */}
      {view === 'new' && (
        // Sits above the phone's bottom menu (z-40 there), at the very bottom from md up.
        <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] left-0 right-0 z-30 bg-background/95 backdrop-blur border-t border-border md:bottom-0 md:pb-[env(safe-area-inset-bottom)]">
          {submitError && (
            <p role="alert" className="mx-auto max-w-4xl px-3 pt-2 text-sm text-red-600 dark:text-red-400 sm:px-4">{submitError}</p>
          )}
          <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2 sm:py-3 flex gap-2 items-center">
            <div className="mr-auto flex min-w-0 shrink flex-col text-xs leading-tight sm:flex-row sm:gap-3 sm:text-sm">
              <span className="font-semibold text-foreground whitespace-nowrap tabular-nums">{`${totalPairs} pairs`}</span>
              <span className="text-muted-foreground whitespace-nowrap">{`${lines.length} line${lines.length !== 1 ? 's' : ''}`}</span>
            </div>
            {editingOrderId != null ? (
              <button type="button" onClick={() => goTo('list')}
                className="h-11 shrink-0 rounded-xl border border-border px-3 sm:px-5 text-sm font-medium hover:bg-muted transition-colors">
                Cancel
              </button>
            ) : (
              <button type="button" onClick={handleSaveDraft} disabled={!(selectedSk || lines.length > 0) || draftStoreFailed}
                className="h-11 shrink-0 rounded-xl border border-border px-3 sm:px-5 text-sm font-medium hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                Save draft
              </button>
            )}
            <button ref={createOrderRef} type="submit" form="new-order-form" disabled={!canSubmit}
              className="h-11 shrink-0 rounded-xl bg-primary px-4 sm:px-6 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {isPending ? (editingOrderId != null ? 'Saving…' : 'Creating…') : (editingOrderId != null ? 'Save Changes' : 'Create Order')}
            </button>
          </div>
        </div>
      )}

      {/* ── Sticky bottom bar — Print Orders ── */}
      {view === 'print' && (() => {
        const assignedOrders = orders.filter(o => o.status === 'assigned' || o.status === 'pending')
        const selectedOrders = assignedOrders.filter(o => printSelectedIds.has(o.id))
        const allLoaded = selectedOrders.every(o => !!printItemsMap[o.id])
        const canPrint = selectedOrders.length > 0 && allLoaded
        const totalPairsSelected = selectedOrders.reduce(
          (s, o) => s + (printItemsMap[o.id] ?? []).reduce((ss, i) => ss + i.quantityOrdered, 0), 0
        )
        return (
          <div className="fixed bottom-[calc(4rem+env(safe-area-inset-bottom))] left-0 right-0 z-30 bg-background/95 backdrop-blur-sm border-t border-border md:bottom-0">
            <div className="max-w-4xl mx-auto px-3 sm:px-4 py-2.5 flex items-center gap-3">
              {/* Left stat pills — only shown when something is selected */}
              {selectedOrders.length > 0 && (
                <div className="flex items-center gap-2 mr-auto flex-wrap">
                  <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground">
                    <svg className="w-3 h-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                    {selectedOrders.length} order{selectedOrders.length !== 1 ? 's' : ''}
                  </span>
                  {allLoaded && totalPairsSelected > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs font-medium text-foreground">
                      <svg className="w-3 h-3 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a2 2 0 014-4z" />
                      </svg>
                      {totalPairsSelected} pairs
                    </span>
                  )}
                  {!allLoaded && (
                    <svg className="w-3.5 h-3.5 text-muted-foreground animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
                    </svg>
                  )}
                </div>
              )}
              <button
                type="button"
                disabled={!canPrint}
                onClick={() => setPrintConfigOpen(true)}
                className={`flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  selectedOrders.length === 0 ? 'w-full sm:w-auto sm:ml-auto' : 'shrink-0'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                {canPrint ? 'Print' : selectedOrders.length === 0 ? 'Select orders to print' : 'Loading…'}
              </button>
            </div>
          </div>
        )
      })()}

      {/* ── Print config modal ── */}
      {printConfigOpen && (() => {
        const assignedOrders = orders.filter(o => o.status === 'assigned' || o.status === 'pending')
        const selectedOrders = assignedOrders.filter(o => printSelectedIds.has(o.id))
        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={e => { if (e.target === e.currentTarget) setPrintConfigOpen(false) }}
          >
            <DialogKeys onClose={() => setPrintConfigOpen(false)} />
            <div className="w-full sm:max-w-sm bg-card rounded-t-2xl sm:rounded-2xl border border-border shadow-2xl overflow-hidden">

              {/* Modal header */}
              <div className="flex items-center justify-between px-4 py-4 border-b border-border">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  <h2 className="text-sm font-semibold text-foreground">Print Settings</h2>
                </div>
                <button
                  type="button"
                  onClick={() => setPrintConfigOpen(false)}
                  className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label="Close"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Pages per paper for these orders, before printing; least paper preselected (owner, 24 Nov 2026). */}
              <PaperEstimate ordersKey={selectedOrders.map(o => o.id).join(',')} pageSize={printPageSize} orientation={printOrientation}
                onPick={(s, o) => { setPrintPageSize(s); setPrintOrientation(o) }}
                orders={selectedOrders.map(o => ({ orderNumber: o.orderNumber, shopkeeperName: o.shopkeeperName, orderedAt: o.orderedAt, salesman: o.salesmanName ?? userName,
                  address: o.shopkeeperAddress || vendorAddressMap.get(o.shopkeeperName.toUpperCase()) || '', sets,
                  items: (printItemsMap[o.id] ?? []).map(it => ({ artNumber: it.artNumber, colorNumber: it.colorNumber ?? null, sizeNumber: it.sizeNumber ?? null, quantityOrdered: it.quantityOrdered })) }))} />

              <div className="px-4 py-4 space-y-4">

                {/* Page size */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Page Size</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { value: 'A4',     label: 'A4',     sub: '210 × 297 mm' },
                      { value: 'A5',     label: 'A5',     sub: '148 × 210 mm' },
                    ] as const).map(({ value, label, sub }) => (
                      <button key={value} type="button"
                        onClick={() => setPrintPageSize(value)}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          printPageSize === value
                            ? 'border-primary bg-primary/8 ring-1 ring-primary'
                            : 'border-border bg-background hover:bg-muted'
                        }`}>
                        {/* Paper icon */}
                        <span className={`flex h-8 w-6 shrink-0 items-center justify-center rounded-sm border-2 ${
                          printPageSize === value ? 'border-primary bg-primary/10' : 'border-muted-foreground/40 bg-muted/40'
                        }`}>
                          <svg className={`w-2.5 h-3 ${printPageSize === value ? 'text-primary' : 'text-muted-foreground'}`} fill="currentColor" viewBox="0 0 8 10">
                            <rect x="1" y="1" width="6" height="8" rx="0.5"/>
                          </svg>
                        </span>
                        <div>
                          <p className={`text-sm font-semibold leading-tight ${printPageSize === value ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Orientation */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Orientation</p>
                  <div className="grid grid-cols-2 gap-2">
                    {([
                      { value: 'portrait',  label: 'Portrait',  sub: `${columnsFor(printPageSize, 'portrait')} columns`,  w: 24, h: 32 },
                      { value: 'landscape', label: 'Landscape', sub: `${columnsFor(printPageSize, 'landscape')} columns`, w: 32, h: 24 },
                    ] as const).map(({ value, label, sub, w, h }) => (
                      <button key={value} type="button"
                        onClick={() => setPrintOrientation(value)}
                        className={`flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          printOrientation === value
                            ? 'border-primary bg-primary/8 ring-1 ring-primary'
                            : 'border-border bg-background hover:bg-muted'
                        }`}>
                        {/* Page shape icon */}
                        <span className={`shrink-0 rounded-sm border-2 ${
                          printOrientation === value ? 'border-primary bg-primary/10' : 'border-muted-foreground/40 bg-muted/40'
                        }`} style={{ width: w, height: h }} />
                        <div>
                          <p className={`text-sm font-semibold leading-tight ${printOrientation === value ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Selected orders summary */}
                <div className="rounded-lg bg-muted/40 border border-border px-3 py-2.5 flex items-center justify-between text-xs text-muted-foreground">
                  <span><span className="font-semibold text-foreground">{selectedOrders.length}</span> order{selectedOrders.length !== 1 ? 's' : ''} will be printed</span>
                  <span className="font-mono text-[11px]">{printPageSize} · {printOrientation === 'portrait' ? '↕' : '↔'}</span>
                </div>
              </div>

              {/* Modal footer */}
              <div className="flex gap-2 px-4 pb-4 pt-0">
                <button type="button"
                  onClick={() => setPrintConfigOpen(false)}
                  className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Cancel
                </button>
                <button type="button"
                  onClick={() => {
                    setPrintConfigOpen(false)
                    handlePrintOrders(selectedOrders, printPageSize, printOrientation)
                  }}
                  className="flex-1 flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring whitespace-nowrap">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                  </svg>
                  Print
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── ⚡ Direct bill of one order: the Direct Billing screen, full screen (owner, 27 Nov 2026) ── */}
      {directOrder && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-background" role="dialog" aria-modal="true" aria-label={`Direct bill ${directOrder.orderNumber}`}>
          <DialogKeys onClose={() => setDirectOrder(null)} />
          <div className="sticky top-0 z-40 flex items-center gap-3 border-b border-border bg-background/95 px-3 py-2.5 backdrop-blur sm:px-4">
            <button type="button" onClick={() => setDirectOrder(null)} aria-label="Back to orders"
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
              articles={catalogue.articles.map(a => a.artNumber)}
              pickers={pickers}
              rateDefaults={billRates}
              embedded
              onBillGenerated={(res) => {
                keepSaved({ ...directOrder, status: 'billed', updatedAt: new Date() }, directOrder.salesmanName ?? null)
                setNotice(`${res.orderNumber} billed · bill ${res.billNo}${res.stock.unscanned_dispatch > 0 ? ` · ${res.stock.unscanned_dispatch} box(es) went out as Unscanned dispatch` : ''}`)
                setDirectOrder(null)
              }}
            />
          </div>
        </div>
      )}

      {/* ── One order: Assign picker ── */}
      {rowAction && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={e => { if (e.target === e.currentTarget && !rowSaving) setRowAction(null) }}
        >
          <DialogKeys onClose={() => { if (!rowSaving) setRowAction(null) }} />
          <form
            role="dialog" aria-modal="true" aria-labelledby="row-action-title"
            onSubmit={e => { e.preventDefault(); saveRowAction() }}
            className="w-full sm:max-w-sm rounded-t-3xl sm:rounded-3xl bg-background p-5 shadow-2xl space-y-4"
          >
            <div>
              <p id="row-action-title" className="text-lg font-bold text-foreground">
                Assign picker
              </p>
              <p className="mt-0.5 truncate text-sm text-muted-foreground">
                {rowAction.order.shopkeeperName} · <span className="font-mono" data-no-translate>{rowAction.order.orderNumber}</span>
              </p>
            </div>
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-foreground">Picker</span>
              <select
                autoFocus
                value={rowPicker}
                onChange={e => { setRowPicker(e.target.value); setRowError('') }}
                className="w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">— Choose —</option>
                {pickers.map(p => <option key={p.id} value={p.id}>{p.name ?? p.id}</option>)}
              </select>
            </label>
            {rowError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{rowError}</p>}
            <div className="flex gap-2">
              <button type="button" onClick={() => setRowAction(null)} disabled={rowSaving}
                className="flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold hover:bg-muted disabled:opacity-50">
                Cancel
              </button>
              <button type="submit" disabled={rowSaving}
                className="flex-1 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {rowSaving ? 'Saving…' : 'Assign'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Set picker dialog ── */}
      {setPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm"
          onClick={() => setSetPickerOpen(false)}
        >
          <DialogKeys onClose={() => setSetPickerOpen(false)} />
          <div
            className="w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl bg-background shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            {/* Drag handle (mobile only) */}
            <div className="sm:hidden flex justify-center pt-3 pb-1">
              <div className="w-10 h-1 rounded-full bg-border" />
            </div>

            {/* Header */}
            <div className="flex items-start justify-between px-6 pt-5 pb-4 border-b border-border">
              <div>
                <p className="text-xl font-bold text-foreground tracking-tight">Select a Set</p>
                {selectedArt && selectedColor && (
                  <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1.5">
                    <span>{selectedArt.artNumber}</span>
                    <span className="text-muted-foreground/30">·</span>
                    <span className="w-3 h-3 rounded-full border border-border inline-block shrink-0"
                      style={{ background: swatch(selectedColor.colorHex, selectedColor.colorName) }} />
                    <span>{selectedColor.colorName}</span>
                  </p>
                )}
              </div>
              <button
                onClick={() => setSetPickerOpen(false)}
                className="mt-0.5 text-muted-foreground hover:text-foreground transition-colors text-lg leading-none"
                aria-label="Close"
              >
                ×
              </button>
            </div>

            {/* Set list */}
            <div className="overflow-y-auto max-h-[50vh] px-4 py-3 space-y-2">
              {sets.length === 0 && (
                <p className="text-center py-6 text-sm text-muted-foreground">No sets registered yet.</p>
              )}
              {sets.map(s => {
                const total = Object.values(s.quantities).reduce((acc, n) => acc + n, 0)
                const preview = Object.entries(s.quantities)
                  .filter(([, v]) => v > 0)
                  .map(([k, v]) => `${k}×${v}`)
                  .join(', ')
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => handlePickSet({ ...s.quantities })}
                    className="w-full rounded-2xl bg-muted/60 px-5 py-3.5 text-left hover:bg-muted active:scale-[0.98] transition-all"
                  >
                    {/* Row 1: name + total */}
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-base font-bold text-foreground">{s.name}</span>
                      <span className="shrink-0 text-base font-bold text-foreground tabular-nums">
                        {total} <span className="text-xs font-normal text-muted-foreground">pairs</span>
                      </span>
                    </div>
                    {/* Row 2: full sizes — wraps, never truncates */}
                    <p className="text-xs text-muted-foreground font-mono mt-1 leading-relaxed break-all">
                      {preview || '—'}
                    </p>
                  </button>
                )
              })}
            </div>

            {/* Footer */}
            <div className="px-4 pb-5 pt-3 border-t border-border">
              <button
                onClick={() => setSetPickerOpen(false)}
                className="w-full rounded-2xl border border-border bg-background px-4 py-4 text-base font-medium text-foreground hover:bg-muted transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set confirmation dialog (when matrix already has values) ── */}
      {setConfirm && (
        <ConfirmDialog
          title="Replace current quantities?"
          message={<>This will replace the quantities currently entered for <strong>{selectedColor?.colorName}</strong>.</>}
          confirmLabel="Apply Set"
          onCancel={() => { setSetConfirm(false); setPendingSetQties(null) }}
          onConfirm={confirmApplySet}
        />
      )}

      {/* ── Drafts panel (same pattern as Direct Billing's draft bills) ── */}
      {draftsOpen && (
        <SidePanel title="Draft orders" onClose={() => setDraftsOpen(false)}>
          <p className="mb-4 text-sm text-muted-foreground">Orders that were started and not created. Saved on this phone as you work; not sent to the warehouse.</p>
          {openDraftId != null && (
            <div className="mb-3 rounded-xl border-2 border-primary/60 px-3 py-2.5">
              <p className="truncate text-sm font-semibold"><span data-no-translate>{selectedSk?.name || 'No vendor yet'}</span></p>
              <p className="text-xs text-muted-foreground">{`Open now · ${draftArticles({ lines })} article(s) · ${totalPairs} pairs`}</p>
              <button type="button" onClick={handleSaveDraft}
                className="mt-2 h-9 rounded-lg border border-border px-3 text-xs font-semibold hover:bg-muted">
                Start a new order (keep this as draft)
              </button>
            </div>
          )}
          {otherDrafts.length === 0 && <p className="text-sm text-muted-foreground">No other saved drafts.</p>}
          {otherDrafts.length > 0 && (
            <ul className="divide-y divide-border rounded-xl border border-border">
              {otherDrafts.map(d => (
                <li key={d.id} className="flex items-center gap-2 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium"><span data-no-translate>{d.vendor?.name || 'No vendor yet'}</span></p>
                    <p className="text-[11px] text-muted-foreground">
                      {`${draftArticles(d)} article(s) · ${draftPairs(d)} pairs · ${fmt(new Date(d.savedAt))}`}
                    </p>
                  </div>
                  <button type="button" onClick={() => { setDraftsOpen(false); openDraft(d) }}
                    className="h-9 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground">Open</button>
                  <button type="button" onClick={() => setDeleteDraftId(d.id)}
                    className="h-9 rounded-lg border border-border px-3 text-xs text-destructive hover:bg-muted">Discard</button>
                </li>
              ))}
            </ul>
          )}
        </SidePanel>
      )}

      {/* ── Drafts: start over / delete ── */}
      {discardOpen && (
        <ConfirmDialog
          title="Start over?"
          message="This order and its draft will be removed from this phone."
          confirmLabel="Start over"
          onCancel={() => setDiscardOpen(false)}
          onConfirm={handleDiscardCurrent}
        />
      )}
      {deleteDraftId != null && (() => {
        const d = drafts.find(x => x.id === deleteDraftId)
        return (
          <ConfirmDialog
            title="Discard this draft?"
            message={<><strong>{d?.vendor?.name ?? 'No vendor yet'}</strong>{d ? ` · ${draftPairs(d)} pairs` : ''}<br />This cannot be undone.</>}
            confirmLabel="Discard"
            onCancel={() => setDeleteDraftId(null)}
            onConfirm={handleDeleteDraft}
          />
        )
      })()}

      {/* ── Cancel order confirmation ── */}
      {cancelOrderId != null && (() => {
        // Look up from orders list OR fall back to detailOrder (when cancelling from detail view)
        const order = orders.find(o => o.id === cancelOrderId) ?? (detailOrder?.id === cancelOrderId ? detailOrder : null)
        return order ? (
          <ConfirmDialog
            title="Cancel this order?"
            message={<><strong>{order.shopkeeperName}</strong> · <span className="font-mono">{order.orderNumber}</span><br />This cannot be undone.</>}
            confirmLabel={cancellingOrder ? 'Cancelling…' : 'Cancel Order'}
            onCancel={() => setCancelOrderId(null)}
            onConfirm={handleCancelOrder}
          />
        ) : null
      })()}

    </div>
  )
}
