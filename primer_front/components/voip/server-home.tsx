"use client"

import { cn } from "@/lib/utils"
import { Archive, AudioLines, ChevronDown, FileKey, KeyRound, LockKeyhole, MoreHorizontal, Pencil, Plus, Settings, ShieldCheck, Trash2 } from "lucide-react"
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
  /** Opens the certificates stored on this device (desktop only). */
  onOpenCertificateStorage?: () => void
  /** Number of certificates in the device storage, shown in the menu. */
  storedCertificateCount?: number
}

function Chip({ tone, children }: { tone: "accent" | "warning" | "muted"; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5",
        tone === "accent" ? "bg-accent/15 text-accent" : tone === "warning" ? "bg-amber-400/15 text-amber-400" : "bg-secondary text-muted-foreground"
      )}
    >
      {children}
    </span>
  )
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
  onOpenDeviceSettings,
  onOpenCertificateStorage,
  storedCertificateCount = 0
}: ServerHomeProps) {
  const { t } = useI18n()

  return (
    <main className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-background p-8">
      <header className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <AudioLines className="h-5 w-5" />
            </div>
            <span className="text-xl font-bold tracking-tight text-foreground">Voixex</span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{t("home.tagline")}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenDeviceSettings}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Settings className="h-4 w-4" />
            {t("home.deviceSettings")}
          </button>
          <button
            type="button"
            onClick={onAdd}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-4 w-4" />
            {t("home.addServer")}
          </button>
        </div>
      </header>

      <section className="mx-auto mt-12 max-w-5xl">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("home.eyebrow")}</p>
            <h1 className="mt-1 text-2xl font-bold text-foreground">{t("home.title")}</h1>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ShieldCheck className="h-4 w-4" />
                {t("home.importCertificate")}
                <ChevronDown className="h-3.5 w-3.5 opacity-70" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem className="gap-2" onClick={onImport}>
                <FileKey className="h-4 w-4" />
                {t("home.importFromFile")}
              </DropdownMenuItem>
              {onOpenCertificateStorage ? (
                <DropdownMenuItem className="gap-2" onClick={onOpenCertificateStorage}>
                  <Archive className="h-4 w-4" />
                  <span className="flex-1">{t("home.certificateStorage")}</span>
                  <span className="text-xs text-muted-foreground">{storedCertificateCount}</span>
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {servers.map((server) => {
            const busy = busyServerId === server.id
            const offline = server.reachable === "offline"
            return (
              <div
                key={server.id}
                role="button"
                tabIndex={0}
                aria-busy={busy}
                onClick={() => !busy && onOpen(server.id)}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === " ") && !busy) {
                    e.preventDefault()
                    onOpen(server.id)
                  }
                }}
                className={cn(
                  "group flex min-h-44 cursor-pointer flex-col rounded-xl bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  offline && "opacity-65"
                )}
              >
                <div className="flex items-start justify-between">
                  <div
                    className="flex size-10 items-center justify-center rounded-xl text-lg font-bold text-white"
                    style={{ background: avatarGradient(server.id) }}
                  >
                    {server.label.slice(0, 1).toUpperCase() || "S"}
                  </div>
                  {busy ? (
                    <Spinner className="h-4 w-4" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => e.stopPropagation()}
                          aria-label={t("home.serverActions")}
                          className="rounded-md p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-card hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
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
                  )}
                </div>
                <p className="mt-4 truncate font-semibold text-foreground">{server.label}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">{server.address}</p>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-4 text-[10px] font-semibold">
                  <Chip tone={server.secure ? "accent" : "muted"}>{server.secure ? "HTTPS" : "HTTP"}</Chip>
                  {server.authMode ? (
                    <Chip tone="muted">{t("home.levelChip", { level: authLevel(server.authMode) })}</Chip>
                  ) : (
                    <Chip tone="warning">{t("home.needsProtection")}</Chip>
                  )}
                  <span
                    className={cn(
                      "ml-auto flex items-center gap-1",
                      server.reachable === "online" ? "text-accent" : "text-muted-foreground"
                    )}
                  >
                    <span
                      className={cn(
                        "size-1.5 rounded-full",
                        server.reachable === "online" ? "bg-accent" : offline ? "bg-destructive" : "bg-muted-foreground/50"
                      )}
                    />
                    {server.reachable === "online" ? t("home.online") : offline ? t("home.offline") : t("home.checking")}
                  </span>
                </div>
              </div>
            )
          })}
          <button
            type="button"
            onClick={onAdd}
            className="flex min-h-44 flex-col items-center justify-center gap-3 rounded-xl bg-card text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-secondary">
              <Plus className="h-5 w-5" />
            </span>
            <span className="text-sm font-medium">{t("home.addServer")}</span>
          </button>
        </div>
      </section>

      <div className="mx-auto mt-10 flex max-w-5xl items-center gap-3 rounded-xl bg-card p-4 text-sm text-muted-foreground">
        <LockKeyhole className="h-5 w-5 shrink-0 text-accent" />
        <p>
          <span className="font-semibold text-foreground">{t("home.closedTitle")}</span> {t("home.closedText")}
        </p>
      </div>
    </main>
  )
}
