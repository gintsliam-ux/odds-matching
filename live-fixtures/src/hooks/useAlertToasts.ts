import { useEffect, useRef, useState } from 'react'
import type { Notification } from './useNotifications'

export interface AlertToast {
  id: string
  notification: Notification
  /** When the toast first appeared, for relative-time labels. */
  firedAt: number
  /** When the underlying alert resolved (SwiftBet flipped to inprogress).
   *  null while still firing — the toast renders in red. Non-null switches
   *  the toast to a "resolved" green state but keeps it visible until X. */
  resolvedAt: number | null
}

/**
 * Maintains a persistent queue of in-page toasts for "SwiftBet still open on
 * started event" alerts. Each unique alert id appears once; the toast lives
 * until the user clicks its X. Re-visits during the same session don't
 * re-show dismissed alerts.
 */
/**
 * Plays a short two-note chime via the Web Audio API. No audio file, no
 * autoplay-policy headaches once the user has interacted with the page
 * (Chrome/Safari unlock AudioContext on any user gesture).
 */
function playChime(ctxRef: { current: AudioContext | null }): void {
  try {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      ctxRef.current = new Ctor()
    }
    const ctx = ctxRef.current
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const now = ctx.currentTime
    // Two-tone alert beep: G5 (~784 Hz) then C6 (~1047 Hz).
    for (const [freq, start, dur] of [
      [784, now, 0.16],
      [1047, now + 0.18, 0.22],
    ] as Array<[number, number, number]>) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      // Quick attack/release so it sounds like a chime, not a sustained tone.
      gain.gain.setValueAtTime(0.0001, start)
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.01)
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(start)
      osc.stop(start + dur + 0.02)
    }
  } catch {
    /* AudioContext unavailable or blocked — silent fallback */
  }
}

export function useAlertToasts(notifications: Notification[]): {
  toasts: AlertToast[]
  dismiss: (id: string) => void
  dismissAll: () => void
} {
  const [toasts, setToasts] = useState<AlertToast[]>([])
  const [dismissed, setDismissed] = useState<Set<string>>(new Set())
  const audioCtxRef = useRef<AudioContext | null>(null)

  useEffect(() => {
    const open = notifications.filter((n) => n.kind === 'swift_still_open')
    const openIds = new Set(open.map((n) => n.id))
    setToasts((prev) => {
      const seen = new Set(prev.map((t) => t.id))
      const fresh: AlertToast[] = []
      for (const n of open) {
        if (seen.has(n.id) || dismissed.has(n.id)) continue
        fresh.push({ id: n.id, notification: n, firedAt: Date.now(), resolvedAt: null })
      }
      // Mark previously-firing toasts as resolved when they leave the open
      // set, but keep them in the array so the operator sees what happened
      // until they hit X. Once a toast is resolved its row stays static —
      // toggling back if SWIFT briefly re-flaps to prematch isn't reflected.
      let changed = fresh.length > 0
      const updated = prev.map((t) => {
        if (t.resolvedAt) return t
        if (!openIds.has(t.id)) {
          changed = true
          return { ...t, resolvedAt: Date.now() }
        }
        return t
      })
      // Critical: return existing ref when nothing changed — otherwise the
      // hook caused an infinite-render loop that locked all routing.
      if (!changed) return prev
      if (fresh.length > 0) playChime(audioCtxRef)
      return [...updated, ...fresh]
    })
  }, [notifications, dismissed])

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev)
      next.add(id)
      return next
    })
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  const dismissAll = () => {
    setDismissed((prev) => {
      const next = new Set(prev)
      for (const t of toasts) next.add(t.id)
      return next
    })
    setToasts([])
  }

  return { toasts, dismiss, dismissAll }
}
