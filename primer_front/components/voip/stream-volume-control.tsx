"use client"

import { useEffect, useRef, useState } from "react"
import { Volume2 } from "lucide-react"
import { Slider } from "@/components/ui/slider"

type StreamVolumeControlProps = {
  value: number
  onLiveChange: (pct: number) => void
  onCommit: (pct: number) => void
}

export function StreamVolumeControl({ value, onLiveChange, onCommit }: StreamVolumeControlProps) {
  const [local, setLocal] = useState(value)
  const localRef = useRef(value)

  useEffect(() => {
    setLocal(value)
    localRef.current = value
  }, [value])

  const applyLocal = (raw: number) => {
    const next = Math.max(0, Math.min(200, Math.round(raw)))
    localRef.current = next
    setLocal(next)
    onLiveChange(next)
  }

  const commit = () => {
    onCommit(localRef.current)
  }

  return (
    <div
      className="flex w-full max-w-md shrink-0 flex-col gap-2 px-2"
      onPointerUp={commit}
      onPointerLeave={commit}
    >
      <div className="flex items-center gap-3">
        <Volume2 className="h-4 w-4 shrink-0 text-muted-foreground" />
        <Slider
          value={[local]}
          min={0}
          max={200}
          step={1}
          className="flex-1"
          onValueChange={([v]) => applyLocal(Number.isFinite(v) ? v : 100)}
        />
        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{local}%</span>
      </div>
    </div>
  )
}
