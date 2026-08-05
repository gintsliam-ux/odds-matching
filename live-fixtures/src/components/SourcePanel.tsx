import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { BRAND_PILL, BRAND_TONE, type Brand } from '../lib/brand'

// Shared building blocks for a per-source detail panel: the OPTIC / SWIFT /
// MYBET cards, and the label-value grid inside them.
//
// Lifted out of FixtureDetailPage so the golf tournament page renders the SAME
// components rather than a lookalike — a copy drifts, and the two pages are
// meant to read identically.

export function SourcePanel({
  kind,
  subtitle,
  action,
  children,
}: {
  kind: 'OPTIC' | 'SWIFT' | 'MYBET'
  subtitle: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  // One accent per source: OPTIC=blue, SWIFT=green, MYBET=amber/live. Literal
  // class strings — Tailwind extracts these statically, so no interpolation.
  const brand = kind.toLowerCase() as Brand
  const tone = BRAND_TONE[brand]
  const pill = BRAND_PILL[brand]
  return (
    <div className={`rounded-lg ${tone} px-4 py-3.5`}>
      <div className="mb-3 flex items-center justify-between">
        <span
          className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium ${pill}`}
        >
          {kind}
        </span>
        <div className="flex items-center gap-2">
          {action}
          <span className="text-[11px] text-[color:var(--muted-2)]">{subtitle}</span>
        </div>
      </div>
      {children}
    </div>
  )
}

export function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>
}

export function Field({
  label,
  value,
  mono,
  copyable,
  tone,
}: {
  label: string
  value: string
  mono?: boolean
  copyable?: boolean
  /** Optional text colour class, e.g. the settlement verdict's amber/green. */
  tone?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-[color:var(--muted-2)]">{prettyLabel(label)}</div>
      <div className="flex items-center gap-1.5">
        <div className={`truncate text-[13px] ${tone ?? 'text-gray-200'} ${mono ? 'tabular-nums' : ''}`}>{value}</div>
        {copyable && value && value !== '—' && <CopyButton value={value} />}
      </div>
    </div>
  )
}

/** Inline copy-to-clipboard button. Shows a brief ✓ check on success. */
export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  async function copy(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      // clipboard unavailable (insecure context) — best-effort fallback
      const ta = document.createElement('textarea')
      ta.value = value
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    }
  }
  return (
    <button
      onClick={copy}
      className="shrink-0 rounded p-1 text-gray-500 transition-colors hover:bg-white/10 hover:text-gray-200"
      title={copied ? 'Copied!' : 'Copy to clipboard'}
      aria-label={`Copy ${value}`}
    >
      {copied ? (
        <Check className="h-3 w-3 text-[var(--total)]" strokeWidth={3} />
      ) : (
        <Copy className="h-3 w-3" />
      )}
    </button>
  )
}

// Field labels used to be ALL CAPS in the call sites ("FIXTURE ID", "START (UTC)").
// Normalise them at render time so the call sites stay readable.
function prettyLabel(s: string): string {
  if (!s) return s
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      // Keep parenthetical timezone codes uppercase ("(utc)" → "(UTC)")
      if (/^\(?(utc|mel|id|raw)\)?$/i.test(w.replace(/[()]/g, ''))) return w.toUpperCase()
      if (i === 0) return w.charAt(0).toUpperCase() + w.slice(1)
      return w
    })
    .join(' ')
}
