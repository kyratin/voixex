"use client"

import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useI18n } from "@/lib/i18n/provider"

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

const statusColors: Record<string, string> = {
  online: "bg-accent",
  idle: "bg-yellow-500",
  dnd: "bg-destructive",
  offline: "bg-muted-foreground"
}

export function MemberList({ members, roles = [] }: MemberListProps) {
  const { t } = useI18n()
  const statusOrder: Record<string, number> = { online: 0, idle: 1, dnd: 2, offline: 3 }
  const sortByStatusThenName = (a: Member, b: Member) => {
    const byStatus = statusOrder[a.status] - statusOrder[b.status]
    if (byStatus !== 0) return byStatus
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    if (byName !== 0) return byName
    return a.id.localeCompare(b.id)
  }

  const groupedMembers: Record<string, Member[]> = {}
  const onlineMembers = members.filter(m => m.status !== "offline")
  const offlineMembers = members.filter(m => m.status === "offline")

  roles.forEach(role => {
    groupedMembers[role.id] = onlineMembers
      .filter(m => m.roles?.includes(role.id))
      .sort(sortByStatusThenName)
  })

  const noRoleMembers = onlineMembers
    .filter(m => !m.roles || m.roles.length === 0)
    .sort(sortByStatusThenName)

  const sortedOfflineMembers = [...offlineMembers].sort((a, b) => {
    const byName = a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    if (byName !== 0) return byName
    return a.id.localeCompare(b.id)
  })

  return (
    <div className="flex h-full w-56 shrink-0 flex-col border-l border-border bg-card">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("members.title")}</span>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-2">
          {roles.map(role => {
            const roleMembers = groupedMembers[role.id] || []
            if (roleMembers.length === 0) return null

            return (
              <div key={role.id} className="mb-4">
                <div
                  className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                  style={role.color ? { color: role.color } : undefined}
                >
                  {role.name} — {roleMembers.length}
                </div>
                <div className="space-y-0.5">
                  {roleMembers.map(member => (
                    <MemberItem key={member.id} member={member} />
                  ))}
                </div>
              </div>
            )
          })}

          {noRoleMembers.length > 0 && (
            <div className="mb-4">
              <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("members.online")} — {noRoleMembers.length}
              </div>
              <div className="space-y-0.5">
                {noRoleMembers.map(member => (
                  <MemberItem key={member.id} member={member} />
                ))}
              </div>
            </div>
          )}

          {sortedOfflineMembers.length > 0 && (
            <div>
              <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("members.offline")} — {sortedOfflineMembers.length}
              </div>
              <div className="space-y-0.5">
                {sortedOfflineMembers.map(member => (
                  <MemberItem key={member.id} member={member} isOffline />
                ))}
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )
}

interface MemberItemProps {
  member: Member
  isOffline?: boolean
}

function MemberItem({ member, isOffline }: MemberItemProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50",
        isOffline && "opacity-40"
      )}
    >
      <div className="relative shrink-0">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
          {member.avatar}
        </div>
        <div className={cn(
          "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full ring-2 ring-card",
          statusColors[member.status]
        )} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={cn("truncate text-sm", isOffline ? "text-muted-foreground" : "text-foreground")}>
            {member.name}
          </span>
          {member.isOwner && (
            <span className="text-yellow-500 text-xs">&#9733;</span>
          )}
          {member.isBot && (
            <Badge variant="outline" className="h-4 px-1 text-[9px]">BOT</Badge>
          )}
        </div>
        {member.activity && (
          <div className="truncate text-[11px] text-muted-foreground">{member.activity}</div>
        )}
      </div>
    </div>
  )
}
