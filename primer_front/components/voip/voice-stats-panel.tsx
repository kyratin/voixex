"use client"

import { BarChart3 } from "lucide-react"
import { Separator } from "@/components/ui/separator"

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
  if (!voiceStats) {
    return <p className="text-sm text-muted-foreground">No stats yet. Join a voice channel.</p>
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <BarChart3 className={`h-4 w-4 shrink-0 ${qualityClass}`} />
        <span className={`text-sm font-semibold ${qualityClass}`}>Voice connection</span>
      </div>
      <div className="space-y-1.5 text-xs text-muted-foreground">
        <div className="flex justify-between gap-4">
          <span>Status</span>
          <span className="text-right">
            {voiceStats.connected ? "Connected" : "Disconnected"}
            {isSpeakingNow ? " · Speaking" : ""}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span>TX / RX</span>
          <span className="tabular-nums">{voiceStats.txPackets ?? 0} / {voiceStats.rxPackets ?? 0}</span>
        </div>
        <div className="flex justify-between gap-4">
          <span>Loss</span>
          <span className="tabular-nums">
            {voiceStats.rxLostEstimated ?? 0} ({voiceStats.packetLossPct ?? 0}%)
          </span>
        </div>
        <Separator />
        <div className={`flex justify-between gap-4 ${qualityClass}`}>
          <span>Ping</span>
          <span className="text-right tabular-nums">
            {voiceStats.pingNowMs ?? 0}ms · p1 {voiceStats.ping1PctMs ?? 0}ms · p0.1 {voiceStats.ping01PctMs ?? 0}ms
          </span>
        </div>
        <div className={`flex justify-between gap-4 ${qualityClass}`}>
          <span>Jitter</span>
          <span className="text-right tabular-nums">
            {voiceStats.jitterNowMs ?? 0}ms · p1 {voiceStats.jitter1PctMs ?? 0}ms · p0.1 {voiceStats.jitter01PctMs ?? 0}ms
          </span>
        </div>
        {audioPipelineDiag ? (
          <>
            <Separator />
            <div className="flex justify-between gap-4">
              <span>Capture SR</span>
              <span className="tabular-nums">{Math.round(audioPipelineDiag.captureSampleRate)} Hz</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Playback SR</span>
              <span className="tabular-nums">{Math.round(audioPipelineDiag.playbackSampleRate)} Hz</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Playout buffer</span>
              <span className="tabular-nums">{audioPipelineDiag.playoutBufferedSamples} samples</span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Underruns</span>
              <span className="tabular-nums" title="Empty-buffer events per ~1s">
                {audioPipelineDiag.playoutUnderruns}
              </span>
            </div>
            <div className="flex justify-between gap-4">
              <span>Overflow drops</span>
              <span className="tabular-nums">{audioPipelineDiag.playoutOverflowDrops}</span>
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
