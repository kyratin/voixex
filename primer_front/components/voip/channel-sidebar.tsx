"use client"

import { cn } from "@/lib/utils"
import { Hash, Volume2, ChevronDown, Lock, MicOff, Headphones, Eye, LogOut } from "lucide-react"
import { useState } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import { useI18n } from "@/lib/i18n/provider"
import { avatarGradient } from "@/lib/avatar-colors"

export interface Channel {
  id: string
  name: string
  type: "text" | "voice"
  isPrivate?: boolean
  unread?: boolean
  mentions?: number
}

export interface ChannelCategory {
  id: string
  name: string
  channels: Channel[]
}

export interface VoiceUser {
  id: string
  name: string
  avatar: string
  isMuted?: boolean
  isDeafened?: boolean
  isSpeaking?: boolean
  isScreenSharing?: boolean
  isWatchingScreen?: boolean
}

interface ChannelSidebarProps {
  serverName: string
  serverBannerUrl?: string | null
  categories: ChannelCategory[]
  activeChannelId: string
  currentVoiceChannelId?: string
  isInVoice?: boolean
  onChannelSelect: (channelId: string) => void
  onLeaveVoice?: () => void
  voiceUsers?: Record<string, VoiceUser[]>
  /** When set, voice rows can open per-user output volume (desktop UDP mixer on server). */
  selfClientId?: string | null
  peerVolumePct?: Record<string, number>
  onPeerVolumeChange?: (roomId: string, targetClientId: string, targetName: string, volumePct: number) => void
  enablePeerVolume?: boolean
}

export function ChannelSidebar({ 
  serverName,
  serverBannerUrl,
  categories, 
  activeChannelId,
  currentVoiceChannelId = "",
  isInVoice = false,
  onChannelSelect,
  onLeaveVoice,
  voiceUsers = {},
  selfClientId = null,
  peerVolumePct = {},
  onPeerVolumeChange,
  enablePeerVolume = false
}: ChannelSidebarProps) {
  const { t } = useI18n()
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories(prev => {
      const next = new Set(prev)
      if (next.has(categoryId)) {
        next.delete(categoryId)
      } else {
        next.add(categoryId)
      }
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-card">
      {serverBannerUrl ? (
        <div className="relative h-20 shrink-0 overflow-hidden">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={serverBannerUrl} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-card via-card/30 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 truncate px-4 pb-1.5 text-sm font-semibold text-foreground">
            {serverName}
          </div>
        </div>
      ) : (
        <div className="flex h-12 shrink-0 items-center px-4 shadow-[0_1px_0_rgba(0,0,0,0.35)]">
          <span className="truncate text-[15px] font-semibold text-foreground">{serverName}</span>
        </div>
      )}

      {isInVoice && currentVoiceChannelId && onLeaveVoice ? (
        <div className="mx-2 mt-2 flex shrink-0 items-center gap-2 rounded-lg bg-accent/10 px-3 py-1.5">
          <Volume2 className="h-3.5 w-3.5 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{t("sidebar.inVoiceChannel")}</span>
          <Button variant="ghost" size="sm" className="h-7 shrink-0 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={onLeaveVoice}>
            <LogOut className="h-3.5 w-3.5" />
            {t("common.leave")}
          </Button>
        </div>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        <div className="p-2">
          {categories.map((category) => (
            <div key={category.id} className="mb-1">
              <button
                onClick={() => toggleCategory(category.id)}
                className="group/cat mb-0.5 mt-3 flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                <span className="flex-1 truncate text-left">{category.name}</span>
                <ChevronDown className={cn(
                  "h-3.5 w-3.5 shrink-0 opacity-70 transition-transform duration-200",
                  collapsedCategories.has(category.id) && "-rotate-90"
                )} />
              </button>

              <div className={cn(
                "grid transition-all duration-200",
                collapsedCategories.has(category.id) ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
              )}>
                <div className="overflow-hidden">
                  <div className="space-y-0.5">
                    {category.channels.map((channel) => (
                      <div key={channel.id}>
                        <button
                          onClick={() => onChannelSelect(channel.id)}
                          className={cn(
                            "flex w-full items-center gap-1.5 rounded-md px-2 py-[5px] text-[15px] text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground",
                            activeChannelId === channel.id && "bg-sidebar-accent text-foreground hover:bg-sidebar-accent",
                            isInVoice && currentVoiceChannelId === channel.id && "text-accent",
                            channel.unread && "font-medium text-foreground"
                          )}
                        >
                          {channel.type === "text" ? (
                            <Hash className="h-[18px] w-[18px] shrink-0 opacity-70" />
                          ) : (
                            <Volume2 className="h-[18px] w-[18px] shrink-0 opacity-70" />
                          )}
                          {channel.isPrivate && (
                            <Lock className="h-3 w-3 shrink-0 opacity-50" />
                          )}
                          <span className="flex-1 truncate text-left">
                            {channel.name}
                          </span>
                          {channel.mentions && channel.mentions > 0 && (
                            <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">
                              {channel.mentions}
                            </Badge>
                          )}
                        </button>

                        {channel.type === "voice" && voiceUsers[channel.id] && voiceUsers[channel.id].length > 0 && (
                          <div className="space-y-px py-0.5 pl-5">
                            {voiceUsers[channel.id].map((user) => (
                              <VoiceChannelUserRow
                                key={user.id}
                                roomId={channel.id}
                                user={user}
                                selfClientId={selfClientId}
                                volumePct={peerVolumePct[`${channel.id}:${user.id}`] ?? 100}
                                enablePeerVolume={enablePeerVolume && Boolean(onPeerVolumeChange)}
                                onPeerVolumeChange={onPeerVolumeChange}
                              />
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

function VoiceChannelUserRow({
  roomId,
  user,
  selfClientId,
  volumePct,
  enablePeerVolume,
  onPeerVolumeChange
}: {
  roomId: string
  user: VoiceUser
  selfClientId: string | null
  volumePct: number
  enablePeerVolume: boolean
  onPeerVolumeChange?: (roomId: string, targetClientId: string, targetName: string, volumePct: number) => void
}) {
  const { t } = useI18n()
  const showVol = enablePeerVolume && onPeerVolumeChange && selfClientId && user.id !== selfClientId
  return (
    <div className="flex items-center gap-2 rounded-md px-1.5 py-1 text-sm text-muted-foreground hover:bg-sidebar-accent/60">
      <div
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold text-white transition-shadow",
          user.isSpeaking && "ring-2 ring-accent ring-offset-2 ring-offset-card"
        )}
        style={{ background: avatarGradient(user.id || user.name) }}
      >
        {user.avatar.slice(0, 1).toUpperCase()}
      </div>
      <span className={cn("min-w-0 flex-1 truncate", user.isSpeaking ? "text-foreground" : "text-foreground/80")}>
        {user.name}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        {user.isScreenSharing && (
          <span className="rounded bg-destructive px-1 py-px text-[9px] font-bold uppercase leading-none tracking-wide text-white" aria-label={t("sidebar.screenSharing")}>
            Live
          </span>
        )}
        {user.isWatchingScreen && <Eye className="h-3 w-3 text-muted-foreground" aria-label={t("sidebar.watchingStream")} />}
        {user.isMuted && <MicOff className="h-3.5 w-3.5 text-muted-foreground" />}
        {user.isDeafened && <Headphones className="h-3.5 w-3.5 text-destructive/80" />}
        {showVol && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t("sidebar.theirVolume")}
              >
                <Volume2 className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-3" align="end" onOpenAutoFocus={(e) => e.preventDefault()}>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label className="text-xs">{t("sidebar.theirVolume")}</Label>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{volumePct}%</span>
                </div>
                <Slider
                  value={[volumePct]}
                  min={0}
                  max={200}
                  step={1}
                  onValueChange={([v]) => {
                    const next = Number.isFinite(v) ? Math.max(0, Math.min(200, Math.round(v))) : 100
                    onPeerVolumeChange(roomId, user.id, user.name, next)
                  }}
                />
                <p className="text-[10px] text-muted-foreground">{t("sidebar.volumeDefaultHint")}</p>
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  )
}
