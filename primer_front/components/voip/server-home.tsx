"use client"

import { cn } from "@/lib/utils"
import { FileKey, KeyRound, Lock, MoreHorizontal, Pencil, Plus, Settings, ShieldAlert, ShieldCheck, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"
import { avatarGradient } from "@/lib/avatar-colors"
import { authLevel, type AuthMode } from "@/lib/voip-client"
import { ConnectionSecurityBadge } from "@/components/voip/server-access-dialog"
import { useI18n } from "@/lib/i18n/provider"

export type ServerCardInfo = {
  id: string
  label: string
  address: string
  secure: boolean
  /** Protection level chosen on this server; null = old unprotected profile. */
  authMode: AuthMode | null
  reachable: "unknown" | "online" | "offline"
}

interface ServerHomeProps {
  servers: ServerCardInfo[]
  /** Card currently signing in, shows a spinner. */
  busyServerId: string | null
  onOpen: (serverId: string) => void
  onAdd: () => void
  onImport: () => void
  /** Opens the sign-in dialog with the superuser password field (level 2 signs in with one click otherwise). */
  onSignInAsAdmin: (serverId: string) => void
  onEdit: (serverId: string) => void
  onRemove: (serverId: string) => void
  onOpenDeviceSettings: () => void
}

/**
 * Entry screen: only what this device knows locally. A server reveals nothing (name, members,
 * channels) until you sign in, so cards show your own label, the address and reachability.
 */
export function ServerHome({
  servers,
  busyServerId,
  onOpen,
  onAdd,
  onImport,
  onSignInAsAdmin,
  onEdit,
  onRemove,
  onOpenDeviceSettings
}: ServerHomeProps) {
  const { t } = useI18n()

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background">
      <header className="flex h-14 shrink-0 items-center justify-between px-6 shadow-[0_1px_0_rgba(0,0,0,0.35)]">
        <span className="text-lg font-bold tracking-tight text-foreground">Voixex</span>
        <Button variant="ghost" size="sm" className="gap-2 text-muted-foreground" onClick={onOpenDeviceSettings}>
          <Settings className="h-4 w-4" />
          {t("home.deviceSettings")}
        </Button>
      </header>

      <div className="mx-auto w-full max-w-5xl px-6 py-8">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{t("home.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("home.subtitle")}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" className="gap-2" onClick={onImport}>
              <FileKey className="h-4 w-4" />
              {t("home.importCertificate")}
            </Button>
            <Button className="gap-2" onClick={onAdd}>
              <Plus className="h-4 w-4" />
              {t("home.addServer")}
            </Button>
          </div>
        </div>

        {servers.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-16 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
              <Lock className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="text-lg font-semibold text-foreground">{t("home.emptyTitle")}</h2>
            <p className="max-w-md text-sm text-muted-foreground">{t("home.emptyText")}</p>
            <Button className="mt-2 gap-2" onClick={onAdd}>
              <Plus className="h-4 w-4" />
              {t("home.addServer")}
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {servers.map((server) => {
              const busy = busyServerId === server.id
              return (
                <div
                  key={server.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => !busy && onOpen(server.id)}
                  onKeyDown={(e) => {
                    if ((e.key === "Enter" || e.key === " ") && !busy) {
                      e.preventDefault()
                      onOpen(server.id)
                    }
                  }}
                  className="group relative flex cursor-pointer flex-col gap-3 rounded-xl bg-card p-4 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <div className="flex items-start gap-3">
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-base font-semibold text-white"
                      style={{ background: avatarGradient(server.id) }}
                    >
                      {server.label.slice(0, 1).toUpperCase() || "S"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[15px] font-semibold text-foreground">{server.label}</div>
                      <div className="truncate text-xs text-muted-foreground">{server.address}</div>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                          aria-label={t("home.serverActions")}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
                        {server.authMode ? (
                          <DropdownMenuItem className="gap-2" onClick={() => onSignInAsAdmin(server.id)}>
                            <KeyRound className="h-4 w-4" />
                            {t("home.signInAsAdmin")}
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem className="gap-2" onClick={() => onEdit(server.id)}>
                          <Pencil className="h-4 w-4" />
                          {t("sidebar.editConnection")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" className="gap-2" onClick={() => onRemove(server.id)}>
                          <Trash2 className="h-4 w-4" />
                          {t("sidebar.removeServer")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>

                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <ConnectionSecurityBadge secure={server.secure} />
                      {server.authMode ? (
                        <span className="inline-flex items-center gap-1 text-accent">
                          <ShieldCheck className="h-3.5 w-3.5" />
                          {t("levels.short", { level: authLevel(server.authMode), name: t(`levels.${server.authMode}`) })}
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-amber-400">
                          <ShieldAlert className="h-3.5 w-3.5" />
                          {t("home.needsProtection")}
                        </span>
                      )}
                    </span>
                    {busy ? (
                      <Spinner className="h-3.5 w-3.5" />
                    ) : (
                      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                        <span
                          className={cn(
                            "h-2 w-2 rounded-full",
                            server.reachable === "online"
                              ? "bg-accent"
                              : server.reachable === "offline"
                                ? "bg-destructive"
                                : "bg-muted-foreground/50"
                          )}
                        />
                        {server.reachable === "online"
                          ? t("home.online")
                          : server.reachable === "offline"
                            ? t("home.offline")
                            : t("home.checking")}
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
