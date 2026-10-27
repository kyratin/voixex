"use client"

import { cn } from "@/lib/utils"
import { Volume2, X } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useI18n } from "@/lib/i18n/provider"
import { avatarGradient } from "@/lib/avatar-colors"

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
  /** Hides the list (header close button). */
  onClose?: () => void
  /** Members currently in a voice channel / speaking, for the voice icon and avatar ring. */
  inVoiceIds?: string[]
  speakingIds?: string[]
}

const statusColors: Record<Member["status"], string> = {
  online: "bg-accent",
  idle: "bg-amber-400",
  dnd: "bg-destructive",
  offline: "bg-muted-foreground"
}

export function MemberList({ members, roles = [], onClose, inVoiceIds = [], speakingIds = [] }: MemberListProps) {
  const { t } = useI18n()
  const statusOrder: Record<string, number> = { online: 0, idle: 1, dnd: 2, offline: 3 }
  const byName = (a: Member, b: Member) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id)
  const sortByStatusThenName = (a: Member, b: Member) => statusOrder[a.status] - statusOrder[b.status] || byName(a, b)

  const onlineMembers = members.filter((m) => m.status !== "offline")
  const offlineMembers = [...members.filter((m) => m.status === "offline")].sort(byName)
  const roleGroups = roles
    .map((role) => ({ role, members: onlineMembers.filter((m) => m.roles?.includes(role.id)).sort(sortByStatusThenName) }))
    .filter((g) => g.members.length > 0)
  const noRoleMembers = onlineMembers.filter((m) => !m.roles || m.roles.length === 0).sort(sortByStatusThenName)
  const inVoice = new Set(inVoiceIds)
  const speaking = new Set(speakingIds)

  const group = (key: string, label: string, list: Member[], color?: string) => (
    <section key={key} className="mb-5">
      <p className="mb-2 px-2 text-[11px] font-semibold text-muted-foreground" style={color ? { color } : undefined}>
        {label} — {list.length}
      </p>
      <div className="space-y-0.5">
        {list.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            roleName={roles.find((r) => member.roles?.includes(r.id))?.name}
            inVoice={inVoice.has(member.id)}
            speaking={speaking.has(member.id)}
          />
        ))}
      </div>
    </section>
  )

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col bg-card">
      <div className="flex shrink-0 items-center justify-between px-4 pb-3 pt-5">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
          {t("members.title")} — {members.length}
        </h2>
        {onClose ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("voice.hideMembers")}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="left">{t("voice.hideMembers")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="px-2 pb-4">
          {roleGroups.map((g) => group(g.role.id, g.role.name, g.members, g.role.color))}
          {noRoleMembers.length > 0 ? group("online", t("members.online"), noRoleMembers) : null}
          {offlineMembers.length > 0 ? group("offline", t("members.offline"), offlineMembers) : null}
        </div>
      </ScrollArea>
    </aside>
  )
}

function MemberRow({
  member,
  roleName,
  inVoice,
  speaking
}: {
  member: Member
  roleName?: string
  inVoice: boolean
  speaking: boolean
}) {
  const { t } = useI18n()
  const offline = member.status === "offline"
  const status = t(`members.status_${member.status}`)
  const subline = member.activity || (member.isOwner ? t("members.owner") : roleName ? `${roleName} · ${status}` : status)
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg px-2 py-2 transition-colors",
        offline ? "opacity-40 hover:opacity-100" : "hover:bg-sidebar-accent"
      )}
    >
      <div className="relative shrink-0">
        <div
          className={cn(
            "flex size-8 items-center justify-center rounded-full text-xs font-bold text-white transition-shadow",
            speaking && "ring-2 ring-accent ring-offset-2 ring-offset-card"
          )}
          style={{ background: avatarGradient(member.id || member.name) }}
        >
          {member.avatar}
        </div>
        {!offline ? (
          <span className={cn("absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-card", statusColors[member.status])} />
        ) : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn("truncate text-sm font-medium", offline ? "text-muted-foreground" : "text-foreground")}>{member.name}</p>
          {member.isBot ? <Badge variant="outline" className="h-4 px-1 text-[9px]">BOT</Badge> : null}
        </div>
        <p className="truncate text-[10px] text-muted-foreground">{subline}</p>
      </div>
      {inVoice ? <Volume2 className="h-4 w-4 shrink-0 text-accent" aria-label={t("sidebar.inVoiceChannel")} /> : null}
    </div>
  )
}
