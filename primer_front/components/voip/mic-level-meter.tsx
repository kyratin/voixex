"use client"

import { cn } from "@/lib/utils"
import { useI18n } from "@/lib/i18n/provider"

export type MicLevelMeterSample = {
  inputPeak: number
  inputRms: number
  txPeak: number
  txRms: number
  gateZone: "off" | "mute" | "duck" | "open"
}

type MicLevelMeterProps = {
  sample: MicLevelMeterSample | null
  gateEnabled: boolean
  gateMuteThreshold: number
  gateOpenThreshold: number
  maxPeak?: number
  active?: boolean
  className?: string
}

const MAX_PEAK = 4000

const ZONE_LABEL_KEY: Record<MicLevelMeterSample["gateZone"], string> = {
  off: "meter.zoneOff",
  mute: "meter.zoneSilence",
  duck: "meter.zoneReduced",
  open: "meter.zoneFull"
}

const ZONE_CLASS: Record<MicLevelMeterSample["gateZone"], string> = {
  off: "text-muted-foreground",
  mute: "text-zinc-400",
  duck: "text-amber-500",
  open: "text-emerald-500"
}

function peakToPct(peak: number, maxPeak: number) {
  return Math.max(0, Math.min(100, (peak / maxPeak) * 100))
}

function peakToDb(peak: number) {
  if (peak <= 1) return "-∞"
  const db = 20 * Math.log10(peak / 32768)
  return `${db.toFixed(1)} dBFS`
}

function rmsToDb(rms: number) {
  if (rms <= 0.00001) return "-∞"
  const db = 20 * Math.log10(rms)
  return `${db.toFixed(1)} dBFS`
}

export function MicLevelMeter({
  sample,
  gateEnabled,
  gateMuteThreshold,
  gateOpenThreshold,
  maxPeak = MAX_PEAK,
  active = true,
  className
}: MicLevelMeterProps) {
  const { t } = useI18n()
  const inputPct = peakToPct(sample?.inputPeak ?? 0, maxPeak)
  const txPct = peakToPct(sample?.txPeak ?? 0, maxPeak)
  const mutePct = peakToPct(gateMuteThreshold, maxPeak)
  const openPct = peakToPct(gateOpenThreshold, maxPeak)
  const zone = sample?.gateZone ?? "off"

  return (
    <div className={cn("space-y-3", className)}>
      {!active ? (
        <p className="text-xs text-muted-foreground">{t("meter.joinToSee")}</p>
      ) : null}

      <div className="grid grid-cols-2 gap-3 text-xs tabular-nums text-muted-foreground">
        <div>
          <div className="font-medium text-foreground">{t("meter.input")}</div>
          <div>{t("meter.peak")} {sample ? Math.round(sample.inputPeak) : 0}</div>
          <div>{sample ? peakToDb(sample.inputPeak) : "-∞ dBFS"}</div>
          <div>RMS {sample ? rmsToDb(sample.inputRms) : "-∞ dBFS"}</div>
        </div>
        <div>
          <div className="font-medium text-foreground">{t("meter.transmit")}</div>
          <div>{t("meter.peak")} {sample ? Math.round(sample.txPeak) : 0}</div>
          <div>{sample ? peakToDb(sample.txPeak) : "-∞ dBFS"}</div>
          <div className={cn("font-medium capitalize", ZONE_CLASS[zone])}>
            {t("meter.zone", { zone: t(ZONE_LABEL_KEY[gateEnabled ? zone : "off"]) })}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{t("meter.inputLevel")}</span>
          <span>{Math.round(inputPct)}%</span>
        </div>
        <MeterBar
          fillPct={inputPct}
          markers={
            gateEnabled
              ? [
                  { pct: mutePct, label: t("meter.mute"), className: "bg-sky-300" },
                  { pct: openPct, label: t("meter.open"), className: "bg-emerald-400" }
                ]
              : []
          }
          variant="input"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>{t("meter.sentToVoice")}</span>
          <span>{Math.round(txPct)}%</span>
        </div>
        <MeterBar fillPct={txPct} markers={[]} variant="tx" />
      </div>

      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {gateEnabled ? (
          <>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-0.5 bg-sky-300" /> {t("meter.mute")} ({gateMuteThreshold})
            </span>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-0.5 bg-emerald-400" /> {t("meter.open")} ({gateOpenThreshold})
            </span>
          </>
        ) : null}
      </div>
    </div>
  )
}

function MeterBar({
  fillPct,
  markers,
  variant
}: {
  fillPct: number
  markers: Array<{ pct: number; label: string; className: string }>
  variant: "input" | "tx"
}) {
  const { t } = useI18n()
  return (
    <div className="relative h-8 overflow-hidden rounded-md border border-border bg-gradient-to-r from-zinc-900 via-zinc-900 to-zinc-950">
      <div className="absolute inset-0 opacity-40">
        {Array.from({ length: 20 }).map((_, i) => (
          <div
            key={i}
            className="absolute top-0 bottom-0 w-px bg-white/10"
            style={{ left: `${(i + 1) * 5}%` }}
          />
        ))}
      </div>
      <div
        className={cn(
          "absolute inset-y-0 left-0 transition-[width] duration-75 ease-out",
          variant === "input"
            ? "bg-gradient-to-r from-emerald-600 via-lime-500 to-amber-400"
            : "bg-gradient-to-r from-cyan-600 via-sky-500 to-violet-400"
        )}
        style={{ width: `${fillPct}%` }}
      />
      {markers.map((m) => (
        <div
          key={m.label}
          className={cn("absolute top-0 bottom-0 w-0.5 shadow-[0_0_6px_rgba(255,255,255,0.35)]", m.className)}
          style={{ left: `calc(${m.pct}% - 1px)` }}
          title={t("meter.threshold", { label: m.label })}
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-t from-black/25 to-transparent pointer-events-none" />
    </div>
  )
}
