"use client"

import { cn } from "@/lib/utils"
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, PhoneOff, Signal } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"

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
  onToggleVoiceStats?: () => void
  voiceStatsSummary?: string
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
  onToggleVoiceStats,
  voiceStatsSummary
}: UserPanelProps) {
  return (
    <div className="bg-sidebar/80 border-t border-border">
      {isInVoice && (
        <div className="flex items-center gap-2 border-b border-border pl-3 pr-2 py-2">
          <button onClick={onToggleVoiceStats} className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <Signal className="h-4 w-4 text-accent" />
            <div className="min-w-0">
              <div className="text-xs font-semibold text-accent">Voice Connected</div>
              <div className="truncate text-[11px] text-muted-foreground">{voiceChannelName}</div>
              {voiceStatsSummary ? <div className="truncate text-[10px] text-muted-foreground">{voiceStatsSummary}</div> : null}
            </div>
          </button>
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
            <TooltipContent>Disconnect</TooltipContent>
          </Tooltip>
        </div>
      )}

      <div className="flex items-center gap-2.5 px-3 py-2">
        <div className="relative shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
            {user.avatar}
          </div>
          <div className={cn(
            "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-sidebar",
            statusColors[user.status]
          )} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{user.name}</div>
        </div>

        <div className="flex gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleMute}
                className={cn(
                  "text-muted-foreground",
                  isMuted && "text-destructive hover:text-destructive"
                )}
              >
                {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isMuted ? "Unmute" : "Mute"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleDeafen}
                className={cn(
                  "text-muted-foreground",
                  isDeafened && "text-destructive hover:text-destructive"
                )}
              >
                {isDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{isDeafened ? "Undeafen" : "Deafen"}</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onOpenSettings}
                className="text-muted-foreground"
              >
                <Settings className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Settings</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  )
}
