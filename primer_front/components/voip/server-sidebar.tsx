"use client"

import { cn } from "@/lib/utils"
import { Plus, Settings } from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"

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
    <div className="flex h-full w-[72px] flex-col items-center bg-sidebar py-3 gap-2">
      <ScrollArea className="flex-1 w-full">
        <div className="flex flex-col items-center gap-2 px-3">
          {servers.map((server) => {
            const isActive = activeServerId === server.id
            return (
              <Tooltip key={server.id}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => onServerSelect(server.id)}
                    className="group relative flex items-center"
                  >
                    <div className={cn(
                      "absolute -left-3 w-1 rounded-r-full bg-foreground transition-all duration-200",
                      isActive ? "h-10" : "h-0 group-hover:h-5"
                    )} />
                    <div className={cn(
                      "flex h-12 w-12 items-center justify-center text-lg transition-all duration-200",
                      isActive
                        ? "rounded-2xl bg-primary text-primary-foreground"
                        : "rounded-3xl bg-muted text-muted-foreground hover:rounded-2xl hover:bg-primary hover:text-primary-foreground"
                    )}>
                      {server.icon}
                    </div>
                    {server.hasNotification && !isActive && (
                      <div className="absolute -left-3 top-1/2 -translate-y-1/2 h-2 w-2 rounded-full bg-foreground" />
                    )}
                    {server.mentions && server.mentions > 0 && (
                      <div className="absolute -bottom-1 -right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground ring-2 ring-sidebar">
                        {server.mentions > 9 ? "9+" : server.mentions}
                      </div>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {server.name}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
      </ScrollArea>

      <div className="flex flex-col items-center gap-2 px-3">
        <div className="h-px w-8 bg-border" />
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onAddServer}
              className="flex h-12 w-12 items-center justify-center rounded-3xl bg-muted text-accent transition-all duration-200 hover:rounded-2xl hover:bg-accent hover:text-accent-foreground"
            >
              <Plus className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Add Server
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onOpenSettings}
              className="flex h-12 w-12 items-center justify-center rounded-3xl bg-muted text-muted-foreground transition-all duration-200 hover:rounded-2xl hover:bg-muted hover:text-foreground"
            >
              <Settings className="h-5 w-5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            Settings
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
