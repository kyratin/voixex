"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Buffer } from "buffer"
import { ServerSidebar } from "@/components/voip/server-sidebar"
import { ChannelSidebar, type ChannelCategory } from "@/components/voip/channel-sidebar"
import { UserPanel } from "@/components/voip/user-panel"
import { ChatArea, type Message } from "@/components/voip/chat-area"
import { MemberList, type Member } from "@/components/voip/member-list"
import { ApiError, VoipClient, type RealtimeState } from "@/lib/voip-client"
import { getPeerVolume, setPeerVolumeStored } from "@/lib/peer-volume-storage"
import { resampleFloat32Chunk, resampleInt16Chunk } from "@/lib/voice-resample"
import { VoicePlayoutPrefetch, loadVoicePlaybackWorklet } from "@/lib/voice-playout"
import { WebRtcMediaSession } from "@/lib/webrtc-media"
import { connectMonoSourceToTap, createMonoMediaStreamTap, createSpeexNoiseWorklet } from "@/lib/speex-capture"
import type { SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor"
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
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { ScrollArea } from "@/components/ui/scroll-area"
import { MicLevelMeter, type MicLevelMeterSample } from "@/components/voip/mic-level-meter"
import { ConnectServerDialog } from "@/components/voip/connect-server-dialog"
import { LanguageSelector } from "@/components/voip/language-selector"
import { VoiceChannelView } from "@/components/voip/voice-channel-view"
import { useI18n } from "@/lib/i18n/provider"
import { Headphones, Server } from "lucide-react"

/** Build-time defaults for Electron (NEXT_PUBLIC_* inlined at `next build`). */
function parseNextPublicApiBase(): { host: string; port: string; useHttps: boolean } | null {
  const raw = process.env.NEXT_PUBLIC_API_BASE?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    const port = u.port || (u.protocol === "https:" ? "443" : "80")
    return { host: u.hostname, port, useHttps: u.protocol === "https:" }
  } catch {
    return null
  }
}

function getBuildTimeConnectionDefaults() {
  const parsed = parseNextPublicApiBase()
  const host = process.env.NEXT_PUBLIC_DEFAULT_API_HOST?.trim() || parsed?.host || "localhost"
  const port = process.env.NEXT_PUBLIC_DEFAULT_API_PORT?.trim() || parsed?.port || "18080"
  const httpsEnv = process.env.NEXT_PUBLIC_DEFAULT_USE_HTTPS
  const useHttps =
    httpsEnv === "true" ? true : httpsEnv === "false" ? false : Boolean(parsed?.useHttps)
  const password = process.env.NEXT_PUBLIC_DEFAULT_SERVER_PASSWORD?.trim() ?? "1234"
  const udpPort = process.env.NEXT_PUBLIC_DEFAULT_UDP_PORT?.trim() ?? ""
  return { host, port, useHttps, password, udpPort }
}

function buildApiBaseUrl(host: string, port: string, useHttps: boolean): string {
  const h = host.trim()
  const p = port.trim()
  const scheme = useHttps ? "https" : "http"
  if (!p) return `${scheme}://${h}`
  return `${scheme}://${h}:${p}`
}

/** Override announced UDP port from /v1/join when user maps a different external port. */
function effectiveVoiceUdpPort(announcedPort: number, overrideStr: string): number {
  const t = overrideStr.trim()
  if (!t) return announcedPort
  const n = Number.parseInt(t, 10)
  if (!Number.isFinite(n) || n < 1 || n > 65535) return announcedPort
  return n
}

function voiceTransportFailureHint(msg: string, triedTransport: "udp" | "tcp"): string {
  if (triedTransport !== "tcp") return msg
  if (/ECONNREFUSED|connect timeout|TCP connect|socket closed before HELLO/i.test(msg)) {
    return `${msg}. TCP is not reachable on the media port — expose "50000:50000/tcp" in docker-compose and run a backend image with TCP media support.`
  }
  return msg
}

type ServerAppearance = {
  serverBannerUrl?: string
  channelBanners?: Record<string, string>
}

function loadServerAppearance(serverId: string): ServerAppearance {
  if (!serverId) return {}
  try {
    const raw = localStorage.getItem(`voixex-server-appearance-${serverId}`)
    if (!raw) return {}
    return JSON.parse(raw) as ServerAppearance
  } catch {
    return {}
  }
}

function saveServerAppearance(serverId: string, appearance: ServerAppearance) {
  if (!serverId) return
  localStorage.setItem(`voixex-server-appearance-${serverId}`, JSON.stringify(appearance))
}

type ConnectionPrefs = {
  mediaEngine?: "legacy" | "webrtc"
  voiceTransport?: "udp" | "tcp"
  apiUseHttps?: boolean
  udpPortOverride?: string
}

const CONNECTION_PREFS_KEY = "voixex-connection-prefs"

function loadGlobalConnectionPrefs(): ConnectionPrefs {
  try {
    const raw = localStorage.getItem(CONNECTION_PREFS_KEY)
    if (!raw) return {}
    return JSON.parse(raw) as ConnectionPrefs
  } catch {
    return {}
  }
}

function saveGlobalConnectionPrefs(prefs: ConnectionPrefs) {
  localStorage.setItem(CONNECTION_PREFS_KEY, JSON.stringify(prefs))
}

function normalizeMediaEngine(value: unknown): "legacy" | "webrtc" {
  return value === "webrtc" ? "webrtc" : "legacy"
}

function normalizeVoiceTransport(value: unknown): "udp" | "tcp" {
  return value === "tcp" ? "tcp" : "udp"
}

function applyConnectionPrefsToState(
  prefs: {
    mediaEngine?: unknown
    voiceTransport?: unknown
    apiUseHttps?: boolean
    udpPortOverride?: string
  },
  setters: {
    setMediaEngine: (v: "legacy" | "webrtc") => void
    setVoiceTransport: (v: "udp" | "tcp") => void
    setApiUseHttps: (v: boolean) => void
    setUdpPortOverride: (v: string) => void
    mediaEngineRef: { current: "legacy" | "webrtc" }
  }
) {
  if (prefs.mediaEngine !== undefined) {
    const engine = normalizeMediaEngine(prefs.mediaEngine)
    setters.mediaEngineRef.current = engine
    setters.setMediaEngine(engine)
  }
  if (prefs.voiceTransport !== undefined) {
    setters.setVoiceTransport(normalizeVoiceTransport(prefs.voiceTransport))
  }
  if (typeof prefs.apiUseHttps === "boolean") {
    setters.setApiUseHttps(prefs.apiUseHttps)
  }
  if (prefs.udpPortOverride !== undefined) {
    setters.setUdpPortOverride(prefs.udpPortOverride)
  }
}

const CONNECTION_DEFAULTS = getBuildTimeConnectionDefaults()
const VOICE_TRACE = process.env.NEXT_PUBLIC_VOICE_TRACE === "1"

export default function VoIPApp() {
  const { t } = useI18n()
  const errorText = (e: unknown, fallbackKey: string) =>
    e instanceof ApiError ? t(`notices.${e.code}`) : e instanceof Error ? e.message : t(fallbackKey)
  type AppSettingsTab = "language" | "voice" | "keybinds" | "server_general" | "server_channels" | "server_roles"
  type SavedServerProfile = {
    serverId: string
    serverName: string
    apiHost: string
    apiPort: string
    /** When true, API + WebSocket use https / wss. */
    apiUseHttps?: boolean
    serverPassword: string
    displayName: string
    superuserPassword?: string
    /** If set, voice UDP connects here instead of the port returned by join. */
    udpPortOverride?: string
    /** Voice transport used by desktop media bridge. */
    voiceTransport?: "udp" | "tcp"
    /** Voice/screen media path (legacy UDP chunks vs WebRTC/LiveKit). */
    mediaEngine?: "legacy" | "webrtc"
  }
  type VoiceRuntimeStats = {
    connected?: boolean
    clientId?: string | null
    traceSessionId?: string
    transport?: "udp" | "tcp"
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
  type VoiceTraceStamp = {
    clientId: string | null
    traceSessionId: string | null
    transport: "udp" | "tcp"
  }
  type AudioDevice = { id: string; label: string; kind: "input" | "output"; isDefault?: boolean }
  type VoicePipelineRuntime = {
    stream: MediaStream
    captureCtx: AudioContext
    captureNode: ScriptProcessorNode
    captureSource: MediaStreamAudioSourceNode
    micGainNode: GainNode
    captureHighpass: BiquadFilterNode
    speexWorklet: SpeexWorkletNode | null
    postDspGain: GainNode
    webrtcMicMerger: ChannelMergerNode
    /** Processed mic branch for LiveKit (parallel to ScriptProcessor UDP uplink). */
    webrtcMicDestNode: MediaStreamAudioDestinationNode
    monitorMicMerger: ChannelMergerNode
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
    rxResampleInput: Float32Array
    rxResamplePos: number
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
  const [serverPassword, setServerPassword] = useState(CONNECTION_DEFAULTS.password)
  const [superuserPasswordInput, setSuperuserPasswordInput] = useState("")
  const [apiHost, setApiHost] = useState(CONNECTION_DEFAULTS.host)
  const [apiPort, setApiPort] = useState(CONNECTION_DEFAULTS.port)
  const [apiUseHttps, setApiUseHttps] = useState(CONNECTION_DEFAULTS.useHttps)
  /** Empty = use UDP port from server join response. */
  const [udpPortOverride, setUdpPortOverride] = useState(CONNECTION_DEFAULTS.udpPort)
  const [voiceTransport, setVoiceTransport] = useState<"udp" | "tcp">("udp")
  const [mediaEngine, setMediaEngine] = useState<"legacy" | "webrtc">("legacy")
  const mediaEngineRef = useRef(mediaEngine)
  const [displayNameInput, setDisplayNameInput] = useState("User")
  const [profileDisplayName, setProfileDisplayName] = useState("User")
  const [servers, setServers] = useState<Array<{ id: string; name: string; icon: string }>>([])
  const [categories, setCategories] = useState<ChannelCategory[]>([])
  const [voiceUsers, setVoiceUsers] = useState<Record<string, Array<{ id: string; name: string; avatar: string; isMuted?: boolean; isDeafened?: boolean; isSpeaking?: boolean; isScreenSharing?: boolean; isWatchingScreen?: boolean }>>>({})
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
  const traceRef = useRef<{
    lastLogMs: number
    txFrames: number
    rxFrames: number
  }>({ lastLogMs: 0, txFrames: 0, rxFrames: 0 })
  const voicePlayoutBufferedRef = useRef(0)
  const [isSpeakingNow, setIsSpeakingNow] = useState(false)
  const [hasDesktopBridge, setHasDesktopBridge] = useState(false)
  const [showAppSettings, setShowAppSettings] = useState(false)
  const [appSettingsTab, setAppSettingsTab] = useState<AppSettingsTab>("voice")
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
  const [noiseSuppressionEnabled, setNoiseSuppressionEnabled] = useState(false)
  const [echoCancellationEnabled, setEchoCancellationEnabled] = useState(false)
  /** AGC often boosts constant hiss between words; prefer manual mic level + Opus. */
  const [autoGainControlEnabled, setAutoGainControlEnabled] = useState(false)
  /** Opus masks noise/hiss far better than raw PCM; PCM uplink sends full ADC noise floor (~768 kb/s). */
  const [useOpusUplink, setUseOpusUplink] = useState(true)
  /** SpeexDSP preprocess in AudioWorklet; causes hollow "tube" sound — off by default, browser NS is better. */
  const [speexNoiseSuppressionEnabled, setSpeexNoiseSuppressionEnabled] = useState(false)
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [monitorVolumePct, setMonitorVolumePct] = useState(15)
  /** Off by default: condenser mics pump with aggressive gating; browser NS + mic level is enough. */
  const [gateEnabled, setGateEnabled] = useState(false)
  /** Below this peak: silence (zone 1). */
  const [gateMuteThreshold, setGateMuteThreshold] = useState(120)
  /** Between mute and open thresholds: reduced level (zone 2). */
  const [gateFloorPct, setGateFloorPct] = useState(15)
  /** Above this peak: full passthrough (zone 3). */
  const [gateOpenThreshold, setGateOpenThreshold] = useState(320)
  const [gateReleaseMs, setGateReleaseMs] = useState(180)
  const [playbackGateEnabled, setPlaybackGateEnabled] = useState(false)
  const [playbackGateThreshold, setPlaybackGateThreshold] = useState(96)
  const [playbackHighpassEnabled, setPlaybackHighpassEnabled] = useState(false)
  const [playbackHighpassHz, setPlaybackHighpassHz] = useState(85)
  const [playbackLimiterEnabled, setPlaybackLimiterEnabled] = useState(false)
  const [micMeter, setMicMeter] = useState<MicLevelMeterSample | null>(null)
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
  const [activeScreenSharerId, setActiveScreenSharerId] = useState<string | null>(null)
  const [streamHiddenByUser, setStreamHiddenByUser] = useState(false)
  const streamHiddenByUserRef = useRef(false)
  const prevActiveScreenSharerIdRef = useRef<string | null>(null)
  const [screenImageUrl, setScreenImageUrl] = useState<string | null>(null)
  const [screenVideoUrl, setScreenVideoUrl] = useState<string | null>(null)
  const [hasRemoteWebRtcVideo, setHasRemoteWebRtcVideo] = useState(false)
  const [localScreenPreviewUrl, setLocalScreenPreviewUrl] = useState<string | null>(null)
  const [screenSources, setScreenSources] = useState<Array<{ id: string; name: string }>>([])
  const [selectedScreenSourceId, setSelectedScreenSourceId] = useState<string | null>(null)
  const [screenResolution, setScreenResolution] = useState("1280x720")
  const [screenFps, setScreenFps] = useState(30)
  const [screenBitrateKbps, setScreenBitrateKbps] = useState(3500)
  const [screenShareWithAudio, setScreenShareWithAudio] = useState(false)
  const screenShareWithAudioRef = useRef(false)
  const [showingStreamWindow, setShowingStreamWindow] = useState(false)
  const [streamVideoFullscreen, setStreamVideoFullscreen] = useState(false)
  const [streamVolumePct, setStreamVolumePct] = useState(100)
  const [streamLoading, setStreamLoading] = useState(false)
  const [legacyStreamBuffered, setLegacyStreamBuffered] = useState(false)
  const [serverAppearance, setServerAppearance] = useState<ServerAppearance>({})
  const [serverBannerDraft, setServerBannerDraft] = useState("")
  const [channelBannerChannelId, setChannelBannerChannelId] = useState("")
  const [channelBannerDraft, setChannelBannerDraft] = useState("")
  const streamVolumePctRef = useRef(streamVolumePct)
  const channelNameByIdRef = useRef<Record<string, string>>({})
  const channelTypeByIdRef = useRef<Record<string, "voice" | "text">>({})
  const lastSeenMessageIdByChannelRef = useRef<Record<string, string>>({})
  const messageNotificationsReadyRef = useRef(false)
  const screenShareTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const screenCaptureStreamRef = useRef<MediaStream | null>(null)
  const screenMediaRecorderRef = useRef<MediaRecorder | null>(null)
  const webRtcAudioSinkRef = useRef<HTMLDivElement | null>(null)
  const webRtcSessionRef = useRef<WebRtcMediaSession | null>(null)
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
  const popupMirrorRetryRef = useRef<number | null>(null)
  const lastPopupMirrorVideoUrlRef = useRef<string | null>(null)
  const renderStreamWindowRef = useRef<() => void>(() => {})
  const currentVoiceChannelRef = useRef("")
  const isScreenSharingRef = useRef(false)
  const screenRecorderResyncAtRef = useRef(0)
  const screenRecorderRestartingRef = useRef(false)
  const lastViewerScreenResyncReqRef = useRef<{ room: string; at: number } | null>(null)
  const screenInitSegmentRef = useRef<ArrayBuffer | null>(null)
  const pendingLegacyStreamResyncRef = useRef(false)
  const screenVideoUrlRef = useRef<string | null>(null)
  const legacyStreamHasBufferedRef = useRef(false)
  const lastWsVoiceJoinSyncRef = useRef<{ room: string; at: number } | null>(null)
  const localPresenceToggleRef = useRef(false)
  const isWatchingScreenRef = useRef(false)
  const resetRemoteStreamPlaybackRef = useRef<() => void>(() => {})
  const lastLocalPreviewUpdateAtRef = useRef(0)
  const uiClient = useMemo(() => new VoipClient(), [])
  const voiceClient = useMemo(() => new VoipClient(), [])
  /** Server where the user is in a voice channel; empty when not in voice. */
  const [voiceServerId, setVoiceServerId] = useState("")
  const activeServerIdRef = useRef("")
  const activeChannelIdRef = useRef(activeChannelId)
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
  const gateMuteThresholdRef = useRef(gateMuteThreshold)
  const gateOpenThresholdRef = useRef(gateOpenThreshold)
  const gateReleaseMsRef = useRef(gateReleaseMs)
  const gateFloorPctRef = useRef(gateFloorPct)
  const speexNoiseSuppressionEnabledRef = useRef(speexNoiseSuppressionEnabled)
  /** Persists noise-gate envelope across frames. */
  const uplinkGateEnvRef = useRef(0)
  const uplinkGateZoneRef = useRef<"mute" | "duck" | "open">("mute")
  const uplinkGateGainRef = useRef(1)
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

  const canStartScreenShare = useMemo(() => {
    if (isScreenSharing) return true
    if (!activeScreenSharerId) return true
    const meId = getVoiceWsClientRef.current().getMeState()?.clientId
    if (!meId) return false
    return activeScreenSharerId === meId
  }, [isScreenSharing, activeScreenSharerId])

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
    webRtcSessionRef.current?.setPeerVoiceVolume(targetClientId, nextVolume)
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

      const sidebarCategories = uiClient.toSidebarCategories()
      setCategories(sidebarCategories)
      const channelNames: Record<string, string> = {}
      const channelTypes: Record<string, "voice" | "text"> = {}
      for (const category of sidebarCategories) {
        for (const channel of category.channels) {
          channelNames[channel.id] = channel.name
          channelTypes[channel.id] = channel.type
        }
      }
      channelNameByIdRef.current = channelNames
      channelTypeByIdRef.current = channelTypes
      const uVu = uiClient.toVoiceUsers()
      const vVu = split && v ? voiceClient.toVoiceUsers() : {}
      setVoiceUsers({ ...uVu, ...vVu })

      const voiceWs = split ? voiceClient : uiClient
      setMyVoiceClientId(voiceWs.getMeState()?.clientId ?? null)

      const meId = voiceWs.getMeState()?.clientId
      if (meId && !localPresenceToggleRef.current) {
        const rt = split && v ? v : u
        const room = currentVoiceChannelRef.current
        const selfMember =
          (room ? rt.rosterByRoom[room]?.find((m) => m.clientId === meId) : undefined) ??
          rt.lobby.find((m) => m.clientId === meId)
        if (selfMember) {
          if (selfMember.muted !== mutedRef.current) {
            setIsMuted(selfMember.muted)
            void window.electronVoice?.setMute(selfMember.muted)
            void webRtcSessionRef.current?.setMuted(selfMember.muted)
          }
          if (selfMember.deafened !== deafenedRef.current) {
            setIsDeafened(selfMember.deafened)
            void window.electronVoice?.setDeafen(selfMember.deafened)
          }
        }
      }

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

      if (u.serverBannerUrl !== undefined) {
        const bannerUrl = u.serverBannerUrl?.trim() || undefined
        setServerAppearance((prev) => {
          if ((prev.serverBannerUrl ?? undefined) === bannerUrl) return prev
          const next = { ...prev }
          if (bannerUrl) next.serverBannerUrl = bannerUrl
          else delete next.serverBannerUrl
          return next
        })
      }

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

      const meClientId = u.me?.clientId
      for (const [channelId, items] of Object.entries(u.messagesByChannel)) {
        const latest = items[items.length - 1]
        if (!latest) continue
        const prev = lastSeenMessageIdByChannelRef.current[channelId]
        lastSeenMessageIdByChannelRef.current[channelId] = latest.id
        if (!messageNotificationsReadyRef.current) continue
        if (!prev || prev === latest.id) continue
        if (channelId === activeChannelIdRef.current) continue
        if (channelTypeByIdRef.current[channelId] !== "text") continue
        if (meClientId && latest.author.clientId === meClientId) continue
        const channelName = channelNameByIdRef.current[channelId] ?? channelId
        const preview = latest.body.trim() ? latest.body.trim() : "[attachment]"
        const shortPreview = preview.length > 90 ? `${preview.slice(0, 90)}...` : preview
        toast(`${latest.author.displayName} -> #${channelName}`, { description: shortPreview })
      }

      const screenState = split && v ? v : u
      const streamRoomId =
        currentVoiceChannelRef.current ||
        (() => {
          const chId = activeChannelIdRef.current
          if (!chId) return null
          return u.rooms.some((room) => room.id === chId && room.kind === "voice") ? chId : null
        })()
      const activeSharerId = streamRoomId ? screenState.activeScreenShareByRoom[streamRoomId] : null
      if (activeSharerId !== prevActiveScreenSharerIdRef.current) {
        prevActiveScreenSharerIdRef.current = activeSharerId ?? null
        if (streamHiddenByUserRef.current) {
          streamHiddenByUserRef.current = false
          setStreamHiddenByUser(false)
        }
      }
      setActiveScreenSharerId(activeSharerId ?? null)
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
    applyMerged()
    messageNotificationsReadyRef.current = true
    return () => {
      unsubUi()
      unsubVoice()
    }
  }, [uiClient, voiceClient, activeChannelId, currentVoiceChannel])

  useEffect(() => {
    currentVoiceChannelRef.current = currentVoiceChannel
  }, [currentVoiceChannel])

  useEffect(() => {
    activeChannelIdRef.current = activeChannelId
  }, [activeChannelId])

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
        webRtcSessionRef.current?.setPeerVoiceVolume(u.id, pct)
      }
    }
  }, [hasDesktopBridge, wsForVoiceJoin, isInVoice, peerVolServerId, peerVolRosterSig])

  useEffect(() => {
    // WS may reconnect while voice transport keeps running; push full presence snapshot to server.
    if (!wsForVoiceJoin) return
    const now = Date.now()
    const roomKey = isInVoice && currentVoiceChannel ? currentVoiceChannel : "__lobby__"
    const prev = lastWsVoiceJoinSyncRef.current
    if (prev && prev.room === roomKey && now - prev.at < 3000) return
    lastWsVoiceJoinSyncRef.current = { room: roomKey, at: now }
    getVoiceWsClient().syncPresence({
      roomId: isInVoice && currentVoiceChannel ? currentVoiceChannel : null,
      muted: mutedRef.current,
      deafened: deafenedRef.current,
      screenSharing: isScreenSharingRef.current,
      watchingScreen: isWatchingScreenRef.current,
      mediaEngine: mediaEngineRef.current
    })
  }, [wsForVoiceJoin, isVoiceSplit, wsConnected, isInVoice, currentVoiceChannel, mediaEngine, uiClient, voiceClient])

  useEffect(() => {
    const watching = Boolean(
      !streamHiddenByUser &&
        isInVoice &&
        currentVoiceChannel &&
        !isScreenSharing &&
        (activeScreenSharerName ||
          screenVideoUrl ||
          screenImageUrl ||
          hasRemoteWebRtcVideo ||
          streamLoading ||
          showingStreamWindow)
    )
    isWatchingScreenRef.current = watching
    if (!wsForVoiceJoin || !currentVoiceChannel) return
    getVoiceWsClient().setWatchingScreen(watching, currentVoiceChannel)
  }, [
    wsForVoiceJoin,
    isInVoice,
    currentVoiceChannel,
    isScreenSharing,
    screenVideoUrl,
    screenImageUrl,
    hasRemoteWebRtcVideo,
    showingStreamWindow,
    activeScreenSharerName,
    streamLoading,
    streamHiddenByUser,
    uiClient,
    voiceClient
  ])

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
      const globalPrefs = loadGlobalConnectionPrefs()
      setActiveServerId(preferred.serverId)
      setApiHost(preferred.apiHost)
      setApiPort(preferred.apiPort)
      setServerPassword(preferred.serverPassword)
      applyConnectionPrefsToState(
        {
          apiUseHttps: typeof preferred.apiUseHttps === "boolean" ? preferred.apiUseHttps : globalPrefs.apiUseHttps,
          udpPortOverride:
            typeof preferred.udpPortOverride === "string" ? preferred.udpPortOverride : (globalPrefs.udpPortOverride ?? ""),
          voiceTransport: preferred.voiceTransport ?? globalPrefs.voiceTransport,
          mediaEngine: preferred.mediaEngine ?? globalPrefs.mediaEngine
        },
        { setMediaEngine, setVoiceTransport, setApiUseHttps, setUdpPortOverride, mediaEngineRef }
      )
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
        gateMuteThreshold?: number
        gateOpenThreshold?: number
        gateReleaseMs?: number
        gateFloorPct?: number
        playbackGateEnabled?: boolean
        playbackGateThreshold?: number
        playbackHighpassEnabled?: boolean
        playbackHighpassHz?: number
        playbackLimiterEnabled?: boolean
        useOpusUplink?: boolean
        speexNoiseSuppressionEnabled?: boolean
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
      const legacyMute =
        typeof parsed.gateMuteThreshold === "number"
          ? parsed.gateMuteThreshold
          : typeof parsed.gateThreshold === "number"
            ? parsed.gateThreshold
            : null
      if (legacyMute !== null) setGateMuteThreshold(Math.max(0, Math.min(4000, Math.round(legacyMute))))
      if (typeof parsed.gateOpenThreshold === "number") {
        setGateOpenThreshold(Math.max(0, Math.min(4000, Math.round(parsed.gateOpenThreshold))))
      } else if (legacyMute !== null) {
        setGateOpenThreshold(Math.max(legacyMute + 80, Math.min(4000, Math.round(legacyMute * 2.2))))
      }
      if (typeof parsed.gateReleaseMs === "number") setGateReleaseMs(Math.max(80, Math.min(2000, Math.round(parsed.gateReleaseMs))))
      if (typeof parsed.gateFloorPct === "number") setGateFloorPct(Math.max(1, Math.min(50, Math.round(parsed.gateFloorPct))))
      // Playback DSP stays manual-only from Settings.
      // Do not auto-restore these toggles from old profiles/localStorage.
      if (typeof parsed.useOpusUplink === "boolean") setUseOpusUplink(parsed.useOpusUplink)
      if (typeof parsed.speexNoiseSuppressionEnabled === "boolean") setSpeexNoiseSuppressionEnabled(parsed.speexNoiseSuppressionEnabled)
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
        gateMuteThreshold,
        gateOpenThreshold,
        gateReleaseMs,
        gateFloorPct,
        playbackGateEnabled,
        playbackGateThreshold,
        playbackHighpassEnabled,
        playbackHighpassHz,
        playbackLimiterEnabled,
        useOpusUplink,
        speexNoiseSuppressionEnabled
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
    gateMuteThreshold,
    gateOpenThreshold,
    gateReleaseMs,
    gateFloorPct,
    playbackGateEnabled,
    playbackGateThreshold,
    playbackHighpassEnabled,
    playbackHighpassHz,
    playbackLimiterEnabled,
    useOpusUplink,
    speexNoiseSuppressionEnabled
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
    mediaEngineRef.current = mediaEngine
    webRtcSessionRef.current?.setPlayRemoteVoice(mediaEngine === "webrtc")
    republishWebRtcMicFromPipeline()
    if (wsForVoiceJoin) {
      getVoiceWsClient().syncPresence(buildPresenceSync())
    }
  }, [mediaEngine, wsForVoiceJoin, uiClient, voiceClient])

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
    gateMuteThresholdRef.current = gateMuteThreshold
    gateOpenThresholdRef.current = gateOpenThreshold
    gateReleaseMsRef.current = gateReleaseMs
    gateFloorPctRef.current = gateFloorPct
  }, [gateEnabled, gateMuteThreshold, gateOpenThreshold, gateReleaseMs, gateFloorPct])

  useEffect(() => {
    uplinkGateEnvRef.current = 0
    uplinkGateZoneRef.current = "mute"
    uplinkGateGainRef.current = 1
  }, [gateEnabled, gateMuteThreshold, gateOpenThreshold, gateFloorPct, gateReleaseMs])

  useEffect(() => {
    speexNoiseSuppressionEnabledRef.current = speexNoiseSuppressionEnabled
  }, [speexNoiseSuppressionEnabled])

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
    if (runtime.speexWorklet) {
      try {
        runtime.speexWorklet.disconnect()
        runtime.speexWorklet.destroy()
      } catch {
        /* ignore */
      }
    }
    runtime.captureNode.disconnect()
    runtime.captureNode.onaudioprocess = null
    runtime.captureSource.disconnect()
    runtime.micGainNode.disconnect()
    runtime.captureHighpass.disconnect()
    runtime.postDspGain.disconnect()
    runtime.webrtcMicMerger.disconnect()
    runtime.webrtcMicDestNode.disconnect()
    runtime.monitorMicMerger.disconnect()
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
    uplinkGateEnvRef.current = 0
    uplinkGateZoneRef.current = "mute"
    uplinkGateGainRef.current = 1
    void webRtcSessionRef.current?.unpublishMic()
    void runtime.captureCtx.close()
    void runtime.playbackCtx.close()
    runtime.stream.getTracks().forEach((t) => t.stop())
    voicePipelineRef.current = null
  }

  const stopWebRtcSession = async () => {
    const session = webRtcSessionRef.current
    webRtcSessionRef.current = null
    if (session) {
      await session.disconnect()
      getVoiceWsClientRef.current().syncPresence({
        roomId: null,
        muted: mutedRef.current,
        deafened: deafenedRef.current,
        screenSharing: false,
        watchingScreen: false,
        mediaEngine: mediaEngineRef.current
      })
    }
  }

  const applyVoiceEnginePresenceFlags = () => {
    void window.electronVoice?.setMute(mutedRef.current)
    void window.electronVoice?.setDeafen(deafenedRef.current)
  }

  const buildPresenceSync = () => ({
    roomId: isInVoiceRef.current && currentVoiceChannelRef.current ? currentVoiceChannelRef.current : null,
    muted: mutedRef.current,
    deafened: deafenedRef.current,
    screenSharing: isScreenSharingRef.current,
    watchingScreen: isWatchingScreenRef.current,
    mediaEngine: mediaEngineRef.current
  })

  const getWebRtcMicTrackFromPipeline = (): MediaStreamTrack | null => {
    const rt = voicePipelineRef.current
    if (!rt) return null
    const processed = rt.webrtcMicDestNode.stream.getAudioTracks()[0]
    if (processed && processed.readyState === "live") return processed
    return rt.stream.getAudioTracks()[0] ?? null
  }

  const republishWebRtcMicFromPipeline = () => {
    const mic = getWebRtcMicTrackFromPipeline()
    if (!mic || !webRtcSessionRef.current?.connected) return
    void webRtcSessionRef.current.publishMicTrack(mic)
    void webRtcSessionRef.current.setMuted(mutedRef.current)
  }

  const resolveRosterDisplayName = (clientId: string) => {
    const rt = latestVoiceStateRef.current ?? latestUiStateRef.current
    if (!rt) return clientId
    for (const users of Object.values(rt.rosterByRoom)) {
      const found = users.find((m) => m.clientId === clientId)
      if (found) return found.displayName
    }
    const lobby = rt.lobby.find((m) => m.clientId === clientId)
    return lobby?.displayName ?? clientId
  }

  const applyRemoteWebRtcVideo = (active: boolean, participantIdentity: string | null) => {
    const roomId = currentVoiceChannelRef.current
    if (streamHiddenByUserRef.current) {
      if (roomId) getVoiceWsClientRef.current().setWatchingScreen(false, roomId)
      return
    }
    if (roomId) getVoiceWsClientRef.current().setWatchingScreen(active, roomId)
    if (active && participantIdentity) {
      setHasRemoteWebRtcVideo(true)
      setActiveScreenSharerName(resolveRosterDisplayName(participantIdentity))
      const legacyActive = legacyStreamHasBufferedRef.current
      if (!legacyActive && screenVideoUrlRef.current) {
        resetLegacyStreamPlayback()
      }
      if (!legacyActive) {
        webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
        if (streamWindowRef.current && !streamWindowRef.current.closed) {
          const popupEl = streamWindowRef.current.document.getElementById("voixex-stream-video") as HTMLVideoElement | null
          webRtcSessionRef.current?.bindPopupScreenVideo(popupEl)
          renderStreamWindowRef.current()
        }
        setStreamLoading(false)
      }
      return
    }
    webRtcSessionRef.current?.bindRemoteScreenVideo(null)
    setHasRemoteWebRtcVideo(false)
    if (remoteStreamVideoRef.current) remoteStreamVideoRef.current.srcObject = null
  }

  const isLegacyStreamBuffered = () => {
    const sbuf = remoteSourceBufferRef.current
    return Boolean(sbuf && sbuf.buffered.length > 0)
  }

  const requestViewerStreamResync = (roomId: string, force = false) => {
    if (!roomId || !hasDesktopBridge || streamHiddenByUserRef.current) return
    const now = Date.now()
    const prev = lastViewerScreenResyncReqRef.current
    if (!force && prev && prev.room === roomId && now - prev.at < 2500) return
    lastViewerScreenResyncReqRef.current = { room: roomId, at: now }
    pendingLegacyStreamResyncRef.current = true
    setStreamLoading(true)
    getVoiceWsClientRef.current().requestScreenResync(roomId)
  }

  const getStreamRoomSharerId = (roomId: string) => {
    const state = latestVoiceStateRef.current ?? latestUiStateRef.current
    if (!state) return null
    return state.activeScreenShareByRoom[roomId] ?? null
  }

  const rebindViewerStreamElements = () => {
    webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
    const v = remoteStreamVideoRef.current
    if (legacyStreamHasBufferedRef.current && screenVideoUrlRef.current && v) {
      void v.play().catch(() => {})
    }
    if (streamWindowRef.current && !streamWindowRef.current.closed) {
      renderStreamWindowRef.current()
    }
  }

  const catchUpViewerStreamAfterJoin = async (serverId: string, roomId: string) => {
    if (streamHiddenByUserRef.current) return
    await ensureLiveKitForVoiceRoom(serverId, roomId)
    if (getStreamRoomSharerId(roomId)) {
      isWatchingScreenRef.current = true
      getVoiceWsClientRef.current().setWatchingScreen(true, roomId)
      requestViewerStreamResync(roomId, true)
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        rebindViewerStreamElements()
      })
    })
  }

  const startWebRtcSession = async (serverId: string, roomId: string) => {
    const sink = webRtcAudioSinkRef.current
    if (!sink) throw new Error("WebRTC audio sink is not ready")
    await stopWebRtcSession()
    const token = await getVoiceWsClientRef.current().getSfuToken(serverId, roomId)
    const session = new WebRtcMediaSession({
      audioSink: sink,
      playRemoteVoice: mediaEngineRef.current === "webrtc",
      onStatus: setStatus,
      onScreenShareChange: () => {
        /* screen share state is driven by server set_screen_share + local capture */
      },
      onWatchingScreenChange: (watching) => {
        getVoiceWsClientRef.current().setWatchingScreen(watching, roomId)
      },
      onRemoteVideo: (active, participantIdentity) => {
        applyRemoteWebRtcVideo(active, participantIdentity)
      }
    })
    await session.connect(token)
    const devices = (await window.electronVoice?.getAudioDevices()) as { inputId: string | null; outputId: string | null } | undefined
    await session.setOutputDevice(devices?.outputId ?? null)
    await session.setDeafened(deafenedRef.current)
    const mic = getWebRtcMicTrackFromPipeline()
    if (mic) {
      await session.publishMicTrack(mic)
      await session.setMuted(mutedRef.current)
    }
    getVoiceWsClientRef.current().syncPresence({
      roomId,
      muted: mutedRef.current,
      deafened: deafenedRef.current,
      screenSharing: false,
      watchingScreen: false,
      mediaEngine: mediaEngineRef.current
    })
    webRtcSessionRef.current = session
  }

  const ensureLiveKitForVoiceRoom = async (serverId: string, roomId: string) => {
    try {
      await startWebRtcSession(serverId, roomId)
    } catch {
      // LiveKit is optional; legacy WS screen chunks and UDP voice still work.
    }
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

  const isWebmInitSegment = (chunk: Uint8Array) =>
    chunk.length >= 4 && chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3

  const sendScreenVideoChunkBytes = (bytes: Uint8Array) => {
    if (isWebmInitSegment(bytes)) {
      screenInitSegmentRef.current = bytes.slice().buffer
    }
    getVoiceWsClientRef.current().sendScreenVideoChunk(encodeBytesBase64(bytes))
  }

  const stopPopupMirrorTracks = useCallback(() => {
    if (popupMirrorRetryRef.current) {
      clearInterval(popupMirrorRetryRef.current)
      popupMirrorRetryRef.current = null
    }
    webRtcSessionRef.current?.unbindPopupScreenVideo()
    const s = popupMirrorStreamRef.current
    if (s) {
      s.getTracks().forEach((t) => t.stop())
      popupMirrorStreamRef.current = null
    }
    lastPopupMirrorVideoUrlRef.current = null
  }, [])

  const schedulePopupMirrorRetry = useCallback(() => {
    if (popupMirrorRetryRef.current) return
    if (!streamWindowRef.current || streamWindowRef.current.closed) return
    let attempts = 0
    popupMirrorRetryRef.current = window.setInterval(() => {
      attempts += 1
      renderStreamWindowRef.current()
      if (attempts >= 48) {
        if (popupMirrorRetryRef.current) {
          clearInterval(popupMirrorRetryRef.current)
          popupMirrorRetryRef.current = null
        }
      }
    }, 250)
  }, [])

  const mirrorLegacyVideoToPopup = (srcVideo: HTMLVideoElement, imageEl: HTMLVideoElement, key: string) => {
    if (srcVideo.videoWidth === 0 || srcVideo.readyState < 2) return false
    const needNewMirror =
      lastPopupMirrorVideoUrlRef.current !== key || imageEl.srcObject !== popupMirrorStreamRef.current
    if (!needNewMirror) {
      void imageEl.play().catch(() => {})
      return true
    }
    const prevMirror = popupMirrorStreamRef.current
    if (prevMirror) {
      prevMirror.getTracks().forEach((t) => t.stop())
      popupMirrorStreamRef.current = null
    }
    webRtcSessionRef.current?.unbindPopupScreenVideo()
    try {
      const cap = (srcVideo as HTMLVideoElement & { captureStream?: (frameRate?: number) => MediaStream }).captureStream?.()
      if (!cap || cap.getVideoTracks().length === 0) return false
      popupMirrorStreamRef.current = cap
      lastPopupMirrorVideoUrlRef.current = key
      imageEl.srcObject = cap
      imageEl.removeAttribute("src")
      void imageEl.play().catch(() => {})
      return true
    } catch {
      lastPopupMirrorVideoUrlRef.current = null
      return false
    }
  }

  const resetLegacyStreamPlayback = () => {
    remoteAppendQueueRef.current = []
    legacyStreamHasBufferedRef.current = false
    setLegacyStreamBuffered(false)
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

  const resetWebRtcStreamPlayback = () => {
    webRtcSessionRef.current?.bindRemoteScreenVideo(null)
    setHasRemoteWebRtcVideo(false)
  }

  const resetRemoteStreamPlayback = () => {
    stopPopupMirrorTracks()
    resetLegacyStreamPlayback()
    resetWebRtcStreamPlayback()
    if (remoteStreamVideoRef.current) remoteStreamVideoRef.current.srcObject = null
  }
  resetRemoteStreamPlaybackRef.current = resetRemoteStreamPlayback

  const prevVoiceChannelForStreamRef = useRef("")

  useEffect(() => {
    if (!currentVoiceChannel) {
      prevVoiceChannelForStreamRef.current = ""
      return
    }
    if (prevVoiceChannelForStreamRef.current === currentVoiceChannel) return
    prevVoiceChannelForStreamRef.current = currentVoiceChannel
    resetRemoteStreamPlaybackRef.current()
    setStreamLoading(false)
  }, [currentVoiceChannel])

  const pushRemoteVideoChunk = (chunk: Uint8Array) => {
    if (streamHiddenByUserRef.current) return
    const buf =
      chunk.buffer instanceof ArrayBuffer && chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? chunk.buffer
        : chunk.slice().buffer

    const isWebmInit =
      chunk.length >= 4 && chunk[0] === 0x1a && chunk[1] === 0x45 && chunk[2] === 0xdf && chunk[3] === 0xa3

    if (isWebmInit && remoteMediaSourceRef.current) {
      const sbuf = remoteSourceBufferRef.current
      const established =
        Boolean(sbuf && sbuf.buffered.length > 0 && (remoteStreamVideoRef.current?.readyState ?? 0) >= 2)
      if (established && !pendingLegacyStreamResyncRef.current) {
        return
      }
      pendingLegacyStreamResyncRef.current = false
      resetLegacyStreamPlayback()
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

    const onMseUpdateEnd = () => {
      const sbuf = remoteSourceBufferRef.current
      if (sbuf && sbuf.buffered.length > 0) {
        legacyStreamHasBufferedRef.current = true
        setLegacyStreamBuffered(true)
        setStreamLoading(false)
        void remoteStreamVideoRef.current?.play().catch(() => {})
        if (streamWindowRef.current && !streamWindowRef.current.closed) renderStreamWindowRef.current()
      }
      drainRemoteMse()
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
        const mimeCandidates = [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm"
        ]
        const mime = mimeCandidates.find((m) => MediaSource.isTypeSupported(m)) ?? "video/webm"
        try {
          const sbuf = ms.addSourceBuffer(mime)
          remoteSourceBufferRef.current = sbuf
          remoteMseUpdateEndRef.current = onMseUpdateEnd
          sbuf.addEventListener("updateend", onMseUpdateEnd)
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

  /**
   * Three-zone uplink gate:
   * 1) below mute threshold → silence
   * 2) between mute and open → floor % of full level
   * 3) above open threshold → 100%
   */
  const applyUplinkNoiseGate = (
    frame: Int16Array,
    muteThreshold: number,
    openThreshold: number,
    floorRatio: number
  ) => {
    if (frame.length === 0) return frame
    const muteT = Math.max(8, muteThreshold)
    const openT = Math.max(muteT + 24, openThreshold)
    const floor = Math.max(0.01, Math.min(0.5, floorRatio))
    const muteEnter = muteT
    const muteLeave = muteT * 0.88
    const openEnter = openT
    const openLeave = openT * 0.9
    const sr = 48000
    const releaseMs = Math.max(80, gateReleaseMsRef.current)
    const coeffR = Math.exp(-1 / (sr * (releaseMs / 1000)))
    const coeffA = Math.exp(-1 / (sr * 0.004))
    const gainSmoothUp = Math.exp(-1 / (sr * 0.003))
    const gainSmoothDown = Math.exp(-1 / (sr * 0.012))

    let env = uplinkGateEnvRef.current
    let zone = uplinkGateZoneRef.current
    let gain = uplinkGateGainRef.current
    const out = new Int16Array(frame.length)
    for (let i = 0; i < frame.length; i += 1) {
      const s = frame[i]
      const p = Math.abs(s)
      if (p >= env) {
        env = env + (p - env) * (1 - coeffA)
      } else {
        env = env * coeffR
      }
      if (zone === "open") {
        if (env < openLeave) zone = env >= muteEnter ? "duck" : "mute"
      } else if (zone === "duck") {
        if (env >= openEnter) zone = "open"
        else if (env < muteLeave) zone = "mute"
      } else if (env >= openEnter) {
        zone = "open"
      } else if (env >= muteEnter) {
        zone = "duck"
      } else {
        zone = "mute"
      }
      const targetGain = zone === "open" ? 1 : zone === "duck" ? floor : 0
      const smooth = targetGain > gain ? gainSmoothUp : gainSmoothDown
      gain = gain + (targetGain - gain) * (1 - smooth)
      out[i] = Math.round(s * gain)
    }
    uplinkGateEnvRef.current = env
    uplinkGateZoneRef.current = zone
    uplinkGateGainRef.current = gain
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

  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v))

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
    const rt = voicePipelineRef.current
    if (!rt || !voiceStats) return
    const jitter = Math.max(0, voiceStats.jitter1PctMs ?? 0)
    // Quality-first adaptive policy: larger startup buffer on unstable links.
    const startMs = clamp(Math.round(140 + jitter * 2.5), 140, 320)
    const maxQueuedSec = clamp(startMs / 1000 + 0.75, 0.9, 1.6)
    rt.playoutPrefetch.reconfigure(startMs, maxQueuedSec)
  }, [voiceStats])

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
        const preferredInputId = selected?.inputId ?? null
        const speexRequested = hasDesktopBridge && speexNoiseSuppressionEnabledRef.current

        if (window.electronVoice?.requestMicrophoneAccess) {
          const micAccess = await window.electronVoice.requestMicrophoneAccess()
          if (!micAccess.granted) {
            const msg = t("notices.micDenied")
            setDeviceError(msg)
            toast.error(msg)
            return
          }
        }

        const captureCtx = new AudioContext({ sampleRate: 48000 })
        let speexWorklet: SpeexWorkletNode | null = null
        if (speexRequested) {
          try {
            speexWorklet = await createSpeexNoiseWorklet(captureCtx)
          } catch (e) {
            console.warn("[voixex] Speex DSP failed:", e)
            setDeviceError(
              e instanceof Error
                ? `Speex failed (${e.message}); using browser noise suppression if enabled.`
                : "Speex failed to load; using browser noise suppression if enabled."
            )
          }
        }
        const speexActive = Boolean(speexWorklet)

        const preferredConstraints: MediaTrackConstraints = {
          ...(preferredInputId ? { deviceId: { exact: preferredInputId } } : {}),
          channelCount: 1,
          sampleRate: 48000,
          sampleSize: 16,
          echoCancellation: echoCancellationEnabled,
          noiseSuppression: speexActive ? false : noiseSuppressionEnabled,
          autoGainControl: autoGainControlEnabled
        }
        let stream: MediaStream
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: preferredConstraints })
        } catch {
          // Fallback ladder:
          // 1) drop strict DSP constraints but keep preferred inputId
          // 2) drop preferred inputId too (default system input)
          // Some drivers reject stale deviceId/sinkId and would otherwise kill the whole pipeline.
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                ...(preferredInputId ? { deviceId: { exact: preferredInputId } } : {}),
                channelCount: 1,
                noiseSuppression: speexActive ? false : noiseSuppressionEnabled
              }
            })
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            if (preferredInputId) {
              void window.electronVoice?.setAudioDevices({ inputId: null, outputId: selected?.outputId ?? null })
              setSelectedDevices((prev) => ({ ...prev, inputId: null }))
              setDeviceError(t("notices.inputDeviceUnavailable"))
            } else if (!speexActive && noiseSuppressionEnabled) {
              setDeviceError(t("notices.noiseSuppressionUnsupported"))
            }
          }
        }
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          void captureCtx.close()
          return
        }

        const playbackCtx = new AudioContext({ sampleRate: 48000 })
        if (selected?.outputId && typeof (playbackCtx as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId === "function") {
          try {
            await (playbackCtx as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(selected.outputId)
          } catch {
            // Keep pipeline alive on stale output device IDs.
            void window.electronVoice?.setAudioDevices({ inputId: selected?.inputId ?? null, outputId: null })
            setSelectedDevices((prev) => ({ ...prev, outputId: null }))
            setDeviceError(t("notices.outputDeviceUnavailable"))
          }
        }

        const captureSource = captureCtx.createMediaStreamSource(stream)
        // Keep 0.2.28 behavior: ScriptProcessor on some Electron stacks is
        // stable only with power-of-two buffer sizes.
        const captureNode = captureCtx.createScriptProcessor(1024, 1, 1)
        const micGainNode = captureCtx.createGain()
        micGainNode.gain.value = micVolumePctRef.current / 100
        const captureHighpass = captureCtx.createBiquadFilter()
        captureHighpass.type = "highpass"
        captureHighpass.frequency.value = 75
        captureHighpass.Q.value = 0.707
        const postDspGain = captureCtx.createGain()
        postDspGain.gain.value = 1
        const webrtcMicTap = createMonoMediaStreamTap(captureCtx)
        const webrtcMicDestNode = webrtcMicTap.destination
        const webrtcMicMerger = webrtcMicTap.merger
        const monitorMicTap = createMonoMediaStreamTap(captureCtx)
        const monitorDestNode = monitorMicTap.destination
        const monitorMicMerger = monitorMicTap.merger
        const captureSinkNode = captureCtx.createMediaStreamDestination()
        const playbackWorklet = await loadVoicePlaybackWorklet(playbackCtx)
        const playoutPrefetch = new VoicePlayoutPrefetch(playbackCtx.sampleRate, playbackWorklet.port, {
          startMs: 220,
          maxQueuedSec: 1.2
        })
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
        const capturePumpGainNode = captureCtx.createGain()
        capturePumpGainNode.gain.value = 0
        const runtime: VoicePipelineRuntime = {
          stream,
          captureCtx,
          captureNode,
          captureSource,
          micGainNode,
          captureHighpass,
          speexWorklet,
          postDspGain,
          webrtcMicMerger,
          webrtcMicDestNode,
          monitorMicMerger,
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
          rxResampleInput: new Float32Array(0),
          rxResamplePos: 0,
          playbackSampleRate: playbackCtx.sampleRate,
          unsubscribeIncoming: null,
          unsubscribeScreenChunk: null,
          lastIncomingAudioAtMs: 0,
          playbackIdleTimer: null,
          captureGateOpenUntilMs: 0
        }
        voicePipelineRef.current = runtime
        voicePlayoutBufferedRef.current = 0
        republishWebRtcMicFromPipeline()
        setAudioPipelineDiag({
          captureSampleRate: captureCtx.sampleRate,
          playbackSampleRate: playbackCtx.sampleRate,
          playoutBufferedSamples: 0,
          playoutUnderruns: 0,
          playoutOverflowDrops: 0
        })

        const frameSize = 960
        runtime.txResampleInput = new Float32Array(0)
        runtime.txResamplePos = 0
        // In TCP mode we prefer raw PCM uplink to avoid additional codec artifacts:
        // transport is already reliable and bandwidth is acceptable for desktop.
        const shouldUseOpusUplink = useOpusUplink && voiceTransport !== "tcp"
        let opusEncoder: unknown = null
        if (shouldUseOpusUplink && window.electronVoice?.sendOpusFrame) {
          try {
            const mod = await import("opusscript")
            const OpusScript = (mod as unknown as { default: typeof import("opusscript") }).default
            const enc = new OpusScript(48_000, 1, OpusScript.Application.VOIP)
            enc.setBitrate(128_000)
            try { enc.encoderCTL(4024, 3001) } catch { /* OPUS_SET_SIGNAL → VOICE */ }
            try { enc.encoderCTL(4006, 1) } catch { /* OPUS_SET_VBR_REQUEST → enabled */ }
            try { enc.encoderCTL(4020, 0) } catch { /* OPUS_SET_VBR_CONSTRAINT_REQUEST → unconstrained */ }
            try { enc.encoderCTL(4010, 10) } catch { /* OPUS_SET_COMPLEXITY → max quality */ }
            try { enc.encoderCTL(4012, 1) } catch { /* OPUS_SET_INBAND_FEC → on */ }
            try { enc.encoderCTL(4014, 5) } catch { /* OPUS_SET_PACKET_LOSS_PERC → realistic mild loss hint */ }
            try { enc.encoderCTL(4016, 0) } catch { /* OPUS_SET_DTX → off for stable speech continuity */ }
            opusEncoder = enc
          } catch {
            setDeviceError(t("notices.opusFailed"))
            opusEncoder = null
          }
        } else if (voiceTransport === "tcp") {
          setDeviceError(t("notices.tcpPcmUplink"))
        }
        let lastMeterEmitAt = 0
        captureNode.onaudioprocess = (ev) => {
          if (!voicePipelineRef.current || voicePipelineRef.current !== runtime) return
          const input = ev.inputBuffer.getChannelData(0)
          const output = ev.outputBuffer.getChannelData(0)
          const resampled = resampleFloat32Chunk(input, runtime.captureCtx.sampleRate, 48000, runtime)
          const pcm = new Int16Array(resampled.length)
          for (let i = 0; i < resampled.length; i += 1) {
            const sample = Math.max(-1, Math.min(1, resampled[i]))
            pcm[i] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767)
          }

          const muteAmp = Math.max(0, Math.round(gateMuteThresholdRef.current))
          const openAmp = Math.max(muteAmp + 24, Math.round(gateOpenThresholdRef.current))
          const gateFloorRatio = Math.max(0.01, Math.min(0.5, gateFloorPctRef.current / 100))
          const gatedPcm = gateEnabledRef.current
            ? applyUplinkNoiseGate(pcm, muteAmp, openAmp, gateFloorRatio)
            : pcm
          const txPcm = mutedRef.current ? new Int16Array(gatedPcm.length) : gatedPcm

          const now = Date.now()
          if (now - lastMeterEmitAt >= 80) {
            lastMeterEmitAt = now
            const pre = calcFrameEnergy(pcm)
            const post = calcFrameEnergy(gatedPcm)
            setMicMeter({
              inputPeak: pre.peak,
              inputRms: pre.rms,
              txPeak: post.peak,
              txRms: post.rms,
              gateZone: gateEnabledRef.current ? uplinkGateZoneRef.current : "off"
            })
          }

          for (let i = 0; i < output.length; i += 1) {
            output[i] = i < txPcm.length ? txPcm[i] / 32768 : 0
          }

          const merged = concatInt16(runtime.txRemainder, txPcm)
          let offset = 0
          while (offset + frameSize <= merged.length) {
            if (!mutedRef.current) {
              const frame = merged.subarray(offset, offset + frameSize)
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
              if (VOICE_TRACE) traceRef.current.txFrames += 1
            }
            offset += frameSize
          }
          const remainder = merged.subarray(offset)
          runtime.txRemainder = new Int16Array(remainder.length)
          runtime.txRemainder.set(remainder)
          if (VOICE_TRACE) {
            const now = Date.now()
            if (now - traceRef.current.lastLogMs >= 1000) {
              traceRef.current.lastLogMs = now
              const traceStamp: VoiceTraceStamp = {
                clientId: voiceStats?.clientId ?? null,
                traceSessionId: voiceStats?.traceSessionId ?? null,
                transport: voiceStats?.transport === "tcp" ? "tcp" : "udp"
              }
              console.info("[voice-trace][tx]", {
                ...traceStamp,
                txFramesPerSec: traceRef.current.txFrames,
                captureSampleRate: runtime.captureCtx.sampleRate,
                remainderSamples: runtime.txRemainder.length
              })
              traceRef.current.txFrames = 0
            }
          }
        }

        runtime.unsubscribeIncoming = window.electronVoice?.onPcm16Frame((pcm16Base64) => {
          if (mediaEngineRef.current === "webrtc") return
          if (deafenedRef.current) return
          const frame48k = decodePcm16Base64(pcm16Base64)
          const resampled = resampleInt16Chunk(frame48k, 48000, runtime.playbackSampleRate, runtime)
          const gated = applyPlaybackNoiseGate(resampled, playbackGateEnabledRef.current, playbackGateThresholdRef.current)
          const frame = applySoftLimiter(gated, playbackLimiterEnabledRef.current)
          // Keep timeline continuous even on near-silence.
          // Dropping silent frames causes playout underruns and audible "word glue"/clicks.
          runtime.lastIncomingAudioAtMs = Date.now()
          if (runtime.playbackCtx.state !== "running") {
            void runtime.playbackCtx.resume()
          }
          const floatOut = new Float32Array(frame.length)
          for (let i = 0; i < frame.length; i += 1) {
            floatOut[i] = frame[i] / 32768
          }
          runtime.playoutPrefetch.pushBlock(floatOut)
          if (VOICE_TRACE) {
            traceRef.current.rxFrames += 1
            const now = Date.now()
            if (now - traceRef.current.lastLogMs >= 1000) {
              traceRef.current.lastLogMs = now
              const traceStamp: VoiceTraceStamp = {
                clientId: voiceStats?.clientId ?? null,
                traceSessionId: voiceStats?.traceSessionId ?? null,
                transport: voiceStats?.transport === "tcp" ? "tcp" : "udp"
              }
              console.info("[voice-trace][rx]", {
                ...traceStamp,
                rxFramesPerSec: traceRef.current.rxFrames,
                frameSamples: frame.length,
                playbackSampleRate: runtime.playbackSampleRate,
                playoutBuffered: voicePlayoutBufferedRef.current
              })
              traceRef.current.rxFrames = 0
            }
          }
        }) ?? null
        // Screen video uses WebSocket (reliable); UDP screen path not used.
        runtime.unsubscribeScreenChunk = null

        captureSource.connect(micGainNode)
        micGainNode.connect(captureHighpass)
        if (speexWorklet) {
          captureHighpass.connect(speexWorklet)
          speexWorklet.connect(postDspGain)
        } else {
          captureHighpass.connect(postDspGain)
        }
        postDspGain.connect(captureNode)
        connectMonoSourceToTap(captureNode, webrtcMicTap)
        connectMonoSourceToTap(captureNode, monitorMicTap)
        // Keep capture worklet actively pulled while avoiding sidetone.
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
        setDeviceError(errorText(e, "notices.audioStartFailed"))
      }
    }

    void startVoicePipeline()
    return () => {
      cancelled = true
      stopVoicePipeline()
    }
  }, [
    hasDesktopBridge,
    isInVoice,
    currentVoiceChannel,
    audioDevicesRevision,
    noiseSuppressionEnabled,
    echoCancellationEnabled,
    autoGainControlEnabled,
    speexNoiseSuppressionEnabled
  ])

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
    screenShareWithAudioRef.current = screenShareWithAudio
  }, [screenShareWithAudio])

  useEffect(() => {
    const savedRes = localStorage.getItem("voixex-screen-resolution")
    const savedFps = Number(localStorage.getItem("voixex-screen-fps") || "30")
    const savedBitrate = Number(localStorage.getItem("voixex-screen-bitrate-kbps") || "3500")
    const savedWithAudio = localStorage.getItem("voixex-screen-with-audio")
    if (savedRes && /^\d+x\d+$/.test(savedRes)) setScreenResolution(savedRes)
    if (Number.isFinite(savedFps) && savedFps > 0) setScreenFps(savedFps)
    if (Number.isFinite(savedBitrate) && savedBitrate > 0) setScreenBitrateKbps(savedBitrate)
    if (savedWithAudio === "1") setScreenShareWithAudio(true)
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
    localStorage.setItem("voixex-screen-with-audio", screenShareWithAudio ? "1" : "0")
  }, [screenShareWithAudio])

  useEffect(() => {
    screenVideoUrlRef.current = screenVideoUrl
  }, [screenVideoUrl])

  const viewingLegacyStream = Boolean((screenVideoUrl || screenImageUrl) && legacyStreamBuffered)
  const viewingWebRtcStream = hasRemoteWebRtcVideo && !viewingLegacyStream
  const streamPathLabel = viewingLegacyStream ? "Legacy" : viewingWebRtcStream ? "WebRTC" : ""
  const activeChannelBannerUrl =
    activeChannelId && serverAppearance.channelBanners?.[activeChannelId]
      ? serverAppearance.channelBanners[activeChannelId]
      : null

  const saveServerBanner = async () => {
    if (!activeServerId) return
    const url = serverBannerDraft.trim() || null
    try {
      await uiClient.updateServerBanner(activeServerId, url)
      const next: ServerAppearance = { ...serverAppearance }
      if (url) next.serverBannerUrl = url
      else delete next.serverBannerUrl
      saveServerAppearance(activeServerId, next)
      setServerAppearance(next)
      toast.success(t("settings.serverBannerSaved"))
    } catch {
      const next: ServerAppearance = { ...serverAppearance }
      if (url) next.serverBannerUrl = url
      else delete next.serverBannerUrl
      saveServerAppearance(activeServerId, next)
      setServerAppearance(next)
      toast.warning(t("settings.serverBannerSavedLocalOnly"))
    }
  }

  const saveChannelBanner = () => {
    if (!activeServerId || !channelBannerChannelId) return
    const banners = { ...(serverAppearance.channelBanners ?? {}) }
    const url = channelBannerDraft.trim()
    if (url) banners[channelBannerChannelId] = url
    else delete banners[channelBannerChannelId]
    const next: ServerAppearance = { ...serverAppearance, channelBanners: banners }
    saveServerAppearance(activeServerId, next)
    setServerAppearance(next)
    toast.success(t("notices.channelBannerSaved"))
  }

  useEffect(() => {
    if (viewingWebRtcStream) {
      webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
    } else {
      webRtcSessionRef.current?.bindRemoteScreenVideo(null)
    }
  }, [viewingWebRtcStream, hasRemoteWebRtcVideo, screenVideoUrl, legacyStreamBuffered])

  useEffect(() => {
    void webRtcSessionRef.current?.setDeafened(isDeafened)
  }, [isDeafened])

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
    isScreenSharing,
    showingStreamWindow,
    hasRemoteWebRtcVideo,
    legacyStreamBuffered,
    isDeafened
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
  }, [showingStreamWindow, screenVideoUrl, hasRemoteWebRtcVideo, legacyStreamBuffered])

  useEffect(() => {
    if (!showingStreamWindow) return
    renderStreamWindowRef.current()
  }, [showingStreamWindow, hasRemoteWebRtcVideo, screenVideoUrl, screenImageUrl, isDeafened, activeScreenSharerName, legacyStreamBuffered])

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

  const applyPresenceState = (input: { muted?: boolean; deafened?: boolean; screenSharing?: boolean }) => {
    const muted = input.muted ?? mutedRef.current
    const deafened = input.deafened ?? deafenedRef.current
    const screenSharing = input.screenSharing ?? isScreenSharingRef.current
    if (input.muted !== undefined) {
      setIsMuted(input.muted)
      void window.electronVoice?.setMute(input.muted)
      void webRtcSessionRef.current?.setMuted(input.muted)
    }
    if (input.deafened !== undefined) {
      setIsDeafened(input.deafened)
      void window.electronVoice?.setDeafen(input.deafened)
      void webRtcSessionRef.current?.setDeafened(input.deafened)
    }
    if (input.screenSharing !== undefined) {
      setIsScreenSharing(input.screenSharing)
    }
    getVoiceWsClientRef.current().syncPresence({
      roomId: isInVoiceRef.current && currentVoiceChannelRef.current ? currentVoiceChannelRef.current : null,
      muted,
      deafened,
      screenSharing,
      watchingScreen: isWatchingScreenRef.current,
      mediaEngine: mediaEngineRef.current
    })
  }

  const applyMute = (next: boolean) => {
    localPresenceToggleRef.current = true
    setIsMuted(next)
    getVoiceWsClient().setMute(next)
    void window.electronVoice?.setMute(next)
    void webRtcSessionRef.current?.setMuted(next)
    setStatus(next ? "Microphone muted" : "Microphone unmuted")
    window.setTimeout(() => {
      localPresenceToggleRef.current = false
    }, 600)
  }

  const applyDeafen = (next: boolean) => {
    localPresenceToggleRef.current = true
    setIsDeafened(next)
    getVoiceWsClient().setDeafen(next)
    void window.electronVoice?.setDeafen(next)
    void webRtcSessionRef.current?.setDeafened(next)
    setStatus(next ? "Headphones deafened" : "Headphones undeafened")
    window.setTimeout(() => {
      localPresenceToggleRef.current = false
    }, 600)
  }

  const handleSendMessage = (content: string) => {
    if (!activeServerId || !activeChannelId) return
    void uiClient.sendMessage(activeServerId, activeChannelId, content).catch((e) => {
      toast.error(errorText(e, "notices.sendMessageFailed"))
    })
  }

  const handleUploadAttachment = async (file: File) => {
    if (!activeServerId || !activeChannelId) return
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === activeChannelId)
    if (!channel || channel.type !== "text") return
    try {
      const uploaded = await uiClient.uploadAttachment(activeServerId, activeChannelId, file)
      await uiClient.sendMessage(activeServerId, activeChannelId, "", [uploaded.attachment.id])
      toast.success(t("notices.fileUploaded"))
    } catch (e) {
      toast.error(errorText(e, "notices.uploadFailed"))
    }
  }

  const stopScreenShare = async () => {
    await webRtcSessionRef.current?.stopScreenShare()
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
    screenInitSegmentRef.current = null
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
  }

  const resyncScreenForLateViewers = useCallback(() => {
    if (!isScreenSharingRef.current) return
    const now = Date.now()
    if (now - screenRecorderResyncAtRef.current < 3000) return
    screenRecorderResyncAtRef.current = now

    const cachedInit = screenInitSegmentRef.current
    if (cachedInit) {
      sendScreenVideoChunkBytes(new Uint8Array(cachedInit))
      return
    }

    const stream = screenCaptureStreamRef.current
    const oldRec = screenMediaRecorderRef.current
    if (!stream || !oldRec || oldRec.state !== "recording") return
    if (screenRecorderRestartingRef.current) return
    screenRecorderRestartingRef.current = true

    const mimeType =
      oldRec.mimeType && MediaRecorder.isTypeSupported(oldRec.mimeType) ? oldRec.mimeType : "video/webm"
    const bps = Math.max(600_000, Math.min(10_000_000, screenBitrateKbps * 1000))

    const onData = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return
      void event.data.arrayBuffer().then((buffer) => {
        sendScreenVideoChunkBytes(new Uint8Array(buffer))
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
      resyncScreenForLateViewers()
    })
  }, [hasDesktopBridge, isScreenSharing, isVoiceSplit, uiClient, voiceClient, resyncScreenForLateViewers])

  useEffect(() => {
    if (!hasDesktopBridge || !currentVoiceChannel || isScreenSharing || !activeScreenSharerName || !isInVoice || streamHiddenByUser) return
    setStreamLoading(true)
    const room = currentVoiceChannel
    const timer = window.setTimeout(() => requestViewerStreamResync(room, true), 350)
    return () => clearTimeout(timer)
  }, [hasDesktopBridge, currentVoiceChannel, isScreenSharing, activeScreenSharerName, isInVoice, streamHiddenByUser])

  useEffect(() => {
    if (streamHiddenByUser || !activeScreenSharerName || !isInVoice || isScreenSharing) {
      setStreamLoading(false)
      return
    }
    const hasLegacy = legacyStreamBuffered
    const hasWebRtc = hasRemoteWebRtcVideo && !legacyStreamBuffered
    if (hasLegacy || hasWebRtc) {
      setStreamLoading(false)
      return
    }
    setStreamLoading(true)
    const room = currentVoiceChannelRef.current
    const retryTimer = window.setTimeout(() => {
      if (!isLegacyStreamBuffered() && !hasRemoteWebRtcVideo) {
        requestViewerStreamResync(room, true)
      }
    }, 5000)
    const fallbackTimer = window.setTimeout(() => {
      if (!isLegacyStreamBuffered() && hasRemoteWebRtcVideo) {
        resetLegacyStreamPlayback()
        webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
        setStreamLoading(false)
      } else if (!isLegacyStreamBuffered() && !hasRemoteWebRtcVideo) {
        if (screenVideoUrl) resetLegacyStreamPlayback()
        setStreamLoading(false)
      }
    }, 12000)
    return () => {
      clearTimeout(retryTimer)
      clearTimeout(fallbackTimer)
    }
  }, [activeScreenSharerName, isInVoice, isScreenSharing, screenVideoUrl, hasRemoteWebRtcVideo, legacyStreamBuffered, streamHiddenByUser])

  const handleHideStream = () => {
    streamHiddenByUserRef.current = true
    setStreamHiddenByUser(true)
    resetRemoteStreamPlayback()
    setStreamLoading(false)
    isWatchingScreenRef.current = false
    const room = currentVoiceChannelRef.current
    if (room) getVoiceWsClientRef.current().setWatchingScreen(false, room)
    if (streamWindowRef.current && !streamWindowRef.current.closed) {
      toggleStreamWindow()
    }
  }

  const handleShowStream = () => {
    streamHiddenByUserRef.current = false
    setStreamHiddenByUser(false)
    const room = currentVoiceChannelRef.current
    const serverId = activeServerId
    if (room && serverId && activeScreenSharerName) {
      void ensureLiveKitForVoiceRoom(serverId, room).then(() => {
        requestViewerStreamResync(room, true)
        window.requestAnimationFrame(() => rebindViewerStreamElements())
      })
    }
  }

  const applyStreamVolumeLive = useCallback((pct: number) => {
    const next = Math.max(0, Math.min(200, Math.round(pct)))
    streamVolumePctRef.current = next
    const vol = Math.max(0, Math.min(1, next / 100))
    const v = remoteStreamVideoRef.current
    if (v && screenVideoUrlRef.current) {
      try {
        v.volume = vol
      } catch {
        /* ignore invalid media element state */
      }
    }
    try {
      webRtcSessionRef.current?.setScreenAudioVolume(next)
    } catch {
      /* ignore detached stream audio elements */
    }
  }, [])

  const handleStreamVolumeCommit = useCallback(
    (pct: number) => {
      applyStreamVolumeLive(pct)
      const next = streamVolumePctRef.current
      setStreamVolumePct(next)
      localStorage.setItem("voixex-stream-volume-pct", String(next))
    },
    [applyStreamVolumeLive]
  )

  useEffect(() => {
    applyStreamVolumeLive(streamVolumePctRef.current)
  }, [screenVideoUrl, hasRemoteWebRtcVideo, legacyStreamBuffered, applyStreamVolumeLive])

  useEffect(() => {
    const saved = localStorage.getItem("voixex-stream-volume-pct")
    if (saved) {
      const n = Number.parseInt(saved, 10)
      if (Number.isFinite(n)) {
        const next = Math.max(0, Math.min(200, n))
        streamVolumePctRef.current = next
        setStreamVolumePct(next)
      }
    }
  }, [])

  useEffect(() => {
    if (!activeServerId) {
      setServerAppearance({})
      return
    }
    const appearance = loadServerAppearance(activeServerId)
    setServerAppearance(appearance)
    setServerBannerDraft(appearance.serverBannerUrl ?? "")
  }, [activeServerId])

  const syncStreamPopupAudio = () => {
    const popup = streamWindowRef.current
    if (!popup || popup.closed) {
      webRtcSessionRef.current?.relocateScreenAudio(null)
      return
    }
    const audioHost = popup.document.getElementById("voixex-stream-audio-host")
    webRtcSessionRef.current?.relocateScreenAudio(audioHost)
  }

  const renderStreamWindow = () => {
    if (!streamWindowRef.current || streamWindowRef.current.closed) return
    const title = activeScreenSharerName ? `Voixex Stream - ${activeScreenSharerName}` : "Voixex Stream"
    streamWindowRef.current.document.title = title
    const viewers = (voiceUsers[currentVoiceChannel] ?? []).map((u) => u.name).join(", ") || t("common.none")
    const imagePreviewUrl = screenImageUrl ?? localScreenPreviewUrl
    const localCapture = isScreenSharing ? screenCaptureStreamRef.current : null
    const doc = streamWindowRef.current.document
    if (!doc.getElementById("voixex-stream-root")) {
      doc.body.innerHTML = `
        <div id="voixex-stream-root" style="font-family:sans-serif;background:#111;color:#eee;margin:0;padding:12px">
          <div id="voixex-streaming" style="margin-bottom:8px"></div>
          <div id="voixex-viewers" style="margin-bottom:8px"></div>
          <div id="voixex-stream-audio-host" style="display:none"></div>
          <video id="voixex-stream-video" autoplay playsinline controls style="display:none;max-width:100%;max-height:85vh;background:#000;border:1px solid #444;border-radius:6px"></video>
          <div id="voixex-stream-placeholder" style="color:#999">${t("voice.popupNoFrame")}</div>
        </div>
      `
    }
    const streamingEl = doc.getElementById("voixex-streaming")
    const viewersEl = doc.getElementById("voixex-viewers")
    const imageEl = doc.getElementById("voixex-stream-video") as HTMLVideoElement | null
    const placeholderEl = doc.getElementById("voixex-stream-placeholder")
    if (streamingEl) streamingEl.textContent = t("voice.popupStreaming", { name: activeScreenSharerName || t("common.none") })
    if (viewersEl) viewersEl.textContent = t("voice.popupViewers", { names: viewers })
    if (imageEl && placeholderEl) {
      if (localCapture) {
        stopPopupMirrorTracks()
        webRtcSessionRef.current?.unbindPopupScreenVideo()
        imageEl.muted = true
        if (imageEl.src) imageEl.removeAttribute("src")
        if (imageEl.srcObject !== localCapture) {
          imageEl.srcObject = localCapture
          void imageEl.play().catch(() => {})
        }
        imageEl.style.display = "block"
        placeholderEl.style.display = "none"
      } else if (hasRemoteWebRtcVideo && webRtcSessionRef.current) {
        stopPopupMirrorTracks()
        imageEl.muted = true
        webRtcSessionRef.current.bindPopupScreenVideo(imageEl)
        void imageEl.play().catch(() => {})
        imageEl.style.display = "block"
        placeholderEl.style.display = "none"
        syncStreamPopupAudio()
      } else if (legacyStreamBuffered && screenVideoUrl && remoteStreamVideoRef.current) {
        imageEl.muted = deafenedRef.current
        const srcVideo = remoteStreamVideoRef.current
        const mirrored = mirrorLegacyVideoToPopup(srcVideo, imageEl, screenVideoUrl)
        if (mirrored) {
          imageEl.style.display = "block"
          placeholderEl.style.display = "none"
        } else {
          imageEl.style.display = "none"
          placeholderEl.style.display = "block"
          const onReady = () => renderStreamWindowRef.current()
          srcVideo.addEventListener("loadeddata", onReady, { once: true })
          srcVideo.addEventListener("playing", onReady, { once: true })
          srcVideo.addEventListener("resize", onReady, { once: true })
          schedulePopupMirrorRetry()
        }
      } else if (imagePreviewUrl) {
        stopPopupMirrorTracks()
        webRtcSessionRef.current?.unbindPopupScreenVideo()
        imageEl.muted = deafenedRef.current
        if (imageEl.srcObject) imageEl.srcObject = null
        if (imageEl.src !== imagePreviewUrl) {
          imageEl.src = imagePreviewUrl
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
        syncStreamPopupAudio()
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
      webRtcSessionRef.current?.relocateScreenAudio(null)
      streamWindowRef.current.close()
      streamWindowRef.current = null
      setShowingStreamWindow(false)
      return
    }
    const popup = window.open("about:blank", "voixex-stream-window", "width=1280,height=760")
    if (!popup) {
      setError(t("notices.popupBlocked"))
      return
    }
    streamWindowRef.current = popup
    setShowingStreamWindow(true)
    renderStreamWindow()
    window.setTimeout(() => renderStreamWindowRef.current(), 400)
    window.setTimeout(() => renderStreamWindowRef.current(), 1500)
  }

  const toggleStreamVideoFullscreen = async () => {
    const el = remoteStreamVideoRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen()
        setStreamVideoFullscreen(false)
      } else {
        await el.requestFullscreen()
        setStreamVideoFullscreen(true)
      }
    } catch {
      setError(t("notices.fullscreenUnavailable"))
    }
  }

  useEffect(() => {
    const onFullscreenChange = () => {
      setStreamVideoFullscreen(document.fullscreenElement === remoteStreamVideoRef.current)
    }
    document.addEventListener("fullscreenchange", onFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange)
  }, [])

  const startScreenShare = async () => {
    if (!hasDesktopBridge || !window.electronVoice) {
      throw new Error(t("notices.screenShareDesktopOnly"))
    }
    if (!isInVoice || !currentVoiceChannel) {
      throw new Error(t("notices.joinVoiceFirst"))
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(t("notices.screenCaptureUnavailable"))
    }
    if (isScreenSharing) return
    const meId = getVoiceWsClientRef.current().getMeState()?.clientId
    if (activeScreenSharerId && (!meId || activeScreenSharerId !== meId)) {
      throw new Error(t("notices.anotherStreaming"))
    }

    const fps = Math.max(8, Math.min(60, screenFps))
    const [targetWidthRaw, targetHeightRaw] = screenResolution.split("x").map((v) => Number(v))
    const targetWidth = Number.isFinite(targetWidthRaw) ? targetWidthRaw : 1280
    const targetHeight = Number.isFinite(targetHeightRaw) ? targetHeightRaw : 720
    const bitrateKbps = Math.max(600, Math.min(10000, screenBitrateKbps))
    await window.electronVoice.setScreenSource(selectedScreenSourceId)

    const wantAudio = screenShareWithAudioRef.current
    const videoConstraints = {
      frameRate: fps,
      width: { ideal: targetWidth, max: targetWidth },
      height: { ideal: targetHeight, max: targetHeight }
    }
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: wantAudio
    })
    if (!wantAudio) {
      for (const track of stream.getAudioTracks()) {
        track.stop()
        stream.removeTrack(track)
      }
    }

    screenCaptureStreamRef.current = stream
    if (localPreviewVideoRef.current) {
      localPreviewVideoRef.current.srcObject = stream
      void localPreviewVideoRef.current.play().catch(() => {})
    }

    const videoTrack = stream.getVideoTracks()[0]
    if (videoTrack) videoTrack.contentHint = "detail"

    const mimeCandidates = wantAudio
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm"
        ]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm"
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrateKbps * 1000
    })
    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return
      void event.data.arrayBuffer().then((buffer) => {
        sendScreenVideoChunkBytes(new Uint8Array(buffer))
      })
    }

    screenInitSegmentRef.current = null

    setIsScreenSharing(true)
    getVoiceWsClientRef.current().setScreenShare(true)
    recorder.start(250)
    screenMediaRecorderRef.current = recorder
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        void stopScreenShare()
      }
    })

    try {
      await webRtcSessionRef.current?.publishScreenStream(stream, { fps, bitrateKbps })
    } catch {
      /* LiveKit mirror is optional when SFU is unavailable */
    }

    setStatus("Screen share started")
  }

  const handleScreenShareToggle = async () => {
    try {
      setError("")
      if (isScreenSharing) {
        await stopScreenShare()
        setStatus("Screen share stopped")
      } else {
        if (!canStartScreenShare) {
          toast.error(t("notices.anotherStreaming"))
          return
        }
        await startScreenShare()
      }
    } catch (e) {
      setError(errorText(e, "notices.toggleScreenShareFailed"))
    }
  }

  const handleChannelSelect = async (channelId: string) => {
    setActiveChannelId(channelId)
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === channelId)
    if (channel?.type === "voice") {
      if (isScreenSharing) {
        await stopScreenShare()
      }
      if (!activeServerId) {
        toast.error(t("notices.connectBeforeVoice"))
        return
      }
      if (isInVoice && voiceServerId && activeServerId && voiceServerId !== activeServerId) {
        const vopts = uiClient.getElectronVoiceConnectParams()
        if (!window.electronVoice || !vopts) {
          toast.error(t("notices.cannotJoinVoiceHere"))
          return
        }
        voiceClient.leaveRoom()
        voiceClient.disconnect()
        await window.electronVoice.leaveRoom()
        await stopWebRtcSession()
        const splitUdp = effectiveVoiceUdpPort(vopts.port, udpPortOverride)
        await window.electronVoice.connect({
          host: vopts.host,
          port: splitUdp,
          mediaToken: vopts.mediaToken,
          transport: voiceTransport
        })
        applyVoiceEnginePresenceFlags()
        setVoiceServerId(activeServerId)
        voiceServerIdRef.current = activeServerId
        setCurrentVoiceChannel(channelId)
        setIsInVoice(true)
        isInVoiceRef.current = true
        getVoiceWsClient().joinRoom(channelId)
        await window.electronVoice.joinRoom(channelId)
        await ensureLiveKitForVoiceRoom(activeServerId, channelId)
        lastViewerScreenResyncReqRef.current = null
        void catchUpViewerStreamAfterJoin(activeServerId, channelId)
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
      applyVoiceEnginePresenceFlags()
      lastViewerScreenResyncReqRef.current = null
      void catchUpViewerStreamAfterJoin(activeServerId, channelId)
      setStatus(`In room: ${channel.name}`)
    } else if (channel?.type === "text" && activeServerId) {
      setStatus(`Text channel: ${channel.name}`)
      await uiClient.getMessages(activeServerId, channelId)
    }
  }

  const handleDisconnect = () => {
    void stopScreenShare()
    void stopWebRtcSession()
    getVoiceWsClientRef.current().leaveRoom()
    setIsInVoice(false)
    isInVoiceRef.current = false
    setCurrentVoiceChannel("")
    setVoiceServerId("")
    voiceServerIdRef.current = ""
    lastViewerScreenResyncReqRef.current = null
    pendingLegacyStreamResyncRef.current = false
    isWatchingScreenRef.current = false
    streamHiddenByUserRef.current = false
    setStreamHiddenByUser(false)
    prevActiveScreenSharerIdRef.current = null
    setActiveScreenSharerId(null)
    prevVoiceChannelForStreamRef.current = ""
    setStreamLoading(false)
    resetRemoteStreamPlayback()
    stopVoicePipeline()
    void window.electronVoice?.leaveRoom()
    setStatus("Connected to server")
  }

  const fullyDisconnectFromApi = async () => {
    await stopScreenShare()
    await stopWebRtcSession()
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
      !window.confirm(t("notices.confirmRemoveServer", { name: entry.serverName }))
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
      // Don't leave the removed profile's credentials in the connect form.
      setApiHost(CONNECTION_DEFAULTS.host)
      setApiPort(CONNECTION_DEFAULTS.port)
      setServerPassword(CONNECTION_DEFAULTS.password)
      setSuperuserPasswordInput("")
      setConnectServerListName("")
      setError("")
      setShowConnectPanel(true)
      toast.success(t("notices.serverRemoved"))
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
    toast.success(t("notices.serverRemoved"))
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

  const persistConnectionSettings = (patch: Partial<SavedServerProfile>) => {
    const globalPatch: ConnectionPrefs = {}
    if (patch.mediaEngine) globalPatch.mediaEngine = patch.mediaEngine
    if (patch.voiceTransport) globalPatch.voiceTransport = patch.voiceTransport
    if (typeof patch.apiUseHttps === "boolean") globalPatch.apiUseHttps = patch.apiUseHttps
    if (patch.udpPortOverride !== undefined) globalPatch.udpPortOverride = patch.udpPortOverride
    if (Object.keys(globalPatch).length > 0) {
      saveGlobalConnectionPrefs({ ...loadGlobalConnectionPrefs(), ...globalPatch })
    }
    const host = apiHost.trim()
    const port = apiPort.trim()
    const match = savedServers.find((s) => s.apiHost === host && s.apiPort === port)
    const serverId = patch.serverId ?? match?.serverId ?? activeServerIdRef.current
    if (!serverId) return
    setSavedServers((prev) => {
      const idx = prev.findIndex((s) => s.serverId === serverId)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      localStorage.setItem("voixex-saved-servers", JSON.stringify(next))
      return next
    })
  }

  const handleMediaEngineChange = (value: "legacy" | "webrtc") => {
    mediaEngineRef.current = value
    setMediaEngine(value)
    persistConnectionSettings({ mediaEngine: value })
  }

  const handleVoiceTransportChange = (value: "udp" | "tcp") => {
    setVoiceTransport(value)
    persistConnectionSettings({ voiceTransport: value })
  }

  const handleApiUseHttpsChange = (value: boolean) => {
    setApiUseHttps(value)
    persistConnectionSettings({ apiUseHttps: value })
  }

  const handleUdpPortOverrideChange = (value: string) => {
    setUdpPortOverride(value)
    persistConnectionSettings({ udpPortOverride: value })
  }

  const connectAndJoin = async (preset?: SavedServerProfile) => {
    try {
      setJoining(true)
      uiClient.disconnect()
      voiceClient.disconnect()
      if (window.electronVoice?.disconnect) {
        await window.electronVoice.disconnect()
      }
      const host = (preset?.apiHost ?? apiHost).trim()
      const port = (preset?.apiPort ?? apiPort).trim()
      const password = preset?.serverPassword ?? serverPassword
      const superPassword = preset?.superuserPassword ?? superuserPasswordInput
      const normalizedDisplayName = (preset?.displayName ?? displayNameInput).trim() || "User"
      const globalPrefs = loadGlobalConnectionPrefs()
      const matchByHost = savedServers.find((s) => s.apiHost === host && s.apiPort === port)
      const resolvedUseHttps =
        typeof preset?.apiUseHttps === "boolean"
          ? preset.apiUseHttps
          : typeof matchByHost?.apiUseHttps === "boolean"
            ? matchByHost.apiUseHttps
            : typeof globalPrefs.apiUseHttps === "boolean"
              ? globalPrefs.apiUseHttps
              : apiUseHttps
      const resolvedUdpOverride =
        preset?.udpPortOverride !== undefined
          ? preset.udpPortOverride
          : matchByHost?.udpPortOverride !== undefined
            ? matchByHost.udpPortOverride
            : globalPrefs.udpPortOverride !== undefined
              ? globalPrefs.udpPortOverride
              : udpPortOverride
      const resolvedVoiceTransport = normalizeVoiceTransport(
        preset?.voiceTransport ?? matchByHost?.voiceTransport ?? globalPrefs.voiceTransport ?? voiceTransport
      )
      const resolvedMediaEngine = normalizeMediaEngine(
        preset?.mediaEngine ?? matchByHost?.mediaEngine ?? globalPrefs.mediaEngine ?? mediaEngine
      )
      let effectiveVoiceTransport: "udp" | "tcp" = resolvedVoiceTransport
      let effectiveMediaEngine: "legacy" | "webrtc" = resolvedMediaEngine
      mediaEngineRef.current = resolvedMediaEngine
      setMediaEngine(resolvedMediaEngine)
      setVoiceTransport(resolvedVoiceTransport)
      setApiUseHttps(resolvedUseHttps)
      setUdpPortOverride(resolvedUdpOverride)
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
            toast.error(t("notices.duplicateServerName"))
            setJoining(false)
            return
          }
        }
      }
      setDisplayNameInput(normalizedDisplayName)
      localStorage.setItem("voip-last-display-name", normalizedDisplayName)
      uiClient.setApiBase(buildApiBaseUrl(host, port, resolvedUseHttps))
      setError("")
      setStatus(`Connecting API: ${host}:${port}`)
      const health = await uiClient.healthcheck()
      if (!health.ok) throw new Error(t("notices.serverNotHealthy"))
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
        toast.error(t("notices.duplicateServerNamePick"))
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
          throw new Error(t("notices.desktopBridgeMissing"))
        }
        setStatus("Connecting voice transport...")
        const vopts = uiClient.getElectronVoiceConnectParams()
        if (vopts) {
          const udpPort = effectiveVoiceUdpPort(vopts.port, resolvedUdpOverride)
          try {
            await window.electronVoice.connect({
              host: vopts.host,
              port: udpPort,
              mediaToken: vopts.mediaToken,
              transport: effectiveVoiceTransport
            })
            applyVoiceEnginePresenceFlags()
          } catch (voiceErr) {
            const firstMsg = voiceErr instanceof Error ? voiceErr.message : String(voiceErr)
            const firstHint = voiceTransportFailureHint(firstMsg, effectiveVoiceTransport)
            const fallbackTransport: "udp" | "tcp" = effectiveVoiceTransport === "udp" ? "tcp" : "udp"
            let fallbackOk = false
            if (/hello|timeout|tcp|udp|connect|ECONNREFUSED|socket closed/i.test(firstMsg)) {
              try {
                await window.electronVoice.connect({
                  host: vopts.host,
                  port: udpPort,
                  mediaToken: vopts.mediaToken,
                  transport: fallbackTransport
                })
                applyVoiceEnginePresenceFlags()
                fallbackOk = true
                effectiveVoiceTransport = fallbackTransport
                setVoiceTransport(fallbackTransport)
                persistConnectionSettings({ voiceTransport: fallbackTransport })
                if (resolvedVoiceTransport === "tcp") {
                  toast.warning(t("notices.tcpFailedUsingUdp", { hint: firstHint }))
                } else {
                  toast.success(
                    t("notices.voiceSwitchedFallback", {
                      to: fallbackTransport.toUpperCase(),
                      from: resolvedVoiceTransport.toUpperCase()
                    })
                  )
                }
              } catch (fallbackErr) {
                const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
                toast.error(
                  t("notices.voiceFailedBoth", {
                    from: resolvedVoiceTransport.toUpperCase(),
                    to: fallbackTransport.toUpperCase(),
                    error: fallbackMsg
                  })
                )
              }
            }
            if (!fallbackOk) {
              if (window.electronVoice?.disconnect) await window.electronVoice.disconnect()
              if (!/hello|timeout|tcp|udp|connect|ECONNREFUSED|socket closed/i.test(firstMsg)) {
                toast.error(t("notices.voiceError", { hint: firstHint }))
              } else if (resolvedVoiceTransport === "tcp") {
                toast.error(t("notices.tcpVoiceFailed", { hint: firstHint }))
              }
            }
          }
        }
      }
      uiClient.connectWs()
      const rooms = await uiClient.getRooms(joinedServerId)
      await uiClient.getMe(joinedServerId)
      void uiClient.getServer(joinedServerId).catch(() => {})
      setActiveServerId(joinedServerId)
      const updatedProfile: SavedServerProfile = {
        serverId: joinedServerId,
        serverName: effectiveListName,
        apiHost: host,
        apiPort: port,
        apiUseHttps: resolvedUseHttps,
        serverPassword: password,
        displayName: join.profile.displayName,
        mediaEngine: effectiveMediaEngine,
        voiceTransport: effectiveVoiceTransport,
        ...(resolvedUdpOverride.trim() ? { udpPortOverride: resolvedUdpOverride.trim() } : {}),
        ...(superPassword ? { superuserPassword: superPassword } : {})
      }
      saveGlobalConnectionPrefs({
        mediaEngine: effectiveMediaEngine,
        voiceTransport: effectiveVoiceTransport,
        apiUseHttps: resolvedUseHttps,
        udpPortOverride: resolvedUdpOverride.trim() || undefined
      })
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
      setError(errorText(e, "notices.joinServerFailed"))
    } finally {
      setJoining(false)
    }
  }

  const openAppSettings = async (initialTab: AppSettingsTab = "voice") => {
    if (!window.electronVoice) {
      setAppSettingsTab(initialTab === "language" ? "language" : initialTab)
      setShowAppSettings(true)
      return
    }
    setDeviceError("")
    let list = (await window.electronVoice.listAudioDevices()) as AudioDevice[]
    if (navigator.mediaDevices?.enumerateDevices) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true })
        probe.getTracks().forEach((t) => t.stop())
      } catch {
        setDeviceError(t("notices.noAudioPermission"))
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
    await webRtcSessionRef.current?.setOutputDevice(selectedDevices.outputId)
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
    toast.success(t("notices.profileUpdated"))
    setStatus("Profile updated")
  }

  const createChannelFromSettings = async () => {
    if (!activeServerId || !canManageServer || creatingChannel) return
    const name = roomNameInput.trim()
    if (!name) {
      setError(t("notices.channelNameRequired"))
      return
    }
    try {
      setCreatingChannel(true)
      setError("")
      await uiClient.createRoom(activeServerId, name, roomKindInput)
      await uiClient.getRooms(activeServerId)
      toast.success(t("notices.channelCreated", { name }))
      setStatus(`Channel created: ${name}`)
      setRoomNameInput("")
    } catch (e) {
      toast.error(errorText(e, "notices.createChannelFailed"))
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
      const ok = window.confirm(t("notices.confirmSwitchServer"))
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
        applyConnectionPrefsToState(
          {
            apiUseHttps: saved.apiUseHttps,
            udpPortOverride: saved.udpPortOverride ?? "",
            voiceTransport: saved.voiceTransport,
            mediaEngine: saved.mediaEngine
          },
          { setMediaEngine, setVoiceTransport, setApiUseHttps, setUdpPortOverride, mediaEngineRef }
        )
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
        toast.error(errorText(err, "notices.serverSwitchFailed"))
      })

    void serverSwitchChainRef.current
  }

  return (
    <>
      <main className="flex h-dvh overflow-hidden bg-background">
        <div ref={webRtcAudioSinkRef} className="hidden" aria-hidden="true" />

        <ServerSidebar
          servers={servers}
          activeServerId={activeServerId}
          onServerSelect={handleServerSelect}
          onRemoveServer={handleRemoveSavedServer}
          onAddServer={() => {
            setConnectServerListName("")
            setShowConnectPanel(true)
          }}
          onOpenSettings={() => {
            const initialTab = activeServerId && canManageServer ? "server_general" : "voice"
            void openAppSettings(initialTab)
          }}
        />

        {activeServerId ? (
          <aside className="flex h-full min-h-0 w-60 shrink-0 flex-col bg-card">
            <ChannelSidebar
              serverName={servers.find((s) => s.id === activeServerId)?.name || t("common.noServer")}
              serverBannerUrl={serverAppearance.serverBannerUrl}
              categories={categories}
              activeChannelId={activeChannelId}
              currentVoiceChannelId={currentVoiceChannel}
              isInVoice={isInVoice}
              onChannelSelect={handleChannelSelect}
              onLeaveVoice={handleDisconnect}
              voiceUsers={voiceUsers}
              selfClientId={myVoiceClientId}
              peerVolumePct={peerVolumePct}
              onPeerVolumeChange={handlePeerVolumeChange}
              enablePeerVolume={hasDesktopBridge && isInVoice && wsForVoiceJoin}
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
              onToggleDeafen={() => applyDeafen(!isDeafened)}
              onDisconnect={handleDisconnect}
              voiceStatsSummary={voiceStatsSummary}
              voiceStats={voiceStats}
              audioPipelineDiag={audioPipelineDiag}
              qualityClass={qualityClass}
              isSpeakingNow={isSpeakingNow}
              onOpenSettings={() => {
                void openAppSettings()
              }}
            />
          </aside>
        ) : null}

        {!activeServerId ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-4 bg-background p-8">
            <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-muted">
              <Headphones className="h-10 w-10 text-muted-foreground" />
            </div>
            <div className="max-w-sm text-center">
              <h2 className="text-lg font-semibold text-foreground">{t("welcome.title")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t("welcome.subtitle")}</p>
            </div>
            <Button variant="outline" onClick={() => setShowConnectPanel(true)}>
              <Server className="mr-2 h-4 w-4" /> {t("welcome.connectToServer")}
            </Button>
          </div>
        ) : activeChannel?.type === "voice" ? (
          <VoiceChannelView
            channelName={activeChannel.name}
            channelBannerUrl={activeChannelBannerUrl}
            error={error}
            activeScreenSharerName={activeScreenSharerName}
            watchingNames={(voiceUsers[currentVoiceChannel] ?? []).map((u) => u.name).join(", ") || t("common.none")}
            isScreenSharing={isScreenSharing}
            viewingLegacyStream={viewingLegacyStream}
            viewingWebRtcStream={viewingWebRtcStream}
            streamLoading={streamLoading}
            streamPathLabel={streamPathLabel}
            screenVideoUrl={screenVideoUrl}
            screenImageUrl={screenImageUrl}
            streamVolumePct={streamVolumePct}
            streamVideoFullscreen={streamVideoFullscreen}
            showingStreamWindow={showingStreamWindow}
            showMemberList={showMemberList}
            isInVoice={isInVoice}
            hasDesktopBridge={hasDesktopBridge}
            isDeafened={isDeafened}
            canStartScreenShare={canStartScreenShare}
            screenShareWithAudio={screenShareWithAudio}
            screenSources={screenSources}
            selectedScreenSourceId={selectedScreenSourceId}
            screenResolution={screenResolution}
            screenFps={screenFps}
            screenBitrateKbps={screenBitrateKbps}
            localPreviewVideoRef={localPreviewVideoRef}
            remoteStreamVideoRef={remoteStreamVideoRef}
            onScreenSourceChange={setSelectedScreenSourceId}
            onScreenResolutionChange={setScreenResolution}
            onScreenFpsChange={setScreenFps}
            onScreenBitrateChange={setScreenBitrateKbps}
            onScreenShareWithAudioToggle={() => setScreenShareWithAudio((v) => !v)}
            onScreenShareToggle={() => void handleScreenShareToggle()}
            onToggleStreamWindow={toggleStreamWindow}
            onToggleStreamFullscreen={() => void toggleStreamVideoFullscreen()}
            onToggleMemberList={() => setShowMemberList((v) => !v)}
            onStreamVolumeLiveChange={applyStreamVolumeLive}
            onStreamVolumeCommit={handleStreamVolumeCommit}
            streamHiddenByUser={streamHiddenByUser}
            onHideStream={handleHideStream}
            onShowStream={handleShowStream}
            onJoinVoice={() => void handleChannelSelect(activeChannelId)}
            onLeaveVoice={handleDisconnect}
          />
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

        {showMemberList && activeServerId ? <MemberList members={members} roles={[]} /> : null}
      </main>

      <ConnectServerDialog
        open={showConnectPanel}
        onOpenChange={setShowConnectPanel}
        connectServerListName={connectServerListName}
        onConnectServerListNameChange={setConnectServerListName}
        apiHost={apiHost}
        onApiHostChange={setApiHost}
        apiPort={apiPort}
        onApiPortChange={setApiPort}
        apiUseHttps={apiUseHttps}
        onApiUseHttpsChange={handleApiUseHttpsChange}
        udpPortOverride={udpPortOverride}
        onUdpPortOverrideChange={handleUdpPortOverrideChange}
        mediaEngine={mediaEngine}
        onMediaEngineChange={handleMediaEngineChange}
        voiceTransport={voiceTransport}
        onVoiceTransportChange={handleVoiceTransportChange}
        serverPassword={serverPassword}
        onServerPasswordChange={setServerPassword}
        displayNameInput={displayNameInput}
        onDisplayNameChange={setDisplayNameInput}
        superuserPasswordInput={superuserPasswordInput}
        onSuperuserPasswordChange={setSuperuserPasswordInput}
        profileDisplayName={profileDisplayName}
        onProfileDisplayNameChange={setProfileDisplayName}
        onSaveProfile={saveProfile}
        activeServerId={activeServerId}
        canManageServer={canManageServer}
        onOpenServerSettings={() => void openAppSettings("server_general")}
        onConnect={() => void connectAndJoin()}
        joining={joining}
        connectedToApi={connectedToApi}
        wsConnected={wsConnected}
        wsReconnecting={wsReconnecting}
        hasDesktopBridge={hasDesktopBridge}
        hasSavedServers={savedServers.length > 0}
        error={error}
      />
      <Dialog open={showAppSettings} onOpenChange={setShowAppSettings}>
        <DialogContent className="flex h-[min(85vh,720px)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>{t("settings.title")}</DialogTitle>
            <DialogDescription>{t("settings.description")}</DialogDescription>
          </DialogHeader>
          <Tabs
            value={appSettingsTab}
            onValueChange={(v) => setAppSettingsTab(v as AppSettingsTab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex min-h-0 flex-1">
              <TabsList className="flex h-auto w-44 shrink-0 flex-col items-stretch justify-start gap-1 rounded-none border-r border-border bg-muted/20 p-2">
                <TabsTrigger value="language" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                  {t("settings.tabLanguage")}
                </TabsTrigger>
                <TabsTrigger value="voice" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                  {t("settings.tabVoice")}
                </TabsTrigger>
                <TabsTrigger value="keybinds" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                  {t("settings.tabKeybinds")}
                </TabsTrigger>
                {canOpenServerSettings ? (
                  <>
                    <TabsTrigger value="server_general" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                      {t("settings.tabServer")}
                    </TabsTrigger>
                    <TabsTrigger value="server_channels" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                      {t("settings.tabChannels")}
                    </TabsTrigger>
                    <TabsTrigger value="server_roles" className="w-full justify-start px-3 py-2 text-xs sm:text-sm">
                      {t("settings.tabRoles")}
                    </TabsTrigger>
                  </>
                ) : null}
              </TabsList>
              <ScrollArea className="min-h-0 flex-1">
                <div className="px-6 py-4">
            <TabsContent value="language" className="mt-0 space-y-4">
              <div>
                <Label className="text-base">{t("language.title")}</Label>
              </div>
              <LanguageSelector />
            </TabsContent>
            <TabsContent value="voice" className="mt-0 space-y-5">
              <div className="space-y-2">
                <Label>{t("settings.inputDevice")}</Label>
                <select
                  className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                  value={selectedDevices.inputId ?? ""}
                  onChange={(e) => setSelectedDevices((prev) => ({ ...prev, inputId: e.target.value || null }))}
                >
                  <option value="">{t("common.default")}</option>
                  {audioDevices.input.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t("settings.outputDevice")}</Label>
                <select
                  className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm focus:border-ring focus:outline-none"
                  value={selectedDevices.outputId ?? ""}
                  onChange={(e) => setSelectedDevices((prev) => ({ ...prev, outputId: e.target.value || null }))}
                >
                  <option value="">{t("common.default")}</option>
                  {audioDevices.output.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("settings.inputVolume")}</Label>
                  <span className="text-xs text-muted-foreground">{micVolumePct}%</span>
                </div>
                <Slider value={[micVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setMicVolumePct(v)} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>{t("settings.outputVolume")}</Label>
                  <span className="text-xs text-muted-foreground">{outputVolumePct}%</span>
                </div>
                <Slider value={[outputVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setOutputVolumePct(v)} />
              </div>
              <div className="rounded-lg border border-border p-4 space-y-4 bg-muted/20">
                <div>
                  <Label>{t("settings.micLevels")}</Label>
                  <p className="text-xs text-muted-foreground mt-1">
                    {t("settings.micLevelsHint")}
                  </p>
                </div>
                <MicLevelMeter
                  sample={micMeter}
                  gateEnabled={gateEnabled}
                  gateMuteThreshold={gateMuteThreshold}
                  gateOpenThreshold={gateOpenThreshold}
                  active={isInVoice && hasDesktopBridge}
                />
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div>
                  <Label>{t("settings.captureDsp")}</Label>
                  <p className="text-xs text-muted-foreground">
                    {t("settings.captureDspHint")}
                  </p>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">{t("settings.noiseSuppression")}</Label>
                  <Switch checked={noiseSuppressionEnabled} onCheckedChange={setNoiseSuppressionEnabled} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">{t("settings.echoCancellation")}</Label>
                  <Switch checked={echoCancellationEnabled} onCheckedChange={setEchoCancellationEnabled} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">{t("settings.autoGainControl")}</Label>
                  <Switch checked={autoGainControlEnabled} onCheckedChange={setAutoGainControlEnabled} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.captureTip")}
                </p>
              </div>

              {hasDesktopBridge ? (
                <div className="rounded-lg border border-border p-3 space-y-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <Label>{t("settings.speexNs")}</Label>
                      <p className="text-xs text-muted-foreground">
                        {t("settings.speexNsHint")}
                      </p>
                    </div>
                    <Switch checked={speexNoiseSuppressionEnabled} onCheckedChange={setSpeexNoiseSuppressionEnabled} />
                  </div>
                </div>
              ) : null}

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t("settings.opusUplink")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.opusUplinkHint")}
                    </p>
                  </div>
                  <Switch checked={useOpusUplink} onCheckedChange={setUseOpusUplink} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("settings.opusFallback")}
                </p>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <Label>{t("settings.micMonitor")}</Label>
                    <p className="text-xs text-muted-foreground">{t("settings.micMonitorHint")}</p>
                  </div>
                  <Switch checked={monitorEnabled} onCheckedChange={setMonitorEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.monitorVolume")}</Label>
                    <span className="text-xs text-muted-foreground">{monitorVolumePct}%</span>
                  </div>
                  <Slider value={[monitorVolumePct]} min={0} max={200} step={1} onValueChange={([v]) => setMonitorVolumePct(v)} />
                </div>
              </div>

              <div className="rounded-lg border border-border p-3 space-y-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <Label>{t("settings.noiseGate")}</Label>
                    <p className="text-xs text-muted-foreground">
                      {t("settings.noiseGateHint")}
                    </p>
                  </div>
                  <Switch checked={gateEnabled} onCheckedChange={setGateEnabled} className="mt-1 shrink-0" />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.gateMuteThreshold")}</Label>
                    <span className="text-xs text-muted-foreground">{gateMuteThreshold}</span>
                  </div>
                  <Slider
                    value={[gateMuteThreshold]}
                    min={0}
                    max={4000}
                    step={10}
                    onValueChange={([v]) => {
                      const next = v
                      setGateMuteThreshold(next)
                      if (gateOpenThreshold <= next + 20) {
                        setGateOpenThreshold(Math.min(4000, next + 120))
                      }
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.gateFloor")}</Label>
                    <span className="text-xs text-muted-foreground">{gateFloorPct}%</span>
                  </div>
                  <Slider value={[gateFloorPct]} min={1} max={50} step={1} onValueChange={([v]) => setGateFloorPct(v)} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.gateOpenThreshold")}</Label>
                    <span className="text-xs text-muted-foreground">{gateOpenThreshold}</span>
                  </div>
                  <Slider
                    value={[gateOpenThreshold]}
                    min={Math.min(4000, gateMuteThreshold + 40)}
                    max={4000}
                    step={10}
                    onValueChange={([v]) => setGateOpenThreshold(Math.max(gateMuteThreshold + 40, v))}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.gateRelease")}</Label>
                    <span className="text-xs text-muted-foreground">{gateReleaseMs}ms</span>
                  </div>
                  <Slider value={[gateReleaseMs]} min={80} max={800} step={10} onValueChange={([v]) => setGateReleaseMs(v)} />
                </div>
              </div>
              <div className="rounded-lg border border-border p-3 space-y-3">
                <div>
                  <Label>{t("settings.playbackDsp")}</Label>
                  <p className="text-xs text-muted-foreground">{t("settings.playbackDspHint")}</p>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">{t("settings.playbackGate")}</Label>
                  <Switch checked={playbackGateEnabled} onCheckedChange={setPlaybackGateEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.playbackGateThreshold")}</Label>
                    <span className="text-xs text-muted-foreground">{playbackGateThreshold}</span>
                  </div>
                  <Slider value={[playbackGateThreshold]} min={0} max={2000} step={10} onValueChange={([v]) => setPlaybackGateThreshold(v)} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-sm">{t("settings.highpassFilter")}</Label>
                  <Switch checked={playbackHighpassEnabled} onCheckedChange={setPlaybackHighpassEnabled} />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm">{t("settings.highpassCutoff")}</Label>
                    <span className="text-xs text-muted-foreground">{playbackHighpassHz}Hz</span>
                  </div>
                  <Slider value={[playbackHighpassHz]} min={20} max={240} step={5} onValueChange={([v]) => setPlaybackHighpassHz(v)} />
                </div>
                <div className="flex items-center justify-between">
                  <div>
                    <Label className="text-sm">{t("settings.softLimiter")}</Label>
                    <p className="text-xs text-muted-foreground">{t("settings.softLimiterHint")}</p>
                  </div>
                  <Switch checked={playbackLimiterEnabled} onCheckedChange={setPlaybackLimiterEnabled} />
                </div>
              </div>
              <Button onClick={saveAudioSettings}>{t("settings.applyAudio")}</Button>
              {deviceError && <p className="text-sm text-destructive">{deviceError}</p>}
            </TabsContent>

            <TabsContent value="keybinds" className="mt-0 space-y-5">
              <p className="text-sm text-muted-foreground">{t("settings.keybindsIntro")}</p>
              <div className="space-y-3">
                <div className="grid grid-cols-[140px_1fr] items-center gap-3">
                  <Label>{t("settings.toggleMute")}</Label>
                  <Input value={keybindDraft.toggleMute} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleMute: e.target.value }))} placeholder="Ctrl+Shift+M" />
                  <Label>{t("settings.toggleDeafen")}</Label>
                  <Input value={keybindDraft.toggleDeafen} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, toggleDeafen: e.target.value }))} placeholder="Ctrl+Shift+D" />
                  <Label>{t("settings.pushToTalk")}</Label>
                  <Input value={keybindDraft.pushToTalk} onChange={(e) => setKeybindDraft((prev) => ({ ...prev, pushToTalk: e.target.value }))} placeholder="Ctrl+Shift+V" />
                </div>
              </div>
              <div className="flex gap-2">
                <Button onClick={saveKeybinds}>{t("settings.saveKeybinds")}</Button>
                <Button variant="outline" onClick={clearKeybinds}>{t("settings.clearAll")}</Button>
              </div>
              <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                {t("settings.activeKeybinds", {
                  mute: keybinds.toggleMute ?? t("common.none"),
                  deafen: keybinds.toggleDeafen ?? t("common.none"),
                  ptt: keybinds.pushToTalk ?? t("common.none")
                })}
              </div>
            </TabsContent>

            <TabsContent value="server_general" className="mt-0 space-y-4">
              <div className="rounded-lg border border-border p-4 space-y-2">
                <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">{t("settings.serverLabel")}</span><span className="text-sm font-medium">{servers.find((s) => s.id === activeServerId)?.name ?? t("common.unknown")}</span></div>
                <div className="flex items-center justify-between"><span className="text-sm text-muted-foreground">{t("settings.serverId")}</span><span className="text-xs font-mono text-muted-foreground">{activeServerId}</span></div>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">{t("settings.serverBannerUrl")}</Label>
                <p className="text-xs text-muted-foreground">{t("settings.serverBannerHint")}</p>
                <Input value={serverBannerDraft} onChange={(e) => setServerBannerDraft(e.target.value)} placeholder="https://example.com/banner.jpg" />
                {serverBannerDraft.trim() ? (
                  <div className="overflow-hidden rounded-lg border border-border">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={serverBannerDraft.trim()} alt="" className="h-20 w-full object-cover" />
                  </div>
                ) : null}
                <Button size="sm" onClick={saveServerBanner}>{t("settings.saveServerBanner")}</Button>
              </div>
            </TabsContent>

            <TabsContent value="server_channels" className="mt-0 space-y-4">
              <p className="text-sm text-muted-foreground">{t("settings.channelsAdminHint")}</p>
              <div className="space-y-2 rounded-lg border border-border p-3">
                <Label className="text-sm">{t("settings.channelBanner")}</Label>
                <p className="text-xs text-muted-foreground">{t("settings.channelBannerHint")}</p>
                <select
                  className="w-full rounded-md border border-input bg-input px-3 py-2 text-sm"
                  value={channelBannerChannelId}
                  onChange={(e) => {
                    const id = e.target.value
                    setChannelBannerChannelId(id)
                    setChannelBannerDraft(id ? (serverAppearance.channelBanners?.[id] ?? "") : "")
                  }}
                >
                  <option value="">{t("settings.selectChannel")}</option>
                  {allChannels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.type === "voice" ? `${t("settings.voiceKind")}:` : `${t("settings.textKind")}:`} {ch.name}
                    </option>
                  ))}
                </select>
                <Input
                  value={channelBannerDraft}
                  onChange={(e) => setChannelBannerDraft(e.target.value)}
                  placeholder="https://example.com/channel-banner.jpg"
                  disabled={!channelBannerChannelId}
                />
                <Button size="sm" onClick={saveChannelBanner} disabled={!channelBannerChannelId}>
                  {t("settings.saveChannelBanner")}
                </Button>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input className="min-w-0 flex-1" value={roomNameInput} onChange={(e) => setRoomNameInput(e.target.value)} placeholder={t("settings.channelName")} disabled={creatingChannel} />
                <select
                  className="rounded-md border border-input bg-input px-3 py-2 text-sm sm:w-28"
                  value={roomKindInput}
                  onChange={(e) => setRoomKindInput(e.target.value as "voice" | "text")}
                  disabled={creatingChannel}
                >
                  <option value="voice">{t("settings.voiceKind")}</option>
                  <option value="text">{t("settings.textKind")}</option>
                </select>
                <Button className="shrink-0" onClick={() => void createChannelFromSettings()} disabled={creatingChannel || roomNameInput.trim().length === 0}>
                  {creatingChannel ? <><Spinner className="mr-2" /> {t("common.creating")}</> : t("common.create")}
                </Button>
              </div>
              <div className="max-h-60 overflow-auto rounded-lg border border-border">
                {allChannels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">{t("settings.noChannels")}</div>
                ) : (
                  <div className="divide-y divide-border">
                    {allChannels.map((ch) => (
                      <div key={ch.id} className="flex items-center justify-between px-3 py-2">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-[10px]">{ch.type === "voice" ? t("settings.voiceKind") : t("settings.textKind")}</Badge>
                          <span className="text-sm">{ch.name}</span>
                        </div>
                        <span className="text-xs font-mono text-muted-foreground">{ch.id.slice(0, 8)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="server_roles" className="mt-0">
              <p className="text-sm text-muted-foreground">
                {t("settings.rolesPlaceholder")}
              </p>
            </TabsContent>
                </div>
              </ScrollArea>
            </div>
          </Tabs>
        </DialogContent>
      </Dialog>
    </>
  )
}
