"use client"

import type { ReactNode, RefObject } from "react"
import {
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
import { avatarGradient } from "@/lib/avatar-colors"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/provider"

type ScreenSource = { id: string; name: string }

type VoiceStageProps = {
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
  /** False on phones: no screen capture there, and pop-out windows do not exist. */
  screenShareSupported?: boolean
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
  remoteStreamVideoRef: RefObject<HTMLVideoElement | null>
  onScreenSourceChange: (id: string | null) => void
  onScreenResolutionChange: (value: string) => void
  onScreenFpsChange: (fps: number) => void
  onScreenBitrateChange: (kbps: number) => void
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

function ParticipantTile({
  user,
  large,
  fill = false,
  volume
}: {
  user: VoiceUser
  large: boolean
  /** Phone call screen: the tile takes its whole grid cell. */
  fill?: boolean
  volume?: { pct: number; onChange: (pct: number) => void }
}) {
  const { t } = useI18n()
  const tile = (
    <div
      className={cn(
        "relative flex shrink-0 flex-col items-center justify-center gap-2 rounded-xl bg-card/80 transition-colors",
        fill ? "aspect-square w-full" : large ? "h-32 w-40" : "h-28 w-[7.5rem]",
        volume && "cursor-pointer hover:bg-card"
      )}
    >
      {user.isScreenSharing ? (
        <span className="absolute left-2 top-2 rounded bg-destructive px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">Live</span>
      ) : null}
      <div
        className={cn(
          "flex items-center justify-center rounded-full font-bold text-white transition-shadow",
          fill ? "size-20 text-2xl" : large ? "size-14 text-lg" : "size-11 text-base",
          user.isSpeaking && "ring-2 ring-accent ring-offset-2 ring-offset-card"
        )}
        style={{ background: avatarGradient(user.id || user.name) }}
      >
        {user.avatar.slice(0, 1).toUpperCase()}
      </div>
      <div className="flex max-w-[90%] items-center gap-1 text-xs font-medium text-foreground">
        <span className="truncate">{user.name}</span>
        {user.isSpeaking ? <span className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
        {user.isMuted ? <MicOff className="h-3 w-3 shrink-0 text-muted-foreground" aria-label={t("userPanel.mute")} /> : null}
        {user.isDeafened ? <HeadphoneOff className="h-3 w-3 shrink-0 text-destructive/80" aria-label={t("userPanel.deafen")} /> : null}
      </div>
    </div>
  )
  if (!volume) return tile
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
export function VoiceStage({
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
  screenShareSupported = true,
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
  const showsVideo = isScreenSharing || hasStream || expectingStream
  const live = Boolean(activeScreenSharerName || isScreenSharing)
  const largeTiles = participants.length <= 2

  return (
    <section
      className={cn(
        "flex flex-col overflow-hidden bg-stage",
        fullscreen
          ? "fixed inset-0 z-50 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]"
          : cn("relative mx-4 mt-4 shrink-0 rounded-xl transition-[height] duration-200", showsVideo ? "h-[min(58vh,620px)]" : "h-64")
      )}
      aria-label={channelName}
    >
      <div
        className={cn(
          "z-10 flex min-w-0 items-center gap-2 text-xs text-muted-foreground",
          fullscreen ? "shrink-0 px-3 pb-1 pt-3" : "absolute left-4 top-3 max-w-[60%]"
        )}
      >
        {fullscreen && onCollapse ? (
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

      <div className={cn("z-10 flex items-center gap-2", fullscreen ? "absolute right-14 top-[calc(env(safe-area-inset-top)+0.75rem)]" : "absolute right-3 top-3")}>
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
            {screenShareSupported ? (
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
                  <SelectItem value="5000">5.0 Mbps</SelectItem>
                  <SelectItem value="8000">8.0 Mbps</SelectItem>
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

      <div className={cn("flex min-h-0 flex-1 items-center justify-center", fullscreen ? "px-3 py-3" : "px-4 pb-16 pt-10")}>
        {isScreenSharing ? (
          <video
            ref={localPreviewVideoRef}
            autoPlay
            muted
            playsInline
            className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl"
          />
        ) : hasStream || expectingStream ? (
          <div className="relative flex h-full w-full items-center justify-center">
            {(streamLoading || expectingStream) && !hasStream ? (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-lg bg-card/60">
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
              className="max-h-full max-w-full rounded-lg bg-black object-contain shadow-2xl"
            />
          </div>
        ) : streamHiddenByUser && activeScreenSharerName ? (
          <div className="flex flex-col items-center gap-2 text-center">
            <EyeOff className="h-6 w-6 text-muted-foreground" />
            <p className="text-sm font-medium text-foreground">{t("voice.streamHiddenTitle")}</p>
            {onShowStream ? (
              <Button size="sm" variant="secondary" className="gap-1.5" onClick={onShowStream}>
                <Eye className="h-3.5 w-3.5" />
                {t("voice.showStream")}
              </Button>
            ) : null}
          </div>
        ) : (
          <div
            className={cn(
              fullscreen
                ? cn("grid w-full gap-3 overflow-y-auto", participants.length > 1 ? "grid-cols-2" : "max-w-xs grid-cols-1")
                : "flex max-w-full items-center gap-3 overflow-x-auto px-2 pb-1"
            )}
          >
            {participants.map((user) => {
              const canAdjust = enablePeerVolume && onPeerVolumeChange && selfClientId && user.id !== selfClientId
              return (
                <ParticipantTile
                  key={user.id}
                  user={user}
                  large={largeTiles}
                  fill={fullscreen}
                  volume={
                    canAdjust
                      ? {
                          pct: peerVolumePct[`${roomId}:${user.id}`] ?? 100,
                          onChange: (pct) => onPeerVolumeChange(roomId, user.id, user.name, pct)
                        }
                      : undefined
                  }
                />
              )
            })}
          </div>
        )}
      </div>

      <div
        className={cn(
          "z-10 flex items-center rounded-xl bg-popover/95 shadow-xl",
          fullscreen
            ? "mx-3 mb-3 shrink-0 justify-around gap-2 rounded-2xl p-2"
            : "absolute bottom-3 left-1/2 -translate-x-1/2 gap-1 p-1.5"
        )}
      >
        <DockButton large={fullscreen} label={isMuted ? t("userPanel.unmute") : t("userPanel.mute")} active={isMuted} onClick={onToggleMute}>
          {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </DockButton>
        <DockButton large={fullscreen} label={isDeafened ? t("userPanel.undeafen") : t("userPanel.deafen")} active={isDeafened} onClick={onToggleDeafen}>
          {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
        </DockButton>
        {fullscreen ? null : <span className="mx-1 h-5 w-px bg-border" />}
        {screenShareSupported ? (
        <DockButton
          large={fullscreen}
          label={
            !isScreenSharing && !canStartScreenShare
              ? t("voice.streamBusyTooltip")
              : isScreenSharing
                ? t("voice.stopSharingTooltip")
                : t("voice.shareScreenTooltip")
          }
          active={isScreenSharing}
          disabled={!hasDesktopBridge || (!isScreenSharing && !canStartScreenShare)}
          onClick={onScreenShareToggle}
        >
          {isScreenSharing ? <MonitorOff className="h-4 w-4" /> : <Monitor className="h-4 w-4" />}
        </DockButton>
        ) : null}
        {canHideStream && onHideStream ? (
          <DockButton large={fullscreen} label={t("voice.hideStreamTooltip")} onClick={onHideStream}>
            <EyeOff className="h-4 w-4" />
          </DockButton>
        ) : null}
        {canPopOut && screenShareSupported ? (
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
    <div className="mx-3 mt-3 flex shrink-0 items-center gap-2 rounded-xl bg-stage px-3 py-2">
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
