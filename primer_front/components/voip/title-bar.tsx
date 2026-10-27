"use client"

import { useEffect, useState } from "react"
import { AudioLines } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * Dark, draggable title bar replacing the system frame (32 px high, see desktop-client main.ts).
 * Native window controls sit on top of it: traffic lights on the left on macOS, the overlaid
 * buttons on the right on Windows/Linux.
 */
export function TitleBar({ title }: { title: string }) {
  const [platform, setPlatform] = useState<string | null>(null)
  useEffect(() => {
    if (window.voixexWindow?.customTitleBar) setPlatform(window.voixexWindow.platform)
  }, [])
  if (!platform) return null
  const mac = platform === "darwin"
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 select-none items-center gap-2 bg-sidebar text-xs text-muted-foreground [-webkit-app-region:drag]",
        mac ? "justify-center px-20" : "pl-3 pr-[150px]"
      )}
    >
      <AudioLines className="h-3.5 w-3.5 shrink-0 text-primary" />
      <span className="truncate">{title}</span>
    </div>
  )
}
