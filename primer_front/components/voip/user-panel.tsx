"use client"

import { cn } from "@/lib/utils"
import { Mic, MicOff, Settings } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { VoiceStatsPanel, type AudioPipelineDiag, type VoiceStatsData } from "@/components/voip/voice-stats-panel"
import { useI18n } from "@/lib/i18n/provider"
import { SpeakingAvatar } from "@/components/voip/speaking-avatar"
import { useLocalVoiceActivity } from "@/lib/voice-activity"

interface UserPanelProps {
  user: {
    id: string
    name: string
    avatar: string
    status: "online" | "idle" | "dnd" | "offline"
  }
  isMuted: boolean
  isInVoice?: boolean
  voiceChannelName?: string
  onToggleMute: () => void
  onOpenSettings: () => void
  voiceStatsSummary?: string
  voiceStats?: VoiceStatsData | null
  audioPipelineDiag?: AudioPipelineDiag | null
  qualityClass?: string
}

const statusColors: Record<string, string> = {
  online: "bg-accent",
  idle: "bg-amber-400",
  dnd: "bg-destructive",
  offline: "bg-muted-foreground"
}

/** Bottom of the channel sidebar: voice connection card (while in voice) and the member's own row. */
export function UserPanel({
  user,
  isMuted,
  isInVoice,
  voiceChannelName,
  onToggleMute,
  onOpenSettings,
  voiceStatsSummary,
  voiceStats = null,
  audioPipelineDiag = null,
  qualityClass = "text-accent"
}: UserPanelProps) {
  const { t } = useI18n()
  const activity = useLocalVoiceActivity()
  const active = Boolean(isInVoice && !isMuted)
  const isSpeakingNow = active && activity.speaking
  // Explicit class names so Tailwind sees them at build time.
  const dotClass =
    qualityClass === "text-destructive"
      ? "bg-destructive"
      : qualityClass === "text-yellow-500"
        ? "bg-yellow-500"
        : qualityClass === "text-muted-foreground"
          ? "bg-muted-foreground"
          : "bg-accent"
  return (
    <div className="shrink-0" data-user-panel>
      {isInVoice ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="mx-2 mb-2 block w-[calc(100%-1rem)] rounded-xl bg-sidebar p-3 text-left transition-colors hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex items-center gap-2">
                <span className={cn("size-2 shrink-0 rounded-full", dotClass)} />
                <span className={cn("truncate text-xs font-semibold", qualityClass)}>{t("userPanel.voiceConnected")}</span>
              </span>
              <span className="mt-1 block truncate pl-4 text-[11px] text-muted-foreground">
                {[voiceChannelName, voiceStatsSummary].filter(Boolean).join(" · ")}
              </span>
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
      ) : null}

      <div className="flex items-center gap-2 bg-sidebar p-3">
        <div className="relative shrink-0">
          <SpeakingAvatar id={user.id} label={user.name} isSpeaking={isSpeakingNow} level={activity.level} active={active} className="size-9 text-sm">
            {user.avatar}
          </SpeakingAvatar>
          <span
            data-presence-status={user.status}
            className={cn("absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-sidebar", statusColors[user.status])}
          />
        </div>

        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold text-foreground">{user.name}</p>
          <p className={cn("truncate text-[11px]", user.status === "offline" ? "text-muted-foreground" : "text-accent")}>
            {user.status === "offline" ? t("members.offline") : t("members.online")}
          </p>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onToggleMute}
              aria-label={isMuted ? t("userPanel.unmute") : t("userPanel.mute")}
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isMuted ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
              )}
            >
              {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
            </button>
          </TooltipTrigger>
          <TooltipContent>{isMuted ? t("userPanel.unmute") : t("userPanel.mute")}</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onOpenSettings}
              aria-label={t("common.settings")}
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Settings className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("common.settings")}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
