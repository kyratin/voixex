"use client"

import { useState } from "react"
import { Crown } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { avatarGradient } from "@/lib/avatar-colors"
import { useI18n } from "@/lib/i18n/provider"

export type RoleMember = { id: string; name: string; isAdmin: boolean; online: boolean }

/**
 * Admin role management: every registered member with an "admin" switch.
 * The server refuses to remove the last admin; the switch is disabled for that case up front.
 */
export function RolesAdmin({
  members,
  meId,
  onSetAdmin,
  describeError
}: {
  members: RoleMember[]
  meId: string | null
  onSetAdmin: (clientId: string, admin: boolean) => Promise<void>
  describeError: (error: unknown) => { text: string }
}) {
  const { t } = useI18n()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const adminCount = members.filter((m) => m.isAdmin).length
  const sorted = [...members].sort(
    (a, b) => Number(b.isAdmin) - Number(a.isAdmin) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  )

  const toggle = async (member: RoleMember, admin: boolean) => {
    setBusyId(member.id)
    setMessage("")
    try {
      await onSetAdmin(member.id, admin)
    } catch (e) {
      setMessage(describeError(e).text)
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-semibold text-foreground">{t("roles.title")}</p>
        <p className="mt-1 text-sm text-muted-foreground">{t("roles.intro")}</p>
      </div>
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("roles.empty")}</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
          {sorted.map((m) => {
            const lastAdmin = m.isAdmin && adminCount <= 1
            return (
              <div key={m.id} className="flex items-center gap-3 px-3 py-2.5">
                <div
                  className={cn("flex size-8 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white", !m.online && "opacity-50")}
                  style={{ background: avatarGradient(m.id || m.name) }}
                >
                  {m.name.slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    {m.name}
                    {m.isAdmin ? <Crown className="h-3.5 w-3.5 shrink-0 text-amber-400" aria-label={t("roles.admin")} /> : null}
                    {m.id === meId ? <span className="text-xs font-normal text-muted-foreground">({t("roles.you")})</span> : null}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {lastAdmin ? t("roles.lastAdmin") : m.online ? t("members.status_online") : t("members.status_offline")}
                  </p>
                </div>
                {busyId === m.id ? <Spinner className="h-4 w-4" /> : null}
                <Switch
                  checked={m.isAdmin}
                  disabled={busyId !== null || lastAdmin}
                  onCheckedChange={(v) => void toggle(m, v)}
                  aria-label={t("roles.admin")}
                />
              </div>
            )
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("roles.superuserHint")}</p>
    </div>
  )
}
