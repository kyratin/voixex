"use client"

import { cn } from "@/lib/utils"
import { Plus, Settings } from "lucide-react"

interface Server {
  id: string
  name: string
  icon: string
  hasNotification?: boolean
  mentions?: number
}

interface ServerSidebarProps {
  servers: Server[]
  activeServerId: string
  onServerSelect: (serverId: string) => void
  onAddServer?: () => void
  onOpenSettings?: () => void
}

export function ServerSidebar({ servers, activeServerId, onServerSelect, onAddServer, onOpenSettings }: ServerSidebarProps) {
  return (
    <div className="flex h-full w-16 flex-col border-r border-border bg-sidebar">
      {/* Server List */}
      <div className="flex flex-1 flex-col overflow-y-auto">
        {servers.map((server) => (
          <button
            key={server.id}
            onClick={() => onServerSelect(server.id)}
            className={cn(
              "relative flex h-12 w-full items-center justify-center border-b border-border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
              activeServerId === server.id && "bg-sidebar-accent text-foreground"
            )}
            title={server.name}
          >
            {/* Server Icon */}
            <span className="text-lg">{server.icon}</span>

            {/* Notification Indicator */}
            {server.hasNotification && activeServerId !== server.id && (
              <div className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary" />
            )}

            {/* Mention Badge */}
            {server.mentions && server.mentions > 0 && (
              <div className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[10px] font-bold text-destructive-foreground">
                {server.mentions > 9 ? "9+" : server.mentions}
              </div>
            )}
          </button>
        ))}
      </div>

      {/* Add Server */}
      <button
        onClick={onAddServer}
        className="flex h-12 w-full items-center justify-center border-t border-border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <Plus className="h-5 w-5" />
      </button>

      {/* Settings */}
      <button
        onClick={onOpenSettings}
        className="flex h-12 w-full items-center justify-center border-t border-border text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
      >
        <Settings className="h-5 w-5" />
      </button>
    </div>
  )
}
