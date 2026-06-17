"use client"

import { Server, Wifi, WifiOff } from "lucide-react"
import { useI18n } from "@/lib/i18n/provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Spinner } from "@/components/ui/spinner"

type ConnectServerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectServerListName: string
  onConnectServerListNameChange: (value: string) => void
  apiHost: string
  onApiHostChange: (value: string) => void
  apiPort: string
  onApiPortChange: (value: string) => void
  apiUseHttps: boolean
  onApiUseHttpsChange: (value: boolean) => void
  udpPortOverride: string
  onUdpPortOverrideChange: (value: string) => void
  mediaEngine: "legacy" | "webrtc"
  onMediaEngineChange: (value: "legacy" | "webrtc") => void
  voiceTransport: "udp" | "tcp"
  onVoiceTransportChange: (value: "udp" | "tcp") => void
  serverPassword: string
  onServerPasswordChange: (value: string) => void
  displayNameInput: string
  onDisplayNameChange: (value: string) => void
  superuserPasswordInput: string
  onSuperuserPasswordChange: (value: string) => void
  profileDisplayName: string
  onProfileDisplayNameChange: (value: string) => void
  onSaveProfile: () => void
  activeServerId: string
  canManageServer: boolean
  onOpenServerSettings: () => void
  onConnect: () => void
  joining: boolean
  connectedToApi: boolean
  wsConnected: boolean
  wsReconnecting: boolean
  hasDesktopBridge: boolean
  error: string
}

export function ConnectServerDialog(props: ConnectServerDialogProps) {
  const {
    open,
    onOpenChange,
    connectServerListName,
    onConnectServerListNameChange,
    apiHost,
    onApiHostChange,
    apiPort,
    onApiPortChange,
    apiUseHttps,
    onApiUseHttpsChange,
    udpPortOverride,
    onUdpPortOverrideChange,
    mediaEngine,
    onMediaEngineChange,
    voiceTransport,
    onVoiceTransportChange,
    serverPassword,
    onServerPasswordChange,
    displayNameInput,
    onDisplayNameChange,
    superuserPasswordInput,
    onSuperuserPasswordChange,
    profileDisplayName,
    onProfileDisplayNameChange,
    onSaveProfile,
    activeServerId,
    canManageServer,
    onOpenServerSettings,
    onConnect,
    joining,
    connectedToApi,
    wsConnected,
    wsReconnecting,
    hasDesktopBridge,
    error
  } = props

  const { t } = useI18n()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <DialogTitle>{t("connect.title")}</DialogTitle>
          </div>
          <DialogDescription>{t("connect.description")}</DialogDescription>
        </DialogHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-6 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="connect-list-name">{t("connect.nameInList")}</Label>
              <Input
                id="connect-list-name"
                className="h-9"
                value={connectServerListName}
                onChange={(e) => onConnectServerListNameChange(e.target.value)}
                placeholder={t("connect.namePlaceholder")}
              />
              <p className="text-[11px] text-muted-foreground">{t("connect.nameHint")}</p>
            </div>

            <div className="grid grid-cols-[1fr_5.5rem] gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="connect-host">{t("connect.host")}</Label>
                <Input id="connect-host" className="h-9" value={apiHost} onChange={(e) => onApiHostChange(e.target.value)} placeholder="localhost" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="connect-port">{t("connect.port")}</Label>
                <Input id="connect-port" className="h-9" value={apiPort} onChange={(e) => onApiPortChange(e.target.value)} placeholder="18080" />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>{t("connect.apiWs")}</Label>
              <Select value={apiUseHttps ? "https" : "http"} onValueChange={(v) => onApiUseHttpsChange(v === "https")}>
                <SelectTrigger className="h-9 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">{t("connect.httpWs")}</SelectItem>
                  <SelectItem value="https">{t("connect.httpsWss")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="connect-udp">{t("connect.voiceUdpPort")}</Label>
              <Input
                id="connect-udp"
                className="h-9"
                value={udpPortOverride}
                onChange={(e) => onUdpPortOverrideChange(e.target.value)}
                placeholder={t("connect.voiceUdpPlaceholder")}
                inputMode="numeric"
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>{t("connect.mediaEngine")}</Label>
                <Select value={mediaEngine} onValueChange={(v) => onMediaEngineChange(v === "webrtc" ? "webrtc" : "legacy")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="legacy">{t("connect.legacyUdp")}</SelectItem>
                    <SelectItem value="webrtc">{t("connect.webrtcLivekit")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t("connect.voiceTransport")}</Label>
                <Select value={voiceTransport} onValueChange={(v) => onVoiceTransportChange(v === "tcp" ? "tcp" : "udp")}>
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="udp">UDP</SelectItem>
                    <SelectItem value="tcp">{t("connect.tcpFallback")}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="connect-password">{t("connect.password")}</Label>
                <Input
                  id="connect-password"
                  className="h-9"
                  type="password"
                  value={serverPassword}
                  onChange={(e) => onServerPasswordChange(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="connect-nickname">{t("connect.nickname")}</Label>
                <Input id="connect-nickname" className="h-9" value={displayNameInput} onChange={(e) => onDisplayNameChange(e.target.value)} />
              </div>
            </div>

            <details className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                {t("common.advanced")}
              </summary>
              <div className="mt-3 space-y-3 pb-1">
                <div className="space-y-1.5">
                  <Label htmlFor="connect-superuser">{t("connect.superuserPassword")}</Label>
                  <Input
                    id="connect-superuser"
                    className="h-9"
                    type="password"
                    value={superuserPasswordInput}
                    onChange={(e) => onSuperuserPasswordChange(e.target.value)}
                    placeholder={t("connect.superuserPlaceholder")}
                  />
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Label htmlFor="connect-profile-name">{t("connect.displayNameOnServer")}</Label>
                    <Input id="connect-profile-name" className="h-9" value={profileDisplayName} onChange={(e) => onProfileDisplayNameChange(e.target.value)} />
                  </div>
                  <Button variant="outline" size="sm" className="shrink-0" onClick={onSaveProfile} disabled={!activeServerId}>
                    {t("connect.saveProfile")}
                  </Button>
                </div>
                {activeServerId && canManageServer ? (
                  <Button variant="outline" size="sm" className="w-full" onClick={onOpenServerSettings}>
                    {t("connect.serverSettings")}
                  </Button>
                ) : null}
              </div>
            </details>
          </div>
        </ScrollArea>

        <div className="shrink-0 space-y-3 border-t border-border bg-card px-6 py-4">
          <Button className="w-full" onClick={onConnect} disabled={joining}>
            {joining ? (
              <>
                <Spinner className="mr-2" /> {t("common.connecting")}
              </>
            ) : (
              t("common.connect")
            )}
          </Button>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              {connectedToApi ? <Wifi className="h-3 w-3 text-accent" /> : <WifiOff className="h-3 w-3" />}
              API {connectedToApi ? t("connect.apiOk") : t("connect.apiOffline")}
            </span>
            <span>
              WS{" "}
              {wsConnected
                ? t("connect.wsConnected")
                : wsReconnecting
                  ? t("connect.wsReconnecting")
                  : t("connect.wsDisconnected")}
            </span>
          </div>
          {!hasDesktopBridge ? <p className="text-xs text-destructive">{t("connect.noDesktopBridge")}</p> : null}
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
