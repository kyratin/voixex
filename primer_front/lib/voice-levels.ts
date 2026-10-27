"use client"

import { useSyncExternalStore } from "react"

/**
 * Live voice loudness per member (0..1), from the server's `voice_levels` events (~10 Hz while
 * someone talks). Kept outside React state on purpose: only the avatars that show a level
 * re-render, not the whole page ten times a second.
 */
const byRoom = new Map<string, Record<string, number>>()
const levels = new Map<string, number>()
const listeners = new Set<() => void>()

function rebuild() {
  levels.clear()
  for (const room of byRoom.values()) for (const [id, level] of Object.entries(room)) levels.set(id, level)
  for (const l of listeners) l()
}

let staleTimer: ReturnType<typeof setTimeout> | null = null

/** One room's update replaces that room's levels (members missing from it are silent). */
export function setRoomVoiceLevels(roomId: string, next: Record<string, number>) {
  if (Object.keys(next).length === 0) byRoom.delete(roomId)
  else byRoom.set(roomId, next)
  rebuild()
  // Updates stop when a room empties mid-sentence: fade everything out instead of freezing.
  if (staleTimer) clearTimeout(staleTimer)
  staleTimer = setTimeout(clearVoiceLevels, 1000)
}

export function clearVoiceLevels() {
  if (byRoom.size === 0) return
  byRoom.clear()
  rebuild()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Current loudness of one member, 0 when silent or unknown. */
export function useVoiceLevel(clientId: string) {
  return useSyncExternalStore(
    subscribe,
    () => levels.get(clientId) ?? 0,
    () => 0
  )
}
