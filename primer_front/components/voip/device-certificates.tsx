"use client"

import { useState } from "react"
import { Download, FileKey, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/provider"

export type DeviceCertificate = {
  ref: string
  certId: string | null
  /** Nick of the profile this certificate signs in as (known after the first sign-in). */
  nick: string | null
  serverLabel: string | null
  address: string | null
  issuedAt: string | null
  /** A saved server on the home screen uses this certificate. */
  inUse: boolean
}

const MIN_PASSPHRASE = 8

/**
 * Certificates stored on this device (private keys stay in the OS keychain). Each row says which
 * profile and server the certificate is for; it can be exported to another computer or deleted.
 */
export function DeviceCertificates({
  certificates,
  onExport,
  onRemove
}: {
  certificates: DeviceCertificate[]
  onExport: (ref: string, passphrase: string) => Promise<string | null>
  onRemove: (ref: string) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [exportingRef, setExportingRef] = useState<string | null>(null)
  const [confirmRemoveRef, setConfirmRemoveRef] = useState<string | null>(null)
  const [passphrase, setPassphrase] = useState("")
  const [passphrase2, setPassphrase2] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ ref: string; text: string; error?: boolean } | null>(null)

  const formatDate = (value: string | null) => {
    if (!value) return null
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(locale)
  }

  const startExport = (ref: string) => {
    setExportingRef(ref)
    setConfirmRemoveRef(null)
    setPassphrase("")
    setPassphrase2("")
    setMessage(null)
  }

  const doExport = async (ref: string) => {
    if (passphrase.length < MIN_PASSPHRASE) return setMessage({ ref, text: t("access.passwordTooShort", { n: MIN_PASSPHRASE }), error: true })
    if (passphrase !== passphrase2) return setMessage({ ref, text: t("access.passwordsDiffer"), error: true })
    setBusy(true)
    try {
      const path = await onExport(ref, passphrase)
      if (path) {
        setExportingRef(null)
        setMessage({ ref, text: t("security.exported", { path }) })
      }
    } catch (e) {
      setMessage({ ref, text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  const doRemove = async (ref: string) => {
    setBusy(true)
    try {
      await onRemove(ref)
      setConfirmRemoveRef(null)
    } catch (e) {
      setMessage({ ref, text: e instanceof Error ? e.message : String(e), error: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section>
      {certificates.length === 0 ? (
        <p className="rounded-xl bg-card p-4 text-sm text-muted-foreground">{t("deviceCerts.empty")}</p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl bg-card">
          {certificates.map((c) => {
            const issued = formatDate(c.issuedAt)
            return (
              <div key={c.ref} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-lg",
                      c.inUse ? "bg-accent/15 text-accent" : "bg-secondary text-muted-foreground"
                    )}
                  >
                    <FileKey className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-foreground">
                      {c.nick ?? t("deviceCerts.unknownNick")}
                      <span className="font-normal text-muted-foreground"> · {c.serverLabel ?? t("deviceCerts.unknownServer")}</span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[c.address, issued ? t("deviceCerts.issued", { date: issued }) : t("deviceCerts.pending"), c.certId ? `#${c.certId.slice(0, 8)}` : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <span
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold",
                      c.inUse ? "bg-accent/15 text-accent" : "bg-amber-400/15 text-amber-400"
                    )}
                  >
                    {c.inUse ? t("deviceCerts.inUse") : t("deviceCerts.unused")}
                  </span>
                  <div className="flex items-center gap-1">
                    {c.certId ? (
                      <Button size="sm" variant="ghost" className="gap-1.5" onClick={() => startExport(c.ref)} disabled={busy}>
                        <Download className="h-3.5 w-3.5" />
                        {t("deviceCerts.export")}
                      </Button>
                    ) : null}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="gap-1.5 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        setConfirmRemoveRef(c.ref)
                        setExportingRef(null)
                        setMessage(null)
                      }}
                      disabled={busy}
                      aria-label={t("deviceCerts.remove")}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {exportingRef === c.ref ? (
                  <form
                    className="mt-3 flex flex-wrap items-center gap-2"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void doExport(c.ref)
                    }}
                  >
                    <Input
                      type="password"
                      autoFocus
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder={t("security.exportPassphrase")}
                      className="h-8 w-56"
                    />
                    <Input
                      type="password"
                      value={passphrase2}
                      onChange={(e) => setPassphrase2(e.target.value)}
                      placeholder={t("deviceCerts.repeatPassphrase")}
                      className="h-8 w-56"
                    />
                    <Button size="sm" type="submit" disabled={busy}>
                      {t("deviceCerts.saveFile")}
                    </Button>
                    <Button size="sm" variant="ghost" type="button" onClick={() => setExportingRef(null)}>
                      {t("access.cancel")}
                    </Button>
                  </form>
                ) : null}

                {confirmRemoveRef === c.ref ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                    <span className="flex-1">{c.inUse ? t("deviceCerts.removeInUse") : t("deviceCerts.removeConfirm")}</span>
                    <Button size="sm" variant="destructive" onClick={() => void doRemove(c.ref)} disabled={busy}>
                      {t("deviceCerts.remove")}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemoveRef(null)}>
                      {t("access.cancel")}
                    </Button>
                  </div>
                ) : null}

                {message?.ref === c.ref ? (
                  <p className={cn("mt-2 text-xs", message.error ? "text-destructive" : "text-muted-foreground")}>{message.text}</p>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
