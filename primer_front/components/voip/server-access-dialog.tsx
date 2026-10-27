"use client"

import { useEffect, useState } from "react"
import { FileKey, KeyRound, Lock, LockOpen, ShieldCheck } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { AUTH_MODES_BY_LEVEL, authLevel, modeNeedsPassword, type AuthMode } from "@/lib/voip-client"
import { useI18n } from "@/lib/i18n/provider"

export type ServerAddress = { apiHost: string; apiPort: string; apiUseHttps: boolean }

export type AccessMode =
  | { kind: "add" }
  | { kind: "import" }
  | { kind: "login"; serverId: string; label: string; authMode: AuthMode; secure: boolean }
  | { kind: "claim"; serverId: string; label: string; nick: string; secure: boolean }
  | {
      kind: "upgrade"
      serverId: string
      label: string
      minLevel: number
      currentMode: AuthMode
      secure: boolean
    }

export type RegisterInput = ServerAddress & {
  label: string
  serverPassword: string
  nick: string
  authMode: AuthMode
  password: string
}
export type ImportInput = Partial<ServerAddress> & {
  label: string
  file: { path: string; contents: string }
  filePassphrase: string
  nick: string
  password: string
}
export type LoginInput = { nick: string; password: string; superuserPassword: string }
export type ClaimInput = { nick: string; authMode: AuthMode; password: string }
export type UpgradeInput = { authMode: AuthMode; newPassword: string }
export type DescribedError = { text: string; code?: string; details?: Record<string, unknown> }

interface ServerAccessDialogProps {
  mode: AccessMode | null
  onOpenChange: (open: boolean) => void
  defaultAddress: ServerAddress
  onRegister: (input: RegisterInput) => Promise<void>
  onImport: (input: ImportInput) => Promise<void>
  onLogin: (input: LoginInput) => Promise<void>
  onClaim: (input: ClaimInput) => Promise<void>
  onUpgrade: (input: UpgradeInput) => Promise<void>
  /** Server predates protected profiles: join with the shared password only. */
  onLegacyJoin: (input: { address?: ServerAddress; label?: string; serverPassword?: string; nick?: string }) => Promise<void>
  pickCertificateFile: () => Promise<{ path: string; contents: string } | null>
  describeError: (error: unknown) => DescribedError
  hasDesktopBridge: boolean
}

const MIN_PASSWORD = 8

/** HTTPS vs plain HTTP: the server's own protection level, independent of the profile. */
export function ConnectionSecurityBadge({ secure, className }: { secure: boolean; className?: string }) {
  const { t } = useI18n()
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        secure ? "bg-accent/15 text-accent" : "bg-amber-400/15 text-amber-400",
        className
      )}
    >
      {secure ? <Lock className="h-3 w-3" /> : <LockOpen className="h-3 w-3" />}
      {secure ? t("levels.httpsShort") : t("levels.httpShort")}
    </span>
  )
}

/** The three protection levels a member can choose; levels below `minLevel` are disabled. */
export function ProtectionLevelPicker({
  value,
  onChange,
  minLevel = 0
}: {
  value: AuthMode
  onChange: (mode: AuthMode) => void
  minLevel?: number
}) {
  const { t } = useI18n()
  return (
    <div className="space-y-2" role="radiogroup">
      {AUTH_MODES_BY_LEVEL.map((mode) => {
        const level = authLevel(mode)
        const disabled = level < minLevel
        const selected = value === mode
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(mode)}
            className={cn(
              "flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors",
              selected ? "border-primary bg-primary/10" : "border-transparent bg-secondary/60 hover:bg-secondary",
              disabled && "cursor-not-allowed opacity-40 hover:bg-secondary/60"
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
                selected ? "bg-primary text-primary-foreground" : "bg-sidebar-accent text-muted-foreground"
              )}
            >
              {level}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-foreground">{t(`levels.${mode}`)}</span>
              <span className="block text-xs text-muted-foreground">{t(`levels.${mode}Hint`)}</span>
              {disabled ? <span className="block text-xs text-amber-400">{t("levels.belowServerMinimum")}</span> : null}
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function ServerAccessDialog({
  mode,
  onOpenChange,
  defaultAddress,
  onRegister,
  onImport,
  onLogin,
  onClaim,
  onUpgrade,
  onLegacyJoin,
  pickCertificateFile,
  describeError,
  hasDesktopBridge
}: ServerAccessDialogProps) {
  const { t } = useI18n()
  const [address, setAddress] = useState<ServerAddress>(defaultAddress)
  const [label, setLabel] = useState("")
  const [serverPassword, setServerPassword] = useState("")
  const [nick, setNick] = useState("")
  const [password, setPassword] = useState("")
  const [passwordRepeat, setPasswordRepeat] = useState("")
  const [superuserPassword, setSuperuserPassword] = useState("")
  const [file, setFile] = useState<{ path: string; contents: string } | null>(null)
  const [filePassphrase, setFilePassphrase] = useState("")
  const [addTab, setAddTab] = useState<"new" | "certificate">("new")
  const [step, setStep] = useState<"server" | "protection">("server")
  const [level, setLevel] = useState<AuthMode>("password_certificate")
  const [minLevel, setMinLevel] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<DescribedError | null>(null)

  const open = mode !== null
  const kind = mode?.kind
  useEffect(() => {
    if (!mode) return
    setAddress(defaultAddress)
    setLabel("")
    setServerPassword("")
    setNick(mode.kind === "claim" ? mode.nick : "")
    setPassword("")
    setPasswordRepeat("")
    setSuperuserPassword("")
    setFile(null)
    setFilePassphrase("")
    setAddTab(mode.kind === "import" ? "certificate" : "new")
    setStep("server")
    setMinLevel(mode.kind === "upgrade" ? mode.minLevel : 0)
    setLevel(mode.kind === "upgrade" && mode.minLevel >= 3 ? "password_certificate" : "password_certificate")
    setError(null)
    setBusy(false)
    // Reset only when the dialog opens for a different purpose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  const secure =
    mode && "secure" in mode ? mode.secure : kind === "add" || kind === "import" ? address.apiUseHttps : true

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      const described = describeError(e)
      if (described.code === "levelTooLow" && typeof described.details?.minLevel === "number") {
        const min = described.details.minLevel
        setMinLevel(min)
        if (authLevel(level) < min) setLevel(AUTH_MODES_BY_LEVEL[Math.min(min, 3) - 1])
        if (kind === "add") setStep("protection")
      }
      if (described.code === "invalidServerPassword" || described.code === "nickTaken" || described.code === "invalidNick") {
        if (kind === "add") setStep("server")
      }
      setError(described)
    } finally {
      setBusy(false)
    }
  }

  const checkNewPassword = () => {
    if (password.length < MIN_PASSWORD) return t("access.passwordTooShort", { n: MIN_PASSWORD })
    if (password !== passwordRepeat) return t("access.passwordsDiffer")
    return null
  }

  const checkNick = () => {
    const n = nick.trim()
    if (n.length < 2 || n.length > 32) return t("access.nickLength")
    return null
  }

  /** Level 1 and 3 need a new password; level 2 none. On upgrade only if there is none yet. */
  const needsNewPassword = (target: AuthMode) => {
    if (!modeNeedsPassword(target)) return false
    if (mode?.kind === "upgrade") return !modeNeedsPassword(mode.currentMode)
    return true
  }

  const submit = () => {
    if (!mode) return
    if (mode.kind === "login") {
      if (modeNeedsPassword(mode.authMode) && (!nick.trim() || !password)) {
        return setError({ text: t("access.fillNickPassword") })
      }
      return void run(() => onLogin({ nick: nick.trim(), password, superuserPassword }))
    }
    if (mode.kind === "claim") {
      const problem = checkNick() ?? (needsNewPassword(level) ? checkNewPassword() : null)
      if (problem) return setError({ text: problem })
      return void run(() => onClaim({ nick: nick.trim(), authMode: level, password }))
    }
    if (mode.kind === "upgrade") {
      if (authLevel(level) < mode.minLevel) return setError({ text: t("levels.belowServerMinimum") })
      const problem = needsNewPassword(level) ? checkNewPassword() : null
      if (problem) return setError({ text: problem })
      return void run(() => onUpgrade({ authMode: level, newPassword: needsNewPassword(level) ? password : "" }))
    }
    if (addTab === "new") {
      if (step === "server") {
        if (!address.apiHost.trim()) return setError({ text: t("access.fillAddress") })
        if (!serverPassword) return setError({ text: t("access.fillServerPassword") })
        const problem = checkNick()
        if (problem) return setError({ text: problem })
        setError(null)
        return setStep("protection")
      }
      const problem = needsNewPassword(level) ? checkNewPassword() : null
      if (problem) return setError({ text: problem })
      return void run(() =>
        onRegister({
          ...address,
          apiHost: address.apiHost.trim(),
          label: label.trim(),
          serverPassword,
          nick: nick.trim(),
          authMode: level,
          password: needsNewPassword(level) ? password : ""
        })
      )
    }
    if (!file) return setError({ text: t("access.pickFileFirst") })
    if (!filePassphrase) return setError({ text: t("access.fillFilePassphrase") })
    return void run(() =>
      onImport({
        ...(address.apiHost.trim() ? { ...address, apiHost: address.apiHost.trim() } : {}),
        label: label.trim(),
        file,
        filePassphrase,
        nick: nick.trim(),
        password
      })
    )
  }

  const legacyFallback =
    error?.code === "authNotSupported" ? (
      <div className="space-y-2 rounded-lg bg-secondary/60 p-3 text-xs text-muted-foreground">
        <p>{t("access.oldServer")}</p>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() =>
            void run(() =>
              onLegacyJoin(
                kind === "add" ? { address, label: label.trim(), serverPassword, nick: nick.trim() } : { nick: nick.trim() }
              )
            )
          }
        >
          {t("access.legacyJoin")}
        </Button>
      </div>
    ) : null

  const serverLabel = mode && "label" in mode ? mode.label : ""
  const title =
    kind === "login"
      ? t("access.loginTitle", { server: serverLabel })
      : kind === "claim"
        ? t("access.claimTitle", { server: serverLabel })
        : kind === "upgrade"
          ? t("access.upgradeTitle", { server: serverLabel })
          : t("access.addTitle")
  const description =
    kind === "login"
      ? mode && mode.kind === "login" && !modeNeedsPassword(mode.authMode)
        ? t("access.loginCertificateDescription")
        : t("access.loginDescription")
      : kind === "claim"
        ? t("access.claimDescription")
        : kind === "upgrade"
          ? t("access.upgradeDescription", { level: mode && mode.kind === "upgrade" ? mode.minLevel : 0 })
          : step === "protection" && addTab === "new"
            ? t("access.protectionDescription")
            : t("access.addDescription")

  const addressFields = (optional: boolean) => (
    <div className="space-y-3">
      <div className="grid grid-cols-[1fr_5.5rem] gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="access-host">{optional ? t("access.hostOptional") : t("connect.host")}</Label>
          <Input
            id="access-host"
            value={address.apiHost}
            onChange={(e) => setAddress((a) => ({ ...a, apiHost: e.target.value }))}
            placeholder="voip.example.com"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="access-port">{t("connect.port")}</Label>
          <Input id="access-port" value={address.apiPort} onChange={(e) => setAddress((a) => ({ ...a, apiPort: e.target.value }))} />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>{t("connect.apiWs")}</Label>
          <Select
            value={address.apiUseHttps ? "https" : "http"}
            onValueChange={(v) => setAddress((a) => ({ ...a, apiUseHttps: v === "https" }))}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="https">{t("connect.httpsWss")}</SelectItem>
              <SelectItem value="http">{t("connect.httpWs")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="access-label">{t("access.label")}</Label>
          <Input id="access-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("access.labelPlaceholder")} />
        </div>
      </div>
    </div>
  )

  const nickField = (autoFocus: boolean, optional = false) => (
    <div className="space-y-1.5">
      <Label htmlFor="access-nick">{optional ? t("access.nickOptional") : t("access.nick")}</Label>
      <Input id="access-nick" value={nick} onChange={(e) => setNick(e.target.value)} autoComplete="off" autoFocus={autoFocus} maxLength={32} />
    </div>
  )

  const passwordField = (labelKey: string, optional = false) => (
    <div className="space-y-1.5">
      <Label htmlFor="access-password">{optional ? t("access.passwordOptional") : t(labelKey)}</Label>
      <Input
        id="access-password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        autoComplete="current-password"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit()
        }}
      />
    </div>
  )

  const newPasswordFields = (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="access-new-password">{t("access.password")}</Label>
        <Input id="access-new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="access-password-repeat">{t("access.passwordRepeat")}</Label>
        <Input
          id="access-password-repeat"
          type="password"
          value={passwordRepeat}
          onChange={(e) => setPasswordRepeat(e.target.value)}
          autoComplete="new-password"
        />
      </div>
    </div>
  )

  const httpWarning =
    !secure && modeNeedsPassword(level) && kind !== "login" ? (
      <p className="flex items-start gap-2 rounded-lg bg-amber-400/10 p-2.5 text-xs text-amber-400">
        <LockOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {t("levels.httpPasswordWarning")}
      </p>
    ) : null

  const protectionStep = (
    <div className="space-y-4">
      <ProtectionLevelPicker value={level} onChange={setLevel} minLevel={minLevel} />
      {needsNewPassword(level) ? newPasswordFields : null}
      {httpWarning}
    </div>
  )

  const advancedSuperuser = (
    <details className="rounded-lg bg-secondary/50 px-3 py-2">
      <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">{t("common.advanced")}</summary>
      <div className="mt-3 space-y-1.5 pb-1">
        <Label htmlFor="access-superuser">{t("connect.superuserPassword")}</Label>
        <Input
          id="access-superuser"
          type="password"
          value={superuserPassword}
          onChange={(e) => setSuperuserPassword(e.target.value)}
          placeholder={t("connect.superuserPlaceholder")}
        />
      </div>
    </details>
  )

  let body: React.ReactNode
  if (!hasDesktopBridge) {
    body = <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">{t("access.desktopOnly")}</p>
  } else if (mode?.kind === "login") {
    body = (
      <div className="space-y-3">
        {modeNeedsPassword(mode.authMode) ? (
          <>
            {nickField(true)}
            {passwordField("access.password")}
          </>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-accent" />
            {t("access.certificateOnlyReady")}
          </p>
        )}
        {advancedSuperuser}
      </div>
    )
  } else if (mode?.kind === "claim") {
    body = (
      <div className="space-y-4">
        {nickField(false)}
        {protectionStep}
      </div>
    )
  } else if (mode?.kind === "upgrade") {
    body = protectionStep
  } else {
    body = (
      <Tabs value={addTab} onValueChange={(v) => setAddTab(v as "new" | "certificate")} className="gap-4">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="new">{t("access.tabNew")}</TabsTrigger>
          <TabsTrigger value="certificate">{t("access.tabCertificate")}</TabsTrigger>
        </TabsList>
        <TabsContent value="new" className="mt-0 space-y-4">
          {step === "server" ? (
            <>
              {addressFields(false)}
              <div className="space-y-1.5">
                <Label htmlFor="access-server-password">{t("access.serverPassword")}</Label>
                <Input id="access-server-password" type="password" value={serverPassword} onChange={(e) => setServerPassword(e.target.value)} />
                <p className="text-[11px] text-muted-foreground">{t("access.serverPasswordHint")}</p>
              </div>
              {nickField(false)}
            </>
          ) : (
            protectionStep
          )}
        </TabsContent>
        <TabsContent value="certificate" className="mt-0 space-y-4">
          <div className="space-y-1.5">
            <Label>{t("access.certificateFile")}</Label>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                className="gap-2"
                onClick={() =>
                  void (async () => {
                    const picked = await pickCertificateFile()
                    if (picked) setFile(picked)
                  })()
                }
              >
                <FileKey className="h-4 w-4" />
                {t("access.pickFile")}
              </Button>
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {file ? file.path.split(/[\\/]/).pop() : t("access.noFile")}
              </span>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="access-file-pass">{t("access.filePassphrase")}</Label>
            <Input id="access-file-pass" type="password" value={filePassphrase} onChange={(e) => setFilePassphrase(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t("access.importNickHint")}</p>
          {nickField(false, true)}
          {passwordField("access.password", true)}
          <details className="rounded-lg bg-secondary/50 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
              {t("access.overrideAddress")}
            </summary>
            <div className="mt-3 pb-1">{addressFields(true)}</div>
          </details>
        </TabsContent>
      </Tabs>
    )
  }

  const submitLabel =
    kind === "login"
      ? t("access.signIn")
      : kind === "claim"
        ? t("access.protectAndSignIn")
        : kind === "upgrade"
          ? t("access.raiseAndSignIn")
          : addTab === "new"
            ? step === "server"
              ? t("access.next")
              : t("access.createAndSignIn")
            : t("access.importAndSignIn")

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="flex max-h-[min(90vh,780px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pb-2 pt-5">
          <div className="flex items-center gap-2">
            {kind === "claim" || kind === "upgrade" ? (
              <ShieldCheck className="h-5 w-5 text-primary" />
            ) : (
              <KeyRound className="h-5 w-5 text-primary" />
            )}
            <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
            {kind && kind !== "import" && !(kind === "add" && addTab === "certificate") ? <ConnectionSecurityBadge secure={secure} /> : null}
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
          {body}
          {error ? <p className="mt-3 text-sm text-destructive">{error.text}</p> : null}
          {legacyFallback ? <div className="mt-3">{legacyFallback}</div> : null}
        </div>

        <div className="flex shrink-0 justify-end gap-2 px-6 pb-5 pt-3">
          {kind === "add" && addTab === "new" && step === "protection" ? (
            <Button variant="ghost" onClick={() => setStep("server")} disabled={busy} className="mr-auto">
              {t("access.back")}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("access.cancel")}
          </Button>
          <Button onClick={submit} disabled={busy || !hasDesktopBridge} className="min-w-32">
            {busy ? <Spinner className="h-4 w-4" /> : submitLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
