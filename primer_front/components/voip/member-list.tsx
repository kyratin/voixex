"use client"

import { cn } from "@/lib/utils"
import { Circle } from "lucide-react"

export interface Member {
  id: string
  name: string
  avatar: string
  status: "online" | "idle" | "dnd" | "offline"
  activity?: string
  roles?: string[]
  isOwner?: boolean
  isBot?: boolean
}

interface MemberListProps {
  members: Member[]
  roles?: { id: string; name: string; color?: string }[]
}

export function MemberList({ members, roles = [] }: MemberListProps) {
  const statusColors = {
    online: "fill-accent text-accent",
    idle: "fill-yellow-500 text-yellow-500",
    dnd: "fill-destructive text-destructive",
    offline: "fill-muted-foreground text-muted-foreground"
  }

  const statusOrder = { online: 0, idle: 1, dnd: 2, offline: 3 }

  // Group members by their highest role
  const groupedMembers: Record<string, Member[]> = {}
  const onlineMembers = members.filter(m => m.status !== "offline")
  const offlineMembers = members.filter(m => m.status === "offline")

  roles.forEach(role => {
    groupedMembers[role.id] = onlineMembers
      .filter(m => m.roles?.includes(role.id))
      .sort((a, b) => statusOrder[a.status] - statusOrder[b.status])
  })

  // Members without roles
  const noRoleMembers = onlineMembers
    .filter(m => !m.roles || m.roles.length === 0)
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status])

  return (
    <div className="flex h-full w-48 flex-col border-l border-border bg-card">
      <div className="flex h-10 items-center border-b border-border bg-sidebar px-3">
        <span className="text-xs font-semibold uppercase text-muted-foreground">Members</span>
      </div>
      
      <div className="flex-1 overflow-y-auto p-2">
        {/* Role Groups */}
        {roles.map(role => {
          const roleMembers = groupedMembers[role.id] || []
          if (roleMembers.length === 0) return null

          return (
            <div key={role.id} className="mb-3">
              <div className="mb-1 px-1 text-[10px] font-semibold uppercase text-muted-foreground">
                {role.name} ({roleMembers.length})
              </div>
              <div className="space-y-px">
                {roleMembers.map(member => (
                  <MemberItem key={member.id} member={member} statusColor={statusColors[member.status]} />
                ))}
              </div>
            </div>
          )
        })}

        {/* Online Members without roles */}
        {noRoleMembers.length > 0 && (
          <div className="mb-3">
            <div className="mb-1 px-1 text-[10px] font-semibold uppercase text-muted-foreground">
              Online ({noRoleMembers.length})
            </div>
            <div className="space-y-px">
              {noRoleMembers.map(member => (
                <MemberItem key={member.id} member={member} statusColor={statusColors[member.status]} />
              ))}
            </div>
          </div>
        )}

        {/* Offline Members */}
        {offlineMembers.length > 0 && (
          <div>
            <div className="mb-1 px-1 text-[10px] font-semibold uppercase text-muted-foreground">
              Offline ({offlineMembers.length})
            </div>
            <div className="space-y-px">
              {offlineMembers.map(member => (
                <MemberItem key={member.id} member={member} statusColor={statusColors[member.status]} isOffline />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

interface MemberItemProps {
  member: Member
  statusColor: string
  isOffline?: boolean
}

function MemberItem({ member, statusColor, isOffline }: MemberItemProps) {
  return (
    <button
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1 hover:bg-muted",
        isOffline && "opacity-50"
      )}
    >
      <div className="relative shrink-0">
        <div className="h-6 w-6 rounded border border-border bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
          {member.avatar}
        </div>
        <Circle className={cn("absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5", statusColor)} />
      </div>
      <div className="flex-1 min-w-0 text-left">
        <div className="flex items-center gap-1">
          <span className={cn("truncate text-xs", isOffline ? "text-muted-foreground" : "text-foreground")}>
            {member.name}
          </span>
          {member.isOwner && (
            <span className="text-yellow-500 text-[10px]">*</span>
          )}
          {member.isBot && (
            <span className="rounded border border-primary px-0.5 text-[8px] font-medium text-primary">BOT</span>
          )}
        </div>
        {member.activity && (
          <div className="truncate text-[10px] text-muted-foreground">{member.activity}</div>
        )}
      </div>
    </button>
  )
}
