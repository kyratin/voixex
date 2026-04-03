"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Buffer } from "buffer"
import { ServerSidebar } from "@/components/voip/server-sidebar"
import { ChannelSidebar, type ChannelCategory } from "@/components/voip/channel-sidebar"
import { UserPanel } from "@/components/voip/user-panel"
import { ChatArea, type Message } from "@/components/voip/chat-area"
import { MemberList, type Member } from "@/components/voip/member-list"
import { VoipClient, type RealtimeState } from "@/lib/voip-client"
import { getPeerVolume, setPeerVolumeStored } from "@/lib/peer-volume-storage"
import { resampleFloat32Chunk, resampleInt16Frame } from "@/lib/voice-resample"
import { VoicePlayoutPrefetch, loadVoicePlaybackWorklet } from "@/lib/voice-playout"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Monitor, MonitorOff, Users, ExternalLink, EyeOff, ChevronDown, Wifi, WifiOff, Headphones, Server, ScreenShare, BarChart3 } from "lucide-react"

export default function VoIPApp() {
  type SavedServerProfile = {
    serverId: string
    serverName: string
    apiHost: string
    apiPort: string
    serverPassword: string
    displayName: string
    superuserPassword?: string
  }
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
    capturePumpGainNode: GainNode
    monitorDestNode: MediaStreamAudioDestinationNode
    playbackCtx: AudioContext
    playbackWorklet: AudioWorkletNode
    playoutPrefetch: VoicePlayoutPrefetch
    playbackFilterNode: BiquadFilterNode
    outputGainNode: GainNode
    monitorSourceNode: MediaStreamAudioSourceNode
    monitorGainNode: GainNode
    txRemainder: Int16Array
    txResampleInput: Float32Array
    txResamplePos: number
    playbackSampleRate: number
    unsubscribeIncoming: (() => void) | null
    unsubscribeScreenChunk: (() => void) | null
    lastIncomingAudioAtMs: number
    playbackIdleTimer: ReturnType<typeof setInterval> | null
    captureGateOpenUntilMs: number
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
  /** Bumps when peer volume localStorage changes so sidebar sliders re-read stored values. */
  const [peerVolumeRevision, setPeerVolumeRevision] = useState(0)
  const [myVoiceClientId, setMyVoiceClientId] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [status, setStatus] = useState("Disconnected")
  const [error, setError] = useState("")
  const [joining, setJoining] = useState(false)
  const [connectedToApi, setConnectedToApi] = useState(false)
  const [showConnectPanel, setShowConnectPanel] = useState(false)
  /** User-defined label in the server list (sidebar). Falls back to API server name if left empty when connecting. */
  const [connectServerListName, setConnectServerListName] = useState("")
  const [roomNameInput, setRoomNameInput] = useState("new-room")
  const [roomKindInput, setRoomKindInput] = useState<"voice" | "text">("voice")
  const [creatingChannel, setCreatingChannel] = useState(false)
  const [voiceStats, setVoiceStats] = useState<VoiceRuntimeStats | null>(null)
  const [audioPipelineDiag, setAudioPipelineDiag] = useState<{
    captureSampleRate: number
    playbackSampleRate: number
    playoutBufferedSamples: number
    playoutUnderruns: number
    playoutOverflowDrops: number
  } | null>(null)
  const voicePlayoutBufferedRef = useRef(0)
  const [isSpeakingNow, setIsSpeakingNow] = useState(false)
  const [hasDesktopBridge, setHasDesktopBridge] = useState(false)
  const [showVoiceStatsPanel, setShowVoiceStatsPanel] = useState(false)
  const [showAppSettings, setShowAppSettings] = useState(false)
  const [appSettingsTab, setAppSettingsTab] = useState<"voice" | "keybinds" | "server_general" | "server_channels" | "server_roles">("voice")
  const [audioDevices, setAudioDevices] = useState<{ input: AudioDevice[]; output: AudioDevice[] }>({ input: [], output: [] })
  const [selectedDevices, setSelectedDevices] = useState<{ inputId: string | null; outputId: string | null }>({
    inputId: null,
    outputId: null
  })
  const [wsConnected, setWsConnected] = useState(false)
  const [wsReconnecting, setWsReconnecting] = useState(false)
  /** WebSocket for voice signaling when UI and voice use different servers. */
  const [voiceSigWsConnected, setVoiceSigWsConnected] = useState(false)
  const [deviceError, setDeviceError] = useState("")
  const [audioDevicesRevision, setAudioDevicesRevision] = useState(0)
  const [micVolumePct, setMicVolumePct] = useState(100)
  const [outputVolumePct, setOutputVolumePct] = useState(100)
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(true)
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(true)
  const [autoGainControlEnabled, setAutoGainControlEnabled] = useState(true)
  const [useOpusUplink, setUseOpusUplink] = useState(false)
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [monitorVolumePct, setMonitorVolumePct] = useState(15)
  const [gateEnabled, setGateEnabled] = useState(false)
  const [gateThreshold, setGateThreshold] = useState(150)
  const [gateReleaseMs, setGateReleaseMs] = useState(180)
  const [playbackGateEnabled, setPlaybackGateEnabled] = useState(false)
  const [playbackGateThreshold, setPlaybackGateThreshold] = useState(96)
  const [playbackHighpassEnabled, setPlaybackHighpassEnabled] = useState(false)
  const [playbackHighpassHz, setPlaybackHighpassHz] = useState(85)
  const [playbackLimiterEnabled, setPlaybackLimiterEnabled] = useState(true)
  const [micMeter, setMicMeter] = useState<{ rms: number; peak: number } | null>(null)
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
  const [savedServers, setSavedServers] = useState<SavedServerProfile[]>([])
  const [isScreenSharing, setIsScreenSharing] = useState(false)
  const [activeScreenSharerName, setActiveScreenSharerName] = useState("")
  const [screenImageUrl, setScreenImageUrl] = useState<string | null>(null)
  const [screenVideoUrl, setScreenVideoUrl] = useState<string | null>(null)
  const [localScreenPreviewUrl, setLocalScreenPreviewUrl] = useState<string | null>(null)
  const [screenSources, setScreenSources] = useState<Array<{ id: string; name: string }>>([])
  const [selectedScreenSourceId, setSelectedScreenSourceId] = useState<string | null>(null)
  const [screenResolution, setScreenResolution] = useState("1280x720")
  const [screenFps, setScreenFps] = useState(30)
  const [screenBitrateKbps, setScreenBitrateKbps] = useState(3500)
  const [showingStreamWindow, setShowingStreamWindow] = useState(false)
  const screenShareTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const screenCaptureStreamRef = useRef<MediaStream | null>(null)
  const screenMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const localPreviewVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteStreamVideoRef = useRef<HTMLVideoElement | null>(null)
  const remoteMediaSourceRef = useRef<MediaSource | null>(null)
  const remoteSourceBufferRef = useRef<SourceBuffer | null>(null)
  const remoteAppendQueueRef = useRef<ArrayBuffer[]>([])
  const remoteMseUpdateEndRef = useRef<(() => void) | null>(null)
  const screenEncodeInFlightRef = useRef(false)
  const streamWindowRef = useRef<Window | null>(null)
  /** Tracks from captureStream() fed to the popup; must be stopped when switching modes or closing. */
  const popupMirrorStreamRef = useRef<MediaStream | null>(null)
  const lastPopupMirrorVideoUrlRef = useRef<string | null>(null)
  const renderStreamWindowRef = useRef<() => void>(() => {})
  const currentVoiceChannelRef = useRef("")
  const isScreenSharingRef = useRef(false)
  const screenRecorderResyncAtRef = useRef(0)
  const screenRecorderRestartingRef = useRef(false)
  const lastViewerScreenResyncReqRef = useRef<{ room: string; at: number } | null>(null)
  const lastWsVoiceJoinSyncRef = useRef<{ room: string; at: number } | null>(null)
  const resetRemoteStreamPlaybackRef = useRef<() => void>(() => {})
  const lastLocalPreviewUpdateAtRef = useRef(0)
  const uiClient = useMemo(() => new VoipClient(), [])
  const voiceClient = useMemo(() => new VoipClient(), [])
  /** Server where the user is in a voice channel; empty when not in voice. */
  const [voiceServerId, setVoiceServerId] = useState("")
  const activeServerIdRef = useRef("")
  const voiceServerIdRef = useRef("")
  const latestUiStateRef = useRef<RealtimeState | null>(null)
  const latestVoiceStateRef = useRef<RealtimeState | null>(null)
  const voicePipelineRef = useRef<VoicePipelineRuntime | null>(null)
  const mutedRef = useRef(isMuted)
  const deafenedRef = useRef(isDeafened)
  const micVolumePctRef = useRef(micVolumePct)
  const outputVolumePctRef = useRef(outputVolumePct)
  const monitorEnabledRef = useRef(monitorEnabled)
  const monitorVolumePctRef = useRef(monitorVolumePct)
  const gateEnabledRef = useRef(gateEnabled)
  const gateThresholdRef = useRef(gateThreshold)
  const gateReleaseMsRef = useRef(gateReleaseMs)
  const playbackGateEnabledRef = useRef(playbackGateEnabled)
  const playbackGateThresholdRef = useRef(playbackGateThreshold)
  const playbackHighpassEnabledRef = useRef(playbackHighpassEnabled)
  const playbackHighpassHzRef = useRef(playbackHighpassHz)
  const playbackLimiterEnabledRef = useRef(playbackLimiterEnabled)
  const pttTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoConnectAttemptedRef = useRef(false)
  /** Serializes sidebar server switches so disconnect + connect never overlap. */
  const serverSwitchChainRef = useRef<Promise<void>>(Promise.resolve())
  const connectedToApiRef = useRef(false)
  const wsConnectedRef = useRef(false)

  const currentUser = useMemo(
    () => ({
  id: "me",
      name: profileDisplayName,
      avatar: profileDisplayName.slice(0, 1).toUpperCase() || "U",
  status: "online" as const
    }),
    [profileDisplayName]
  )

  connectedToApiRef.current = connectedToApi
  wsConnectedRef.current = wsConnected

  activeServerIdRef.current = activeServerId
  voiceServerIdRef.current = voiceServerId
  const isVoiceSplit =
    Boolean(isInVoice && voiceServerId && activeServerId && voiceServerId !== activeServerId)

  const getVoiceWsClient = () => {
    const vs = voiceServerIdRef.current
    const act = activeServerIdRef.current
    if (vs && act && vs !== act) return voiceClient
    return uiClient
  }

  const getVoiceWsClientRef = useRef(getVoiceWsClient)
  getVoiceWsClientRef.current = getVoiceWsClient

  const peerVolTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const peerVolServerId = voiceServerId || activeServerId
  const peerVolumePct = useMemo(() => {
    if (!peerVolServerId) return {}
    const out: Record<string, number> = {}
    for (const roomId of Object.keys(voiceUsers)) {
      for (const u of voiceUsers[roomId] ?? []) {
        out[`${roomId}:${u.id}`] = getPeerVolume(peerVolServerId, roomId, u.id, u.name)
      }
    }
    return out
  }, [peerVolServerId, voiceUsers, peerVolumeRevision])

  const peerVolRosterSig = useMemo(() => {
    if (!peerVolServerId) return ""
    const parts: string[] = []
    for (const roomId of Object.keys(voiceUsers).sort()) {
      const ids = (voiceUsers[roomId] ?? [])
        .map((u) => u.id)
        .sort()
        .join(",")
      parts.push(`${roomId}:${ids}`)
    }
    return parts.join("|")
  }, [peerVolServerId, voiceUsers])

  const handlePeerVolumeChange = useCallback((roomId: string, targetClientId: string, targetName: string, volumePct: number) => {
    const sid = voiceServerIdRef.current || activeServerIdRef.current
    if (!sid || !roomId) return
    const nextVolume = Number.isFinite(volumePct) ? Math.max(0, Math.min(200, Math.round(volumePct))) : 100
    setPeerVolumeStored(sid, roomId, targetClientId, targetName, nextVolume)
    setPeerVolumeRevision((r) => r + 1)
    const timerKey = `${roomId}:${targetClientId}`
    const prev = peerVolTimersRef.current[timerKey]
    if (prev) clearTimeout(prev)
    peerVolTimersRef.current[timerKey] = setTimeout(() => {
      getVoiceWsClientRef.current().setPeerVolume(roomId, targetClientId, nextVolume)
      delete peerVolTimersRef.current[timerKey]
    }, 100)
  }, [])

  useEffect(() => {
    return () => {
      for (const t of Object.values(peerVolTimersRef.current)) {
        clearTimeout(t)
      }
    }
  }, [])

  const isInVoiceRef = useRef(isInVoice)
  useEffect(() => {
    isInVoiceRef.current = isInVoice
  }, [isInVoice])

  useEffect(() => {
    const key = "voip-client-id"
    const existing = localStorage.getItem(key)
    if (!existing) localStorage.setItem(key, crypto.randomUUID())
    const savedNick = localStorage.getItem("voip-last-display-name")
    if (savedNick && savedNick.trim()) {
      setDisplayNameInput(savedNick)
      setProfileDisplayName(savedNick)
    }

    const applyMerged = () => {
      const u = latestUiStateRef.current
      if (!u) return
      const split =
        Boolean(voiceServerIdRef.current && activeServerIdRef.current && voiceServerIdRef.current !== activeServerIdRef.current)
      const v = latestVoiceStateRef.current

      setCategories(uiClient.toSidebarCategories())
      const uVu = uiClient.toVoiceUsers()
      const vVu = split && v ? voiceClient.toVoiceUsers() : {}
      setVoiceUsers({ ...uVu, ...vVu })

      const voiceWs = split ? voiceClient : uiClient
      setMyVoiceClientId(voiceWs.getMeState()?.clientId ?? null)

      setWsConnected(u.connection.wsConnected)
      setWsReconnecting(u.connection.reconnecting)
      if (split && v) {
        setVoiceSigWsConnected(v.connection.wsConnected)
      } else {
        setVoiceSigWsConnected(false)
      }

      if (u.me?.displayName) {
        setProfileDisplayName(u.me.displayName)
      }
      setCanManageServer(Boolean(u.me?.permissions?.manage_server))

      const onlineByClientId = new Map<string, { clientId: string; displayName: string }>()
      for (const member of u.lobby) {
        onlineByClientId.set(member.clientId, { clientId: member.clientId, displayName: member.displayName })
      }
      for (const users of Object.values(u.rosterByRoom)) {
        for (const member of users) {
          onlineByClientId.set(member.clientId, { clientId: member.clientId, displayName: member.displayName })
        }
      }
      setMembers(
        Array.from(onlineByClientId.values())
          .sort((a, b) => {
            const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
            if (byName !== 0) return byName
            return a.clientId.localeCompare(b.clientId)
          })
          .map((m) => ({
            id: m.clientId,
            name: m.displayName,
            avatar: m.displayName.slice(0, 1).toUpperCase(),
            status: "online",
            roles: []
          }))
      )

      const activeMessages = uiClient.getMessagesState(activeChannelId)
      setMessages(
        activeMessages.map((m) => ({
          id: m.id,
          author: { id: m.author.clientId, name: m.author.displayName, avatar: m.author.displayName.slice(0, 1).toUpperCase() || "U" },
          content: m.body,
          timestamp: new Date(m.createdAt),
          attachments: m.attachments
        }))
      )

      const screenState = split && v ? v : u
      const activeSharerId = currentVoiceChannel ? screenState.activeScreenShareByRoom[currentVoiceChannel] : null
      if (activeSharerId) {
        const inLobby = screenState.lobby.find((x) => x.clientId === activeSharerId)
        if (inLobby) {
          setActiveScreenSharerName(inLobby.displayName)
        } else {
          let name = activeSharerId
          for (const users of Object.values(screenState.rosterByRoom)) {
            const found = users.find((x) => x.clientId === activeSharerId)
            if (found) {
              name = found.displayName
              break
            }
          }
          setActiveScreenSharerName(name)
        }
      } else {
        setActiveScreenSharerName("")
      }
    }

    const unsubUi = uiClient.subscribe((state) => {
      latestUiStateRef.current = state
      applyMerged()
    })
    const unsubVoice = voiceClient.subscribe((state) => {
      latestVoiceStateRef.current = state
      applyMerged()
    })
    return () => {
      unsubUi()
      unsubVoice()
    }
  }, [uiClient, voiceClient, activeChannelId, currentVoiceChannel])

  useEffect(() => {
    currentVoiceChannelRef.current = currentVoiceChannel
  }, [currentVoiceChannel])

  useEffect(() => {
    isScreenSharingRef.current = isScreenSharing
  }, [isScreenSharing])

  const wsForVoiceJoin = isVoiceSplit ? voiceSigWsConnected : wsConnected

  useEffect(() => {
    if (!hasDesktopBridge || !wsForVoiceJoin || !isInVoice || !peerVolServerId) return
    const ws = getVoiceWsClientRef.current()
    const me = ws.getMeState()?.clientId
    if (!me) return
    for (const roomId of Object.keys(voiceUsers)) {
      for (const u of voiceUsers[roomId] ?? []) {
        if (u.id === me) continue
        const pct = getPeerVolume(peerVolServerId, roomId, u.id, u.name)
        ws.setPeerVolume(roomId, u.id, pct)
      }
    }
  }, [hasDesktopBridge, wsForVoiceJoin, isInVoice, peerVolServerId, peerVolRosterSig])

  useEffect(() => {
    // WS may reconnect while desktop voice transport keeps running;
    // re-send join_room so server routes screen chunks to this viewer.
    if (!wsForVoiceJoin || !isInVoice || !currentVoiceChannel) return
    const now = Date.now()
    const prev = lastWsVoiceJoinSyncRef.current
    if (prev && prev.room === currentVoiceChannel && now - prev.at < 3000) return
    lastWsVoiceJoinSyncRef.current = { room: currentVoiceChannel, at: now }
    getVoiceWsClient().joinRoom(currentVoiceChannel)
  }, [wsForVoiceJoin, isVoiceSplit, wsConnected, isInVoice, currentVoiceChannel, uiClient, voiceClient])

  useEffect(() => {
    const raw = localStorage.getItem("voixex-saved-servers")
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as SavedServerProfile[]
      if (!Array.isArray(parsed)) return
      const valid = parsed.filter(
        (s) =>
          typeof s.serverId === "string" &&
          typeof s.serverName === "string" &&
          typeof s.apiHost === "string" &&
          typeof s.apiPort === "string" &&
          typeof s.serverPassword === "string" &&
          typeof s.displayName === "string"
      )
      if (valid.length === 0) return
      setSavedServers(valid)
      setServers(valid.map((s) => ({ id: s.serverId, name: s.serverName, icon: s.serverName.slice(0, 1).toUpperCase() || "S" })))
      const lastServerId = localStorage.getItem("voixex-last-server-id")
      const preferred = valid.find((s) => s.serverId === lastServerId) ?? valid[0]
      setActiveServerId(preferred.serverId)
      setApiHost(preferred.apiHost)
      setApiPort(preferred.apiPort)
      setServerPassword(preferred.serverPassword)
      setDisplayNameInput(preferred.displayName)
      setProfileDisplayName(preferred.displayName)
      setSuperuserPasswordInput(preferred.superuserPassword ?? "")
      setConnectServerListName(preferred.serverName)
    } catch {
      // ignore malformed saved server payload
    }
  }, [])

  useEffect(() => {
    setHasDesktopBridge(Boolean(window.electronVoice))
  }, [])

  useEffect(() => {
    if (!hasDesktopBridge) return
    if (autoConnectAttemptedRef.current) return
    if (savedServers.length === 0) return
    const lastServerId = localStorage.getItem("voixex-last-server-id")
    const preferred = savedServers.find((s) => s.serverId === lastServerId) ?? savedServers[0]
    autoConnectAttemptedRef.current = true
    void connectAndJoin(preferred)
  }, [hasDesktopBridge, savedServers])

  useEffect(() => {
    const raw = localStorage.getItem("voip-audio-settings")
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as {
        micVolumePct?: number
        outputVolumePct?: number
        noiseSuppressionEnabled?: boolean
        echoCancellationEnabled?: boolean
        autoGainControlEnabled?: boolean
        monitorEnabled?: boolean
        monitorVolumePct?: number
        gateEnabled?: boolean
        gateThreshold?: number
        gateReleaseMs?: number
        playbackGateEnabled?: boolean
        playbackGateThreshold?: number
        playbackHighpassEnabled?: boolean
        playbackHighpassHz?: number
        playbackLimiterEnabled?: boolean
        useOpusUplink?: boolean
      }
      if (typeof parsed.micVolumePct === "number") setMicVolumePct(Math.max(0, Math.min(200, Math.round(parsed.micVolumePct))))
      if (typeof parsed.outputVolumePct === "number") setOutputVolumePct(Math.max(0, Math.min(200, Math.round(parsed.outputVolumePct))))
      if (typeof parsed.noiseSuppressionEnabled === "boolean") setNoiseSuppressionEnabled(parsed.noiseSuppressionEnabled)
      if (typeof parsed.echoCancellationEnabled === "boolean") setEchoCancellationEnabled(parsed.echoCancellationEnabled)
      else if (typeof parsed.noiseSuppressionEnabled === "boolean") setEchoCancellationEnabled(parsed.noiseSuppressionEnabled)
      if (typeof parsed.autoGainControlEnabled === "boolean") setAutoGainControlEnabled(parsed.autoGainControlEnabled)
      else if (typeof parsed.noiseSuppressionEnabled === "boolean") setAutoGainControlEnabled(parsed.noiseSuppressionEnabled)
      if (typeof parsed.monitorEnabled === "boolean") setMonitorEnabled(parsed.monitorEnabled)
      if (typeof parsed.monitorVolumePct === "number") setMonitorVolumePct(Math.max(0, Math.min(200, Math.round(parsed.monitorVolumePct))))
      if (typeof parsed.gateEnabled === "boolean") setGateEnabled(parsed.gateEnabled)
      if (typeof parsed.gateThreshold === "number") setGateThreshold(Math.max(0, Math.min(4000, Math.round(parsed.gateThreshold))))
      if (typeof parsed.gateReleaseMs === "number") setGateReleaseMs(Math.max(0, Math.min(2000, Math.round(parsed.gateReleaseMs))))
      if (typeof parsed.playbackGateEnabled === "boolean") setPlaybackGateEnabled(parsed.playbackGateEnabled)
      if (typeof parsed.playbackGateThreshold === "number") {
        setPlaybackGateThreshold(Math.max(0, Math.min(2000, Math.round(parsed.playbackGateThreshold))))
      }
      if (typeof parsed.playbackHighpassEnabled === "boolean") setPlaybackHighpassEnabled(parsed.playbackHighpassEnabled)
      if (typeof parsed.playbackHighpassHz === "number") {
        setPlaybackHighpassHz(Math.max(20, Math.min(240, Math.round(parsed.playbackHighpassHz))))
      }
      if (typeof parsed.playbackLimiterEnabled === "boolean") setPlaybackLimiterEnabled(parsed.playbackLimiterEnabled)
      if (typeof parsed.useOpusUplink === "boolean") setUseOpusUplink(parsed.useOpusUplink)
    } catch {
      // ignore broken localStorage payload
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(
      "voip-audio-settings",
      JSON.stringify({
        micVolumePct,
        outputVolumePct,
        noiseSuppressionEnabled,
        echoCancellationEnabled,
        autoGainControlEnabled,
        monitorEnabled,
        monitorVolumePct,
        gateEnabled,
        gateThreshold,
        gateReleaseMs,
        playbackGateEnabled,
        playbackGateThreshold,
        playbackHighpassEnabled,
        playbackHighpassHz,
        playbackLimiterEnabled,
        useOpusUplink
      })
    )
  }, [
    micVolumePct,
    outputVolumePct,
    noiseSuppressionEnabled,
    echoCancellationEnabled,
    autoGainControlEnabled,
    monitorEnabled,
    monitorVolumePct,
    gateEnabled,
    gateThreshold,
    gateReleaseMs,
    playbackGateEnabled,
    playbackGateThreshold,
    playbackHighpassEnabled,
    playbackHighpassHz,
    playbackLimiterEnabled,
    useOpusUplink
  ])

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

  useEffect(() => {
    micVolumePctRef.current = micVolumePct
    const rt = voicePipelineRef.current
    if (rt) rt.micGainNode.gain.value = micVolumePct / 100
  }, [micVolumePct])

  useEffect(() => {
    outputVolumePctRef.current = outputVolumePct
    const rt = voicePipelineRef.current
    if (rt) rt.outputGainNode.gain.value = outputVolumePct / 100
  }, [outputVolumePct])

  useEffect(() => {
    monitorEnabledRef.current = monitorEnabled
    monitorVolumePctRef.current = monitorVolumePct
    const rt = voicePipelineRef.current
    if (!rt) return
    rt.monitorGainNode.gain.value = monitorEnabled ? monitorVolumePct / 100 : 0
    if (monitorEnabled && monitorVolumePct > 0) {
      void rt.playbackCtx.resume()
    } else if (voicePlayoutBufferedRef.current === 0) {
      void rt.playbackCtx.suspend()
    }
  }, [monitorEnabled, monitorVolumePct])

  useEffect(() => {
    gateEnabledRef.current = gateEnabled
    gateThresholdRef.current = gateThreshold
    gateReleaseMsRef.current = gateReleaseMs
  }, [gateEnabled, gateThreshold, gateReleaseMs])

  useEffect(() => {
    playbackGateEnabledRef.current = playbackGateEnabled
    playbackGateThresholdRef.current = playbackGateThreshold
    playbackHighpassEnabledRef.current = playbackHighpassEnabled
    playbackHighpassHzRef.current = playbackHighpassHz
    playbackLimiterEnabledRef.current = playbackLimiterEnabled
    const rt = voicePipelineRef.current
    if (!rt) return
    rt.playbackFilterNode.frequency.value = playbackHighpassEnabled ? playbackHighpassHz : 20
  }, [playbackGateEnabled, playbackGateThreshold, playbackHighpassEnabled, playbackHighpassHz, playbackLimiterEnabled])

  const stopVoicePipeline = () => {
    const runtime = voicePipelineRef.current
    if (!runtime) return
    runtime.unsubscribeIncoming?.()
    runtime.unsubscribeScreenChunk?.()
    runtime.captureNode.disconnect()
    runtime.captureSource.disconnect()
    runtime.micGainNode.disconnect()
    runtime.captureSinkNode.disconnect()
    runtime.capturePumpGainNode.disconnect()
    runtime.monitorDestNode.disconnect()
    runtime.playbackWorklet.disconnect()
    runtime.playoutPrefetch.reset()
    voicePlayoutBufferedRef.current = 0
    setAudioPipelineDiag(null)
    runtime.playbackFilterNode.disconnect()
    runtime.outputGainNode.disconnect()
    runtime.monitorSourceNode.disconnect()
    runtime.monitorGainNode.disconnect()
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

  const encodeBytesBase64 = (bytes: Uint8Array) => {
    let out = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(out)
  }

  const decodeBytesBase64 = (payload: string) => {
    const raw = atob(payload)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i)
    }
    return bytes
  }

  const stopPopupMirrorTracks = useCallback(() => {
    const s = popupMirrorStreamRef.current
    if (s) {
      s.getTracks().forEach((t) => t.stop())
      popupMirrorStreamRef.current = null
    }
    lastPopupMirrorVideoUrlRef.current = null
  }, [])

  const resetRemoteStreamPlayback = () => {
    stopPopupMirrorTracks()
    remoteAppendQueueRef.current = []
    const sb = remoteSourceBufferRef.current
    if (sb && remoteMseUpdateEndRef.current) {
      try {
        sb.removeEventListener("updateend", remoteMseUpdateEndRef.current)
      } catch {
        /* ignore */
      }
    }
    remoteMseUpdateEndRef.current = null
    remoteSourceBufferRef.current = null
    const ms = remoteMediaSourceRef.current
    remoteMediaSourceRef.current = null
    if (ms) {
      try {
        if (ms.readyState === "open") ms.endOfStream()
      } catch {
        /* ignore */
      }
    }
    setScreenVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }
  resetRemoteStreamPlaybackRef.current = resetRemoteStreamPlayback

  useEffect(() => {
    if (!currentVoiceChannel || isScreenSharing) return
    resetRemoteStreamPlaybackRef.current()
  }, [currentVoiceChannel, isScreenSharing])

  const pushRemoteVideoChunk = (chunk: Uint8Array) => {
    const buf =
      chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer
        : chunk.slice().buffer

    const isWebmInitSegment =
      chunk.length >= 4 && chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3

    if (isWebmInitSegment && remoteMediaSourceRef.current) {
      resetRemoteStreamPlayback()
    }

    const drainRemoteMse = () => {
      const sbuf = remoteSourceBufferRef.current
      if (!sbuf || sbuf.updating) return
      const q = remoteAppendQueueRef.current
      if (q.length === 0) return
      const next = q.shift()!
      try {
        sbuf.appendBuffer(next)
      } catch (e) {
        if (e instanceof DOMException && e.name === "QuotaExceededError") {
          q.unshift(next)
          try {
            if (sbuf.buffered.length > 0) {
              const a = sbuf.buffered.start(0)
              const b = sbuf.buffered.end(0)
              if (b - a > 1.2) sbuf.remove(a, a + (b - a) * 0.22)
            }
          } catch {
            /* ignore */
          }
          return
        }
        console.warn("[voixex] MSE appendBuffer failed", e)
        drainRemoteMse()
      }
    }

    remoteAppendQueueRef.current.push(buf)

    if (!remoteMediaSourceRef.current) {
      const mediaSource = new MediaSource()
      remoteMediaSourceRef.current = mediaSource
      const url = URL.createObjectURL(mediaSource)
      setScreenVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return url
      })
      mediaSource.addEventListener("sourceopen", () => {
        if (remoteSourceBufferRef.current) return
        const ms = remoteMediaSourceRef.current
        if (!ms || ms.readyState !== "open") return
        const mimeCandidates = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
        const mime = mimeCandidates.find((m) => MediaSource.isTypeSupported(m)) ?? "video/webm"
        try {
          const sbuf = ms.addSourceBuffer(mime)
          remoteSourceBufferRef.current = sbuf
          const onEnd = () => drainRemoteMse()
          remoteMseUpdateEndRef.current = onEnd
          sbuf.addEventListener("updateend", onEnd)
          drainRemoteMse()
        } catch {
          /* ignore */
        }
      })
      return
    }

    drainRemoteMse()
  }

  const pushRemoteVideoChunkRef = useRef(pushRemoteVideoChunk)
  pushRemoteVideoChunkRef.current = pushRemoteVideoChunk

  useEffect(() => {
    if (!hasDesktopBridge) return
    const c = isVoiceSplit ? voiceClient : uiClient
    return c.subscribeScreenVideoChunks((fromClientId, chunkBase64) => {
      const me = c.getMeState()
      if (me && fromClientId === me.clientId) return
      try {
        pushRemoteVideoChunkRef.current(decodeBytesBase64(chunkBase64))
      } catch {
        /* ignore */
      }
    })
  }, [hasDesktopBridge, isVoiceSplit, uiClient, voiceClient])

  useEffect(() => {
    const rt = voicePipelineRef.current
    if (!rt?.playbackWorklet) return
    if (isDeafened) {
      rt.playbackWorklet.port.postMessage({ type: "reset" })
      rt.playoutPrefetch.reset()
      voicePlayoutBufferedRef.current = 0
    }
  }, [isDeafened])

  const concatInt16 = (a: Int16Array, b: Int16Array) => {
    if (a.length === 0) return b
    if (b.length === 0) return a
    const out = new Int16Array(a.length + b.length)
    out.set(a, 0)
    out.set(b, a.length)
    return out
  }

  const applyAmplitudeGate = (frame: Int16Array, threshold: number, quietAttenuation = 0.2) => {
    if (frame.length === 0) return frame
    const gateThreshold = Math.max(8, threshold)
    const atten = Math.max(0, Math.min(1, quietAttenuation))
    const out = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const sample = frame[i]
      out[i] = Math.abs(sample) < gateThreshold ? Math.round(sample * atten) : sample
    }
    return out
  }

  const applyPlaybackNoiseGate = (frame: Int16Array, enabled: boolean, threshold: number) => {
    if (!enabled) return frame
    // Keep amplitude continuity and avoid frame-level RMS hard cuts.
    return applyAmplitudeGate(frame, Math.max(12, threshold), 0.35)
  }

  const applySoftLimiter = (frame: Int16Array, enabled: boolean) => {
    if (!enabled || frame.length === 0) return frame
    let peak = 0
    for (let i = 0; i < frame.length; i += 1) {
      const abs = Math.abs(frame[i])
      if (abs > peak) peak = abs
    }
    if (peak <= 30_000) return frame
    const drive = Math.max(0.6, 30_000 / peak)
    const out = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const x = (frame[i] / 32768) * drive * 1.35
      out[i] = Math.max(-32768, Math.min(32767, Math.round(Math.tanh(x) * 32767)))
    }
    return out
  }

  const calcFrameEnergy = (frame: Int16Array) => {
    if (frame.length === 0) return { rms: 0, peak: 0 }
    let peak = 0
    let sumSq = 0
    for (let i = 0; i < frame.length; i += 1) {
      const v = Math.abs(frame[i])
      peak = Math.max(peak, v)
      const f = frame[i] / 32768
      sumSq += f * f
    }
    const rms = Math.sqrt(sumSq / frame.length)
    return { rms, peak }
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
          echoCancellation: echoCancellationEnabled,
          noiseSuppression: noiseSuppressionEnabled,
          autoGainControl: autoGainControlEnabled
        }
        if (window.electronVoice?.requestMicrophoneAccess) {
          const micAccess = await window.electronVoice.requestMicrophoneAccess()
          if (!micAccess.granted) {
            const msg =
              "Microphone access was denied. Allow Voixex in System Settings → Privacy & Security → Microphone."
            setDeviceError(msg)
            toast.error(msg)
            return
          }
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
        micGainNode.gain.value = micVolumePctRef.current / 100
        const captureSinkNode = captureCtx.createMediaStreamDestination()
        const capturePumpGainNode = captureCtx.createGain()
        capturePumpGainNode.gain.value = 0
        const monitorDestNode = captureCtx.createMediaStreamDestination()
        const playbackWorklet = await loadVoicePlaybackWorklet(playbackCtx)
        const playoutPrefetch = new VoicePlayoutPrefetch(playbackCtx.sampleRate, playbackWorklet.port, 80)
        playbackWorklet.port.onmessage = (ev: MessageEvent) => {
          const d = ev.data as { type?: string; bufferedSamples?: number; underruns?: number; overflowDrops?: number }
          if (d?.type !== "stats") return
          voicePlayoutBufferedRef.current = d.bufferedSamples ?? 0
          setAudioPipelineDiag((prev) => ({
            captureSampleRate: voicePipelineRef.current?.captureCtx.sampleRate ?? prev?.captureSampleRate ?? 48000,
            playbackSampleRate: voicePipelineRef.current?.playbackCtx.sampleRate ?? prev?.playbackSampleRate ?? 48000,
            playoutBufferedSamples: d.bufferedSamples ?? 0,
            playoutUnderruns: d.underruns ?? 0,
            playoutOverflowDrops: d.overflowDrops ?? 0
          }))
        }
        const playbackFilterNode = playbackCtx.createBiquadFilter()
        playbackFilterNode.type = "highpass"
        playbackFilterNode.frequency.value = playbackHighpassEnabledRef.current ? playbackHighpassHzRef.current : 20
        playbackFilterNode.Q.value = 0.707
        const outputGainNode = playbackCtx.createGain()
        outputGainNode.gain.value = outputVolumePctRef.current / 100
        const monitorSourceNode = playbackCtx.createMediaStreamSource(monitorDestNode.stream)
        const monitorGainNode = playbackCtx.createGain()
        monitorGainNode.gain.value = monitorEnabledRef.current ? monitorVolumePctRef.current / 100 : 0
        const runtime: VoicePipelineRuntime = {
          stream,
          captureCtx,
          captureNode,
          captureSource,
          micGainNode,
          captureSinkNode,
          capturePumpGainNode,
          monitorDestNode,
          playbackCtx,
          playbackWorklet,
          playoutPrefetch,
          playbackFilterNode,
          outputGainNode,
          monitorSourceNode,
          monitorGainNode,
          txRemainder: new Int16Array(0),
          txResampleInput: new Float32Array(0),
          txResamplePos: 0,
          playbackSampleRate: playbackCtx.sampleRate,
          unsubscribeIncoming: null,
          unsubscribeScreenChunk: null,
          lastIncomingAudioAtMs: 0,
          playbackIdleTimer: null,
          captureGateOpenUntilMs: 0
        }
        voicePipelineRef.current = runtime
        voicePlayoutBufferedRef.current = 0
        setAudioPipelineDiag({
          captureSampleRate: captureCtx.sampleRate,
          playbackSampleRate: playbackCtx.sampleRate,
          playoutBufferedSamples: 0,
          playoutUnderruns: 0,
          playoutOverflowDrops: 0
        })

        const frameSize = 960
        let opusEncoder: unknown = null
        if (useOpusUplink && window.electronVoice?.sendOpusFrame) {
          try {
            const mod = await import("opusscript")
            const OpusScript = (mod as unknown as { default: typeof import("opusscript") }).default
            opusEncoder = new OpusScript(48_000, 1, OpusScript.Application.AUDIO)
          } catch {
            setDeviceError("Opus encoder failed to load in renderer; falling back to PCM uplink.")
            opusEncoder = null
          }
        }
        let lastMeterEmitAt = 0
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
              let frame = merged.subarray(offset, offset + frameSize)

              const now = Date.now()
              if (now - lastMeterEmitAt >= 120) {
                lastMeterEmitAt = now
                const energy = calcFrameEnergy(frame)
                setMicMeter(energy)
              }

              if (gateEnabledRef.current) {
                const thresholdAmp = Math.max(0, Math.round(gateThresholdRef.current))
                // Amplitude-based gate for uplink: no RMS/noise-classification hard mute.
                frame = applyAmplitudeGate(frame, thresholdAmp, 0.2)
              }

              if (opusEncoder && window.electronVoice?.sendOpusFrame) {
                try {
                  const pcmBytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength)
                  const encoded = (opusEncoder as { encode: (pcm: Buffer, frameSize: number) => Uint8Array }).encode(pcmBytes, frameSize)
                  void window.electronVoice.sendOpusFrame(encodeBytesBase64(encoded))
                } catch {
                  void window.electronVoice?.sendPcm16Frame(encodePcm16Base64(frame))
                }
              } else {
                void window.electronVoice?.sendPcm16Frame(encodePcm16Base64(frame))
              }
            }
            offset += frameSize
          }
          runtime.txRemainder = merged.subarray(offset)
        }

        runtime.unsubscribeIncoming = window.electronVoice?.onPcm16Frame((pcm16Base64) => {
          if (deafenedRef.current) return
          const frame48k = decodePcm16Base64(pcm16Base64)
          const resampled = resampleInt16Frame(frame48k, 48000, runtime.playbackSampleRate)
          const gated = applyPlaybackNoiseGate(resampled, playbackGateEnabledRef.current, playbackGateThresholdRef.current)
          const frame = applySoftLimiter(gated, playbackLimiterEnabledRef.current)
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
          const floatOut = new Float32Array(frame.length)
          for (let i = 0; i < frame.length; i += 1) {
            floatOut[i] = frame[i] / 32768
          }
          runtime.playoutPrefetch.pushBlock(floatOut)
        }) ?? null
        // Screen video uses WebSocket (reliable); UDP screen path not used.
        runtime.unsubscribeScreenChunk = null

        captureSource.connect(micGainNode)
        micGainNode.connect(captureNode)
        micGainNode.connect(monitorDestNode)
        // Keep ScriptProcessor actively pulled on all platforms (especially macOS)
        // while keeping output silent to avoid sidetone.
        captureNode.connect(captureSinkNode)
        captureNode.connect(capturePumpGainNode)
        capturePumpGainNode.connect(captureCtx.destination)
        monitorSourceNode.connect(monitorGainNode)
        monitorGainNode.connect(playbackCtx.destination)
        playbackWorklet.connect(playbackFilterNode)
        playbackFilterNode.connect(outputGainNode)
        outputGainNode.connect(playbackCtx.destination)
        runtime.playbackIdleTimer = setInterval(() => {
          const idleForMs = Date.now() - runtime.lastIncomingAudioAtMs
          const monitorActive = monitorEnabledRef.current && monitorVolumePctRef.current > 0
          if (!monitorActive && voicePlayoutBufferedRef.current === 0 && idleForMs > 700 && runtime.playbackCtx.state === "running") {
            void runtime.playbackCtx.suspend()
          }
        }, 300)
        await captureCtx.resume()
        if (monitorEnabledRef.current && monitorVolumePctRef.current > 0) {
          await playbackCtx.resume()
        } else {
          await playbackCtx.suspend()
        }
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
  }, [hasDesktopBridge, isInVoice, currentVoiceChannel, audioDevicesRevision, noiseSuppressionEnabled, echoCancellationEnabled, autoGainControlEnabled])

  useEffect(() => {
    if (isInVoice) {
      setShowVoiceStatsPanel(true)
    }
  }, [isInVoice])

  useEffect(() => {
    if (!hasDesktopBridge || !window.electronVoice) return
    void window.electronVoice
      .listScreenSources()
      .then((sources) => {
        setScreenSources(sources)
        if (!selectedScreenSourceId && sources.length > 0) {
          setSelectedScreenSourceId(sources[0].id)
        }
      })
      .catch(() => {
        setScreenSources([])
      })
  }, [hasDesktopBridge, selectedScreenSourceId])

  useEffect(() => {
    const savedRes = localStorage.getItem("voixex-screen-resolution")
    const savedFps = Number(localStorage.getItem("voixex-screen-fps") || "30")
    const savedBitrate = Number(localStorage.getItem("voixex-screen-bitrate-kbps") || "3500")
    if (savedRes && /^\d+x\d+$/.test(savedRes)) setScreenResolution(savedRes)
    if (Number.isFinite(savedFps) && savedFps > 0) setScreenFps(savedFps)
    if (Number.isFinite(savedBitrate) && savedBitrate > 0) setScreenBitrateKbps(savedBitrate)
  }, [])

  useEffect(() => {
    localStorage.setItem("voixex-screen-resolution", screenResolution)
  }, [screenResolution])

  useEffect(() => {
    localStorage.setItem("voixex-screen-fps", String(screenFps))
  }, [screenFps])

  useEffect(() => {
    localStorage.setItem("voixex-screen-bitrate-kbps", String(screenBitrateKbps))
  }, [screenBitrateKbps])

  useEffect(() => {
    if (activeScreenSharerName) return
    setScreenImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resetRemoteStreamPlayback()
  }, [activeScreenSharerName])

  useEffect(() => {
    return () => {
      if (screenImageUrl) URL.revokeObjectURL(screenImageUrl)
    }
  }, [screenImageUrl])

  useEffect(() => {
    return () => {
      if (screenVideoUrl) URL.revokeObjectURL(screenVideoUrl)
    }
  }, [screenVideoUrl])

  useEffect(() => {
    return () => {
      if (localScreenPreviewUrl) URL.revokeObjectURL(localScreenPreviewUrl)
    }
  }, [localScreenPreviewUrl])

  useEffect(() => {
    renderStreamWindow()
  }, [
    screenImageUrl,
    screenVideoUrl,
    localScreenPreviewUrl,
    activeScreenSharerName,
    currentVoiceChannel,
    voiceUsers,
    isScreenSharing
  ])

  useEffect(() => {
    return () => {
      stopPopupMirrorTracks()
      if (streamWindowRef.current && !streamWindowRef.current.closed) {
        streamWindowRef.current.close()
      }
    }
  }, [stopPopupMirrorTracks])

  useEffect(() => {
    const v = remoteStreamVideoRef.current
    if (!v || !showingStreamWindow) return
    const sync = () => renderStreamWindowRef.current()
    v.addEventListener("playing", sync)
    v.addEventListener("loadeddata", sync)
    return () => {
      v.removeEventListener("playing", sync)
      v.removeEventListener("loadeddata", sync)
    }
  }, [showingStreamWindow, screenVideoUrl])

  useEffect(() => {
    if (!localPreviewVideoRef.current) return
    const video = localPreviewVideoRef.current
    video.srcObject = isScreenSharing ? screenCaptureStreamRef.current : null
    if (isScreenSharing) {
      void video.play().catch(() => {})
    }
  }, [isScreenSharing, currentVoiceChannel])

  useEffect(() => {
    if (!screenVideoUrl || isScreenSharing) return
    const v = remoteStreamVideoRef.current
    if (!v) return
    void v.play().catch(() => {})
  }, [screenVideoUrl, isScreenSharing])

  const applyMute = (next: boolean) => {
    setIsMuted(next)
    getVoiceWsClient().setMute(next)
    void window.electronVoice?.setMute(next)
    setStatus(next ? "Microphone muted" : "Microphone unmuted")
  }

  const applyDeafen = (next: boolean) => {
    setIsDeafened(next)
    getVoiceWsClient().setDeafen(next)
    void window.electronVoice?.setDeafen(next)
    setStatus(next ? "Headphones deafened" : "Headphones undeafened")
  }

  const handleSendMessage = (content: string) => {
    if (!activeServerId || !activeChannelId) return
    void uiClient.sendMessage(activeServerId, activeChannelId, content).catch((e) => {
      toast.error(e instanceof Error ? e.message : "Failed to send message")
    })
  }

  const handleUploadAttachment = async (file: File) => {
    if (!activeServerId || !activeChannelId) return
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === activeChannelId)
    if (!channel || channel.type !== "text") return
    try {
      const uploaded = await uiClient.uploadAttachment(activeServerId, activeChannelId, file)
      await uiClient.sendMessage(activeServerId, activeChannelId, "", [uploaded.attachment.id])
      toast.success("File uploaded")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed")
    }
  }

  const stopScreenShare = async () => {
    if (screenShareTimerRef.current) {
      clearInterval(screenShareTimerRef.current)
      screenShareTimerRef.current = null
    }
    if (screenMediaRecorderRef.current) {
      try {
        if (screenMediaRecorderRef.current.state !== "inactive") {
          screenMediaRecorderRef.current.stop()
        }
      } catch {
        // ignore
      }
      screenMediaRecorderRef.current = null
    }
    if (screenCaptureStreamRef.current) {
      screenCaptureStreamRef.current.getTracks().forEach((t) => t.stop())
      screenCaptureStreamRef.current = null
    }
    screenEncodeInFlightRef.current = false
    setIsScreenSharing(false)
    getVoiceWsClientRef.current().setScreenShare(false)
    setLocalScreenPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    if (localPreviewVideoRef.current) {
      localPreviewVideoRef.current.srcObject = null
    }
    setScreenImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resetRemoteStreamPlayback()
  }

  const restartScreenRecorderForLateViewers = useCallback(() => {
    if (!isScreenSharingRef.current) return
    const stream = screenCaptureStreamRef.current
    const oldRec = screenMediaRecorderRef.current
    if (!stream || !oldRec || oldRec.state !== "recording") return
    const now = Date.now()
    if (now - screenRecorderResyncAtRef.current < 1200) return
    screenRecorderResyncAtRef.current = now
    if (screenRecorderRestartingRef.current) return
    screenRecorderRestartingRef.current = true

    const mimeType =
      oldRec.mimeType && MediaRecorder.isTypeSupported(oldRec.mimeType) ? oldRec.mimeType : "video/webm"
    const bps = Math.max(600_000, Math.min(10_000_000, screenBitrateKbps * 1000))

    const onData = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return
      void event.data.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer)
        getVoiceWsClientRef.current().sendScreenVideoChunk(encodeBytesBase64(bytes))
      })
    }

    oldRec.onstop = () => {
      screenRecorderRestartingRef.current = false
      const cap = screenCaptureStreamRef.current
      if (!cap || !isScreenSharingRef.current) return
      try {
        const next = new MediaRecorder(cap, { mimeType, videoBitsPerSecond: bps })
        next.ondataavailable = onData
        next.start(250)
        screenMediaRecorderRef.current = next
      } catch {
        screenMediaRecorderRef.current = null
        void stopScreenShare()
      }
    }
    try {
      oldRec.stop()
    } catch {
      screenRecorderRestartingRef.current = false
    }
  }, [screenBitrateKbps])

  useEffect(() => {
    if (!hasDesktopBridge || !isScreenSharing) return
    const c = isVoiceSplit ? voiceClient : uiClient
    return c.subscribeScreenResyncRequests((roomId) => {
      if (roomId !== currentVoiceChannelRef.current) return
      restartScreenRecorderForLateViewers()
    })
  }, [hasDesktopBridge, isScreenSharing, isVoiceSplit, uiClient, voiceClient, restartScreenRecorderForLateViewers])

  useEffect(() => {
    if (!hasDesktopBridge || !currentVoiceChannel || isScreenSharing || !activeScreenSharerName) return
    const now = Date.now()
    const prev = lastViewerScreenResyncReqRef.current
    if (prev && prev.room === currentVoiceChannel && now - prev.at < 5000) return
    const room = currentVoiceChannel
    const timer = window.setTimeout(() => {
      lastViewerScreenResyncReqRef.current = { room, at: Date.now() }
      getVoiceWsClientRef.current().requestScreenResync(room)
    }, 400)
    return () => clearTimeout(timer)
  }, [hasDesktopBridge, currentVoiceChannel, isScreenSharing, activeScreenSharerName, isVoiceSplit])

  const renderStreamWindow = () => {
    if (!streamWindowRef.current || streamWindowRef.current.closed) return
    const title = activeScreenSharerName ? `Voixex Stream - ${activeScreenSharerName}` : "Voixex Stream"
    streamWindowRef.current.document.title = title
    const viewers = (voiceUsers[currentVoiceChannel] ?? []).map((u) => u.name).join(", ") || "none"
    const previewUrl = screenVideoUrl ?? screenImageUrl ?? localScreenPreviewUrl
    const localCapture = isScreenSharing ? screenCaptureStreamRef.current : null
    const doc = streamWindowRef.current.document
    if (!doc.getElementById("voixex-stream-root")) {
      doc.body.innerHTML = `
        <div id="voixex-stream-root" style="font-family:sans-serif;background:#111;color:#eee;margin:0;padding:12px">
          <div id="voixex-streaming" style="margin-bottom:8px"></div>
          <div id="voixex-viewers" style="margin-bottom:8px"></div>
          <video id="voixex-stream-video" autoplay muted playsinline controls style="display:none;max-width:100%;max-height:85vh;border:1px solid #444;border-radius:6px"></video>
          <div id="voixex-stream-placeholder" style="color:#999">No active stream frame.</div>
        </div>
      `
    }
    const streamingEl = doc.getElementById("voixex-streaming")
    const viewersEl = doc.getElementById("voixex-viewers")
    const imageEl = doc.getElementById("voixex-stream-video") as HTMLVideoElement | null
    const placeholderEl = doc.getElementById("voixex-stream-placeholder")
    if (streamingEl) streamingEl.textContent = `Streaming: ${activeScreenSharerName || "none"}`
    if (viewersEl) viewersEl.textContent = `Viewers: ${viewers}`
    if (imageEl && placeholderEl) {
      if (localCapture) {
        stopPopupMirrorTracks()
        if (imageEl.src) imageEl.removeAttribute("src")
        if (imageEl.srcObject !== localCapture) {
          imageEl.srcObject = localCapture
          void imageEl.play().catch(() => {})
        }
        imageEl.style.display = "block"
        placeholderEl.style.display = "none"
      } else if (screenVideoUrl && remoteStreamVideoRef.current) {
        // Blob URLs tied to MediaSource in the opener do not reliably play in a second window
        // (Steam overlay / pop-out). Mirror decoded output via captureStream from the main <video>.
        const srcVideo = remoteStreamVideoRef.current
        const mirrorFps = Math.min(60, Math.max(8, screenFps))
        const needNewMirror =
          lastPopupMirrorVideoUrlRef.current !== screenVideoUrl || imageEl.srcObject !== popupMirrorStreamRef.current
        if (needNewMirror) {
          stopPopupMirrorTracks()
          try {
            const cap = srcVideo.captureStream(mirrorFps)
            popupMirrorStreamRef.current = cap
            lastPopupMirrorVideoUrlRef.current = screenVideoUrl
            imageEl.srcObject = cap
            imageEl.removeAttribute("src")
            void imageEl.play().catch(() => {})
          } catch {
            lastPopupMirrorVideoUrlRef.current = null
            if (imageEl.srcObject) imageEl.srcObject = null
            if (previewUrl && imageEl.src !== previewUrl) {
              imageEl.src = previewUrl
              void imageEl.play().catch(() => {})
            }
          }
        } else {
          void imageEl.play().catch(() => {})
        }
        imageEl.style.display = "block"
        placeholderEl.style.display = "none"
      } else if (previewUrl) {
        stopPopupMirrorTracks()
        if (imageEl.srcObject) imageEl.srcObject = null
        if (imageEl.src !== previewUrl) {
          imageEl.src = previewUrl
          void imageEl.play().catch(() => {})
        }
        imageEl.style.display = "block"
        placeholderEl.style.display = "none"
      } else {
        stopPopupMirrorTracks()
        imageEl.srcObject = null
        imageEl.removeAttribute("src")
        imageEl.style.display = "none"
        placeholderEl.style.display = "block"
      }
    }
  }
  renderStreamWindowRef.current = renderStreamWindow

  const toggleStreamWindow = () => {
    if (streamWindowRef.current && !streamWindowRef.current.closed) {
      try {
        const v = streamWindowRef.current.document.getElementById("voixex-stream-video") as HTMLVideoElement | null
        if (v) v.srcObject = null
      } catch {
        /* ignore */
      }
      stopPopupMirrorTracks()
      streamWindowRef.current.close()
      streamWindowRef.current = null
      setShowingStreamWindow(false)
      return
    }
    const popup = window.open("", "voixex-stream-window", "width=1280,height=760")
    if (!popup) {
      setError("Unable to open stream window. Allow popups for Voixex.")
      return
    }
    streamWindowRef.current = popup
    setShowingStreamWindow(true)
    renderStreamWindow()
  }

  const startScreenShare = async () => {
    if (!hasDesktopBridge || !window.electronVoice) {
      throw new Error("Screen share is available only in the desktop client.")
    }
    if (!isInVoice || !currentVoiceChannel) {
      throw new Error("Join a voice channel first.")
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error("Screen capture API is not available in this runtime.")
    }
    if (isScreenSharing) return
    const fps = Math.max(8, Math.min(60, screenFps))
    const [targetWidthRaw, targetHeightRaw] = screenResolution.split("x").map((v) => Number(v))
    const targetWidth = Number.isFinite(targetWidthRaw) ? targetWidthRaw : 1280
    const targetHeight = Number.isFinite(targetHeightRaw) ? targetHeightRaw : 720
    const bitrateKbps = Math.max(600, Math.min(10000, screenBitrateKbps))
    await window.electronVoice.setScreenSource(selectedScreenSourceId)
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: fps,
        width: { ideal: targetWidth, max: targetWidth },
        height: { ideal: targetHeight, max: targetHeight }
      },
      audio: false
    })
    screenCaptureStreamRef.current = stream
    if (localPreviewVideoRef.current) {
      localPreviewVideoRef.current.srcObject = stream
      void localPreviewVideoRef.current.play().catch(() => {})
    }
    const mimeCandidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm"
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrateKbps * 1000
    })
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return
      void event.data.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer)
        getVoiceWsClientRef.current().sendScreenVideoChunk(encodeBytesBase64(bytes))
      })
    }
    // Server drops screen_chunk until set_screen_share(active:true) is applied; register share before any blob.
    setIsScreenSharing(true)
    getVoiceWsClientRef.current().setScreenShare(true)
    // Variant A: smaller timeslice for lower end-to-end latency (more appendBuffer work).
    recorder.start(250)
    screenMediaRecorderRef.current = recorder
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        void stopScreenShare()
      }
    })
    setStatus("Screen share started")
  }

  const handleScreenShareToggle = async () => {
    try {
      setError("")
      if (isScreenSharing) {
        await stopScreenShare()
        setStatus("Screen share stopped")
      } else {
        await startScreenShare()
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle screen share")
    }
  }

  const handleChannelSelect = async (channelId: string) => {
    setActiveChannelId(channelId)
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === channelId)
    if (channel?.type === "voice") {
      if (isScreenSharing) {
        await stopScreenShare()
      }
      if (isInVoice && voiceServerId && activeServerId && voiceServerId !== activeServerId) {
        const vopts = uiClient.getElectronVoiceConnectParams()
        if (!window.electronVoice || !vopts) {
          toast.error("Cannot join voice on this server from the current setup.")
          return
        }
        voiceClient.leaveRoom()
        voiceClient.disconnect()
        await window.electronVoice.leaveRoom()
        await window.electronVoice.connect({
          host: vopts.host,
          port: vopts.port,
          mediaToken: vopts.mediaToken
        })
        setVoiceServerId(activeServerId)
        voiceServerIdRef.current = activeServerId
        setCurrentVoiceChannel(channelId)
      setIsInVoice(true)
        isInVoiceRef.current = true
        uiClient.joinRoom(channelId)
        await window.electronVoice.joinRoom(channelId)
        setStatus(`In room: ${channel.name}`)
        return
      }
      setIsInVoice(true)
      isInVoiceRef.current = true
      setCurrentVoiceChannel(channelId)
      setVoiceServerId(activeServerId)
      voiceServerIdRef.current = activeServerId
      getVoiceWsClient().joinRoom(channelId)
      void window.electronVoice?.joinRoom(channelId)
      setStatus(`In room: ${channel.name}`)
    } else if (channel?.type === "text" && activeServerId) {
      setStatus(`Text channel: ${channel.name}`)
      await uiClient.getMessages(activeServerId, channelId)
    }
  }

  const handleDisconnect = () => {
    void stopScreenShare()
    getVoiceWsClientRef.current().leaveRoom()
    voiceClient.disconnect()
    setIsInVoice(false)
    isInVoiceRef.current = false
    setCurrentVoiceChannel("")
    setVoiceServerId("")
    voiceServerIdRef.current = ""
    stopVoicePipeline()
    void window.electronVoice?.leaveRoom()
    setStatus("Connected to server")
  }

  const fullyDisconnectFromApi = async () => {
    await stopScreenShare()
    setIsInVoice(false)
    isInVoiceRef.current = false
    setCurrentVoiceChannel("")
    setVoiceServerId("")
    voiceServerIdRef.current = ""
    stopVoicePipeline()
    uiClient.leaveRoom()
    voiceClient.leaveRoom()
    void window.electronVoice?.leaveRoom()
    void window.electronVoice?.disconnect()
    uiClient.disconnect()
    voiceClient.disconnect()
    setConnectedToApi(false)
    setActiveChannelId("")
    setWsConnected(false)
    setWsReconnecting(false)
    setVoiceSigWsConnected(false)
    setStatus("Disconnected")
    setActiveScreenSharerName("")
    setError("")
  }

  const handleRemoveSavedServer = async (serverId: string) => {
    const entry = savedServers.find((s) => s.serverId === serverId)
    if (!entry) return
    if (
      !window.confirm(
        `Remove "${entry.serverName}" from your list? You can connect again later with the same host and password.`
      )
    ) {
      return
    }
    const touchesUi = connectedToApi && uiClient.getCurrentServerId() === serverId
    const touchesVoice = isInVoice && voiceServerId === serverId
    if (touchesUi || touchesVoice) {
      await fullyDisconnectFromApi()
    }
    const next = savedServers.filter((s) => s.serverId !== serverId)
    setSavedServers(next)
    localStorage.setItem("voixex-saved-servers", JSON.stringify(next))
    setServers(
      next.map((s) => ({
        id: s.serverId,
        name: s.serverName,
        icon: s.serverName.slice(0, 1).toUpperCase() || "S"
      }))
    )
    if (next.length === 0) {
      autoConnectAttemptedRef.current = false
      localStorage.removeItem("voixex-last-server-id")
      setActiveServerId("")
      setShowConnectPanel(true)
      toast.success("Server removed")
      return
    }
    if (activeServerId === serverId) {
      const pick = next[0]
      setActiveServerId(pick.serverId)
      localStorage.setItem("voixex-last-server-id", pick.serverId)
      setApiHost(pick.apiHost)
      setApiPort(pick.apiPort)
      setServerPassword(pick.serverPassword)
      setDisplayNameInput(pick.displayName)
      setSuperuserPasswordInput(pick.superuserPassword ?? "")
      setProfileDisplayName(pick.displayName)
    }
    toast.success("Server removed from list")
  }

  const activeChannel = categories.flatMap((c) => c.channels).find((c) => c.id === activeChannelId)
  const allChannels = categories.flatMap((c) => c.channels)
  const voiceChannelName = categories.flatMap((c) => c.channels).find((c) => c.id === currentVoiceChannel)?.name || ""
  const isTextChannel = activeChannel?.type === "text"
  const canOpenServerSettings = Boolean(activeServerId && canManageServer)
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

  const connectAndJoin = async (preset?: SavedServerProfile) => {
    try {
      setJoining(true)
      voiceClient.disconnect()
      const host = (preset?.apiHost ?? apiHost).trim()
      const port = (preset?.apiPort ?? apiPort).trim()
      const password = preset?.serverPassword ?? serverPassword
      const superPassword = preset?.superuserPassword ?? superuserPasswordInput
      const normalizedDisplayName = (preset?.displayName ?? displayNameInput).trim() || "User"
      if (preset) {
        setApiHost(host)
        setApiPort(port)
        setServerPassword(password)
        setSuperuserPasswordInput(superPassword)
        setConnectServerListName(preset.serverName)
      }
      if (!preset) {
        const earlyLabel = connectServerListName.trim()
        if (earlyLabel) {
          const others = savedServers.filter((s) => !(s.apiHost === host && s.apiPort === port))
          if (others.some((s) => s.serverName.trim().toLowerCase() === earlyLabel.toLowerCase())) {
            toast.error("A server with this name already exists in your list.")
            setJoining(false)
            return
          }
        }
      }
      setDisplayNameInput(normalizedDisplayName)
      localStorage.setItem("voip-last-display-name", normalizedDisplayName)
      uiClient.setApiBase(`http://${host}:${port}`)
      setError("")
      setStatus(`Connecting API: ${host}:${port}`)
      const health = await uiClient.healthcheck()
      if (!health.ok) throw new Error("server is not healthy")
      setConnectedToApi(true)
      setStatus("Joining server...")
      const clientId = localStorage.getItem("voip-client-id") || crypto.randomUUID()
      const join = await uiClient.joinServer(password, clientId, normalizedDisplayName, superPassword || undefined)
      const joinedServerId = join.serverId
      const joinedServerName = join.serverName ?? "Server"
      const effectiveListName = (
        preset?.serverName ?? (connectServerListName.trim() || joinedServerName)
      ).trim() || "Server"
      const withoutSameHostForName = savedServers.filter((s) => !(s.apiHost === host && s.apiPort === port))
      if (
        withoutSameHostForName.some(
          (s) => s.serverName.trim().toLowerCase() === effectiveListName.toLowerCase()
        )
      ) {
        toast.error(
          "A server with this name already exists in your list. Pick another name and connect again."
        )
        uiClient.disconnect()
        setConnectedToApi(false)
        setJoining(false)
        return
      }
      localStorage.setItem("voip-client-id", join.profile.clientId)
      localStorage.setItem("voip-last-display-name", join.profile.displayName)
      localStorage.setItem("voixex-last-server-id", joinedServerId)
      setProfileDisplayName(join.profile.displayName)
      if (join.mediaToken) {
        if (!window.electronVoice) {
          throw new Error("Desktop voice bridge not available. Run inside voip-desktop-client.")
        }
        setStatus("Connecting voice transport...")
        const vopts = uiClient.getElectronVoiceConnectParams()
        if (vopts) {
          await window.electronVoice.connect({
            host: vopts.host,
            port: vopts.port,
            mediaToken: vopts.mediaToken
          })
        }
      }
      uiClient.connectWs()
      const rooms = await uiClient.getRooms(joinedServerId)
      await uiClient.getMe(joinedServerId)
      setActiveServerId(joinedServerId)
      const updatedProfile: SavedServerProfile = {
        serverId: joinedServerId,
        serverName: effectiveListName,
        apiHost: host,
        apiPort: port,
        serverPassword: password,
        displayName: join.profile.displayName,
        ...(superPassword ? { superuserPassword: superPassword } : {})
      }
      const nextSaved = [updatedProfile, ...withoutSameHostForName]
      setSavedServers(nextSaved)
      localStorage.setItem("voixex-saved-servers", JSON.stringify(nextSaved))
      setServers(
        nextSaved.map((s) => ({
          id: s.serverId,
          name: s.serverName,
          icon: s.serverName.slice(0, 1).toUpperCase() || "S"
        }))
      )
      setConnectServerListName(effectiveListName)
      const text = rooms.find((r) => r.kind === "text")
      if (text) {
        setActiveChannelId(text.id)
        await uiClient.getMessages(joinedServerId, text.id)
      }
      setCurrentVoiceChannel("")
      setIsInVoice(false)
      isInVoiceRef.current = false
      setVoiceServerId("")
      voiceServerIdRef.current = ""
      setStatus("Connected to server")
    } catch (e) {
      setConnectedToApi(false)
      setError(e instanceof Error ? e.message : "join server failed")
    } finally {
      setJoining(false)
    }
  }

  const openAppSettings = async (initialTab: "voice" | "keybinds" | "server_general" | "server_channels" | "server_roles" = "voice") => {
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
    setAppSettingsTab(initialTab)
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
    await uiClient.updateProfile(activeServerId, profileDisplayName)
    localStorage.setItem("voip-last-display-name", profileDisplayName)
    setSavedServers((prev) => {
      const next = prev.map((s) => (s.serverId === activeServerId ? { ...s, displayName: profileDisplayName } : s))
      localStorage.setItem("voixex-saved-servers", JSON.stringify(next))
      return next
    })
    toast.success("Profile updated")
    setStatus("Profile updated")
  }

  const createChannelFromSettings = async () => {
    if (!activeServerId || !canManageServer || creatingChannel) return
    const name = roomNameInput.trim()
    if (!name) {
      setError("Channel name is required")
      return
    }
    try {
      setCreatingChannel(true)
      setError("")
      await uiClient.createRoom(activeServerId, name, roomKindInput)
      await uiClient.getRooms(activeServerId)
      toast.success(`Channel "${name}" created`)
      setStatus(`Channel created: ${name}`)
      setRoomNameInput("")
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to create channel")
    } finally {
      setCreatingChannel(false)
    }
  }

  const handleServerSelect = (serverId: string) => {
    const saved = savedServers.find((s) => s.serverId === serverId)
    if (!saved) return

    if (
      isInVoiceRef.current &&
      currentVoiceChannelRef.current &&
      serverId !== activeServerIdRef.current
    ) {
      const ok = window.confirm(
        "Вы в голосовом канале. Переход на другой сервер разорвёт голосовое соединение и выполнит полное переподключение к выбранному серверу. Продолжить?"
      )
      if (!ok) return
    }

    serverSwitchChainRef.current = serverSwitchChainRef.current
      .then(async () => {
        setActiveServerId(serverId)
        activeServerIdRef.current = serverId
        localStorage.setItem("voixex-last-server-id", serverId)
        setConnectServerListName(saved.serverName)
        setApiHost(saved.apiHost)
        setApiPort(saved.apiPort)
        setServerPassword(saved.serverPassword)
        setDisplayNameInput(saved.displayName)
        setSuperuserPasswordInput(saved.superuserPassword ?? "")

        const targetId = serverId
        const inVoice = isInVoiceRef.current
        let voiceSrv = voiceServerIdRef.current
        if (inVoice && currentVoiceChannelRef.current && !voiceSrv) {
          voiceSrv = voiceClient.getCurrentServerId() ?? uiClient.getCurrentServerId() ?? ""
          if (voiceSrv) {
            voiceServerIdRef.current = voiceSrv
            setVoiceServerId(voiceSrv)
          }
        }

        const uiOn = uiClient.getCurrentServerId()
        if (uiOn === targetId && connectedToApiRef.current && wsConnectedRef.current) {
          return
        }

        if (
          inVoice &&
          voiceSrv &&
          voiceSrv === targetId &&
          uiOn === targetId &&
          connectedToApiRef.current &&
          !wsConnectedRef.current
        ) {
          uiClient.connectWs()
          return
        }

        if (uiOn !== null || connectedToApiRef.current || wsConnectedRef.current) {
          await fullyDisconnectFromApi()
        }
        await connectAndJoin(saved)
      })
      .catch((err) => {
        console.error(err)
        toast.error(err instanceof Error ? err.message : "Server switch failed")
      })

    void serverSwitchChainRef.current
  }

  return (
    <main className="flex h-screen overflow-hidden bg-background">
      <ServerSidebar
        servers={servers}
        activeServerId={activeServerId}
        onServerSelect={handleServerSelect}
        onRemoveServer={handleRemoveSavedServer}
        onAddServer={() => {
          setShowConnectPanel((open) => {
            if (!open) setConnectServerListName("")
            return !open
          })
        }}
        onOpenSettings={() => {
          const initialTab = activeServerId && canManageServer ? "server_general" : "voice"
          void openAppSettings(initialTab)
        }}
      />

      <div className="flex h-full flex-col">
        {showConnectPanel && (
          <div className="m-3 w-[400px] max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-card p-4 shadow-lg">
            <div className="mb-4 flex items-center gap-2">
              <Server className="h-5 w-5 text-primary" />
              <h2 className="text-sm font-semibold text-foreground">Server Connection</h2>
            </div>
            <div className="space-y-3">
              <div>
                <Label className="mb-1 text-xs text-muted-foreground">Name in list</Label>
                <Input
                  className="h-8 text-sm"
                  value={connectServerListName}
                  onChange={(e) => setConnectServerListName(e.target.value)}
                  placeholder="Unique name (sidebar). Empty = use server name from API"
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Names are compared without case. Two saved servers cannot share the same name.
                </p>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="mb-1 text-xs text-muted-foreground">Host</Label>
                  <Input className="h-8 text-sm" value={apiHost} onChange={(e) => setApiHost(e.target.value)} placeholder="localhost" />
                </div>
                <div className="w-20">
                  <Label className="mb-1 text-xs text-muted-foreground">Port</Label>
                  <Input className="h-8 text-sm" value={apiPort} onChange={(e) => setApiPort(e.target.value)} placeholder="18080" />
                </div>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="mb-1 text-xs text-muted-foreground">Password</Label>
                  <Input className="h-8 text-sm" type="password" value={serverPassword} onChange={(e) => setServerPassword(e.target.value)} placeholder="Server password" />
                </div>
                <div className="flex-1">
                  <Label className="mb-1 text-xs text-muted-foreground">Nickname</Label>
                  <Input className="h-8 text-sm" value={displayNameInput} onChange={(e) => setDisplayNameInput(e.target.value)} placeholder="Your name" />
                </div>
              </div>
              <details className="group">
                <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Advanced options
                </summary>
                <div className="mt-2 space-y-2">
                  <div>
                    <Label className="mb-1 text-xs text-muted-foreground">Superuser password</Label>
                    <Input className="h-8 text-sm" type="password" value={superuserPasswordInput} onChange={(e) => setSuperuserPasswordInput(e.target.value)} placeholder="Optional, grants admin" />
                  </div>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <Label className="mb-1 text-xs text-muted-foreground">Display name</Label>
                      <Input className="h-8 text-sm" value={profileDisplayName} onChange={(e) => setProfileDisplayName(e.target.value)} placeholder="Server profile" />
                    </div>
                    <div className="flex items-end">
                      <Button variant="outline" size="sm" onClick={saveProfile} disabled={!activeServerId}>Save</Button>
                    </div>
                  </div>
                  {activeServerId && canManageServer && (
                    <Button variant="outline" size="sm" className="w-full" onClick={() => void openAppSettings("server_general")}>
                      Server settings
                    </Button>
                  )}
                </div>
              </details>
              <Button className="w-full" onClick={() => void connectAndJoin()} disabled={joining}>
                {joining ? <><Spinner className="mr-2" /> Connecting...</> : "Connect"}
              </Button>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  {connectedToApi ? <Wifi className="h-3 w-3 text-accent" /> : <WifiOff className="h-3 w-3" />}
                  <span>{connectedToApi ? "API" : "API ?"}</span>
                </div>
                <span className="text-border">|</span>
                <span>WS: {wsConnected ? "connected" : wsReconnecting ? "reconnecting..." : "disconnected"}</span>
              </div>
              {!hasDesktopBridge && (
                <p className="text-xs text-destructive">Desktop voice bridge not detected.</p>
              )}
              {error && <p className="text-xs text-destructive">{error}</p>}
            </div>
          </div>
        )}
        {activeServerId ? (
        <ChannelSidebar
            serverName={servers.find((s) => s.id === activeServerId)?.name || "No Server"}
          categories={categories}
          activeChannelId={activeChannelId}
          onChannelSelect={handleChannelSelect}
          voiceUsers={voiceUsers}
          selfClientId={myVoiceClientId}
          peerVolumePct={peerVolumePct}
          onPeerVolumeChange={handlePeerVolumeChange}
          enablePeerVolume={hasDesktopBridge && isInVoice && wsForVoiceJoin}
        />
        ) : null}
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

      {/* Voice Stats Popover */}
      {showVoiceStatsPanel && (
        <div className="fixed bottom-24 left-20 z-20 w-[380px] rounded-xl border border-border bg-card p-4 shadow-xl">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className={`h-4 w-4 ${qualityClass}`} />
              <span className={`text-sm font-semibold ${qualityClass}`}>Voice Stats</span>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setShowVoiceStatsPanel(false)}>Close</Button>
          </div>
          {voiceStats ? (
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex justify-between"><span>Status</span><span>{voiceStats.connected ? "Connected" : "Disconnected"} {isSpeakingNow ? "| Speaking" : ""}</span></div>
              <div className="flex justify-between"><span>TX / RX</span><span>{voiceStats.txPackets ?? 0} / {voiceStats.rxPackets ?? 0}</span></div>
              <div className="flex justify-between"><span>Loss</span><span>{voiceStats.rxLostEstimated ?? 0} ({voiceStats.packetLossPct ?? 0}%)</span></div>
              <Separator />
              <div className={`flex justify-between ${qualityClass}`}><span>Ping</span><span>{voiceStats.pingNowMs ?? 0}ms now / {voiceStats.ping1PctMs ?? 0}ms p1 / {voiceStats.ping01PctMs ?? 0}ms p0.1</span></div>
              <div className={`flex justify-between ${qualityClass}`}><span>Jitter</span><span>{voiceStats.jitterNowMs ?? 0}ms now / {voiceStats.jitter1PctMs ?? 0}ms p1 / {voiceStats.jitter01PctMs ?? 0}ms p0.1</span></div>
              {audioPipelineDiag && (
                <>
                  <Separator />
                  <div className="flex justify-between"><span>Capture SR</span><span>{Math.round(audioPipelineDiag.captureSampleRate)} Hz</span></div>
                  <div className="flex justify-between"><span>Playback SR</span><span>{Math.round(audioPipelineDiag.playbackSampleRate)} Hz</span></div>
                  <div className="flex justify-between"><span>Playout buffer</span><span>{audioPipelineDiag.playoutBufferedSamples} samples</span></div>
                  <div className="flex justify-between"><span>Underruns</span><span>{audioPipelineDiag.playoutUnderruns}</span></div>
                  <div className="flex justify-between"><span>Overflow drops</span><span>{audioPipelineDiag.playoutOverflowDrops}</span></div>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No stats yet. Join a voice channel.</p>
          )}
        </div>
      )}

      {/* Settings Dialog */}
      <Dialog open={showAppSettings} onOpenChange={setShowAppSettings}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
            <DialogDescription>Configure voice, video, keybinds, and server options.</DialogDescription>
          </DialogHeader>
          <Tabs value={appSettingsTab} onValueChange={(v) => setAppSettingsTab(v as typeof appSettingsTab)}>
            <TabsList className="w-full">
              <TabsTrigger value="voice">Voice & Video</TabsTrigger>
              <TabsTrigger value="keybinds">Keybinds</TabsTrigger>
              {canOpenServerSettings && (
                <>
                  <TabsTrigger value="server_general">General</TabsTrigger>
                  <TabsTrigger value="server_channels">Channels</TabsTrigger>
                  <TabsTrigger value="server_roles">Roles</TabsTrigger>
                </>
              )}
            </TabsList>

            <TabsContent value="voice" className="space-y-5 pt-4">
              <div className="space-y-2">
                <Label>Input Device</Label>
                <select
                  className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                  value={selectedDevices.inputId ?? ""}
                  onChange={(e) => setSelectedDevices((prev) => ({ ...prev, inputId: e.target.value || null }))}
                >
                  <option value="">Default</option>
                  {audioDevices.input.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>Output Device</Label>
                <select
                  className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                  value={selectedDevices.outputId ?? ""}
                  onChange={(e) => setSelectedDevices((prev) => ({ ...prev, outputId: e.target.value || null }))}
                >
                  <option value="">Default</option>
                  {audioDevices.output.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Input Volume</Label>
                  <span className="text-xs text-muted-foreground">{micVolumePct}%</span>
                </div>
                <Slider value={[micVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setMicVolumePct(v)} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Output Volume</Label>
                  <span className="text-xs text-muted-foreground">{outputVolumePct}%</span>
                </div>
                <Slider value={[outputVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setOutputVolumePct(v)} />
              </div>
              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Microphone Meter</Label>
                    <p className="text-xs text-muted-foreground">Helps you set gate thresholds and levels.</p>
                  </div>
                  <div className="text-right text-xs text-muted-foreground tabular-nums">
                    <div>Peak: {micMeter ? Math.round(micMeter.peak) : 0}</div>
                    <div>RMS: {micMeter ? micMeter.rms.toFixed(3) : "0.000"}</div>
                  </div>
                </div>
                <div className="h-2 w-full overflow-hidden rounded bg-muted">
                  <div
                    className="h-full bg-primary transition-[width]"
                    style={{ width: `${Math.min(100, Math.round(((micMeter?.peak ?? 0) / 4000) * 100))}%` }}
                  />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div>
                  <Label>Capture DSP (getUserMedia constraints)</Label>
                  <p className="text-xs text-muted-foreground">
                    These flags affect microphone capture in Electron/Chromium. They do not change your UDP transport.
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Noise Suppression</Label>
                  <Switch checked={noiseSuppressionEnabled} onCheckedChange={setNoiseSuppressionEnabled} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Echo Cancellation (AEC)</Label>
                  <Switch checked={echoCancellationEnabled} onCheckedChange={setEchoCancellationEnabled} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Auto Gain Control (AGC)</Label>
                  <Switch checked={autoGainControlEnabled} onCheckedChange={setAutoGainControlEnabled} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Tip: your OS may have stronger mic noise reduction (Windows Studio Effects, macOS Voice Isolation).
                </p>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Opus Uplink (beta)</Label>
                    <p className="text-xs text-muted-foreground">Encodes mic audio to Opus before sending to server.</p>
                  </div>
                  <Switch checked={useOpusUplink} onCheckedChange={setUseOpusUplink} />
                </div>
                <p className="text-xs text-muted-foreground">
                  If unsupported, the app falls back to PCM uplink automatically.
                </p>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Mic Monitor (listen to yourself)</Label>
                    <p className="text-xs text-muted-foreground">Use headphones to avoid feedback.</p>
                  </div>
                  <Switch checked={monitorEnabled} onCheckedChange={setMonitorEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Monitor Volume</Label>
                    <span className="text-xs text-muted-foreground">{monitorVolumePct}%</span>
                  </div>
                  <Slider value={[monitorVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setMonitorVolumePct(v)} />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>Noise Gate</Label>
                    <p className="text-xs text-muted-foreground">Simple RMS gate before sending audio.</p>
                  </div>
                  <Switch checked={gateEnabled} onCheckedChange={setGateEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Gate Threshold</Label>
                    <span className="text-xs text-muted-foreground">{gateThreshold}</span>
                  </div>
                  <Slider value={[gateThreshold]} min={0} max={4000} step={10} onValueChange={([v]) => setGateThreshold(v)} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Release</Label>
                    <span className="text-xs text-muted-foreground">{gateReleaseMs}ms</span>
                  </div>
                  <Slider value={[gateReleaseMs]} min={0} max={800} step={10} onValueChange={([v]) => setGateReleaseMs(v)} />
                </div>
              </div>
              <div className="rounded-lg border border-border p-3 space-y-3">
                <div>
                  <Label>Playback DSP (incoming voice)</Label>
                  <p className="text-xs text-muted-foreground">Tune this if remote voice sounds robotic, metallic, or too bright.</p>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">Playback Gate</Label>
                  <Switch checked={playbackGateEnabled} onCheckedChange={setPlaybackGateEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">Playback Gate Threshold</Label>
                    <span className="text-xs text-muted-foreground">{playbackGateThreshold}</span>
                  </div>
                  <Slider value={[playbackGateThreshold]} min={0} max={2000} step={10} onValueChange={([v]) => setPlaybackGateThreshold(v)} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">High-pass Filter</Label>
                  <Switch checked={playbackHighpassEnabled} onCheckedChange={setPlaybackHighpassEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">High-pass Cutoff</Label>
                    <span className="text-xs text-muted-foreground">{playbackHighpassHz}Hz</span>
                  </div>
                  <Slider value={[playbackHighpassHz]} min={20} max={240} step={5} onValueChange={([v]) => setPlaybackHighpassHz(v)} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">Soft Limiter / Clip Guard</Label>
                    <p className="text-xs text-muted-foreground">Protects from harsh clipping at high levels.</p>
                  </div>
                  <Switch checked={playbackLimiterEnabled} onCheckedChange={setPlaybackLimiterEnabled} />
                </div>
              </div>
              <Button onClick={saveAudioSettings}>Apply Audio Settings</Button>
              {deviceError && <p className="text-sm text-destructive">{deviceError}</p>}
            </TabsContent>

            <TabsContent value="keybinds" className="space-y-5 pt-4">
              <p className="text-sm text-muted-foreground">Global OS shortcuts (Electron format, e.g. Ctrl+Shift+M)</p>
              <div className="space-y-3">
                <div className="grid grid-cols-[140px_1fr] items-center gap-3">
                  <Label>Toggle Mute</Label>
                  <Input value={keybindDraft.toggleMute} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleMute: e.target.value }))} placeholder="Ctrl+Shift+M" />
                  <Label>Toggle Deafen</Label>
                  <Input value={keybindDraft.toggleDeafen} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleDeafen: e.target.value }))} placeholder="Ctrl+Shift+D" />
                  <Label>Push To Talk</Label>
                  <Input value={keybindDraft.pushToTalk} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, pushToTalk: e.target.value }))} placeholder="Ctrl+Shift+V" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={saveKeybinds}>Save Keybinds</Button>
                <Button variant="outline" onClick={clearKeybinds}>Clear All</Button>
              </div>
              <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                Active: mute={keybinds.toggleMute ?? "none"}, deafen={keybinds.toggleDeafen ?? "none"}, ptt={keybinds.pushToTalk ?? "none"}
              </div>
            </TabsContent>

            <TabsContent value="server_general" className="space-y-3 pt-4">
              <div className="rounded-lg border border-border p-4 space-y-2">
                <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">Server</span><span className="text-sm font-medium">{servers.find((s) => s.id === activeServerId)?.name ?? "Unknown"}</span></div>
                <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">ID</span><span className="text-xs font-mono text-muted-foreground">{activeServerId}</span></div>
              </div>
              <p className="text-sm text-muted-foreground">General server moderation/admin settings will live here.</p>
            </TabsContent>

            <TabsContent value="server_channels" className="space-y-4 pt-4">
              <p className="text-sm text-muted-foreground">Only admins can create or edit channels.</p>
              <div className="flex gap-2">
                <Input className="flex-1" value={roomNameInput} onChange={(e) => setRoomNameInput(e.target.value)} placeholder="Channel name" disabled={creatingChannel} />
                <select
                  className="rounded-md border border-input bg-input px-3 py-2 text-sm"
                  value={roomKindInput}
                  onChange={(e) => setRoomKindInput(e.target.value as "voice" | "text")}
                  disabled={creatingChannel}
                >
                  <option value="voice">Voice</option>
                  <option value="text">Text</option>
                </select>
                <Button onClick={() => void createChannelFromSettings()} disabled={creatingChannel || roomNameInput.trim().length === 0}>
                  {creatingChannel ? <><Spinner className="mr-2" /> Creating</> : "Create"}
                </Button>
              </div>
              <div className="max-h-60 overflow-auto rounded-lg border border-border">
                {allChannels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">No channels yet.</div>
                ) : (
                  <div className="divide-y divide-border">
                    {allChannels.map((ch) => (
                      <div key={ch.id} className="flex items-center justify-between px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{ch.type === "voice" ? "Voice" : "Text"}</Badge>
                          <span className="text-sm">{ch.name}</span>
                        </div>
                        <span className="text-xs font-mono text-muted-foreground">{ch.id.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="server_roles" className="pt-4">
              <p className="text-sm text-muted-foreground">
                Role permissions (channel access, moderation, speaking/mute controls) will be configured here.
              </p>
            </TabsContent>
          </Tabs>
        </DialogContent>
      </Dialog>

      {/* Main Content */}
      {!activeServerId ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 bg-background p-8">
          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
            <Headphones className="h-10 w-10 text-muted-foreground" />
          </div>
          <div className="text-center">
            <h2 className="text-lg font-semibold text-foreground">Welcome to Voixex</h2>
            <p className="mt-1 text-sm text-muted-foreground">Connect to a server to start chatting and talking.</p>
          </div>
          <Button variant="outline" onClick={() => setShowConnectPanel(true)}>
            <Server className="mr-2 h-4 w-4" /> Connect to Server
          </Button>
        </div>
      ) : activeChannel?.type === "voice" ? (
        <div className="flex h-full flex-1 flex-col bg-background">
          {/* Voice channel toolbar */}
          <div className="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
            <div className="flex items-center gap-2">
              <ScreenShare className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-semibold text-foreground">{activeChannel.name}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <Select value={selectedScreenSourceId ?? ""} onValueChange={(v) => setSelectedScreenSourceId(v || null)}>
                <SelectTrigger size="sm" className="h-7 w-40 text-xs" disabled={screenSources.length === 0}>
                  <SelectValue placeholder="No sources" />
                </SelectTrigger>
                <SelectContent>
                  {screenSources.map((source) => (
                    <SelectItem key={source.id} value={source.id}>{source.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={screenResolution} onValueChange={setScreenResolution}>
                <SelectTrigger size="sm" className="h-7 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="854x480">480p</SelectItem>
                  <SelectItem value="1280x720">720p</SelectItem>
                  <SelectItem value="1600x900">900p</SelectItem>
                  <SelectItem value="1920x1080">1080p</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(screenFps)} onValueChange={(v) => setScreenFps(Number(v))}>
                <SelectTrigger size="sm" className="h-7 w-20 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 FPS</SelectItem>
                  <SelectItem value="15">15 FPS</SelectItem>
                  <SelectItem value="24">24 FPS</SelectItem>
                  <SelectItem value="30">30 FPS</SelectItem>
                  <SelectItem value="60">60 FPS</SelectItem>
                </SelectContent>
              </Select>
              <Select value={String(screenBitrateKbps)} onValueChange={(v) => setScreenBitrateKbps(Number(v))}>
                <SelectTrigger size="sm" className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1200">1.2 Mbps</SelectItem>
                  <SelectItem value="2000">2.0 Mbps</SelectItem>
                  <SelectItem value="3500">3.5 Mbps</SelectItem>
                  <SelectItem value="5000">5.0 Mbps</SelectItem>
                  <SelectItem value="8000">8.0 Mbps</SelectItem>
                </SelectContent>
              </Select>

              <Separator orientation="vertical" className="h-5" />

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isScreenSharing ? "destructive" : "outline"}
                    size="sm"
                    onClick={() => void handleScreenShareToggle()}
                    disabled={!isInVoice || !hasDesktopBridge}
                    className="h-7 gap-1 text-xs"
                  >
                    {isScreenSharing ? <MonitorOff className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
                    {isScreenSharing ? "Stop" : "Share"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{isScreenSharing ? "Stop Screen Share" : "Start Screen Share"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={toggleStreamWindow}
                    disabled={!activeScreenSharerName && !screenImageUrl && !screenVideoUrl && !isScreenSharing}
                    className="h-7 gap-1 text-xs"
                  >
                    {showingStreamWindow ? <EyeOff className="h-3.5 w-3.5" /> : <ExternalLink className="h-3.5 w-3.5" />}
                    {showingStreamWindow ? "Close" : "Pop-out"}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{showingStreamWindow ? "Close Stream Window" : "Open Stream Window"}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showMemberList ? "secondary" : "ghost"}
                    size="icon-sm"
                    className="h-7 w-7"
                    onClick={() => setShowMemberList(!showMemberList)}
                  >
                    <Users className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{showMemberList ? "Hide Members" : "Show Members"}</TooltipContent>
              </Tooltip>
            </div>
          </div>

          {/* Voice channel body */}
          <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-sm text-destructive">
                {error}
              </div>
            )}
            {activeScreenSharerName ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <ScreenShare className="h-4 w-4 text-accent" />
                <span><span className="font-medium text-foreground">{activeScreenSharerName}</span> is sharing their screen</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No active screen share</div>
            )}
            {activeScreenSharerName && (
              <div className="text-xs text-muted-foreground">
                Watching: {(voiceUsers[currentVoiceChannel] ?? []).map((u) => u.name).join(", ") || "none"}
              </div>
            )}
            {isScreenSharing ? (
              <video ref={localPreviewVideoRef} autoPlay muted playsInline className="max-h-[70vh] w-auto rounded-xl border border-border shadow-lg" />
            ) : screenVideoUrl || screenImageUrl ? (
              <video
                ref={remoteStreamVideoRef}
                src={screenVideoUrl ?? screenImageUrl ?? undefined}
                autoPlay
                muted
                playsInline
                controls
                className="max-h-[70vh] w-auto rounded-xl border border-border shadow-lg"
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                  <ScreenShare className="h-8 w-8 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  Voice channel selected. Share your screen or wait for someone to start streaming.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
      <ChatArea
        channelName={activeChannel?.name || "general"}
        channelType={activeChannel?.type || "text"}
        messages={messages}
        onSendMessage={handleSendMessage}
          onUploadAttachment={handleUploadAttachment}
          canSend={Boolean(activeServerId && activeChannelId && isTextChannel)}
        showMemberList={showMemberList}
        onToggleMemberList={() => setShowMemberList(!showMemberList)}
      />
      )}

      {showMemberList && activeServerId && (
        <MemberList members={members} roles={[]} />
      )}
    </main>
  )
}
