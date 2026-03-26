"use client"

import { cn } from "@/lib/utils"
import { Mic, MicOff, Headphones, HeadphoneOff, Settings, PhoneOff, Circle } from "lucide-react"

interface UserPanelProps {
  user: {
    id: string
    name: string
    discriminator: string
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
  const statusColors = {
    online: "fill-accent text-accent",
    idle: "fill-yellow-500 text-yellow-500",
    dnd: "fill-destructive text-destructive",
    offline: "fill-muted-foreground text-muted-foreground"
  }

  return (
    <div className="border-r border-t border-border bg-sidebar">
      {/* Voice Connected Panel */}
      {isInVoice && (
        <div className="flex items-center justify-between border-b border-border px-2 py-1.5">
          <button onClick={onToggleVoiceStats} className="text-left">
            <div className="text-[10px] font-semibold text-accent">Voice Connected</div>
            <div className="text-[10px] text-muted-foreground">{voiceChannelName}</div>
            {voiceStatsSummary ? <div className="text-[10px] text-muted-foreground">{voiceStatsSummary}</div> : null}
          </button>
          <button 
            onClick={onDisconnect}
            className="rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
            title="Disconnect"
          >
            <PhoneOff className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* User Info */}
      <div className="flex items-center gap-2 p-2">
        {/* Avatar with Status */}
        <div className="relative shrink-0">
          <div className="h-8 w-8 rounded border border-border bg-muted flex items-center justify-center text-xs font-medium text-muted-foreground">
            {user.avatar}
          </div>
          <Circle className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3", statusColors[user.status])} />
        </div>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <div className="truncate text-xs font-medium text-foreground">{user.name}</div>
          <div className="truncate text-[10px] text-muted-foreground">#{user.discriminator}</div>
        </div>

        {/* Control Buttons */}
        <div className="flex gap-0.5">
          <button
            onClick={onToggleMute}
            className={cn(
              "rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
              isMuted && "text-destructive hover:text-destructive"
            )}
            title={isMuted ? "Unmute" : "Mute"}
          >
            {isMuted ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
          </button>

          <button
            onClick={onToggleDeafen}
            className={cn(
              "rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground",
              isDeafened && "text-destructive hover:text-destructive"
            )}
            title={isDeafened ? "Undeafen" : "Deafen"}
          >
            {isDeafened ? <HeadphoneOff className="h-3.5 w-3.5" /> : <Headphones className="h-3.5 w-3.5" />}
          </button>

          <button
            onClick={onOpenSettings}
            className="rounded border border-border p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  )
}
