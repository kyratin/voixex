"use client"

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type Ref, type RefObject } from "react"
import {
  Video,
  VideoOff,
  Eye,
  EyeOff,
  ExternalLink,
  Headphones,
  HeadphoneOff,
  Loader2,
  Maximize2,
  Mic,
  MicOff,
  Minimize2,
  Monitor,
  MonitorOff,
  MoreHorizontal,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  PhoneOff,
  Volume2
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { StreamVolumeControl } from "@/components/voip/stream-volume-control"
import type { VoiceUser } from "@/components/voip/channel-sidebar"
import { SpeakingAvatar } from "@/components/voip/speaking-avatar"
import { useVoiceLevel } from "@/lib/voice-levels"
import { useLocalVoiceActivity } from "@/lib/voice-activity"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/provider"

import type { CameraControls, CameraPicture } from "@/lib/camera/use-camera"

export function CameraVideo({ picture, mirror }: { picture: CameraPicture; mirror: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !picture.stream) return
    el.srcObject = picture.stream
    void el.play().catch(() => {})
    return () => { el.srcObject = null }
  }, [picture.stream])
  const className = cn("absolute inset-0 h-full w-full rounded-xl bg-black object-cover", mirror && "-scale-x-100")
  return picture.stream ? <video ref={ref} muted autoPlay playsInline className={className} onDoubleClick={event => { event.stopPropagation(); void event.currentTarget.requestFullscreen?.().catch(() => {}) }} /> : <img src={picture.image} alt="" className={className} />
}

type ScreenSource = { id: string; name: string }

type VoiceStageProps = {
  camera?: CameraControls
  /** Voice channel the member is in; the stage sits above the open text channel. */
  roomId: string
  channelName: string
  participants: VoiceUser[]
  error: string
  isMuted: boolean
  isDeafened: boolean
  onToggleMute: () => void
  onToggleDeafen: () => void
  onLeaveVoice: () => void
  activeScreenSharerName: string
  watchingNames: string
  isScreenSharing: boolean
  viewingLegacyStream: boolean
  viewingWebRtcStream: boolean
  streamLoading: boolean
  streamPathLabel?: string
  screenVideoUrl: string | null
  screenImageUrl: string | null
  streamVolumePct: number
  streamVideoFullscreen: boolean
  showingStreamWindow: boolean
  hasDesktopBridge: boolean
  canStartScreenShare?: boolean
  /** Channel picture from the admins, shown dimmed behind the call. */
  bannerUrl?: string | null
  /** Channel rules: microphones / streams turned off by an admin in this channel. */
  micLocked?: boolean
  streamsLocked?: boolean
  /** False on phones: no pop-out windows, no capture source/quality settings, no local preview. */
  desktopControls?: boolean
  /** Phones: the stage covers the whole screen (like a call screen); onCollapse goes back to chat. */
  fullscreen?: boolean
  onCollapse?: () => void
  screenShareWithAudio: boolean
  screenSources: ScreenSource[]
  selectedScreenSourceId: string | null
  screenResolution: string
  screenFps: number
  screenBitrateKbps: number
  localPreviewVideoRef: RefObject<HTMLVideoElement | null>
  /** A callback ref in practice: every new <video> (rotation, collapse, fullscreen) must get the stream. */
  remoteStreamVideoRef: Ref<HTMLVideoElement>
  onScreenSourceChange: (id: string | null) => void
  onScreenResolutionChange: (value: string) => void
  onScreenFpsChange: (fps: number) => void
  onScreenBitrateChange: (kbps: number) => void
  screenContent?: "motion" | "detail"
  onScreenContentChange?: (content: "motion" | "detail") => void
  onScreenShareWithAudioToggle: () => void
  onScreenShareToggle: () => void
  onToggleStreamWindow: () => void
  onToggleStreamFullscreen: () => void
  onStreamVolumeLiveChange: (pct: number) => void
  onStreamVolumeCommit: (pct: number) => void
  streamHiddenByUser?: boolean
  onHideStream?: () => void
  onShowStream?: () => void
  /** Viewer: chosen stream quality and whether lower LiveKit layers are available for this stream. */
  viewerQuality?: "original" | "medium" | "low"
  onViewerQualityChange?: (quality: "original" | "medium" | "low") => void
  viewerQualityAvailable?: boolean
  /** Per-participant output volume (desktop mixer). */
  selfClientId?: string | null
  peerVolumePct?: Record<string, number>
  enablePeerVolume?: boolean
  onPeerVolumeChange?: (roomId: string, targetClientId: string, targetName: string, volumePct: number) => void
}

function DockButton({
  label,
  onClick,
  active = false,
  destructive = false,
  disabled = false,
  large = false,
  children
}: {
  label: string
  onClick?: () => void
  active?: boolean
  destructive?: boolean
  disabled?: boolean
  /** Touch-sized (phones). */
  large?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={cn(
            "flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40",
            large ? "size-12 rounded-xl [&_svg]:size-5" : "size-9 rounded-lg",
            destructive && large
              ? "bg-destructive text-white hover:bg-destructive/90"
              : destructive
              ? "bg-destructive/15 text-destructive hover:bg-destructive/25"
              : active
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

export function ParticipantTile({
  user,
  picture,
  mirror = false,
  isSelf = false,
  muted = user.isMuted,
  volume
}: {
  user: VoiceUser
  picture?: CameraPicture
  mirror?: boolean
  isSelf?: boolean
  muted?: boolean
  volume?: { pct: number; onChange: (pct: number) => void }
}) {
  const { t } = useI18n()
  const remoteLevel = useVoiceLevel(user.id)
  const localActivity = useLocalVoiceActivity(isSelf)
  // Keep the local microphone responsive, with the participant's actual received
  // level as a fallback when a platform delays its capture-meter callbacks.
  const measured = isSelf ? Math.max(localActivity.speaking ? localActivity.level : 0, remoteLevel) : remoteLevel
  const effective = muted ? 0 : Math.max(0, Math.min(1, measured > 0 ? measured : !isSelf && user.isSpeaking ? 0.35 : 0))
  const speaking = effective > 0.02
  const tile = (
    <div
      data-participant-id={user.id}
      data-speaking={speaking ? "true" : "false"}
      style={{ minHeight: "calc(clamp(2rem, 7vh, 5rem) + 2rem)", minWidth: "calc(clamp(2rem, 7vh, 5rem) + 1rem)" }}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-xl bg-card/80 transition-colors animate-in fade-in zoom-in-90 duration-300",
        volume && "cursor-pointer hover:bg-card"
      )}
    >
      {picture ? <CameraVideo picture={picture} mirror={mirror} /> : null}
      <span
        data-speaking-tile-ring
        aria-hidden
        className="pointer-events-none absolute inset-0 z-20 rounded-xl transition-[opacity,box-shadow] duration-150 ease-out"
        style={{ opacity: speaking ? 1 : 0, boxShadow: `inset 0 0 0 3px rgb(35 165 90 / ${0.75 + effective * 0.25}), inset 0 0 ${8 + effective * 16}px rgb(35 165 90 / ${0.12 + effective * 0.2})` }}
      />
      {user.isScreenSharing ? (
        <span className="absolute left-2 top-2 rounded bg-destructive px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">Live</span>
      ) : null}
      <div className={picture ? "invisible" : "contents"}><SpeakingAvatar
        id={user.id}
        label={user.name}
        isSpeaking={speaking}
        level={effective}
        active={!muted}
        className="size-[clamp(2rem,7vh,5rem)] shrink-0 text-xl"
      >
        {user.avatar.slice(0, 1).toUpperCase()}
      </SpeakingAvatar></div>
      <div className={cn("z-10 flex max-w-[90%] items-center gap-1 text-xs font-medium text-foreground", picture && "absolute bottom-2 rounded bg-black/65 px-2 py-1 text-white")}>
        <span className="truncate">{user.name}</span>
        {speaking ? <span className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        {muted ? <MicOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("userPanel.mute")} /> : null}
        {user.isDeafened ? <HeadphoneOff className="h-3 w-3 shrink-0 text-destructive/80" aria-label={t("userPanel.deafen")} /> : null}
      </div>
    </div>
  )
  if (!volume) return tile
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="h-full min-h-0 w-full min-w-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tile}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-3" side="top" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{t("sidebar.theirVolume")}</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">{volume.pct}%</span>
          </div>
          <Slider
            value={[volume.pct]}
            min={0}
            max={200}
            step={1}
            onValueChange={([v]) => volume.onChange(Number.isFinite(v) ? Math.max(0, Math.min(200, Math.round(v))) : 100)}
          />
          <p className="text-[10px] text-muted-foreground">{t("sidebar.volumeDefaultHint")}</p>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Voice "stage" shown above the open text channel while the member is in voice: participant
 * tiles, or the screen share when someone streams, with a floating control dock.
 */
/** The inline stage's height chosen by dragging its bottom edge, separately with and without a stream. */
const STAGE_HEIGHTS_KEY = "voixex-stage-heights"
type StageHeights = { idle: number | null; video: number | null }
/** The chat below keeps at least this much room (its header, a few messages, the composer). */
const CHAT_RESERVE_PX = 260
const STAGE_MIN_PX = { idle: 150, video: 220 }

function readStageHeights(): StageHeights {
  try {
    const v = JSON.parse(localStorage.getItem(STAGE_HEIGHTS_KEY) ?? "{}") as Partial<StageHeights>
    const ok = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : null)
    return { idle: ok(v.idle), video: ok(v.video) }
  } catch {
    return { idle: null, video: null }
  }
}

function saveStageHeights(next: StageHeights) {
  try {
    localStorage.setItem(STAGE_HEIGHTS_KEY, JSON.stringify(next))
  } catch {
    /* only this session */
  }
}

export function VoiceStage({
  camera,
  roomId,
  channelName,
  participants,
  error,
  isMuted,
  isDeafened,
  onToggleMute,
  onToggleDeafen,
  onLeaveVoice,
  activeScreenSharerName,
  watchingNames,
  isScreenSharing,
  viewingLegacyStream,
  viewingWebRtcStream,
  streamLoading,
  streamPathLabel,
  screenVideoUrl,
  screenImageUrl,
  streamVolumePct,
  streamVideoFullscreen,
  showingStreamWindow,
  hasDesktopBridge,
  canStartScreenShare = true,
  micLocked = false,
  bannerUrl = null,
  streamsLocked = false,
  desktopControls = true,
  screenShareWithAudio,
  screenSources,
  selectedScreenSourceId,
  screenResolution,
  screenFps,
  screenBitrateKbps,
  localPreviewVideoRef,
  remoteStreamVideoRef,
  onScreenSourceChange,
  onScreenResolutionChange,
  onScreenFpsChange,
  onScreenBitrateChange,
  screenContent = "motion",
  onScreenContentChange,
  onScreenShareWithAudioToggle,
  onScreenShareToggle,
  onToggleStreamWindow,
  onToggleStreamFullscreen,
  onStreamVolumeLiveChange,
  onStreamVolumeCommit,
  streamHiddenByUser = false,
  onHideStream,
  onShowStream,
  viewerQuality = "original",
  onViewerQualityChange,
  viewerQualityAvailable = false,
  selfClientId = null,
  peerVolumePct = {},
  enablePeerVolume = false,
  onPeerVolumeChange,
  fullscreen = false,
  onCollapse
}: VoiceStageProps) {
  const { t } = useI18n()
  const hasStream = (viewingLegacyStream || viewingWebRtcStream) && !streamHiddenByUser
  const expectingStream = Boolean(activeScreenSharerName && !isScreenSharing && !hasStream && !streamHiddenByUser)
  const canHideStream = Boolean(!isScreenSharing && activeScreenSharerName && !streamHiddenByUser)
  const canPopOut = Boolean(activeScreenSharerName || hasStream || isScreenSharing)
  const hasScreenVideo = !showingStreamWindow && (isScreenSharing || hasStream || expectingStream)
  const hasCameraVideo = Boolean(camera?.local || (camera && Object.keys(camera.pictures).length > 0))
  const showsVideo = hasScreenVideo || hasCameraVideo
  const live = Boolean(activeScreenSharerName || isScreenSharing)
  const sectionRef = useRef<HTMLElement>(null)
  const [heights, setHeights] = useState<StageHeights>({ idle: null, video: null })
  useEffect(() => setHeights(readStageHeights()), [])
  /** Height while the edge is being dragged (no transition then). */
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const [participantPage, setParticipantPage] = useState(0)
  const participantPages = Math.max(1, Math.ceil(participants.length / 12))
  const currentParticipantPage = Math.min(participantPage, participantPages - 1)
  useEffect(() => setParticipantPage(0), [roomId])
  useEffect(() => setParticipantPage(page => Math.min(page, participantPages - 1)), [participantPages])
  const visibleParticipants = participants.slice(currentParticipantPage * 12, (currentParticipantPage + 1) * 12)
  // Fill available call space: 1×1, 2×1, 2×2, 3×2, 4×2, then 4×3.
  const participantColumns = visibleParticipants.length <= 1 ? 1 : visibleParticipants.length <= 4 ? 2 : visibleParticipants.length <= 6 ? 3 : 4
  const participantRows = Math.max(1, Math.ceil(visibleParticipants.length / participantColumns))
  const heightMode = showsVideo ? "video" : "idle"
  const chosenHeight = dragHeight ?? heights[heightMode]

  const [bounds, setBounds] = useState({ available: 640, viewport: 900 })
  useEffect(() => {
    const section = sectionRef.current
    if (!section || fullscreen) return
    // A display:contents wrapper has no box. Measure the actual chat container.
    let container = section.parentElement
    while (container && getComputedStyle(container).display === "contents") container = container.parentElement
    if (!container) return
    const measure = () => {
      if (!section.getClientRects().length) return
      const rect = container.getBoundingClientRect()
      const available = Math.max(0, rect.bottom - section.getBoundingClientRect().top - CHAT_RESERVE_PX)
      setBounds(previous => previous.available === available && previous.viewport === window.innerHeight ? previous : { available, viewport: window.innerHeight })
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    observer.observe(section)
    window.addEventListener("resize", measure)
    measure()
    return () => { observer.disconnect(); window.removeEventListener("resize", measure) }
  }, [fullscreen])
  const tileMinHeight = Math.min(80, Math.max(32, bounds.viewport * 0.07)) + 32
  const rows = participantRows
  const baseMinHeight = Math.max(STAGE_MIN_PX[heightMode], tileMinHeight + 104)
  const maxHeight = Math.max(baseMinHeight, bounds.available)
  const minHeight = Math.min(maxHeight, Math.max(baseMinHeight, hasScreenVideo ? STAGE_MIN_PX.video : rows * tileMinHeight + (rows - 1) * 12 + 104 + (participants.length > 12 ? 28 : 0)))
  const clampHeight = (h: number) => Math.round(Math.min(maxHeight, Math.max(minHeight, h)))
  const commitHeight = (h: number | null) => {
    setHeights((prev) => {
      const next = { ...prev, [heightMode]: h }
      saveStageHeights(next)
      return next
    })
  }
  const startResize = (e: ReactPointerEvent) => {
    const section = sectionRef.current
    if (!section || e.button !== 0) return
    e.preventDefault()
    const startY = e.clientY
    const startHeight = section.getBoundingClientRect().height
    let latest = startHeight
    setDragHeight(startHeight)
    const move = (ev: PointerEvent) => {
      latest = clampHeight(startHeight + ev.clientY - startY)
      setDragHeight(latest)
    }
    const end = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", end)
      window.removeEventListener("pointercancel", end)
      document.body.style.cursor = ""
      document.body.style.userSelect = ""
      setDragHeight(null)
      commitHeight(latest)
    }
    document.body.style.cursor = "row-resize"
    document.body.style.userSelect = "none"
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", end)
    window.addEventListener("pointercancel", end)
  }
  const resizeWithKeys = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    e.preventDefault()
    const current = sectionRef.current?.getBoundingClientRect().height ?? 0
    commitHeight(clampHeight(current + (e.key === "ArrowDown" ? 32 : -32)))
  }
  // "Stream hidden" shows for 1.5 s after hiding, then only the participants remain.
  const [hiddenNotice, setHiddenNotice] = useState(false)
  useEffect(() => {
    if (!streamHiddenByUser) {
      setHiddenNotice(false)
      return
    }
    setHiddenNotice(true)
    const timer = setTimeout(() => setHiddenNotice(false), 1500)
    return () => clearTimeout(timer)
  }, [streamHiddenByUser])
  const participantsGrid = (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2 overflow-auto" data-participant-panel>
      <div
        data-participant-grid
        className="grid min-h-0 flex-1 gap-2 sm:gap-3"
        style={{ gridTemplateColumns: `repeat(${participantColumns}, minmax(calc(clamp(2rem, 7vh, 5rem) + 1rem), 1fr))`, gridTemplateRows: `repeat(${participantRows}, minmax(calc(clamp(2rem, 7vh, 5rem) + 2rem), 1fr))` }}
      >
        {visibleParticipants.map(user => {
          const canAdjust = enablePeerVolume && onPeerVolumeChange && selfClientId && user.id !== selfClientId
          return (
            <ParticipantTile
              key={user.id}
              user={user}
              picture={user.id === selfClientId && camera?.local ? { stream: camera.local } : camera?.pictures[user.id]}
              mirror={user.id === selfClientId}
              isSelf={user.id === selfClientId}
              muted={user.id === selfClientId ? isMuted : user.isMuted}
              volume={canAdjust ? {
                pct: peerVolumePct[`${roomId}:${user.id}`] ?? 100,
                onChange: pct => onPeerVolumeChange(roomId, user.id, user.name, pct)
              } : undefined}
            />
          )
        })}
      </div>
      {participantPages > 1 ? (
        <div className="flex shrink-0 items-center justify-center gap-3 text-xs text-foreground">
          <button type="button" aria-label={t("camera.previousParticipants")} disabled={currentParticipantPage === 0} onClick={() => setParticipantPage(currentParticipantPage - 1)} className="rounded p-1 disabled:opacity-30"><ChevronLeft className="size-4" /></button>
          <span aria-live="polite">{currentParticipantPage + 1} / {participantPages}</span>
          <button type="button" aria-label={t("camera.nextParticipants")} disabled={currentParticipantPage === participantPages - 1} onClick={() => setParticipantPage(currentParticipantPage + 1)} className="rounded p-1 disabled:opacity-30"><ChevronRight className="size-4" /></button>
        </div>
      ) : null}
    </div>
  )
  /** Phone call screen with the stream maximized: only the video (landscape), plus an exit button. */
  const immersive = fullscreen && streamVideoFullscreen && (hasStream || expectingStream)

  return (
    <section
      ref={sectionRef}
      className={cn(
        "isolate flex flex-col overflow-hidden bg-stage",
        fullscreen
          ? "fixed inset-0 z-50 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] animate-in fade-in slide-in-from-bottom-8 duration-300"
          : cn(
              "relative mx-4 mt-4 shrink-0 rounded-xl animate-in fade-in slide-in-from-top-3 duration-300",
              // Grows and shrinks smoothly when a stream starts or stops (not while dragging).
              dragHeight === null && "transition-[height] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
              chosenHeight === null && (showsVideo ? "h-[min(58vh,620px)]" : "h-64")
            )
      )}
      style={fullscreen ? undefined : { height: chosenHeight === null ? undefined : clampHeight(chosenHeight), minHeight, maxHeight }}
      aria-label={channelName}
    >
      {bannerUrl && !immersive ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={bannerUrl} alt="" className="pointer-events-none absolute inset-0 -z-10 h-full w-full object-cover opacity-30" />
          <div className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-stage/40 via-stage/70 to-stage" />
        </>
      ) : null}
      <div
        className={cn(
          "z-10 flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          fullscreen ? "shrink-0 px-3 pb-1 pt-3" : "absolute left-4 top-3 max-w-[60%]",
          immersive && "hidden"
        )}
      >
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t("voice.backToChat")}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80 text-foreground"
          >
            <ChevronDown className="h-5 w-5" />
          </button>
        ) : null}
        <Volume2 className={cn("h-3.5 w-3.5 shrink-0 text-accent", fullscreen && "h-4 w-4")} />
        <span className={cn("truncate font-semibold text-foreground", fullscreen && "text-base")}>{channelName}</span>
        {activeScreenSharerName ? (
          <span className="truncate">· {t("voice.isSharing", { name: activeScreenSharerName })}</span>
        ) : null}
        {fullscreen && onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t("voice.backToChat")}
            className="ml-auto flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/80 text-foreground"
          >
            <MessageSquare className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div
        className={cn(
          "z-10 flex items-center gap-2",
          fullscreen ? "absolute right-14 top-[calc(env(safe-area-inset-top)+0.75rem)]" : "absolute right-3 top-3",
          immersive && "hidden"
        )}
      >
        {live && viewerQuality !== "original" && !isScreenSharing ? (
          <span className="rounded-md bg-secondary px-2 py-1 text-[10px] font-semibold text-foreground">
            {viewerQuality === "medium" ? "720p" : "360p"}
          </span>
        ) : null}
        {live ? <span className="rounded-md bg-destructive px-2 py-1 text-[10px] font-bold uppercase text-white">Live</span> : null}
        <Popover>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={t("voice.streamQuality")}
                  className="rounded-lg bg-secondary/80 p-2 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("voice.streamQuality")}</TooltipContent>
          </Tooltip>
          <PopoverContent align="end" className="w-72 space-y-3 p-4">
            {activeScreenSharerName && !isScreenSharing && onViewerQualityChange ? (
              <div className="space-y-2 border-b border-border pb-3">
                <p className="text-xs font-medium text-foreground">{t("voice.viewQuality")}</p>
                <div className="grid grid-cols-3 gap-1 rounded-lg bg-secondary p-1" role="radiogroup">
                  {(["original", "medium", "low"] as const).map((q) => {
                    const disabled = q !== "original" && !viewerQualityAvailable
                    return (
                      <button
                        key={q}
                        type="button"
                        role="radio"
                        aria-checked={viewerQuality === q}
                        disabled={disabled}
                        onClick={() => onViewerQualityChange(q)}
                        className={cn(
                          "rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40",
                          viewerQuality === q ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {q === "original" ? t("voice.qualityOriginal") : q === "medium" ? "720p" : "360p"}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {viewerQualityAvailable ? t("voice.viewQualityHint") : t("voice.viewQualityUnavailable")}
                </p>
              </div>
            ) : null}
            {desktopControls ? (
            <>
            <p className="text-xs font-medium text-foreground">{t("voice.streamQuality")}</p>
            {isScreenSharing ? <p className="text-[11px] text-muted-foreground">{t("voice.restartHint")}</p> : null}
            <div className="space-y-1.5">
              <Label className="text-xs">{t("voice.captureSource")}</Label>
              <Select
                value={selectedScreenSourceId && screenSources.some((s) => s.id === selectedScreenSourceId) ? selectedScreenSourceId : undefined}
                onValueChange={(v) => onScreenSourceChange(v || null)}
              >
                <SelectTrigger className="h-8 w-full text-xs" disabled={screenSources.length === 0}>
                  <SelectValue placeholder={t("voice.noSources")} />
                </SelectTrigger>
                <SelectContent>
                  {screenSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>
                      {source.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {onScreenContentChange ? (
              <div className="space-y-1.5">
                <Label className="text-xs">{t("voice.streamContent")}</Label>
                <div className="grid grid-cols-2 gap-1 rounded-lg bg-secondary p-1" role="radiogroup">
                  {(["motion", "detail"] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={screenContent === c}
                      onClick={() => onScreenContentChange(c)}
                      className={cn(
                        "rounded-md px-2 py-1 text-xs font-medium transition-colors",
                        screenContent === c ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                      )}
                    >
                      {c === "motion" ? t("voice.contentMotion") : t("voice.contentDetail")}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">{screenContent === "motion" ? t("voice.contentMotionHint") : t("voice.contentDetailHint")}</p>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs">{t("voice.resolution")}</Label>
                <Select value={screenResolution} onValueChange={onScreenResolutionChange}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="854x480">480p</SelectItem>
                    <SelectItem value="1280x720">720p</SelectItem>
                    <SelectItem value="1600x900">900p</SelectItem>
                    <SelectItem value="1920x1080">1080p</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">{t("voice.frameRate")}</Label>
                <Select value={String(screenFps)} onValueChange={(v) => onScreenFpsChange(Number(v))}>
                  <SelectTrigger className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 FPS</SelectItem>
                    <SelectItem value="15">15 FPS</SelectItem>
                    <SelectItem value="24">24 FPS</SelectItem>
                    <SelectItem value="30">30 FPS</SelectItem>
                    <SelectItem value="60">60 FPS</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("voice.bitrate")}</Label>
              <Select value={String(screenBitrateKbps)} onValueChange={(v) => onScreenBitrateChange(Number(v))}>
                <SelectTrigger className="h-8 w-full text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1200">1.2 Mbps</SelectItem>
                  <SelectItem value="2000">2.0 Mbps</SelectItem>
                  <SelectItem value="3500">3.5 Mbps</SelectItem>
                  <SelectItem value="6000">6.0 Mbps</SelectItem>
                  <SelectItem value="8000">8.0 Mbps</SelectItem>
                  <SelectItem value="12000">12 Mbps</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="stage-system-audio" className="text-xs">
                {t("voice.systemAudioTooltip")}
              </Label>
              <Switch
                id="stage-system-audio"
                checked={screenShareWithAudio}
                onCheckedChange={onScreenShareWithAudioToggle}
                disabled={isScreenSharing}
              />
            </div>
            </>
            ) : null}
            {hasStream ? (
              <div className="space-y-1.5 border-t border-border pt-3">
                <StreamVolumeControl value={streamVolumePct} onLiveChange={onStreamVolumeLiveChange} onCommit={onStreamVolumeCommit} />
              </div>
            ) : null}
            {activeScreenSharerName ? (
              <p className="text-[11px] text-muted-foreground">
                {t("voice.watching", { names: watchingNames })}
                {streamPathLabel ? ` · ${streamPathLabel}` : ""}
              </p>
            ) : null}
          </PopoverContent>
        </Popover>
      </div>

      {error ? (
        <div className="absolute left-1/2 top-12 z-10 w-[min(90%,32rem)] -translate-x-1/2 rounded-lg bg-destructive/15 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className={cn("flex min-h-0 flex-1 items-center justify-center", immersive ? "bg-black p-0" : fullscreen ? "px-3 py-3" : "px-4 pb-16 pt-10")}>
        {isScreenSharing && !desktopControls ? (
          <div className="flex flex-col items-center gap-2 text-center animate-in fade-in zoom-in-95 duration-300">
            <Monitor className="h-8 w-8 text-accent" />
            <p className="text-sm font-medium text-foreground">{t("voice.sharingFromPhone")}</p>
          </div>
        ) : isScreenSharing && !showingStreamWindow ? (
          <video
            ref={localPreviewVideoRef}
            autoPlay
            muted
            playsInline
            className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl animate-in fade-in zoom-in-95 duration-500"
          />
        ) : hasStream || expectingStream ? (
          <>
          {showingStreamWindow ? participantsGrid : null}
          <div className={showingStreamWindow ? "hidden" : "relative flex h-full w-full items-center justify-center animate-in fade-in zoom-in-95 duration-500"}>
            {(streamLoading || expectingStream) && !hasStream ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-card/60 animate-in fade-in duration-300">
                <Loader2 className="h-7 w-7 animate-spin text-primary" />
                <p className="text-xs text-muted-foreground">{t("voice.loadingStream")}</p>
              </div>
            ) : null}
            <video
              ref={remoteStreamVideoRef}
              src={viewingLegacyStream ? (screenVideoUrl ?? screenImageUrl ?? undefined) : undefined}
              autoPlay
              muted={viewingWebRtcStream ? true : isDeafened}
              playsInline
              className={cn("bg-black object-contain", immersive ? "h-full w-full" : "max-h-full max-w-full rounded-lg shadow-2xl")}
            />
            {immersive ? (
              <button
                type="button"
                onClick={onToggleStreamFullscreen}
                aria-label={t("voice.exitFullscreen")}
                className="absolute right-3 top-3 z-20 flex size-10 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur"
              >
                <Minimize2 className="h-5 w-5" />
              </button>
            ) : null}
          </div>
          </>
        ) : streamHiddenByUser && activeScreenSharerName ? (
          // Hidden stream: the call looks like there is no stream; a short notice says so.
          <>
            {participantsGrid}
            {hiddenNotice ? (
              <div className="pointer-events-none absolute inset-x-0 top-12 z-10 flex justify-center animate-in fade-in slide-in-from-top-2 duration-300">
                <span className="flex items-center gap-2 rounded-full bg-popover/95 px-3 py-1.5 text-xs font-medium text-foreground shadow-lg">
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("voice.streamHiddenTitle")}
                </span>
              </div>
            ) : null}
          </>
        ) : (
          participantsGrid
        )}
      </div>

      <div
        className={cn(
          "z-10 flex items-center rounded-xl bg-popover/95 shadow-xl",
          immersive && "hidden",
          fullscreen
            ? "mx-3 mb-3 shrink-0 justify-around gap-2 rounded-2xl p-2"
            : "absolute bottom-3 left-1/2 -translate-x-1/2 gap-1 p-1.5"
        )}
      >
        {camera ? <>
          <DockButton large={fullscreen} label={camera.enabled ? t("camera.disable") : camera.supported ? t("camera.enable") : t("camera.unavailable")} active={camera.enabled} disabled={!camera.supported && !camera.enabled} onClick={camera.toggle}>
            {camera.busy ? <Loader2 className="h-4 w-4 animate-spin" /> : camera.enabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
          </DockButton>
          <Popover>
            <PopoverTrigger asChild><button type="button" aria-label={t("camera.device")} className="p-1 text-muted-foreground"><ChevronDown className="h-4 w-4" /></button></PopoverTrigger>
            <PopoverContent className="w-64 space-y-2">
              <Label>{t("camera.device")}</Label>
              <Select value={camera.deviceId || undefined} onValueChange={camera.select} disabled={camera.busy}>
                <SelectTrigger><SelectValue placeholder={t("camera.device")} /></SelectTrigger>
                <SelectContent>{camera.devices.filter(d => d.deviceId).map((device, i) => <SelectItem key={device.deviceId} value={device.deviceId}>{device.label || `${t("camera.device")} ${i + 1}`}</SelectItem>)}</SelectContent>
              </Select>
              {camera.error ? <p role="alert" className="text-xs text-destructive">{camera.error}</p> : null}
              {!camera.supported ? <p className="text-xs text-muted-foreground">{t("camera.unavailable")}</p> : null}
            </PopoverContent>
          </Popover>
        </> : null}
        <DockButton
          large={fullscreen}
          label={micLocked ? t("channelRules.micLocked") : isMuted ? t("userPanel.unmute") : t("userPanel.mute")}
          active={isMuted}
          onClick={onToggleMute}
        >
          {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </DockButton>
        <DockButton large={fullscreen} label={isDeafened ? t("userPanel.undeafen") : t("userPanel.deafen")} active={isDeafened} onClick={onToggleDeafen}>
          {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
        </DockButton>
        {fullscreen ? null : <span className="mx-1 h-5 w-px bg-border" />}
        {(
        <DockButton
          large={fullscreen}
          label={
            streamsLocked && !isScreenSharing
              ? t("channelRules.streamsLocked")
              : !isScreenSharing && !canStartScreenShare
              ? t("voice.streamBusyTooltip")
              : isScreenSharing
                ? t("voice.stopSharingTooltip")
                : t("voice.shareScreenTooltip")
          }
          active={isScreenSharing}
          disabled={!hasDesktopBridge || (!isScreenSharing && !canStartScreenShare && !streamsLocked)}
          onClick={onScreenShareToggle}
        >
          {isScreenSharing ? <MonitorOff className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
        </DockButton>
        )}
        {streamHiddenByUser && activeScreenSharerName && onShowStream ? (
          <DockButton large={fullscreen} label={t("voice.showStream")} onClick={onShowStream}>
            <Eye className="h-4 w-4" />
          </DockButton>
        ) : null}
        {canHideStream && onHideStream ? (
          <DockButton large={fullscreen} label={t("voice.hideStreamTooltip")} onClick={onHideStream}>
            <EyeOff className="h-4 w-4" />
          </DockButton>
        ) : null}
        {canPopOut && desktopControls ? (
          <DockButton large={fullscreen} label={showingStreamWindow ? t("voice.closePopOutBtn") : t("voice.popOutTooltip")} active={showingStreamWindow} onClick={onToggleStreamWindow}>
            <ExternalLink className="h-4 w-4" />
          </DockButton>
        ) : null}
        {hasStream ? (
          <DockButton large={fullscreen} label={streamVideoFullscreen ? t("voice.exitFullscreen") : t("voice.fullscreen")} onClick={onToggleStreamFullscreen}>
            {streamVideoFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </DockButton>
        ) : null}
        {fullscreen ? null : <span className="mx-1 h-5 w-px bg-border" />}
        <DockButton large={fullscreen} label={t("userPanel.leaveVoiceChannel")} destructive onClick={onLeaveVoice}>
          <PhoneOff className="h-4 w-4" />
        </DockButton>
      </div>

      {hasScreenVideo && hasCameraVideo && !immersive ? <div className="absolute right-3 top-14 z-10 max-h-[calc(100%-8rem)] max-w-[60%] rounded-xl bg-stage/80 p-1" style={{ height: participantRows * tileMinHeight + (participantRows - 1) * 12 + 8 + (participantPages > 1 ? 28 : 0), width: Math.max(320, participantColumns * (tileMinHeight - 16) + (participantColumns - 1) * 12 + 8) }}>{participantsGrid}</div> : null}

      {camera?.error ? <p role="alert" className="absolute inset-x-3 top-12 z-20 rounded bg-popover/95 p-2 text-center text-xs text-destructive">{camera.error}</p> : null}

      {fullscreen ? null : (
        // Drag the bottom edge to give the call more or less room; double-click resets.
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("voice.resizeStage")}
          title={t("voice.resizeStage")}
          tabIndex={0}
          onPointerDown={startResize}
          onDoubleClick={() => commitHeight(null)}
          onKeyDown={resizeWithKeys}
          className="group absolute inset-x-0 bottom-0 z-20 flex h-3 touch-none cursor-row-resize items-end justify-center pb-0.5 focus-visible:outline-none"
        >
          <span
            className={cn(
              "h-1 w-10 rounded-full bg-muted-foreground/30 transition-colors group-hover:bg-muted-foreground/70 group-focus-visible:bg-primary",
              dragHeight !== null && "bg-primary"
            )}
          />
        </div>
      )}
    </section>
  )
}

/**
 * Phones, with the call screen collapsed: a slim bar above the chat that brings the call screen
 * back, plus mute and leave.
 */
export function VoiceMiniBar({
  channelName,
  participants,
  live,
  isMuted,
  onToggleMute,
  onLeave,
  onOpen
}: {
  channelName: string
  participants: VoiceUser[]
  live: boolean
  isMuted: boolean
  onToggleMute: () => void
  onLeave: () => void
  onOpen: () => void
}) {
  const { t } = useI18n()
  const speaking = participants.filter((u) => u.isSpeaking).map((u) => u.name)
  return (
    <div className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-xl bg-stage px-3 py-2 animate-in fade-in slide-in-from-top-2 duration-300">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <Volume2 className="h-4 w-4 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold text-foreground">
            {channelName}
            {live ? <span className="ml-2 rounded bg-destructive px-1 py-px text-[9px] font-bold uppercase text-white">Live</span> : null}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {speaking.length > 0 ? speaking.join(", ") : t("voice.participantsCount", { n: participants.length })}
          </span>
        </span>
      </button>
      <DockButton label={isMuted ? t("userPanel.unmute") : t("userPanel.mute")} active={isMuted} onClick={onToggleMute}>
        {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </DockButton>
      <DockButton label={t("userPanel.leaveVoiceChannel")} destructive onClick={onLeave}>
        <PhoneOff className="h-4 w-4" />
      </DockButton>
    </div>
  )
}
