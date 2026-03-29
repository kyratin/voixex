"use client"

import { cn } from "@/lib/utils"
import { Hash, Volume2, ChevronDown, Lock, MicOff, Headphones } from "lucide-react"
import { useState } from "react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"

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
}

interface ChannelSidebarProps {
  serverName: string
  categories: ChannelCategory[]
  activeChannelId: string
  onChannelSelect: (channelId: string) => void
  voiceUsers?: Record<string, VoiceUser[]>
}

export function ChannelSidebar({ 
  serverName, 
  categories, 
  activeChannelId, 
  onChannelSelect,
  voiceUsers = {}
}: ChannelSidebarProps) {
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
    <div className="flex h-full w-60 flex-col bg-card">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <span className="truncate text-sm font-semibold text-foreground">{serverName}</span>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-2">
          {categories.map((category) => (
            <div key={category.id} className="mb-1">
              <button
                onClick={() => toggleCategory(category.id)}
                className="mb-0.5 flex w-full items-center gap-1 rounded-md px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
              >
                <ChevronDown className={cn(
                  "h-3 w-3 shrink-0 transition-transform duration-200",
                  collapsedCategories.has(category.id) && "-rotate-90"
                )} />
                <span className="truncate">{category.name}</span>
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
                            "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                            activeChannelId === channel.id && "bg-muted text-foreground",
                            channel.unread && "font-medium text-foreground"
                          )}
                        >
                          {channel.type === "text" ? (
                            <Hash className="h-4 w-4 shrink-0 opacity-60" />
                          ) : (
                            <Volume2 className="h-4 w-4 shrink-0 opacity-60" />
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
                          <div className="ml-4 border-l-2 border-border/50 py-0.5 pl-3">
                            {voiceUsers[channel.id].map((user) => (
                              <div
                                key={user.id}
                                className="flex items-center gap-2 rounded-md px-1.5 py-1 text-xs text-muted-foreground"
                              >
                                <div className={cn(
                                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-medium transition-all",
                                  user.isSpeaking
                                    ? "bg-accent/20 text-accent ring-2 ring-accent"
                                    : "bg-muted text-muted-foreground"
                                )}>
                                  {user.avatar.slice(0, 1).toUpperCase()}
                                </div>
                                <span className={cn("truncate", user.isSpeaking && "text-foreground")}>
                                  {user.name}
                                </span>
                                <div className="ml-auto flex gap-0.5">
                                  {user.isMuted && <MicOff className="h-3 w-3 text-destructive/70" />}
                                  {user.isDeafened && <Headphones className="h-3 w-3 text-destructive/70" />}
                                </div>
                              </div>
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
