"use client"

import type { RefObject } from "react"
import {
  ExternalLink,
  EyeOff,
  Loader2,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorOff,
  Phone,
  ScreenShare,
  Settings2,
  Users,
  Volume2,
  VolumeX
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Slider } from "@/components/ui/slider"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n/provider"

type ScreenSource = { id: string; name: string }

type VoiceChannelViewProps = {
  channelName: string
  channelBannerUrl?: string | null
  error: string
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
  showMemberList: boolean
  isInVoice: boolean
  hasDesktopBridge: boolean
  isDeafened: boolean
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
  onToggleMemberList: () => void
  onStreamVolumeChange: (pct: number) => void
  onJoinVoice?: () => void
  onLeaveVoice?: () => void
}

export function VoiceChannelView({
  channelName,
  channelBannerUrl,
  error,
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
  showMemberList,
  isInVoice,
  hasDesktopBridge,
  isDeafened,
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
  onToggleMemberList,
  onStreamVolumeChange,
  onJoinVoice,
  onLeaveVoice
}: VoiceChannelViewProps) {
  const { t } = useI18n()
  const hasStream = viewingLegacyStream || viewingWebRtcStream
  const canPopOut = Boolean(activeScreenSharerName || hasStream || isScreenSharing)
  const expectingStream = Boolean(activeScreenSharerName && isInVoice && !isScreenSharing && !hasStream)

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      {channelBannerUrl ? (
        <div className="relative h-24 shrink-0 overflow-hidden border-b border-border sm:h-28">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={channelBannerUrl} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-background/90 via-background/20 to-transparent" />
        </div>
      ) : null}

      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <ScreenShare className="h-4 w-4 shrink-0 text-primary" />
          <h1 className="truncate text-sm font-semibold text-foreground">{channelName}</h1>
          {isInVoice ? (
            <span className="hidden shrink-0 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-medium text-accent sm:inline">
              {t("voice.connected")}
            </span>
          ) : null}
        </div>

        <div className="ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {isInVoice && onLeaveVoice ? (
            <Button variant="destructive" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={onLeaveVoice}>
              <LogOut className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("common.leave")}</span>
            </Button>
          ) : !isInVoice && onJoinVoice ? (
            <Button variant="default" size="sm" className="h-8 shrink-0 gap-1.5 text-xs" onClick={onJoinVoice}>
              <Phone className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">{t("voice.joinVoice")}</span>
            </Button>
          ) : null}

          <Separator orientation="vertical" className="mx-0.5 hidden h-5 sm:block" />

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1.5 text-xs">
                <Settings2 className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t("voice.stream")}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3 p-4">
              <p className="text-xs font-medium text-foreground">{t("voice.streamQuality")}</p>
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
            </PopoverContent>
          </Popover>

          <Separator orientation="vertical" className="mx-0.5 hidden h-5 sm:block" />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={screenShareWithAudio ? "secondary" : "outline"}
                size="sm"
                className="h-8 shrink-0 gap-1 text-xs"
                onClick={onScreenShareWithAudioToggle}
                disabled={isScreenSharing}
              >
                {screenShareWithAudio ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
                <span className="hidden md:inline">{screenShareWithAudio ? t("voice.audio") : t("voice.noAudio")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("voice.systemAudioTooltip")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={isScreenSharing ? "destructive" : "default"}
                size="sm"
                className="h-8 shrink-0 gap-1 text-xs"
                onClick={onScreenShareToggle}
                disabled={!isInVoice || !hasDesktopBridge}
              >
                {isScreenSharing ? <MonitorOff className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
                {isScreenSharing ? t("voice.stopShare") : t("voice.share")}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isScreenSharing ? t("voice.stopSharingTooltip") : t("voice.shareScreenTooltip")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 shrink-0 gap-1 text-xs" onClick={onToggleStreamWindow} disabled={!canPopOut}>
                {showingStreamWindow ? <EyeOff className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}
                <span className="hidden lg:inline">{showingStreamWindow ? t("voice.closePopOut") : t("voice.popOut")}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("voice.popOutTooltip")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showMemberList ? "secondary" : "ghost"}
                size="icon-sm"
                className="h-8 w-8 shrink-0"
                onClick={onToggleMemberList}
              >
                <Users className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{showMemberList ? t("voice.hideMembers") : t("voice.showMembers")}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 overflow-auto p-4 sm:p-6">
        {error ? (
          <div className="w-full max-w-lg shrink-0 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="flex shrink-0 flex-col items-center gap-1 text-center">
          {activeScreenSharerName ? (
            <>
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ScreenShare className="h-4 w-4 text-accent" />
                <span>{t("voice.isSharing", { name: activeScreenSharerName })}</span>
                {streamPathLabel ? (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {streamPathLabel}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{t("voice.watching", { names: watchingNames })}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{t("voice.noScreenShare")}</p>
          )}
        </div>

        <div className="flex w-full min-h-0 flex-1 items-center justify-center">
          {isScreenSharing ? (
            <video
              ref={localPreviewVideoRef}
              autoPlay
              muted
              playsInline
              className="max-h-full max-w-full rounded-xl border border-border object-contain shadow-lg"
            />
          ) : hasStream || expectingStream ? (
            <div className="flex max-h-full w-full max-w-5xl flex-col items-center gap-3">
              <div className="relative flex w-full items-center justify-center">
                {(streamLoading || expectingStream) && !hasStream ? (
                  <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 rounded-xl bg-muted/40">
                    <Loader2 className="h-8 w-8 animate-spin text-primary" />
                    <p className="text-xs text-muted-foreground">{t("voice.loadingStream")}</p>
                  </div>
                ) : null}
                <video
                  ref={remoteStreamVideoRef}
                  src={viewingLegacyStream ? (screenVideoUrl ?? screenImageUrl ?? undefined) : undefined}
                  autoPlay
                  muted={viewingWebRtcStream ? true : isDeafened}
                  playsInline
                  controls={viewingLegacyStream}
                  className="max-h-[min(70vh,calc(100dvh-14rem))] w-full max-w-full rounded-xl border border-border object-contain shadow-lg"
                />
              </div>
              <div className="flex w-full max-w-md shrink-0 flex-col gap-2 px-2">
                <div className="flex items-center gap-3">
                  <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <Slider
                    value={[streamVolumePct]}
                    min={0}
                    max={200}
                    step={1}
                    className="flex-1"
                    onValueChange={([v]) => onStreamVolumeChange(Number.isFinite(v) ? Math.round(v) : 100)}
                  />
                  <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{streamVolumePct}%</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap justify-center gap-2">
                <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={onToggleStreamFullscreen}>
                  {streamVideoFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                  {streamVideoFullscreen ? t("voice.exitFullscreen") : t("voice.fullscreen")}
                </Button>
                <Button variant="outline" size="sm" className="h-8 gap-1 text-xs" onClick={onToggleStreamWindow}>
                  {showingStreamWindow ? <EyeOff className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}
                  {showingStreamWindow ? t("voice.closePopOutBtn") : t("voice.popOut")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-3 px-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <ScreenShare className="h-8 w-8 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground">
                {isInVoice ? t("voice.shareOrWait") : t("voice.joinToWatch")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
