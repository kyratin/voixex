"use client"

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { createPortal } from "react-dom"
import { Headphones, HeadphoneOff, Maximize2, Mic, MicOff, PhoneOff, Volume2, X } from "lucide-react"
import type { VoiceUser } from "@/components/voip/channel-sidebar"
import { SpeakingAvatar } from "@/components/voip/speaking-avatar"
import { useI18n } from "@/lib/i18n/provider"
import { cn } from "@/lib/utils"

/** Window name the desktop app recognizes (frameless, always on top, bottom-right corner). */
const MINI_WINDOW_NAME = "voixex-mini"

const drag = { WebkitAppRegion: "drag" } as CSSProperties
const noDrag = { WebkitAppRegion: "no-drag" } as CSSProperties

/**
 * The call at a glance, like Google Meet's floating window: who is in the channel, who is
 * talking (the rings follow their volume), and mute / deafen / leave.
 * `pip` is Android picture-in-picture: the system draws the buttons there, taps don't reach us.
 */
export function MiniCallView({
  channelName,
  participants,
  live,
  isMuted,
  isDeafened,
  onToggleMute,
  onToggleDeafen,
  onLeave,
  onOpen,
  onClose,
  pip = false
}: {
  channelName: string
  participants: VoiceUser[]
  /** Name of who is streaming, if anyone. */
  live: string | null
  isMuted: boolean
  isDeafened: boolean
  onToggleMute: () => void
  onToggleDeafen: () => void
  onLeave: () => void
  onOpen: () => void
  onClose?: () => void
  pip?: boolean
}) {
  const { t } = useI18n()
  const speaking = participants.filter((u) => u.isSpeaking)
  const many = participants.length > 4
  return (
    <div className="flex h-full select-none flex-col overflow-hidden bg-background text-foreground">
      <div className={cn("flex shrink-0 items-center gap-2 px-3", pip ? "pt-2" : "h-9 border-b border-border/60")} style={pip ? undefined : drag}>
        <Volume2 className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold">{channelName}</span>
        {live ? (
          <span className="shrink-0 rounded bg-destructive px-1 py-px text-[9px] font-bold uppercase text-white" title={live}>
            Live
          </span>
        ) : null}
        {pip ? null : (
          <span className="flex shrink-0 items-center" style={noDrag}>
            <HeaderButton label={t("mini.open")} onClick={onOpen}>
              <Maximize2 className="h-3.5 w-3.5" />
            </HeaderButton>
            {onClose ? (
              <HeaderButton label={t("mini.hide")} onClick={onClose}>
                <X className="h-3.5 w-3.5" />
              </HeaderButton>
            ) : null}
          </span>
        )}
      </div>

      <button
        type="button"
        onDoubleClick={onOpen}
        className="flex min-h-0 flex-1 flex-wrap content-center items-center justify-center gap-x-3 gap-y-2 overflow-y-auto px-3 py-2"
      >
        {participants.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("mini.empty")}</span>
        ) : (
          participants.map((u) => (
            <span key={u.id} className="flex w-14 flex-col items-center gap-1 animate-in fade-in zoom-in-90 duration-300">
              <span className="relative">
                <SpeakingAvatar
                  id={u.id}
                  label={u.name}
                  isSpeaking={u.isSpeaking}
                  ringScale={0.8}
                  className={many ? "size-9 text-sm" : "size-11 text-base"}
                >
                  {u.avatar.slice(0, 1).toUpperCase()}
                </SpeakingAvatar>
                {u.isDeafened || u.isMuted ? (
                  <span className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-background">
                    {u.isDeafened ? <HeadphoneOff className="h-2.5 w-2.5 text-destructive" /> : <MicOff className="h-2.5 w-2.5 text-muted-foreground" />}
                  </span>
                ) : null}
              </span>
              <span className={cn("w-full truncate text-center text-[10px]", u.isSpeaking ? "text-foreground" : "text-muted-foreground")}>{u.name}</span>
            </span>
          ))
        )}
      </button>

      {pip ? (
        <p className="shrink-0 truncate px-3 pb-2 text-center text-[10px] text-muted-foreground">
          {speaking.length > 0 ? speaking.map((u) => u.name).join(", ") : t("voice.participantsCount", { n: participants.length })}
        </p>
      ) : (
        <div className="flex shrink-0 items-center justify-center gap-2 border-t border-border/60 px-3 py-2">
          <ControlButton label={isMuted ? t("userPanel.unmute") : t("userPanel.mute")} active={isMuted} onClick={onToggleMute}>
            {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          </ControlButton>
          <ControlButton label={isDeafened ? t("userPanel.undeafen") : t("userPanel.deafen")} active={isDeafened} onClick={onToggleDeafen}>
            {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
          </ControlButton>
          <ControlButton label={t("userPanel.leaveVoiceChannel")} destructive onClick={onLeave}>
            <PhoneOff className="h-4 w-4" />
          </ControlButton>
        </div>
      )}
    </div>
  )
}

/** Plain title tooltips: Radix tooltips would open in the main window, not in this one. */
function HeaderButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  )
}

function ControlButton({
  label,
  onClick,
  active = false,
  destructive = false,
  children
}: {
  label: string
  onClick: () => void
  active?: boolean
  destructive?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex h-8 w-11 items-center justify-center rounded-lg transition-colors",
        destructive
          ? "bg-destructive text-white hover:bg-destructive/90"
          : active
            ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
            : "bg-secondary text-foreground hover:bg-secondary/80"
      )}
    >
      {children}
    </button>
  )
}

/**
 * Opens the mini window while `open` and renders `children` into it with a portal, so it shows
 * live state without any syncing. The page's styles are copied over. `onClosed` fires when the
 * window is closed from outside (system close, Alt+F4).
 */
export function MiniCallWindow({ open, onClosed, children }: { open: boolean; onClosed: () => void; children: React.ReactNode }) {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const onClosedRef = useRef(onClosed)
  onClosedRef.current = onClosed

  useEffect(() => {
    if (!open) return
    const popup = window.open("about:blank", MINI_WINDOW_NAME, "width=320,height=236")
    if (!popup) return
    const doc = popup.document
    doc.title = "Voixex"
    for (const node of Array.from(document.querySelectorAll<HTMLElement>('link[rel="stylesheet"], style'))) {
      const clone = node.cloneNode(true) as HTMLElement
      // about:blank has no base URL of its own: point stylesheets at their full address.
      if (clone instanceof HTMLLinkElement) clone.href = (node as HTMLLinkElement).href
      doc.head.appendChild(clone)
    }
    doc.documentElement.className = document.documentElement.className
    doc.documentElement.style.cssText = document.documentElement.style.cssText
    doc.body.className = document.body.className
    doc.body.style.margin = "0"
    doc.body.style.overflow = "hidden"
    const root = doc.createElement("div")
    root.style.height = "100vh"
    doc.body.appendChild(root)
    setContainer(root)

    let closing = false
    const onUnload = () => {
      if (!closing) onClosedRef.current()
    }
    popup.addEventListener("pagehide", onUnload)
    return () => {
      closing = true
      popup.removeEventListener("pagehide", onUnload)
      setContainer(null)
      popup.close()
    }
  }, [open])

  return container ? createPortal(children, container) : null
}
