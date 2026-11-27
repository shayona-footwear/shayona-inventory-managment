// Shared utilities for the orders UI (used by client components only)

import { tablistKeyDown } from '@/lib/shortcuts/tabs'
import { DialogKeys } from '@/components/dialog-keys'

export type BadgeColor = 'gray' | 'blue' | 'yellow' | 'green' | 'red' | 'purple' | 'orange'

export const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  to_confirm: { label: 'To confirm',  color: 'bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300' },
  pending:    { label: 'Pending',     color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400' },
  assigned:   { label: 'Assigned',    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  packed:     { label: 'Packed',      color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400' },
  billed:     { label: 'Billed',      color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  dispatched: { label: 'Dispatched',  color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400' },
  delivered:  { label: 'Delivered',   color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400' },
  cancelled:  { label: 'Cancelled',   color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
  out_of_stock: { label: 'Out of Stock', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
}

export const ROLE_BADGE: Record<string, { label: string; color: string }> = {
  admin:      { label: 'Admin',       color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400' },
  accountant: { label: 'Accountant',  color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-400' },
  salesman:   { label: 'Salesman',    color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  picker:     { label: 'Picker',      color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400' },
  biller:     { label: 'Biller',      color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400' },
  dispatcher: { label: 'Dispatcher',  color: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400' },
  user:       { label: 'No Role',     color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' },
}

/** Status dot colour (owner, 27 Nov 2026: the old filled pills did not suit the new look). */
const STATUS_DOT: Record<string, string> = {
  to_confirm: 'bg-amber-400', pending: 'bg-amber-400', assigned: 'bg-blue-500', packed: 'bg-violet-500',
  billed: 'bg-sky-400', dispatched: 'bg-orange-500', delivered: 'bg-emerald-500', cancelled: 'bg-red-500', out_of_stock: 'bg-red-500',
}

/** Order status: a coloured dot and the word in a thin outline chip. */
export function StatusPill({ status }: { status: string }) {
  const label = STATUS_BADGE[status]?.label ?? status
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-foreground/80">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[status] ?? 'bg-muted-foreground'}`} aria-hidden />
      {label}
    </span>
  )
}

/** New / Updated on an order row: a small dot and the word, no box. */
export function ChangeTag({ tag }: { tag: 'new' | 'updated' | null | undefined }) {
  if (!tag) return null
  const on = tag === 'new'
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium ${on ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${on ? 'bg-emerald-500' : 'bg-sky-500'}`} aria-hidden />
      {on ? 'New' : 'Updated'}
    </span>
  )
}

export function RolePill({ role }: { role: string | null | undefined }) {
  if (!role) {
    const r = ROLE_BADGE.user
    return (
      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${r.color}`}>
        {r.label}
      </span>
    )
  }

  const roles = role.split(',').map(r => r.trim()).filter(Boolean)
  if (roles.length === 0) {
    const r = ROLE_BADGE.user
    return (
      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${r.color}`}>
        {r.label}
      </span>
    )
  }

  return (
    <div className="flex flex-wrap gap-1">
      {roles.map(r => {
        const badge = ROLE_BADGE[r] ?? ROLE_BADGE.user
        return (
          <span key={r} className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${badge.color}`}>
            {badge.label}
          </span>
        )
      })}
    </div>
  )
}

export function fmt(d: Date | null | undefined) {
  if (!d) return '—'
  return new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d))
}

export function PageHeader({ title, subtitle, back }: { title: string; subtitle?: string; back?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4 sm:mb-6 min-w-0">
      {back && (
        <a href={back} className="flex items-center justify-center w-8 h-8 rounded-lg border border-border hover:bg-muted transition-colors">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </a>
      )}
      <div>
        <h1 className="text-lg sm:text-xl font-semibold text-foreground truncate">{title}</h1>
        {subtitle && <p className="text-xs sm:text-sm text-muted-foreground line-clamp-2">{subtitle}</p>}
      </div>
    </div>
  )
}

/** "In progress" for a salesman: with the warehouse or billing, not yet dispatched (same rule as the card). */
export const isInProgress = (status: string) => !['pending', 'cancelled', 'dispatched', 'delivered'].includes(status)

/**
 * A stat card that is also a button: tapping it opens the matching list (Pending → the pending
 * orders). `active` marks the card whose list is showing.
 */
export function StatButton({ label, value, color, active, onClick, hint }: {
  label: string; value: number | string; color?: string; active?: boolean; onClick: () => void; hint?: string
}) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active} title={hint}
      className={`group min-w-0 rounded-xl border bg-card px-2.5 py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] sm:px-4 sm:py-3 ${
        active ? 'border-primary ring-1 ring-primary' : 'border-border hover:bg-muted/40'
      }`}>
      {/* Normal case on phones so "In progress" fits a quarter of the screen. */}
      <span className="block truncate text-[11px] font-medium text-muted-foreground sm:text-xs sm:uppercase sm:tracking-wide">{label}</span>
      <span className="mt-0.5 flex items-baseline justify-between gap-1">
        <span className={`text-xl font-bold tabular-nums sm:text-2xl ${color ?? 'text-foreground'}`}>{value}</span>
        <svg className={`h-3.5 w-3.5 shrink-0 transition-colors ${active ? 'text-primary' : 'text-muted-foreground/40 group-hover:text-muted-foreground'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
      </span>
    </button>
  )
}

/**
 * Right-hand panel, same look as Direct Billing's (drafts, things used now and then). Full screen on
 * a phone. Esc or a tap outside closes it.
 */
export function SidePanel({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  // Esc, focus inside, Tab wraps, focus back to the opener: <DialogKeys>.
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <DialogKeys onClose={onClose} />
      <section role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-2xl">
        <div className="flex items-center gap-3 border-b border-border px-4 py-3 sm:px-5 sm:py-4">
          <h2 className="flex-1 text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-10 w-10 items-center justify-center rounded-lg border border-border hover:bg-muted">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] sm:p-5">{children}</div>
      </section>
    </div>
  )
}

export interface SegTab<T extends string> { value: T; label: string; count?: number }

/** Segmented tabs that fit a phone: equal columns, short labels, optional count bubble. */
export function SegTabs<T extends string>({ tabs, active, onChange, label }: {
  tabs: SegTab<T>[]; active: T; onChange: (v: T) => void; label: string
}) {
  return (
    <div role="tablist" aria-label={label} onKeyDown={tablistKeyDown} className="grid gap-1 rounded-xl border border-border bg-muted/40 p-1"
      style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map(t => {
        const on = t.value === active
        return (
          <button key={t.value} type="button" role="tab" aria-selected={on} onClick={() => onChange(t.value)}
            className={`flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-1 py-2 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm ${
              on ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            }`}>
            <span className="truncate">{t.label}</span>
            {t.count != null && t.count > 0 && (
              <span className={`inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold tabular-nums ${
                on ? 'bg-foreground text-background' : 'bg-muted-foreground/20 text-muted-foreground'
              }`}>{t.count}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-2.5 sm:p-4">
      <p className="text-[10px] sm:text-xs text-muted-foreground font-medium uppercase tracking-wide truncate">{label}</p>
      <p className={`text-xl sm:text-2xl font-bold mt-0.5 sm:mt-1 tabular-nums ${color ?? 'text-foreground'}`}>{value}</p>
    </div>
  )
}
