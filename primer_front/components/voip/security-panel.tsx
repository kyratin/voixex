"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { FileKey, ShieldCheck, ShieldOff } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import {
  AUTH_MODES_BY_LEVEL,
  authLevel,
  modeNeedsCertificate,
  modeNeedsPassword,
  type AuthMode,
  type CertificateInfo,
  type SecurityInfo
} from "@/lib/voip-client"
import { ConnectionSecurityBadge, ProtectionLevelPicker } from "@/components/voip/server-access-dialog"
import { useI18n } from "@/lib/i18n/provider"

const MIN_PASSWORD = 8

function formatDate(value: string | null, locale: string) {
  if (!value) return "—"
  // SQLite datetime('now') has no zone and is UTC.
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value.replace(" ", "T")}Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale)
}

function CertificateList({
  certificates,
  currentCertId,
  onRevoke
}: {
  certificates: CertificateInfo[]
  currentCertId: string | null
  onRevoke: (certId: string) => Promise<void>
}) {
  const { t, locale } = useI18n()
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  if (certificates.length === 0) return <p className="text-sm text-muted-foreground">{t("security.noCertificates")}</p>
  return (
    <div className="divide-y divide-border rounded-lg bg-secondary/40">
      {certificates.map((c) => {
        const current = c.certId === currentCertId
        return (
          <div key={c.certId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
            {c.revokedAt ? (
              <ShieldOff className="h-4 w-4 shrink-0 text-destructive" />
            ) : (
              <ShieldCheck className="h-4 w-4 shrink-0 text-accent" />
            )}
            <div className={cn("min-w-0 flex-1 text-xs", c.revokedAt && "opacity-60")}>
              <div className="flex items-center gap-2 text-sm text-foreground">
                <span className="font-mono">{c.certId.slice(0, 8)}</span>
                {current ? <Badge variant="secondary" className="h-5 text-[10px]">{t("security.thisDevice")}</Badge> : null}
              </div>
              <div className="text-muted-foreground">
                {t("security.issued")}: {formatDate(c.issuedAt, locale)} · {t("security.lastUsed")}: {formatDate(c.lastUsedAt, locale)}
              </div>
              {c.revokedAt ? (
                <div className="text-destructive">
                  {c.revokedByAdmin ? t("security.revokedByAdmin") : t("security.revoked")}: {formatDate(c.revokedAt, locale)}
                </div>
              ) : null}
            </div>
            {!c.revokedAt ? (
              confirmId === c.certId ? (
                <div className="flex items-center gap-1.5">
                  <span className="text-xs text-muted-foreground">{current ? t("security.revokeCurrentWarning") : t("security.revokeConfirm")}</span>
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-7"
                    disabled={busyId === c.certId}
                    onClick={() =>
                      void (async () => {
                        setBusyId(c.certId)
                        try {
                          await onRevoke(c.certId)
                        } finally {
                          setBusyId(null)
                          setConfirmId(null)
                        }
                      })()
                    }
                  >
                    {busyId === c.certId ? <Spinner className="h-3.5 w-3.5" /> : t("security.revoke")}
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7" onClick={() => setConfirmId(null)}>
                    {t("access.cancel")}
                  </Button>
                </div>
              ) : (
                <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={() => setConfirmId(c.certId)}>
                  {t("security.revoke")}
                </Button>
              )
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** "My profile here": protection level, certificates, certificate export and password. */
export function MySecurityPanel({
  load,
  secure,
  canExport,
  onChangeLevel,
  onRevoke,
  onChangePassword,
  onExport,
  describeError
}: {
  load: () => Promise<SecurityInfo>
  /** Server reached over HTTPS. */
  secure: boolean
  /** This device holds a certificate for the server. */
  canExport: boolean
  onChangeLevel: (mode: AuthMode, input: { currentPassword: string; newPassword: string }) => Promise<void>
  onRevoke: (certId: string) => Promise<void>
  onChangePassword: (currentPassword: string, newPassword: string) => Promise<void>
  /** Returns the saved path, or null if the user cancelled the file dialog. */
  onExport: (passphrase: string) => Promise<string | null>
  describeError: (error: unknown) => { text: string }
}) {
  const { t } = useI18n()
  const [info, setInfo] = useState<SecurityInfo | null>(null)
  const [loadError, setLoadError] = useState("")
  const [targetLevel, setTargetLevel] = useState<AuthMode>("password_certificate")
  const [levelCurrent, setLevelCurrent] = useState("")
  const [levelNew, setLevelNew] = useState("")
  const [levelRepeat, setLevelRepeat] = useState("")
  const [levelState, setLevelState] = useState<{ busy: boolean; message: string; ok: boolean }>({ busy: false, message: "", ok: false })
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [pwState, setPwState] = useState<{ busy: boolean; message: string; ok: boolean }>({ busy: false, message: "", ok: false })
  const [exportPass, setExportPass] = useState("")
  const [exportRepeat, setExportRepeat] = useState("")
  const [exportState, setExportState] = useState<{ busy: boolean; message: string; ok: boolean }>({ busy: false, message: "", ok: false })

  // The parent passes new function instances on every render (it re-renders many times a second
  // during voice), so keep them in refs: loading must not depend on their identity, or it would
  // refetch constantly and reset the level being chosen.
  const loadRef = useRef(load)
  const describeErrorRef = useRef(describeError)
  useEffect(() => {
    loadRef.current = load
    describeErrorRef.current = describeError
  })

  const refresh = useCallback(async () => {
    try {
      const loaded = await loadRef.current()
      setInfo(loaded)
      if (loaded.authMode) setTargetLevel(loaded.authMode)
      setLoadError("")
    } catch (e) {
      setLoadError(describeErrorRef.current(e).text)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>
  if (!info) return <Spinner className="h-5 w-5" />
  if (!info.protected || !info.authMode) return <p className="text-sm text-muted-foreground">{t("security.notProtected")}</p>

  const currentMode = info.authMode
  const levelChanged = targetLevel !== currentMode
  const needsNewPassword = modeNeedsPassword(targetLevel) && !info.hasPassword

  return (
    <div className="space-y-6">
      <div>
        <Label className="text-base">{t("security.title")}</Label>
        <p className="mt-1 text-sm text-muted-foreground">{t("security.nickHere", { nick: info.nick ?? "" })}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <ConnectionSecurityBadge secure={secure} />
          <span>
            {t("levels.current", { level: authLevel(currentMode), name: t(`levels.${currentMode}`) })}
          </span>
          {info.minAuthLevel ? <span>· {t("levels.serverRequires", { level: info.minAuthLevel })}</span> : null}
        </div>
      </div>

      <section className="space-y-3">
        <Label>{t("levels.title")}</Label>
        <ProtectionLevelPicker value={targetLevel} onChange={setTargetLevel} minLevel={info.minAuthLevel ?? 0} />
        {levelChanged ? (
          <div className="space-y-3 rounded-lg bg-secondary/40 p-3">
            {info.hasPassword ? (
              <Input
                type="password"
                placeholder={t("security.currentPassword")}
                value={levelCurrent}
                onChange={(e) => setLevelCurrent(e.target.value)}
                autoComplete="current-password"
              />
            ) : null}
            {needsNewPassword ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <Input type="password" placeholder={t("security.newPassword")} value={levelNew} onChange={(e) => setLevelNew(e.target.value)} autoComplete="new-password" />
                <Input type="password" placeholder={t("access.passwordRepeat")} value={levelRepeat} onChange={(e) => setLevelRepeat(e.target.value)} autoComplete="new-password" />
              </div>
            ) : null}
            {!secure && modeNeedsPassword(targetLevel) ? (
              <p className="text-xs text-amber-400">{t("levels.httpPasswordWarning")}</p>
            ) : null}
            <div className="flex items-center gap-3">
              <Button
                disabled={levelState.busy || (info.hasPassword && !levelCurrent)}
                onClick={() =>
                  void (async () => {
                    if (needsNewPassword) {
                      if (levelNew.length < MIN_PASSWORD) {
                        return setLevelState({ busy: false, ok: false, message: t("access.passwordTooShort", { n: MIN_PASSWORD }) })
                      }
                      if (levelNew !== levelRepeat) return setLevelState({ busy: false, ok: false, message: t("access.passwordsDiffer") })
                    }
                    setLevelState({ busy: true, ok: false, message: "" })
                    try {
                      await onChangeLevel(targetLevel, { currentPassword: levelCurrent, newPassword: needsNewPassword ? levelNew : "" })
                      setLevelCurrent("")
                      setLevelNew("")
                      setLevelRepeat("")
                      setLevelState({ busy: false, ok: true, message: t("levels.changed") })
                      await refresh()
                    } catch (e) {
                      setLevelState({ busy: false, ok: false, message: describeError(e).text })
                    }
                  })()
                }
              >
                {levelState.busy ? <Spinner className="h-4 w-4" /> : t("levels.apply")}
              </Button>
            </div>
          </div>
        ) : null}
        {levelState.message ? (
          <span className={cn("text-xs", levelState.ok ? "text-accent" : "text-destructive")}>{levelState.message}</span>
        ) : null}
      </section>

      {info.certificates.length > 0 ? (
        <section className="space-y-2">
          <Label>{t("security.certificates")}</Label>
          <p className="text-xs text-muted-foreground">{t("security.certificatesHint")}</p>
          <CertificateList
            certificates={info.certificates}
            currentCertId={info.currentCertId ?? null}
            onRevoke={async (certId) => {
              try {
                await onRevoke(certId)
                if (certId !== info.currentCertId) await refresh()
              } catch (e) {
                setLoadError("")
                setLevelState({ busy: false, ok: false, message: describeError(e).text })
              }
            }}
          />
        </section>
      ) : null}

      {canExport && modeNeedsCertificate(currentMode) ? (
        <section className="space-y-3 rounded-lg bg-secondary/40 p-4">
          <div>
            <Label>{t("security.exportTitle")}</Label>
            <p className="mt-1 text-xs text-muted-foreground">{t("security.exportHint")}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input type="password" placeholder={t("security.exportPassphrase")} value={exportPass} onChange={(e) => setExportPass(e.target.value)} />
            <Input type="password" placeholder={t("access.passwordRepeat")} value={exportRepeat} onChange={(e) => setExportRepeat(e.target.value)} />
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              className="gap-2"
              disabled={exportState.busy}
              onClick={() =>
                void (async () => {
                  if (exportPass.length < MIN_PASSWORD) {
                    return setExportState({ busy: false, ok: false, message: t("access.passwordTooShort", { n: MIN_PASSWORD }) })
                  }
                  if (exportPass !== exportRepeat) return setExportState({ busy: false, ok: false, message: t("access.passwordsDiffer") })
                  setExportState({ busy: true, ok: false, message: "" })
                  try {
                    const path = await onExport(exportPass)
                    setExportPass("")
                    setExportRepeat("")
                    setExportState({ busy: false, ok: Boolean(path), message: path ? t("security.exported", { path }) : "" })
                  } catch (e) {
                    setExportState({ busy: false, ok: false, message: describeError(e).text })
                  }
                })()
              }
            >
              {exportState.busy ? <Spinner className="h-4 w-4" /> : <FileKey className="h-4 w-4" />}
              {t("security.exportButton")}
            </Button>
            {exportState.message ? (
              <span className={cn("text-xs", exportState.ok ? "text-accent" : "text-destructive")}>{exportState.message}</span>
            ) : null}
          </div>
        </section>
      ) : null}

      {info.hasPassword ? (
        <section className="space-y-3">
          <Label>{t("security.changePassword")}</Label>
          <Input type="password" placeholder={t("security.currentPassword")} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input type="password" placeholder={t("security.newPassword")} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
            <Input type="password" placeholder={t("access.passwordRepeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
          </div>
          <div className="flex items-center gap-3">
            <Button
              disabled={pwState.busy || !current || !next}
              onClick={() =>
                void (async () => {
                  if (next.length < MIN_PASSWORD) {
                    return setPwState({ busy: false, ok: false, message: t("access.passwordTooShort", { n: MIN_PASSWORD }) })
                  }
                  if (next !== repeat) return setPwState({ busy: false, ok: false, message: t("access.passwordsDiffer") })
                  setPwState({ busy: true, ok: false, message: "" })
                  try {
                    await onChangePassword(current, next)
                    setCurrent("")
                    setNext("")
                    setRepeat("")
                    setPwState({ busy: false, ok: true, message: t("security.passwordChanged") })
                  } catch (e) {
                    setPwState({ busy: false, ok: false, message: describeError(e).text })
                  }
                })()
              }
            >
              {pwState.busy ? <Spinner className="h-4 w-4" /> : t("security.changePasswordButton")}
            </Button>
            {pwState.message ? (
              <span className={cn("text-xs", pwState.ok ? "text-accent" : "text-destructive")}>{pwState.message}</span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}

/** Admin: minimum protection level a member needs to enter the server. */
export function ServerSecurityPolicy({
  load,
  save,
  describeError
}: {
  load: () => Promise<{ minAuthLevel: number }>
  save: (minAuthLevel: number) => Promise<void>
  describeError: (error: unknown) => { text: string }
}) {
  const { t } = useI18n()
  const [value, setValue] = useState<number | null>(null)
  const [saved, setSaved] = useState<number | null>(null)
  const [state, setState] = useState<{ busy: boolean; message: string; ok: boolean }>({ busy: false, message: "", ok: false })

  // Load once on open; `load` is a new function on every parent render.
  const loadRef = useRef(load)
  const describeErrorRef = useRef(describeError)
  useEffect(() => {
    loadRef.current = load
    describeErrorRef.current = describeError
  })
  useEffect(() => {
    void loadRef
      .current()
      .then((p) => {
        setValue(p.minAuthLevel)
        setSaved(p.minAuthLevel)
      })
      .catch((e) => setState({ busy: false, ok: false, message: describeErrorRef.current(e).text }))
  }, [])

  if (value === null) return state.message ? <p className="text-sm text-destructive">{state.message}</p> : <Spinner className="h-5 w-5" />

  return (
    <div className="space-y-2 rounded-lg border border-border p-4">
      <Label className="text-sm">{t("levels.policyTitle")}</Label>
      <p className="text-xs text-muted-foreground">{t("levels.policyHint")}</p>
      <select
        className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm"
        value={value}
        onChange={(e) => setValue(Number(e.target.value))}
      >
        <option value={0}>{t("levels.policyNone")}</option>
        {AUTH_MODES_BY_LEVEL.map((mode) => (
          <option key={mode} value={authLevel(mode)}>
            {t("levels.policyAtLeast", { level: authLevel(mode), name: t(`levels.${mode}`) })}
          </option>
        ))}
      </select>
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          disabled={state.busy || value === saved}
          onClick={() =>
            void (async () => {
              setState({ busy: true, ok: false, message: "" })
              try {
                await save(value)
                setSaved(value)
                setState({ busy: false, ok: true, message: t("levels.policySaved") })
              } catch (e) {
                setState({ busy: false, ok: false, message: describeError(e).text })
              }
            })()
          }
        >
          {state.busy ? <Spinner className="h-4 w-4" /> : t("common.save")}
        </Button>
        {state.message ? <span className={cn("text-xs", state.ok ? "text-accent" : "text-destructive")}>{state.message}</span> : null}
      </div>
    </div>
  )
}

/** Admin view: inspect and revoke another member's certificates, or reset their access. */
export function MemberSecurityAdmin({
  members,
  load,
  onRevoke,
  onReset,
  describeError
}: {
  members: Array<{ id: string; name: string }>
  load: (clientId: string) => Promise<SecurityInfo>
  onRevoke: (clientId: string, certId: string) => Promise<void>
  onReset: (clientId: string) => Promise<void>
  describeError: (error: unknown) => { text: string }
}) {
  const { t } = useI18n()
  const [selected, setSelected] = useState<string>("")
  const [info, setInfo] = useState<SecurityInfo | null>(null)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)

  const open = async (clientId: string) => {
    setSelected(clientId)
    setInfo(null)
    setMessage("")
    setConfirmReset(false)
    if (!clientId) return
    setLoading(true)
    try {
      setInfo(await load(clientId))
    } catch (e) {
      setMessage(describeError(e).text)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t("adminSecurity.intro")}</p>
      <select
        className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm"
        value={selected}
        onChange={(e) => void open(e.target.value)}
      >
        <option value="">{t("adminSecurity.pickMember")}</option>
        {members.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
          </option>
        ))}
      </select>
      {loading ? <Spinner className="h-5 w-5" /> : null}
      {message ? <p className="text-sm text-destructive">{message}</p> : null}
      {info ? (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {info.protected && info.authMode
              ? t("adminSecurity.protected", {
                  nick: info.nick ?? "",
                  level: authLevel(info.authMode),
                  name: t(`levels.${info.authMode}`)
                })
              : t("adminSecurity.notProtected")}
          </p>
          <CertificateList
            certificates={info.certificates}
            currentCertId={null}
            onRevoke={async (certId) => {
              try {
                await onRevoke(selected, certId)
                await open(selected)
              } catch (e) {
                setMessage(describeError(e).text)
              }
            }}
          />
          {info.protected ? (
            confirmReset ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
                <span className="flex-1">{t("adminSecurity.resetConfirm")}</span>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() =>
                    void (async () => {
                      try {
                        await onReset(selected)
                        await open(selected)
                      } catch (e) {
                        setMessage(describeError(e).text)
                      }
                    })()
                  }
                >
                  {t("adminSecurity.reset")}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                  {t("access.cancel")}
                </Button>
              </div>
            ) : (
              <Button variant="outline" size="sm" onClick={() => setConfirmReset(true)}>
                {t("adminSecurity.reset")}
              </Button>
            )
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
