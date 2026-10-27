"use client"

import type { CSSProperties, ReactNode } from "react"
import { avatarGradient } from "@/lib/avatar-colors"
import { cn } from "@/lib/utils"
import { useVoiceLevel } from "@/lib/voice-levels"

/** Accent green (--accent) as rgb components for the rings. */
const RING = "35 165 90"

/**
 * Avatar with rings that follow how loud the member is talking: they grow, brighten and glow
 * with the level. Levels arrive ~10 Hz; the CSS transitions smooth them between updates.
 * Servers without level events only say "speaking": that shows as a medium ring.
 */
export function SpeakingAvatar({
  id,
  label,
  isSpeaking = false,
  className,
  ringScale = 1,
  children
}: {
  id: string
  /** Seed for the gradient when id is empty. */
  label: string
  isSpeaking?: boolean
  /** Size of the avatar, e.g. "size-14 text-lg". */
  className?: string
  /** Smaller rings for small avatars (sidebar stacks). */
  ringScale?: number
  children: ReactNode
}) {
  const level = useVoiceLevel(id)
  const effective = level > 0 ? level : isSpeaking ? 0.35 : 0
  const on = effective > 0.02
  const inner: CSSProperties = {
    transform: `scale(${1 + (0.08 + effective * 0.12) * ringScale})`,
    opacity: on ? 0.55 + effective * 0.45 : 0,
    boxShadow: `0 0 0 ${Math.max(1.5, 2 * ringScale)}px rgb(${RING} / 0.95), 0 0 ${(6 + effective * 18) * ringScale}px rgb(${RING} / ${0.25 + effective * 0.45})`
  }
  const outer: CSSProperties = {
    transform: `scale(${1 + (0.16 + effective * 0.34) * ringScale})`,
    opacity: on ? effective * 0.55 : 0,
    boxShadow: `0 0 0 ${Math.max(1, 1.5 * ringScale)}px rgb(${RING} / 0.5)`
  }
  return (
    <div className="relative shrink-0">
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full transition-[transform,opacity,box-shadow] duration-150 ease-out" style={outer} />
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full transition-[transform,opacity,box-shadow] duration-150 ease-out" style={inner} />
      <div
        className={cn("relative flex items-center justify-center rounded-full font-bold text-white", className)}
        style={{ background: avatarGradient(id || label) }}
      >
        {children}
      </div>
    </div>
  )
}
