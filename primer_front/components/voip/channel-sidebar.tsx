"use client"

import { cn } from "@/lib/utils"
import { ArrowLeft, ChevronDown, Hash, Lock, Settings, Volume2 } from "lucide-react"
import { useState } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n/provider"
import { avatarGradient } from "@/lib/avatar-colors"
import { ConnectionSecurityBadge } from "@/components/voip/server-access-dialog"

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
  /** host:port shown under the server name. */
  serverAddress?: string
  /** Leave this server and go back to the server list. */
  onLeaveServer?: () => void
  /** Opens settings (server tab for admins, "My profile here" otherwise). */
  onOpenServerSettings?: () => void
  /** Connection (HTTPS/HTTP) and the member's protection level on this server. */
  security?: { secure: boolean; levelLabel: string; levelHint?: string }
  serverBannerUrl?: string | null
  categories: ChannelCategory[]
  activeChannelId: string
  currentVoiceChannelId?: string
  isInVoice?: boolean
  onChannelSelect: (channelId: string) => void
  voiceUsers?: Record<string, VoiceUser[]>
}

const STACK_LIMIT = 4

/** Participants of a voice channel as a compact avatar stack (details live on the voice stage). */
function VoiceUserStack({ users }: { users: VoiceUser[] }) {
  const shown = users.slice(0, STACK_LIMIT)
  const extra = users.length - shown.length
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="ml-auto flex shrink-0 items-center -space-x-1.5">
          {shown.map((u) => (
            <span
              key={u.id}
              className={cn(
                "flex size-5 items-center justify-center rounded-full text-[9px] font-bold text-white ring-2 ring-card",
                u.isSpeaking && "ring-accent"
              )}
              style={{ background: avatarGradient(u.id || u.name) }}
            >
              {u.avatar.slice(0, 1).toUpperCase()}
            </span>
          ))}
          {extra > 0 ? (
            <span className="flex size-5 items-center justify-center rounded-full bg-secondary text-[9px] font-semibold text-foreground ring-2 ring-card">
              +{extra}
            </span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="right">
        {users.map((u) => u.name).join(", ")}
      </TooltipContent>
    </Tooltip>
  )
}

export function ChannelSidebar({
  serverName,
  serverAddress,
  onLeaveServer,
  onOpenServerSettings,
  security,
  serverBannerUrl,
  categories,
  activeChannelId,
  currentVoiceChannelId = "",
  isInVoice = false,
  onChannelSelect,
  voiceUsers = {}
}: ChannelSidebarProps) {
  const { t } = useI18n()
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set())

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev)
      if (next.has(categoryId)) next.delete(categoryId)
      else next.add(categoryId)
      return next
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-card">
      <div className="flex shrink-0 items-center gap-3 bg-sidebar px-4 py-3">
        {onLeaveServer ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onLeaveServer}
                aria-label={t("sidebar.backToServers")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("sidebar.backToServers")}</TooltipContent>
          </Tooltip>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">{t("sidebar.backToServers")}</span>
        {onOpenServerSettings ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onOpenServerSettings}
                aria-label={t("sidebar.serverSettings")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Settings className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("sidebar.serverSettings")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      {security ? (
        <div className="flex shrink-0 items-center gap-2 px-4 pt-3 text-[11px] text-muted-foreground">
          <ConnectionSecurityBadge secure={security.secure} />
          <span className="truncate" title={security.levelHint}>
            {security.levelLabel}
          </span>
        </div>
      ) : null}

      <div className="relative shrink-0 overflow-hidden px-4 pb-4 pt-2">
        {serverBannerUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={serverBannerUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-40" />
            <div className="absolute inset-0 bg-gradient-to-t from-card via-card/70 to-transparent" />
          </>
        ) : null}
        <div className="relative">
          <p className="truncate text-lg font-bold text-foreground">{serverName}</p>
          {serverAddress ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{serverAddress}</p> : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <nav className="px-2 pb-2">
          {categories.map((category) => (
            <div key={category.id} className="mb-5">
              <button
                type="button"
                onClick={() => toggleCategory(category.id)}
                className="mb-1 flex w-full items-center gap-1 px-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="flex-1 truncate text-left">{category.name}</span>
                <ChevronDown
                  className={cn("h-3 w-3 shrink-0 transition-transform duration-200", collapsedCategories.has(category.id) && "-rotate-90")}
                />
              </button>

              <div
                className={cn(
                  "grid transition-all duration-200",
                  collapsedCategories.has(category.id) ? "grid-rows-[0fr]" : "grid-rows-[1fr]"
                )}
              >
                <div className="space-y-0.5 overflow-hidden">
                  {category.channels.map((channel) => {
                    const users = channel.type === "voice" ? (voiceUsers[channel.id] ?? []) : []
                    const inThisVoice = isInVoice && currentVoiceChannelId === channel.id
                    const active = channel.type === "text" ? activeChannelId === channel.id : inThisVoice
                    const live = users.some((u) => u.isScreenSharing)
                    return (
                      <button
                        key={channel.id}
                        type="button"
                        onClick={() => onChannelSelect(channel.id)}
                        className={cn(
                          "group flex h-9 w-full items-center gap-2 rounded-lg px-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          active
                            ? "bg-sidebar-accent text-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground",
                          inThisVoice && "text-accent",
                          channel.unread && !active && "font-semibold text-foreground"
                        )}
                      >
                        {channel.type === "text" ? (
                          <Hash className="h-4 w-4 shrink-0 opacity-70" />
                        ) : (
                          <Volume2 className={cn("h-4 w-4 shrink-0", inThisVoice ? "opacity-100" : "opacity-70")} />
                        )}
                        {channel.isPrivate ? <Lock className="h-3 w-3 shrink-0 opacity-50" /> : null}
                        <span className="min-w-0 truncate">{channel.name}</span>
                        {live ? (
                          <span className="shrink-0 rounded bg-destructive px-1 py-px text-[9px] font-bold uppercase leading-none text-white">
                            Live
                          </span>
                        ) : null}
                        {channel.mentions && channel.mentions > 0 ? (
                          <Badge variant="destructive" className="ml-auto h-4 min-w-4 px-1 text-[10px]">
                            {channel.mentions}
                          </Badge>
                        ) : null}
                        {users.length > 0 ? <VoiceUserStack users={users} /> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          ))}
        </nav>
      </ScrollArea>
    </div>
  )
}
