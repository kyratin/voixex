"use client"

import { useSyncExternalStore } from "react"

export type LocalVoiceActivity = { speaking: boolean; level: number }
const silence: LocalVoiceActivity = { speaking: false, level: 0 }
let current = silence
let staleTimer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** Detect speech from post-DSP microphone RMS, independently of transport packet counts. */
export class VoiceActivityDetector {
  private until = 0
  private lastLevel = 0

  sample(rms: number, now: number, enabled: boolean): LocalVoiceActivity {
    if (!enabled || !Number.isFinite(rms) || rms < 0) {
      this.until = 0
      this.lastLevel = 0
      return silence
    }
    // Match the remote speaking display's -50..-12 dBFS range. A -44 dBFS
    // microphone is audible and lights its remote tile; it must light self too.
    const threshold = now < this.until ? 0.0028 : 0.0036
    if (rms >= threshold) {
      this.until = now + 180
      this.lastLevel = Math.max(0.03, Math.min(1, (20 * Math.log10(rms) + 50) / 38))
    }
    if (now >= this.until) return silence
    return { speaking: true, level: this.lastLevel }
  }
}

export function setLocalVoiceActivity(next: LocalVoiceActivity) {
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = next.speaking ? setTimeout(resetLocalVoiceActivity, 400) : null
  if (next.speaking === current.speaking && next.level === current.level) return
  current = next
  for (const listener of listeners) listener()
}

export function resetLocalVoiceActivity() { setLocalVoiceActivity(silence) }

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

const noSubscription = () => () => {}

/** Remote tiles do not subscribe to every local microphone sample. */
export function useLocalVoiceActivity(enabled = true) {
  return useSyncExternalStore(enabled ? subscribe : noSubscription, () => enabled ? current : silence, () => silence)
}
