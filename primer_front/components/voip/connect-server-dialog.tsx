"use client"

import { useEffect, useState } from "react"
import { Server } from "lucide-react"
import { useI18n } from "@/lib/i18n/provider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

/** Connection settings of a saved server; passwords and nick are asked for when signing in. */
export type ConnectionDraft = {
  serverName: string
  apiHost: string
  apiPort: string
  apiUseHttps: boolean
  udpPortOverride: string
  mediaEngine: "legacy" | "webrtc"
  voiceTransport: "udp" | "tcp"
}

type ConnectServerDialogProps = {
  /** Draft to edit; null closes the dialog. */
  draft: ConnectionDraft | null
  onOpenChange: (open: boolean) => void
  onSave: (draft: ConnectionDraft) => void
}

export function ConnectServerDialog({ draft, onOpenChange, onSave }: ConnectServerDialogProps) {
  const { t } = useI18n()
  const [value, setValue] = useState<ConnectionDraft | null>(draft)

  useEffect(() => {
    setValue(draft)
  }, [draft])

  const set = <K extends keyof ConnectionDraft>(key: K, next: ConnectionDraft[K]) =>
    setValue((prev) => (prev ? { ...prev, [key]: next } : prev))

  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(90vh,760px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-6 pb-2 pt-5">
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <DialogTitle>{t("connect.editTitle")}</DialogTitle>
          </div>
          <DialogDescription>{t("connect.editDescription")}</DialogDescription>
        </DialogHeader>

        {value ? (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="space-y-4 px-6 py-3">
              <div className="grid grid-cols-[1fr_5.5rem] gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="connect-host">{t("connect.host")}</Label>
                  <Input id="connect-host" className="h-9" value={value.apiHost} onChange={(e) => set("apiHost", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="connect-port">{t("connect.port")}</Label>
                  <Input id="connect-port" className="h-9" value={value.apiPort} onChange={(e) => set("apiPort", e.target.value)} />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{t("connect.apiWs")}</Label>
                <Select value={value.apiUseHttps ? "https" : "http"} onValueChange={(v) => set("apiUseHttps", v === "https")}>
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
                  value={value.udpPortOverride}
                  onChange={(e) => set("udpPortOverride", e.target.value)}
                  placeholder={t("connect.voiceUdpPlaceholder")}
                  inputMode="numeric"
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{t("connect.mediaEngine")}</Label>
                  <Select value={value.mediaEngine} onValueChange={(v) => set("mediaEngine", v === "webrtc" ? "webrtc" : "legacy")}>
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
                  <Select value={value.voiceTransport} onValueChange={(v) => set("voiceTransport", v === "tcp" ? "tcp" : "udp")}>
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
            </div>
          </div>
        ) : null}

        <div className="flex shrink-0 justify-end gap-2 px-6 pb-5 pt-3">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("access.cancel")}
          </Button>
          <Button onClick={() => value && onSave(value)} disabled={!value?.apiHost.trim()}>
            {t("common.save")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
