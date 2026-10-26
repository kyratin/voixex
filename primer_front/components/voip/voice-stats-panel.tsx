"use client"

import { BarChart3 } from "lucide-react"
import { Separator } from "@/components/ui/separator"
import { useI18n } from "@/lib/i18n/provider"

export type VoiceStatsData = {
  connected?: boolean
  txPackets?: number
  rxPackets?: number
  rxLostEstimated?: number
  packetLossPct?: number
  pingNowMs?: number
  ping1PctMs?: number
  ping01PctMs?: number
  jitterNowMs?: number
  jitter1PctMs?: number
  jitter01PctMs?: number
}

export type AudioPipelineDiag = {
  captureSampleRate: number
  playbackSampleRate: number
  playoutBufferedSamples: number
  playoutUnderruns: number
  playoutOverflowDrops: number
}

type VoiceStatsPanelProps = {
  voiceStats: VoiceStatsData | null
  audioPipelineDiag: AudioPipelineDiag | null
  qualityClass: string
  isSpeakingNow: boolean
}

export function VoiceStatsPanel({ voiceStats, audioPipelineDiag, qualityClass, isSpeakingNow }: VoiceStatsPanelProps) {
  const { t } = useI18n()
  if (!voiceStats) {
    return <p className="text-sm text-muted-foreground">{t("stats.noStats")}</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <BarChart3 className={`h-4 w-4 shrink-0 ${qualityClass}`} />
        <span className={`text-sm font-semibold ${qualityClass}`}>{t("stats.title")}</span>
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <div className="flex justify-between gap-4">
          <span>{t("stats.status")}</span>
          <span className="text-right">
            {voiceStats.connected ? t("stats.connected") : t("stats.disconnected")}
            {isSpeakingNow ? ` · ${t("stats.speaking")}` : ""}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>TX / RX</span>
          <span className="tabular-nums">{voiceStats.txPackets ?? 0} / {voiceStats.rxPackets ?? 0}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>{t("stats.loss")}</span>
          <span className="tabular-nums">
            {voiceStats.rxLostEstimated ?? 0} ({voiceStats.packetLossPct ?? 0}%)
          </span>
        </div>
        <Separator />
        <div className={`flex justify-between gap-4 ${qualityClass}`}>
          <span>{t("stats.ping")}</span>
          <span className="text-right tabular-nums">
            {voiceStats.pingNowMs ?? 0}ms · p1 {voiceStats.ping1PctMs ?? 0}ms · p0.1 {voiceStats.ping01PctMs ?? 0}ms
          </span>
        </div>
        <div className={`flex justify-between gap-4 ${qualityClass}`}>
          <span>{t("stats.jitter")}</span>
          <span className="text-right tabular-nums">
            {voiceStats.jitterNowMs ?? 0}ms · p1 {voiceStats.jitter1PctMs ?? 0}ms · p0.1 {voiceStats.jitter01PctMs ?? 0}ms
          </span>
        </div>
        {audioPipelineDiag ? (
          <>
            <Separator />
            <div className="flex justify-between gap-4">
              <span>{t("stats.captureSr")}</span>
              <span className="tabular-nums">{Math.round(audioPipelineDiag.captureSampleRate)} Hz</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>{t("stats.playbackSr")}</span>
              <span className="tabular-nums">{Math.round(audioPipelineDiag.playbackSampleRate)} Hz</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>{t("stats.playoutBuffer")}</span>
              <span className="tabular-nums">{t("stats.samples", { n: audioPipelineDiag.playoutBufferedSamples })}</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>{t("stats.underruns")}</span>
              <span className="tabular-nums" title={t("stats.underrunsHint")}>
                {audioPipelineDiag.playoutUnderruns}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>{t("stats.overflowDrops")}</span>
              <span className="tabular-nums">{audioPipelineDiag.playoutOverflowDrops}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
