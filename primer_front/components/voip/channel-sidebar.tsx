"use client"

import { cn } from "@/lib/utils"
import { Hash, Volume2, ChevronDown, ChevronRight, Lock, Circle } from "lucide-react"
import { useState } from "react"

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
    <div className="flex h-full w-56 flex-col border-r border-border bg-card">
      {/* Server Header */}
      <div className="flex h-10 items-center border-b border-border bg-sidebar px-3">
        <span className="truncate text-sm font-semibold text-foreground">{serverName}</span>
      </div>

      {/* Channels List */}
      <div className="flex-1 overflow-y-auto p-2">
        {categories.map((category) => (
          <div key={category.id} className="mb-3">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory(category.id)}
              className="mb-1 flex w-full items-center gap-1 px-1 text-xs font-semibold uppercase text-muted-foreground hover:text-foreground"
            >
              {collapsedCategories.has(category.id) ? (
                <ChevronRight className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              <span>{category.name}</span>
            </button>

            {/* Channels */}
            {!collapsedCategories.has(category.id) && (
              <div className="space-y-px">
                {category.channels.map((channel) => (
                  <div key={channel.id}>
                    <button
                      onClick={() => onChannelSelect(channel.id)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm border border-transparent px-2 py-1 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                        activeChannelId === channel.id && "border-border bg-muted text-foreground",
                        channel.unread && "font-medium text-foreground"
                      )}
                    >
                      {channel.type === "text" ? (
                        <Hash className="h-4 w-4 shrink-0" />
                      ) : (
                        <Volume2 className="h-4 w-4 shrink-0" />
                      )}
                      {channel.isPrivate && (
                        <Lock className="h-3 w-3 shrink-0" />
                      )}
                      <span className="flex-1 truncate text-left">
                        {channel.name}
                      </span>
                      {channel.mentions && channel.mentions > 0 && (
                        <span className="flex h-4 min-w-4 items-center justify-center rounded bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
                          {channel.mentions}
                        </span>
                      )}
                    </button>

                    {/* Voice Users in Channel */}
                    {channel.type === "voice" && voiceUsers[channel.id] && voiceUsers[channel.id].length > 0 && (
                      <div className="ml-5 border-l border-border py-1 pl-2">
                        {voiceUsers[channel.id].map((user) => (
                          <div
                            key={user.id}
                            className={cn(
                              "flex items-center gap-2 py-0.5 text-xs text-muted-foreground",
                              user.isSpeaking && "text-accent"
                            )}
                          >
                            <Circle 
                              className={cn(
                                "h-2 w-2",
                                user.isSpeaking ? "fill-accent text-accent" : "fill-muted-foreground"
                              )} 
                            />
                            <span className="truncate">{user.name}</span>
                            {(user.isMuted || user.isDeafened) && (
                              <span className="text-destructive">
                                {user.isMuted ? "M" : ""}{user.isDeafened ? "D" : ""}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
