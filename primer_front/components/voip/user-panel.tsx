"use client"

import { cn } from "@/lib/utils"
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, PhoneOff, Signal, LogOut } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import { VoiceStatsPanel, type AudioPipelineDiag, type VoiceStatsData } from "@/components/voip/voice-stats-panel"
import { useI18n } from "@/lib/i18n/provider"

interface UserPanelProps {
  user: {
    id: string
    name: string
    avatar: string
    status: "online" | "idle" | "dnd" | "offline"
  }
  isMuted: boolean
  isDeafened: boolean
  isInVoice?: boolean
  voiceChannelName?: string
  onToggleMute: () => void
  onToggleDeafen: () => void
  onDisconnect?: () => void
  onOpenSettings: () => void
  voiceStatsSummary?: string
  voiceStats?: VoiceStatsData | null
  audioPipelineDiag?: AudioPipelineDiag | null
  qualityClass?: string
  isSpeakingNow?: boolean
}

const statusColors: Record<string, string> = {
  online: "bg-accent",
  idle: "bg-yellow-500",
  dnd: "bg-destructive",
  offline: "bg-muted-foreground"
}

export function UserPanel({
  user,
  isMuted,
  isDeafened,
  isInVoice,
  voiceChannelName,
  onToggleMute,
  onToggleDeafen,
  onDisconnect,
  onOpenSettings,
  voiceStatsSummary,
  voiceStats = null,
  audioPipelineDiag = null,
  qualityClass = "text-muted-foreground",
  isSpeakingNow = false
}: UserPanelProps) {
  const { t } = useI18n()
  return (
    <div className="shrink-0 bg-sidebar/80 border-t border-border">
      {isInVoice ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted/40"
              >
                <Signal className="h-4 w-4 shrink-0 text-accent" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold text-accent">{t("userPanel.voiceConnected")}</div>
                  <div className="truncate text-[11px] text-muted-foreground">{voiceChannelName}</div>
                  {voiceStatsSummary ? (
                    <div className="truncate text-[10px] text-muted-foreground">{voiceStatsSummary}</div>
                  ) : null}
                </div>
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-80 p-4" sideOffset={8}>
              <VoiceStatsPanel
                voiceStats={voiceStats}
                audioPipelineDiag={audioPipelineDiag}
                qualityClass={qualityClass}
                isSpeakingNow={isSpeakingNow}
              />
            </PopoverContent>
          </Popover>
          {onDisconnect ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onDisconnect}
                  className="h-8 shrink-0 gap-1 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  {t("common.leave")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("userPanel.leaveVoiceChannel")}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}

      <div className="flex items-center gap-2 px-3 py-2">
        <div className="relative shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
            {user.avatar}
          </div>
          <div
            className={cn(
              "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-sidebar",
              statusColors[user.status]
            )}
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {isInVoice && onDisconnect ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={onDisconnect}
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <PhoneOff className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("userPanel.disconnect")}</TooltipContent>
            </Tooltip>
          ) : null}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleMute}
                className={cn("text-muted-foreground", isMuted && "text-destructive hover:text-destructive")}
              >
                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isMuted ? t("userPanel.unmute") : t("userPanel.mute")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleDeafen}
                className={cn("text-muted-foreground", isDeafened && "text-destructive hover:text-destructive")}
              >
                {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isDeafened ? t("userPanel.undeafen") : t("userPanel.deafen")}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onOpenSettings} className="text-muted-foreground">
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t("common.settings")}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
