"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CameraAssembler, fragmentCamera } from "./protocol"
import type { VoipClient } from "../voip-client"
import type { WebRtcMediaSession } from "../webrtc-media"

export type CameraPicture = { stream?: MediaStream; image?: string }
export type CameraControls = {
  enabled: boolean
  busy: boolean
  supported: boolean
  error: string
  devices: MediaDeviceInfo[]
  deviceId: string
  local: MediaStream | null
  pictures: Record<string, CameraPicture>
  toggle: () => void
  select: (deviceId: string) => void
}

const CAMERA_FRAME_INTERVAL_MS = 1000 / 30

const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data))
const bytes = (data: string) => Uint8Array.from(atob(data), c => c.charCodeAt(0))

/** Owns capture independently of renderer mounts and of the selected voice transport. */
export function useCamera(options: {
  roomKey: string
  client: () => VoipClient
  serverId: string
  roomId: string
  allowed: boolean
  session: () => WebRtcMediaSession | null
  ensureSession: () => Promise<void>
  errorMessage: (code: string) => string
}) {
  const opts = useRef(options)
  opts.current = options
  const [local, setLocal] = useState<MediaStream | null>(null)
  const [busy, setBusy] = useState(false)
  const [supported, setSupported] = useState(false)
  const [error, setError] = useState("")
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState("")
  const [pictures, setPictures] = useState<Record<string, CameraPicture>>({})
  const capture = useRef<MediaStream | null>(null)
  const generation = useRef(0)
  const busyRef = useRef(false)
  const allowed = useRef(false)
  const livekit = useRef(false)
  const remote = useRef(new Map<string, { stream?: MediaStream; image?: string; last: number }>())
  const assembler = useRef(new CameraAssembler())
  const published = useRef<WebRtcMediaSession | null>(null)

  const stop = useCallback(() => {
    generation.current++
    capture.current?.getTracks().forEach(track => track.stop())
    capture.current = null
    setLocal(null)
    busyRef.current = false
    setBusy(false)
    const session = published.current
    published.current = null
    void session?.stopCamera().catch(() => {})
  }, [])

  const refreshDevices = useCallback(async () => {
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "videoinput")) } catch { /* denied */ }
  }, [])

  const start = useCallback(async (device: string) => {
    if (!opts.current.roomKey || !allowed.current || !opts.current.allowed || busyRef.current) return
    const key = opts.current.roomKey
    stop()
    const seq = generation.current
    busyRef.current = true
    setBusy(true)
    setError("")
    let stream: MediaStream | null = null
    const stale = () => seq !== generation.current || key !== opts.current.roomKey || !allowed.current || !opts.current.allowed
    try {
      const permission = await window.electronVoice?.requestCameraAccess?.()
      if (permission && !permission.granted) throw new DOMException("Camera permission denied", "NotAllowedError")
      if (stale()) return
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, ...(device ? { deviceId: { exact: device } } : { facingMode: "user" }) }
      })
      if (stale()) { stream.getTracks().forEach(t => t.stop()); return }
      capture.current = stream
      setLocal(stream)
      const actual = stream.getVideoTracks()[0]?.getSettings().deviceId ?? device
      setDeviceId(actual)
      try { localStorage.setItem("voixex-camera-device", actual) } catch { /* storage unavailable */ }
      stream.getVideoTracks()[0]?.addEventListener("ended", () => { if (capture.current === stream) stop() }, { once: true })
      await refreshDevices()
      if (livekit.current && !stale()) {
        await opts.current.ensureSession()
        const session = opts.current.session()
        if (session?.live && !stale()) {
          published.current = session
          // A denied/unavailable SFU never interrupts legacy video.
          await session.publishCamera(stream.getVideoTracks()[0]).catch(() => {})
        }
      }
    } catch (cause) {
      stream?.getTracks().forEach(t => t.stop())
      if (!stale()) {
        stop()
        const name = cause instanceof Error ? cause.name : "Error"
        setError(opts.current.errorMessage(name))
      }
    } finally {
      if (seq === generation.current) { busyRef.current = false; setBusy(false) }
    }
  }, [refreshDevices, stop])

  useEffect(() => {
    stop()
    setSupported(false)
    allowed.current = false
    setError("")
    assembler.current.clear()
    for (const entry of remote.current.values()) if (entry.image) URL.revokeObjectURL(entry.image)
    remote.current.clear()
    setPictures({})
    if (!options.roomKey) return
    let cancelled = false
    const check = async () => {
      try {
        const capabilities = await opts.current.client().getCameraCapabilities(opts.current.serverId, opts.current.roomId)
        if (cancelled) return
        allowed.current = capabilities.version === 1 && capabilities.allowCamera
        livekit.current = capabilities.livekit
        setSupported(allowed.current)
        if (!allowed.current) stop()
      } catch {
        if (!cancelled) { allowed.current = false; setSupported(false); stop() }
      }
    }
    // Presence may still be joining the room when React mounts the stage.
    const initial = setTimeout(() => void check(), 500)
    const polling = setInterval(() => void check(), 5000)
    return () => {
      cancelled = true; clearTimeout(initial); clearInterval(polling); stop()
      for (const entry of remote.current.values()) if (entry.image) URL.revokeObjectURL(entry.image)
      remote.current.clear()
      assembler.current.clear()
    }
  }, [options.roomKey, stop])

  useEffect(() => { if (!options.allowed) stop() }, [options.allowed, stop])
  useEffect(() => {
    const media = navigator.mediaDevices
    void refreshDevices()
    media?.addEventListener("devicechange", refreshDevices)
    const hidden = () => { if (document.hidden) stop() }
    // All platforms release camera when the app is hidden; no background camera capture.
    const background = () => stop()
    window.addEventListener("voixex-camera-background", background)
    document.addEventListener("visibilitychange", hidden)
    return () => { media?.removeEventListener("devicechange", refreshDevices); document.removeEventListener("visibilitychange", hidden); window.removeEventListener("voixex-camera-background", background) }
  }, [refreshDevices, stop])

  useEffect(() => {
    if (!options.roomKey) return
    const unsubscribe = window.electronVoice?.onCameraPacket?.(encoded => {
      try {
        const packet = bytes(encoded), length = packet[0]
        if (!length || length + 1 >= packet.length) return
        const sender = new TextDecoder("utf-8", { fatal: true }).decode(packet.subarray(1, length + 1))
        const frame = assembler.current.push(sender, packet.subarray(length + 1), performance.now())
        if (!frame) return
        const image = URL.createObjectURL(new Blob([frame.slice().buffer], { type: "image/jpeg" }))
        const previous = remote.current.get(sender)
        if (!previous && remote.current.size >= 64) {
          const oldest = remote.current.keys().next().value!
          const entry = remote.current.get(oldest)
          if (entry?.image) URL.revokeObjectURL(entry.image)
          remote.current.delete(oldest)
        }
        if (previous?.image) URL.revokeObjectURL(previous.image)
        remote.current.set(sender, { ...previous, image, last: performance.now() })
        setPictures(Object.fromEntries(remote.current))
      } catch { /* malformed or expired frame */ }
    })
    const timer = setInterval(() => {
      let changed = false
      for (const [sender, entry] of remote.current) {
        if (entry.image && performance.now() - entry.last > 2000) {
          URL.revokeObjectURL(entry.image)
          if (entry.stream) remote.current.set(sender, { stream: entry.stream, last: entry.last })
          else remote.current.delete(sender)
          changed = true
        }
      }
      if (changed) setPictures(Object.fromEntries(remote.current))
    }, 500)
    return () => { unsubscribe?.(); clearInterval(timer) }
  }, [options.roomKey])

  useEffect(() => {
    if (!local) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const video = document.createElement("video")
    video.muted = true; video.playsInline = true; video.srcObject = local
    const canvas = document.createElement("canvas")
    const context = canvas.getContext("2d")
    const streamId = crypto.getRandomValues(new Uint32Array(1))[0]
    let frameId = 0
    const tick = async () => {
      const startedAt = performance.now()
      try {
        if (!context || video.readyState < 2 || cancelled) return
        const ratio = video.videoWidth / video.videoHeight
        canvas.width = Math.min(480, video.videoWidth)
        canvas.height = Math.max(1, Math.round(canvas.width / ratio))
        context.drawImage(video, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.55))
        if (!blob || cancelled) return
        const packets = fragmentCamera(new Uint8Array(await blob.arrayBuffer()), streamId, frameId++, Date.now())
        for (const [index, packet] of packets.entries()) {
          if (cancelled) break
          await window.electronVoice?.sendCameraPacket?.(base64(packet))
          // Yield in small batches so audio/control can run without a delay per fragment.
          if ((index + 1) % 4 === 0) await new Promise(resolve => setTimeout(resolve, 0))
        }
        const session = opts.current.session()
        if (livekit.current && session?.live && published.current !== session && !cancelled) {
          published.current = session
          await session.publishCamera(local.getVideoTracks()[0]).catch(() => { if (published.current === session) published.current = null })
        }
      } catch { /* next independent frame recovers from packet/encoder failure */ }
      finally { if (!cancelled) timer = setTimeout(() => void tick(), Math.max(0, CAMERA_FRAME_INTERVAL_MS - (performance.now() - startedAt))) }
    }
    void video.play().then(() => tick()).catch(() => { if (!cancelled) { stop(); setError(opts.current.errorMessage("Error")) } })
    return () => { cancelled = true; clearTimeout(timer); video.pause(); video.srcObject = null }
  }, [local, stop])

  const onRemoteCamera = useCallback((identity: string, stream: MediaStream | null) => {
    const previous = remote.current.get(identity)
    if (!stream && !previous?.image) remote.current.delete(identity)
    else remote.current.set(identity, { ...previous, stream: stream ?? undefined, last: previous?.last ?? performance.now() })
    setPictures(Object.fromEntries(remote.current))
  }, [])

  return {
    controls: {
      enabled: Boolean(local), busy, supported: supported && options.allowed, error, devices, deviceId, local, pictures,
      toggle: () => { if (capture.current || busyRef.current) stop(); else { let stored = ""; try { stored = localStorage.getItem("voixex-camera-device") ?? "" } catch {} void start(devices.some(d => d.deviceId === stored) ? stored : "") } },
      select: (id: string) => { setDeviceId(id); try { localStorage.setItem("voixex-camera-device", id) } catch {} if (capture.current) void start(id) }
    } satisfies CameraControls,
    onRemoteCamera,
    stop
  }
}
