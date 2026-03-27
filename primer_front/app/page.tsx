"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ServerSidebar } from "@/components/voip/server-sidebar"
import { ChannelSidebar, type ChannelCategory } from "@/components/voip/channel-sidebar"
import { UserPanel } from "@/components/voip/user-panel"
import { ChatArea, type Message } from "@/components/voip/chat-area"
import { MemberList, type Member } from "@/components/voip/member-list"
import { VoipClient } from "@/lib/voip-client"

export default function VoIPApp() {
  type VoiceRuntimeStats = {
    connected?: boolean
    roomId?: string | null
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
  type AudioDevice = { id: string; label: string; kind: "input" | "output"; isDefault?: boolean }
  type VoicePipelineRuntime = {
    stream: MediaStream
    captureCtx: AudioContext
    captureNode: ScriptProcessorNode
    captureSource: MediaStreamAudioSourceNode
    micGainNode: GainNode
    captureSinkNode: MediaStreamAudioDestinationNode
    playbackCtx: AudioContext
    playbackNode: ScriptProcessorNode
    playbackFilterNode: BiquadFilterNode
    outputGainNode: GainNode
    queue: Int16Array[]
    txRemainder: Int16Array
    txResampleInput: Float32Array
    txResamplePos: number
    playbackSampleRate: number
    bufferedSamples: number
    unsubscribeIncoming: (() => void) | null
    lastIncomingAudioAtMs: number
    playbackIdleTimer: ReturnType<typeof setInterval> | null
  }

  const [activeServerId, setActiveServerId] = useState("")
  const [activeChannelId, setActiveChannelId] = useState("")
  const [showMemberList, setShowMemberList] = useState(true)
  const [isMuted, setIsMuted] = useState(false)
  const [isDeafened, setIsDeafened] = useState(false)
  const [isInVoice, setIsInVoice] = useState(false)
  const [currentVoiceChannel, setCurrentVoiceChannel] = useState("")
  const [messages, setMessages] = useState<Message[]>([])
  const [serverPassword, setServerPassword] = useState("1234")
  const [superuserPasswordInput, setSuperuserPasswordInput] = useState("")
  const [apiHost, setApiHost] = useState("localhost")
  const [apiPort, setApiPort] = useState("18080")
  const [displayNameInput, setDisplayNameInput] = useState("User")
  const [profileDisplayName, setProfileDisplayName] = useState("User")
  const [servers, setServers] = useState<Array<{ id: string; name: string; icon: string }>>([])
  const [categories, setCategories] = useState<ChannelCategory[]>([])
  const [voiceUsers, setVoiceUsers] = useState<Record<string, Array<{ id: string; name: string; avatar: string; isMuted?: boolean; isDeafened?: boolean; isSpeaking?: boolean }>>>({})
  const [members, setMembers] = useState<Member[]>([])
  const [status, setStatus] = useState("Disconnected")
  const [error, setError] = useState("")
  const [joining, setJoining] = useState(false)
  const [connectedToApi, setConnectedToApi] = useState(false)
  const [showConnectPanel, setShowConnectPanel] = useState(false)
  const [showServerSettings, setShowServerSettings] = useState(false)
  const [serverSettingsTab, setServerSettingsTab] = useState<"general" | "channels" | "roles">("general")
  const [roomNameInput, setRoomNameInput] = useState("new-room")
  const [roomKindInput, setRoomKindInput] = useState<"voice" | "text">("voice")
  const [voiceStats, setVoiceStats] = useState<VoiceRuntimeStats | null>(null)
  const [isSpeakingNow, setIsSpeakingNow] = useState(false)
  const [hasDesktopBridge, setHasDesktopBridge] = useState(false)
  const [showVoiceStatsPanel, setShowVoiceStatsPanel] = useState(false)
  const [showAppSettings, setShowAppSettings] = useState(false)
  const [appSettingsTab, setAppSettingsTab] = useState<"voice" | "keybinds">("voice")
  const [audioDevices, setAudioDevices] = useState<{ input: AudioDevice[]; output: AudioDevice[] }>({ input: [], output: [] })
  const [selectedDevices, setSelectedDevices] = useState<{ inputId: string | null; outputId: string | null }>({
    inputId: null,
    outputId: null
  })
  const [wsConnected, setWsConnected] = useState(false)
  const [wsReconnecting, setWsReconnecting] = useState(false)
  const [deviceError, setDeviceError] = useState("")
  const [audioDevicesRevision, setAudioDevicesRevision] = useState(0)
  const [micVolumePct, setMicVolumePct] = useState(100)
  const [outputVolumePct, setOutputVolumePct] = useState(100)
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true)
  const [keybinds, setKeybinds] = useState<{ toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }>({
    toggleMute: null,
    toggleDeafen: null,
    pushToTalk: null
  })
  const [keybindDraft, setKeybindDraft] = useState<{ toggleMute: string; toggleDeafen: string; pushToTalk: string }>({
    toggleMute: "",
    toggleDeafen: "",
    pushToTalk: ""
  })
  const [canManageServer, setCanManageServer] = useState(false)
  const client = useMemo(() => new VoipClient(), [])
  const voicePipelineRef = useRef<VoicePipelineRuntime | null>(null)
  const mutedRef = useRef(isMuted)
  const deafenedRef = useRef(isDeafened)
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const currentUser = useMemo(
    () => ({
      id: "me",
      name: profileDisplayName,
      discriminator: "0001",
      avatar: profileDisplayName.slice(0, 1).toUpperCase() || "U",
      status: "online" as const
    }),
    [profileDisplayName]
  )

  useEffect(() => {
    const key = "voip-client-id"
    const existing = localStorage.getItem(key)
    if (!existing) localStorage.setItem(key, crypto.randomUUID())
    const unsubscribe = client.subscribe((state) => {
      setCategories(client.toSidebarCategories())
      setVoiceUsers(client.toVoiceUsers())
      setWsConnected(state.connection.wsConnected)
      setWsReconnecting(state.connection.reconnecting)
      if (state.me?.displayName) {
        setProfileDisplayName(state.me.displayName)
      }
      setCanManageServer(Boolean(state.me?.permissions?.manage_server))
      const roomUsers = currentVoiceChannel ? state.rosterByRoom[currentVoiceChannel] ?? [] : state.lobby
      setMembers(roomUsers.map((u) => ({ id: u.clientId, name: u.displayName, avatar: u.displayName.slice(0, 1).toUpperCase(), status: "online", roles: [] })))
      const activeMessages = client.getMessagesState(activeChannelId)
      setMessages(
        activeMessages.map((m) => ({
          id: m.id,
          author: { id: m.author.clientId, name: m.author.displayName, avatar: m.author.displayName.slice(0, 1).toUpperCase() || "U" },
          content: m.body,
          timestamp: new Date(m.createdAt)
        }))
      )
    })
    return unsubscribe
  }, [client, currentVoiceChannel, activeChannelId])

  useEffect(() => {
    setHasDesktopBridge(Boolean(window.electronVoice))
  }, [])

  useEffect(() => {
    const raw = localStorage.getItem("voip-audio-settings")
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { micVolumePct?: number; outputVolumePct?: number; noiseSuppressionEnabled?: boolean }
      if (typeof parsed.micVolumePct === "number") setMicVolumePct(Math.max(0, Math.min(200, Math.round(parsed.micVolumePct))))
      if (typeof parsed.outputVolumePct === "number") setOutputVolumePct(Math.max(0, Math.min(200, Math.round(parsed.outputVolumePct))))
      if (typeof parsed.noiseSuppressionEnabled === "boolean") setNoiseSuppressionEnabled(parsed.noiseSuppressionEnabled)
    } catch {
      // ignore broken localStorage payload
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      "voip-audio-settings",
      JSON.stringify({ micVolumePct, outputVolumePct, noiseSuppressionEnabled })
    )
  }, [micVolumePct, outputVolumePct, noiseSuppressionEnabled])

  useEffect(() => {
    if (!hasDesktopBridge || !window.electronVoice) return
    void window.electronVoice.getKeybinds().then((value) => {
      const next = {
        toggleMute: value.toggleMute ?? null,
        toggleDeafen: value.toggleDeafen ?? null,
        pushToTalk: value.pushToTalk ?? null
      }
      setKeybinds(next)
      setKeybindDraft({
        toggleMute: next.toggleMute ?? "",
        toggleDeafen: next.toggleDeafen ?? "",
        pushToTalk: next.pushToTalk ?? ""
      })
    })
    const unsub = window.electronVoice.onHotkeyAction((payload) => {
      if (payload.action === "toggle_mute") {
        const next = !mutedRef.current
        applyMute(next)
      } else if (payload.action === "toggle_deafen") {
        const next = !deafenedRef.current
        applyDeafen(next)
      } else if (payload.action === "push_to_talk") {
        applyMute(false)
        if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
        pttTimerRef.current = setTimeout(() => applyMute(true), 1200)
      }
    })
    return unsub
  }, [hasDesktopBridge])

  useEffect(() => {
    mutedRef.current = isMuted
  }, [isMuted])

  useEffect(() => {
    deafenedRef.current = isDeafened
  }, [isDeafened])

  const stopVoicePipeline = () => {
    const runtime = voicePipelineRef.current
    if (!runtime) return
    runtime.unsubscribeIncoming?.()
    runtime.captureNode.disconnect()
    runtime.captureSource.disconnect()
    runtime.micGainNode.disconnect()
    runtime.captureSinkNode.disconnect()
    runtime.playbackNode.disconnect()
    runtime.playbackFilterNode.disconnect()
    runtime.outputGainNode.disconnect()
    if (runtime.playbackIdleTimer) {
      clearInterval(runtime.playbackIdleTimer)
      runtime.playbackIdleTimer = null
    }
    void runtime.captureCtx.close()
    void runtime.playbackCtx.close()
    runtime.stream.getTracks().forEach((t) => t.stop())
    voicePipelineRef.current = null
  }

  const encodePcm16Base64 = (frame: Int16Array) => {
    const bytes = new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength)
    let out = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(out)
  }

  const decodePcm16Base64 = (payload: string) => {
    const raw = atob(payload)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i)
    }
    return new Int16Array(bytes.buffer)
  }

  const concatInt16 = (a: Int16Array, b: Int16Array) => {
    if (a.length === 0) return b
    if (b.length === 0) return a
    const out = new Int16Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  const resampleFloat32Chunk = (
    chunk: Float32Array,
    inRate: number,
    outRate: number,
    runtime: Pick<VoicePipelineRuntime, "txResampleInput" | "txResamplePos">
  ) => {
    if (inRate === outRate) return chunk
    const combined = new Float32Array(runtime.txResampleInput.length + chunk.length)
    combined.set(runtime.txResampleInput, 0)
    combined.set(chunk, runtime.txResampleInput.length)
    const step = inRate / outRate
    let pos = runtime.txResamplePos
    const out: number[] = []
    while (pos + 1 < combined.length) {
      const i = Math.floor(pos)
      const frac = pos - i
      const sample = combined[i] * (1 - frac) + combined[i + 1] * frac
      out.push(sample)
      pos += step
    }
    const keepFrom = Math.max(0, Math.floor(pos) - 1)
    runtime.txResampleInput = combined.subarray(keepFrom)
    runtime.txResamplePos = pos - keepFrom
    return Float32Array.from(out)
  }

  const resampleInt16Frame = (frame: Int16Array, inRate: number, outRate: number) => {
    if (inRate === outRate) return frame
    const outLen = Math.max(1, Math.round((frame.length * outRate) / inRate))
    const out = new Int16Array(outLen)
    const step = inRate / outRate
    for (let i = 0; i < outLen; i += 1) {
      const pos = i * step
      const idx = Math.floor(pos)
      const frac = pos - idx
      const a = frame[Math.min(frame.length - 1, idx)]
      const b = frame[Math.min(frame.length - 1, idx + 1)]
      out[i] = Math.round(a * (1 - frac) + b * frac)
    }
    return out
  }

  const applyPlaybackNoiseGate = (frame: Int16Array) => {
    if (frame.length === 0) return frame
    let peak = 0
    let sumSq = 0
    for (let i = 0; i < frame.length; i += 1) {
      const abs = Math.abs(frame[i])
      if (abs > peak) peak = abs
      sumSq += abs * abs
    }
    const rms = Math.sqrt(sumSq / frame.length)
    const gateThreshold = 96
    // If the whole frame is near-noise floor, mute it completely.
    if (peak < gateThreshold || rms < gateThreshold * 0.6) {
      return new Int16Array(frame.length)
    }
    const out = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const sample = frame[i]
      out[i] = Math.abs(sample) < gateThreshold ? 0 : sample
    }
    return out
  }

  const normalizeLatencyMs = (value: number | undefined) => {
    if (typeof value !== "number" || Number.isNaN(value) || !Number.isFinite(value)) return 0
    if (value < 0) return 0
    if (value > 60_000) {
      return 0
    }
    return value
  }

  useEffect(() => {
    if (!hasDesktopBridge) return
    let prevTx = 0
    const timer = setInterval(async () => {
      const stats = (await window.electronVoice?.getStats()) as VoiceRuntimeStats | undefined
      if (stats) {
        const normalized: VoiceRuntimeStats = {
          ...stats,
          pingNowMs: normalizeLatencyMs(stats.pingNowMs),
          ping1PctMs: normalizeLatencyMs(stats.ping1PctMs),
          ping01PctMs: normalizeLatencyMs(stats.ping01PctMs)
        }
        const tx = stats.txPackets ?? 0
        setIsSpeakingNow(tx > prevTx && !isMuted)
        prevTx = tx
        setVoiceStats(normalized)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [hasDesktopBridge, isMuted])

  useEffect(() => {
    if (!hasDesktopBridge || !isInVoice || !currentVoiceChannel) {
      stopVoicePipeline()
      return
    }

    let cancelled = false

    const startVoicePipeline = async () => {
      try {
        stopVoicePipeline()
        const selected = (await window.electronVoice?.getAudioDevices()) as { inputId: string | null; outputId: string | null } | undefined
        const preferredConstraints: MediaTrackConstraints = {
          ...(selected?.inputId ? { deviceId: { exact: selected.inputId } } : {}),
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: noiseSuppressionEnabled,
          noiseSuppression: noiseSuppressionEnabled,
          autoGainControl: noiseSuppressionEnabled
        }
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: preferredConstraints })
        } catch {
          // Fallback if strict constraints are unsupported by the current audio stack.
          stream = await navigator.mediaDevices.getUserMedia({ audio: selected?.inputId ? { deviceId: { exact: selected.inputId } } : true })
          if (noiseSuppressionEnabled) {
            setDeviceError("Noise suppression constraints are not supported on this device. Running without DSP constraints.")
          }
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }

        const captureCtx = new AudioContext({ sampleRate: 48000 })
        const playbackCtx = new AudioContext({ sampleRate: 48000 })
        if (selected?.outputId && typeof (playbackCtx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId === "function") {
          await (playbackCtx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(selected.outputId)
        }

        const captureSource = captureCtx.createMediaStreamSource(stream)
        const captureNode = captureCtx.createScriptProcessor(1024, 1, 1)
        const micGainNode = captureCtx.createGain()
        micGainNode.gain.value = micVolumePct / 100
        const captureSinkNode = captureCtx.createMediaStreamDestination()
        const playbackNode = playbackCtx.createScriptProcessor(1024, 1, 1)
        const playbackFilterNode = playbackCtx.createBiquadFilter()
        playbackFilterNode.type = "highpass"
        playbackFilterNode.frequency.value = 85
        playbackFilterNode.Q.value = 0.707
        const outputGainNode = playbackCtx.createGain()
        outputGainNode.gain.value = outputVolumePct / 100
        const runtime: VoicePipelineRuntime = {
          stream,
          captureCtx,
          captureNode,
          captureSource,
          micGainNode,
          captureSinkNode,
          playbackCtx,
          playbackNode,
          playbackFilterNode,
          outputGainNode,
          queue: [],
          txRemainder: new Int16Array(0),
          txResampleInput: new Float32Array(0),
          txResamplePos: 0,
          playbackSampleRate: playbackCtx.sampleRate,
          bufferedSamples: 0,
          unsubscribeIncoming: null,
          lastIncomingAudioAtMs: 0,
          playbackIdleTimer: null
        }
        voicePipelineRef.current = runtime

        const frameSize = 960
        captureNode.onaudioprocess = (event) => {
          const input = event.inputBuffer.getChannelData(0)
          const resampled = resampleFloat32Chunk(input, runtime.captureCtx.sampleRate, 48000, runtime)
          const pcm = new Int16Array(resampled.length)
          for (let i = 0; i < resampled.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, resampled[i]))
            pcm[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
          }
          const merged = concatInt16(runtime.txRemainder, pcm)
          let offset = 0
          while (offset + frameSize <= merged.length) {
            if (!mutedRef.current) {
              const frame = merged.subarray(offset, offset + frameSize)
              void window.electronVoice?.sendPcm16Frame(encodePcm16Base64(frame))
            }
            offset += frameSize
          }
          runtime.txRemainder = merged.subarray(offset)
        }

        playbackNode.onaudioprocess = (event) => {
          const out = event.outputBuffer.getChannelData(0)
          out.fill(0)
          if (deafenedRef.current) {
            runtime.queue = []
            runtime.bufferedSamples = 0
            return
          }
          const minBufferedSamples = Math.round(runtime.playbackSampleRate * 0.04)
          if (runtime.bufferedSamples < minBufferedSamples) return
          let cursor = 0
          while (cursor < out.length && runtime.queue.length > 0) {
            const current = runtime.queue[0]
            const copyLen = Math.min(out.length - cursor, current.length)
            for (let i = 0; i < copyLen; i += 1) {
              out[cursor + i] = current[i] / 32768
            }
            cursor += copyLen
            runtime.bufferedSamples -= copyLen
            if (copyLen === current.length) {
              runtime.queue.shift()
            } else {
              runtime.queue[0] = current.subarray(copyLen)
            }
          }
        }

        runtime.unsubscribeIncoming = window.electronVoice?.onPcm16Frame((pcm16Base64) => {
          const frame48k = decodePcm16Base64(pcm16Base64)
          const frame = applyPlaybackNoiseGate(resampleInt16Frame(frame48k, 48000, runtime.playbackSampleRate))
          let hasSignal = false
          for (let i = 0; i < frame.length; i += 1) {
            if (frame[i] !== 0) {
              hasSignal = true
              break
            }
          }
          if (!hasSignal) return
          runtime.lastIncomingAudioAtMs = Date.now()
          if (runtime.playbackCtx.state !== "running") {
            void runtime.playbackCtx.resume()
          }
          runtime.queue.push(frame)
          runtime.bufferedSamples += frame.length
          if (runtime.queue.length > 300) {
            const dropped = runtime.queue.splice(0, runtime.queue.length - 300)
            for (const d of dropped) runtime.bufferedSamples -= d.length
          }
        }) ?? null

        captureSource.connect(micGainNode)
        micGainNode.connect(captureNode)
        // Keep ScriptProcessor running without routing mic signal to speakers.
        captureNode.connect(captureSinkNode)
        playbackNode.connect(playbackFilterNode)
        playbackFilterNode.connect(outputGainNode)
        outputGainNode.connect(playbackCtx.destination)
        runtime.playbackIdleTimer = setInterval(() => {
          const idleForMs = Date.now() - runtime.lastIncomingAudioAtMs
          if (runtime.bufferedSamples === 0 && idleForMs > 700 && runtime.playbackCtx.state === "running") {
            void runtime.playbackCtx.suspend()
          }
        }, 300)
        await captureCtx.resume()
        await playbackCtx.suspend()
        setStatus((prev) => {
          if (prev.includes("Voice I/O active")) return prev
          return prev.includes("In room:") ? `${prev} | Voice I/O active` : "Voice I/O active"
        })
      } catch (e) {
        setDeviceError(e instanceof Error ? e.message : "Failed to start audio pipeline")
      }
    }

    void startVoicePipeline()
    return () => {
      cancelled = true
      stopVoicePipeline()
    }
  }, [hasDesktopBridge, isInVoice, currentVoiceChannel, audioDevicesRevision, noiseSuppressionEnabled, micVolumePct, outputVolumePct])

  useEffect(() => {
    if (isInVoice) {
      setShowVoiceStatsPanel(true)
    }
  }, [isInVoice])

  const applyMute = (next: boolean) => {
    setIsMuted(next)
    client.setMute(next)
    void window.electronVoice?.setMute(next)
    setStatus(next ? "Microphone muted" : "Microphone unmuted")
  }

  const applyDeafen = (next: boolean) => {
    setIsDeafened(next)
    client.setDeafen(next)
    void window.electronVoice?.setDeafen(next)
    setStatus(next ? "Headphones deafened" : "Headphones undeafened")
  }

  const handleSendMessage = (content: string) => {
    if (!activeServerId || !activeChannelId) return
    void client.sendMessage(activeServerId, activeChannelId, content).catch((e) => {
      setError(e instanceof Error ? e.message : "send message failed")
    })
  }

  const handleChannelSelect = async (channelId: string) => {
    setActiveChannelId(channelId)
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === channelId)
    if (channel?.type === "voice") {
      setIsInVoice(true)
      setCurrentVoiceChannel(channelId)
      client.joinRoom(channelId)
      void window.electronVoice?.joinRoom(channelId)
      setStatus(`In room: ${channel.name}`)
    } else if (channel?.type === "text" && activeServerId) {
      setStatus(`Text channel: ${channel.name}`)
      await client.getMessages(activeServerId, channelId)
    }
  }

  const handleDisconnect = () => {
    setIsInVoice(false)
    setCurrentVoiceChannel("")
    stopVoicePipeline()
    client.leaveRoom()
    void window.electronVoice?.leaveRoom()
    setStatus("Connected to server")
  }

  const activeChannel = categories.flatMap((c) => c.channels).find((c) => c.id === activeChannelId)
  const allChannels = categories.flatMap((c) => c.channels)
  const voiceChannelName = categories.flatMap((c) => c.channels).find((c) => c.id === currentVoiceChannel)?.name || ""
  const isTextChannel = activeChannel?.type === "text"
  const qualityClass = useMemo(() => {
    const loss = voiceStats?.packetLossPct ?? 0
    const jitter = voiceStats?.jitter1PctMs ?? 0
    if (loss < 0.5 && jitter < 20) return "text-accent"
    if (loss < 2 && jitter < 50) return "text-yellow-500"
    return "text-destructive"
  }, [voiceStats])
  const voiceStatsSummary = useMemo(() => {
    if (!isInVoice || !voiceStats) return ""
    return `Ping1% ${voiceStats.ping1PctMs ?? 0}ms | Loss ${voiceStats.packetLossPct ?? 0}% | Jitter1% ${voiceStats.jitter1PctMs ?? 0}ms`
  }, [isInVoice, voiceStats])

  const connectAndJoin = async () => {
    try {
      setJoining(true)
      client.setApiBase(`http://${apiHost.trim()}:${apiPort.trim()}`)
      setError("")
      setStatus(`Connecting API: ${apiHost}:${apiPort}`)
      const health = await client.healthcheck()
      if (!health.ok) throw new Error("server is not healthy")
      setConnectedToApi(true)
      setStatus("Joining server...")
      const clientId = localStorage.getItem("voip-client-id") || crypto.randomUUID()
      const join = await client.joinServer(serverPassword, clientId, displayNameInput, superuserPasswordInput || undefined)
      const joinedServerId = join.serverId
      const joinedServerName = join.serverName ?? "Server"
      localStorage.setItem("voip-client-id", join.profile.clientId)
      setProfileDisplayName(join.profile.displayName)
      if (join.mediaToken) {
        if (!window.electronVoice) {
          throw new Error("Desktop voice bridge not available. Run inside voip-desktop-client.")
        }
        setStatus("Connecting voice transport...")
        await window.electronVoice.connect({
          host: join.udp.host === "backend" ? apiHost.trim() : join.udp.host,
          port: join.udp.port,
          mediaToken: join.mediaToken
        })
      }
      client.connectWs()
      const rooms = await client.getRooms(joinedServerId)
      await client.getMe(joinedServerId)
      setActiveServerId(joinedServerId)
      setServers([{ id: joinedServerId, name: joinedServerName, icon: joinedServerName.slice(0, 1).toUpperCase() || "S" }])
      const text = rooms.find((r) => r.kind === "text")
      const voice = rooms.find((r) => r.kind === "voice")
      if (text) {
        setActiveChannelId(text.id)
        await client.getMessages(joinedServerId, text.id)
      }
      if (voice) {
        setCurrentVoiceChannel(voice.id)
        setIsInVoice(true)
        client.joinRoom(voice.id)
        await window.electronVoice?.joinRoom(voice.id)
        setStatus(`In room: ${voice.name}`)
      } else {
        setStatus("Connected to server")
      }
    } catch (e) {
      setConnectedToApi(false)
      setError(e instanceof Error ? e.message : "join server failed")
    } finally {
      setJoining(false)
    }
  }

  const openAppSettings = async () => {
    if (!window.electronVoice) return
    setDeviceError("")
    let list = (await window.electronVoice.listAudioDevices()) as AudioDevice[]
    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch {
        setDeviceError("No permission to access microphone/headphones. Allow audio permissions in desktop client.")
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const mapped: AudioDevice[] = devices
          .filter((d) => d.kind === "audioinput" || d.kind === "audiooutput")
          .map((d) => ({
            id: d.deviceId,
            label: d.label || (d.kind === "audioinput" ? "Microphone" : "Headphones"),
            kind: d.kind === "audioinput" ? "input" : "output"
          }))
        if (mapped.length > 0) {
          list = mapped
        }
      } catch {
        // keep fallback list from electron bridge
      }
    }
    const input = list.filter((d) => d.kind === "input")
    const output = list.filter((d) => d.kind === "output")
    if (input.length === 0) {
      input.push({ id: "default-input", label: "Default Input", kind: "input", isDefault: true })
    }
    if (output.length === 0) {
      output.push({ id: "default-output", label: "Default Output", kind: "output", isDefault: true })
    }
    const current = (await window.electronVoice.getAudioDevices()) as { inputId: string | null; outputId: string | null }
    setAudioDevices({ input, output })
    setSelectedDevices(current)
    setAppSettingsTab("voice")
    setShowAppSettings(true)
  }

  const saveAudioSettings = async () => {
    await window.electronVoice?.setAudioDevices(selectedDevices)
    setAudioDevicesRevision((v) => v + 1)
    setShowAppSettings(false)
  }

  const saveKeybinds = async () => {
    if (!window.electronVoice) return
    const next = {
      toggleMute: keybindDraft.toggleMute.trim() || null,
      toggleDeafen: keybindDraft.toggleDeafen.trim() || null,
      pushToTalk: keybindDraft.pushToTalk.trim() || null
    }
    const saved = (await window.electronVoice.setKeybinds(next)) as { toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }
    setKeybinds(saved)
    setKeybindDraft({
      toggleMute: saved.toggleMute ?? "",
      toggleDeafen: saved.toggleDeafen ?? "",
      pushToTalk: saved.pushToTalk ?? ""
    })
  }

  const clearKeybinds = async () => {
    if (!window.electronVoice) return
    const saved = (await window.electronVoice.clearKeybinds()) as { toggleMute: string | null; toggleDeafen: string | null; pushToTalk: string | null }
    setKeybinds(saved)
    setKeybindDraft({ toggleMute: "", toggleDeafen: "", pushToTalk: "" })
  }

  const saveProfile = async () => {
    if (!activeServerId) return
    await client.updateProfile(activeServerId, profileDisplayName)
    setStatus("Profile updated")
  }

  return (
    <main className="flex h-screen overflow-hidden bg-background">
      {/* Server Sidebar */}
      <ServerSidebar
        servers={servers}
        activeServerId={activeServerId}
        onServerSelect={setActiveServerId}
        onAddServer={() => setShowConnectPanel((v) => !v)}
        onOpenServerSettings={() => {
          if (!activeServerId || activeServerId === "home" || !canManageServer) return
          setShowServerSettings(true)
        }}
      />

      {/* Channel Sidebar + User Panel */}
      <div className="flex h-full flex-col">
        {showConnectPanel && (
          <div className="m-2 w-[340px] rounded border border-border bg-card p-3 text-xs">
            <div className="mb-2 font-semibold">Server connection</div>
            <div className="mb-2 flex gap-2">
              <input className="w-40 rounded border px-2 py-1" value={apiHost} onChange={(e) => setApiHost(e.target.value)} placeholder="Backend host/ip" />
              <input className="w-20 rounded border px-2 py-1" value={apiPort} onChange={(e) => setApiPort(e.target.value)} placeholder="Port" />
              <button className="rounded border px-2 py-1" onClick={connectAndJoin} disabled={joining}>
                {joining ? "Connecting..." : "Connect"}
              </button>
            </div>
            <div className="mb-2 flex gap-2">
              <input className="w-28 rounded border px-2 py-1" value={serverPassword} onChange={(e) => setServerPassword(e.target.value)} placeholder="Password" />
              <input className="w-28 rounded border px-2 py-1" value={displayNameInput} onChange={(e) => setDisplayNameInput(e.target.value)} placeholder="Nickname" />
              <span className="rounded border px-2 py-1 text-muted-foreground">{connectedToApi ? "API OK" : "API ?"} </span>
            </div>
            <div className="mb-2 flex gap-2">
              <input
                className="w-full rounded border px-2 py-1"
                type="password"
                value={superuserPasswordInput}
                onChange={(e) => setSuperuserPasswordInput(e.target.value)}
                placeholder="Superuser password (optional, grants admin role)"
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground">Single server mode: join by host/port + password.</div>
              <button
                className="rounded border px-2 py-1"
                onClick={() => {
                  if (!activeServerId || activeServerId === "home" || !canManageServer) return
                  setShowServerSettings(true)
                }}
                disabled={!activeServerId || activeServerId === "home" || !canManageServer}
              >
                Server settings
              </button>
            </div>
            <div className="mt-2 flex gap-2">
              <input className="w-40 rounded border px-2 py-1" value={profileDisplayName} onChange={(e) => setProfileDisplayName(e.target.value)} placeholder="Server profile name" />
              <button className="rounded border px-2 py-1" onClick={saveProfile} disabled={!activeServerId}>Save profile</button>
            </div>
            <div className="mt-2 text-muted-foreground">{status}</div>
            <div className="mt-1 text-muted-foreground">
              WS: {wsConnected ? "connected" : wsReconnecting ? "reconnecting..." : "disconnected"}
            </div>
            {!hasDesktopBridge ? (
              <div className="mt-1 text-destructive">
                Desktop voice bridge not detected. Reinstall/update `voip-desktop-client`.
              </div>
            ) : null}
            {error ? <div className="mt-1 text-destructive">{error}</div> : null}
          </div>
        )}
        <ChannelSidebar
          serverName={servers.find((s) => s.id === activeServerId)?.name || "No Server"}
          categories={categories}
          activeChannelId={activeChannelId}
          onChannelSelect={handleChannelSelect}
          voiceUsers={voiceUsers}
        />
        <UserPanel
          user={currentUser}
          isMuted={isMuted}
          isDeafened={isDeafened}
          isInVoice={isInVoice}
          voiceChannelName={voiceChannelName}
          onToggleMute={() => {
            const next = !isMuted
            if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
            applyMute(next)
          }}
          onToggleDeafen={() => {
            const next = !isDeafened
            applyDeafen(next)
          }}
          onToggleVoiceStats={() => setShowVoiceStatsPanel((v) => !v)}
          onDisconnect={handleDisconnect}
          voiceStatsSummary={voiceStatsSummary}
          onOpenSettings={() => {
            void openAppSettings()
          }}
        />
      </div>

      {showVoiceStatsPanel && (
        <div className="fixed bottom-24 left-20 z-20 w-[360px] rounded border border-border bg-card p-3 text-xs shadow-lg">
          <div className="mb-2 flex items-center justify-between font-semibold">
            <span className={qualityClass}>Voice connection stats</span>
            <button className="rounded border px-2 py-0.5" onClick={() => setShowVoiceStatsPanel(false)}>Close</button>
          </div>
          {voiceStats ? (
            <div className="text-[11px] text-muted-foreground">
              <div>Voice: {voiceStats.connected ? "connected" : "disconnected"} | Speaking now: {isSpeakingNow ? "yes" : "no"}</div>
              <div>TX: {voiceStats.txPackets ?? 0} | RX: {voiceStats.rxPackets ?? 0}</div>
              <div>Lost: {voiceStats.rxLostEstimated ?? 0} ({voiceStats.packetLossPct ?? 0}%)</div>
              <div className={qualityClass}>Ping now: {voiceStats.pingNowMs ?? 0} ms | Jitter now: {voiceStats.jitterNowMs ?? 0} ms</div>
              <div className={qualityClass}>Ping 1%: {voiceStats.ping1PctMs ?? 0} ms | Ping 0.1%: {voiceStats.ping01PctMs ?? 0} ms</div>
              <div className={qualityClass}>Jitter 1%: {voiceStats.jitter1PctMs ?? 0} ms | Jitter 0.1%: {voiceStats.jitter01PctMs ?? 0} ms</div>
            </div>
          ) : (
            <div className="text-muted-foreground">No stats yet. Join a voice room and wait 1-2 seconds.</div>
          )}
        </div>
      )}

      {showAppSettings && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
          <div className="w-[760px] max-w-full rounded border border-border bg-card p-4 text-xs shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">User settings</div>
              <button className="rounded border px-2 py-1" onClick={() => setShowAppSettings(false)}>
                Close
              </button>
            </div>
            <div className="mb-3 flex gap-2">
              <button
                className={`rounded border px-2 py-1 ${appSettingsTab === "voice" ? "bg-muted" : ""}`}
                onClick={() => setAppSettingsTab("voice")}
              >
                Voice & Video
              </button>
              <button
                className={`rounded border px-2 py-1 ${appSettingsTab === "keybinds" ? "bg-muted" : ""}`}
                onClick={() => setAppSettingsTab("keybinds")}
              >
                Keybinds
              </button>
            </div>

            {appSettingsTab === "voice" && (
              <div className="space-y-3">
                <div>
                  <div className="mb-1 text-muted-foreground">Input device</div>
                  <select
                    className="w-full rounded border px-2 py-1"
                    value={selectedDevices.inputId ?? ""}
                    onChange={(e) => setSelectedDevices((prev) => ({ ...prev, inputId: e.target.value || null }))}
                  >
                    <option value="">Default</option>
                    {audioDevices.input.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Output device</div>
                  <select
                    className="w-full rounded border px-2 py-1"
                    value={selectedDevices.outputId ?? ""}
                    onChange={(e) => setSelectedDevices((prev) => ({ ...prev, outputId: e.target.value || null }))}
                  >
                    <option value="">Default</option>
                    {audioDevices.output.map((d) => (
                      <option key={d.id} value={d.id}>{d.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Input volume: {micVolumePct}%</div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={micVolumePct}
                    onChange={(e) => setMicVolumePct(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div>
                  <div className="mb-1 text-muted-foreground">Output volume: {outputVolumePct}%</div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={outputVolumePct}
                    onChange={(e) => setOutputVolumePct(Number(e.target.value))}
                    className="w-full"
                  />
                </div>
                <label className="flex items-center gap-2 text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={noiseSuppressionEnabled}
                    onChange={(e) => setNoiseSuppressionEnabled(e.target.checked)}
                  />
                  Active noise suppression (AEC/NS/AGC)
                </label>
                <button className="rounded border px-2 py-1" onClick={saveAudioSettings}>Apply</button>
                {deviceError ? <div className="mt-2 text-destructive">{deviceError}</div> : null}
              </div>
            )}

            {appSettingsTab === "keybinds" && (
              <div className="space-y-3">
                <div className="text-muted-foreground">Global OS shortcuts (Electron format, e.g. Ctrl+Shift+M)</div>
                <div className="grid grid-cols-[180px_1fr] items-center gap-2">
                  <div>Toggle Mute</div>
                  <input
                    className="rounded border px-2 py-1"
                    value={keybindDraft.toggleMute}
                    onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleMute: e.target.value }))}
                    placeholder="Ctrl+Shift+M"
                  />
                  <div>Toggle Deafen</div>
                  <input
                    className="rounded border px-2 py-1"
                    value={keybindDraft.toggleDeafen}
                    onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleDeafen: e.target.value }))}
                    placeholder="Ctrl+Shift+D"
                  />
                  <div>Push To Talk (pulse)</div>
                  <input
                    className="rounded border px-2 py-1"
                    value={keybindDraft.pushToTalk}
                    onChange={(e) => setKeybindDraft((prev) => ({ ...prev, pushToTalk: e.target.value }))}
                    placeholder="Ctrl+Shift+V"
                  />
                </div>
                <div className="flex gap-2">
                  <button className="rounded border px-2 py-1" onClick={saveKeybinds}>Save keybinds</button>
                  <button className="rounded border px-2 py-1" onClick={clearKeybinds}>Clear</button>
                </div>
                <div className="text-muted-foreground">
                  Active: mute={keybinds.toggleMute ?? "none"}, deafen={keybinds.toggleDeafen ?? "none"}, ptt={keybinds.pushToTalk ?? "none"}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showServerSettings && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
          <div className="w-[720px] max-w-full rounded border border-border bg-card p-4 text-xs shadow-lg">
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-semibold">Server settings</div>
              <button className="rounded border px-2 py-1" onClick={() => setShowServerSettings(false)}>
                Close
              </button>
            </div>
            <div className="mb-3 flex gap-2">
              <button
                className={`rounded border px-2 py-1 ${serverSettingsTab === "general" ? "bg-muted" : ""}`}
                onClick={() => setServerSettingsTab("general")}
              >
                General
              </button>
              <button
                className={`rounded border px-2 py-1 ${serverSettingsTab === "channels" ? "bg-muted" : ""}`}
                onClick={() => setServerSettingsTab("channels")}
              >
                Channels
              </button>
              <button
                className={`rounded border px-2 py-1 ${serverSettingsTab === "roles" ? "bg-muted" : ""}`}
                onClick={() => setServerSettingsTab("roles")}
              >
                Roles
              </button>
            </div>

            {serverSettingsTab === "general" && (
              <div className="space-y-2 text-muted-foreground">
                <div>Server: {servers.find((s) => s.id === activeServerId)?.name ?? "Unknown"}</div>
                <div>ID: {activeServerId}</div>
                <div>General server moderation/admin settings will live here.</div>
              </div>
            )}

            {serverSettingsTab === "channels" && (
              <div className="space-y-3">
                <div className="text-muted-foreground">
                  Room/channel creation moved here. Only admins can create/edit channels.
                </div>
                <div className="flex gap-2">
                  <input
                    className="w-40 rounded border px-2 py-1"
                    value={roomNameInput}
                    onChange={(e) => setRoomNameInput(e.target.value)}
                    placeholder="Channel name"
                    disabled
                  />
                  <select
                    className="w-24 rounded border px-2 py-1"
                    value={roomKindInput}
                    onChange={(e) => setRoomKindInput(e.target.value as "voice" | "text")}
                    disabled
                  >
                    <option value="voice">voice</option>
                    <option value="text">text</option>
                  </select>
                  <button className="rounded border px-2 py-1" disabled>
                    Create channel
                  </button>
                </div>
                <div className="max-h-52 overflow-auto rounded border p-2">
                  {allChannels.length === 0 ? (
                    <div className="text-muted-foreground">No channels.</div>
                  ) : (
                    allChannels.map((ch) => (
                      <div key={ch.id} className="mb-1 flex items-center justify-between rounded border px-2 py-1">
                        <span>
                          {ch.type === "voice" ? "Voice" : "Text"}: {ch.name}
                        </span>
                        <span className="text-muted-foreground">{ch.id.slice(0, 8)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {serverSettingsTab === "roles" && (
              <div className="text-muted-foreground">
                Role permissions (channel access, moderation, speaking/mute controls) will be configured here.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Chat Area */}
      {activeServerId ? (
        <ChatArea
          channelName={activeChannel?.name || "general"}
          channelType={activeChannel?.type || "text"}
          messages={messages}
          onSendMessage={handleSendMessage}
          canSend={Boolean(activeServerId && activeChannelId && isTextChannel)}
          showMemberList={showMemberList}
          onToggleMemberList={() => setShowMemberList(!showMemberList)}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center bg-background text-sm text-muted-foreground">
          Connect and join a server to open chat and voice channels.
        </div>
      )}

      {/* Member List */}
      {showMemberList && (
        <MemberList members={members} roles={[]} />
      )}
    </main>
  )
}
