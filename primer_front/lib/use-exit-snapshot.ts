"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"

/**
 * Keeps the last non-null element on screen for `ms` after it goes away, so it can play an
 * exit animation instead of vanishing (e.g. the voice stage when leaving a channel).
 * Returns that leftover element while it leaves, otherwise null.
 */
export function useExitSnapshot(element: ReactNode | null, ms: number): ReactNode | null {
  const last = useRef<ReactNode | null>(null)
  const [leaving, setLeaving] = useState<ReactNode | null>(null)
  const present = element !== null && element !== undefined && element !== false

  // Remember what was shown (after render, not during it).
  useEffect(() => {
    if (present) last.current = element
  })

  useEffect(() => {
    if (present) {
      setLeaving(null)
      return
    }
    if (!last.current) return
    setLeaving(last.current)
    last.current = null
    const timer = setTimeout(() => setLeaving(null), ms)
    return () => clearTimeout(timer)
  }, [present, ms])

  return present ? null : leaving
}
