"use client"

// Android app: installs the voice/identity bridges before anything reads them.
import { onNativeScreenShareStopped, setScreenOrientation, startNativeScreenShare, stopNativeScreenShare } from "@/lib/mobile-bridge"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { cn } from "@/lib/utils"
import { useExitSnapshot } from "@/lib/use-exit-snapshot"
import { Buffer } from "buffer"
import { ServerHome, type ServerCardInfo } from "@/components/voip/server-home"
import {
  ServerAccessDialog,
  type AccessMode,
  type ClaimInput,
  type ImportInput,
  type DescribedError,
  type LoginInput,
  type RegisterInput,
  type UpgradeInput
} from "@/components/voip/server-access-dialog"
import { MemberSecurityAdmin, MySecurityPanel, ServerSecurityPolicy } from "@/components/voip/security-panel"
import { RolesAdmin } from "@/components/voip/roles-admin"
import { DeviceCertificates, type DeviceCertificate } from "@/components/voip/device-certificates"
import type { VoixexShellAction, VoixexStoredIdentity } from "@/types/electron-voice"
import { ChannelSidebar, type ChannelCategory } from "@/components/voip/channel-sidebar"
import { UserPanel } from "@/components/voip/user-panel"
import { ChatArea, type Message } from "@/components/voip/chat-area"
import { MemberList, type Member } from "@/components/voip/member-list"
import {
  ApiError,
  VoipClient,
  authLevel,
  modeNeedsCertificate,
  modeNeedsPassword,
  type AuthMode,
  type IssuedProfile,
  type RealtimeState
} from "@/lib/voip-client"
import { getPeerVolume, setPeerVolumeStored } from "@/lib/peer-volume-storage"
import { resampleFloat32Chunk, resampleInt16Chunk } from "@/lib/voice-resample"
import { VoicePlayoutPrefetch, loadVoicePlaybackWorklet } from "@/lib/voice-playout"
import { WebRtcMediaSession } from "@/lib/webrtc-media"
import { connectMonoSourceToTap, createMonoMediaStreamTap, createRnnoiseWorklet, createSpeexNoiseWorklet } from "@/lib/speex-capture"
import type { RnnoiseWorkletNode, SpeexWorkletNode } from "@sapphi-red/web-noise-suppressor"
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
import { ConnectServerDialog, type ConnectionDraft } from "@/components/voip/connect-server-dialog"
import { LanguageSelector } from "@/components/voip/language-selector"
import { VoiceMiniBar, VoiceStage } from "@/components/voip/voice-stage"
import { MiniCallView, MiniCallWindow } from "@/components/voip/mini-call"
import { TitleBar } from "@/components/voip/title-bar"
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

/** The `sub` claim of a JWT (LiveKit tokens carry the participant identity there). */
function jwtSubject(token: string): string {
  try {
    const part = token.split(".")[1] ?? ""
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "="))
    return String((JSON.parse(json) as { sub?: unknown }).sub ?? "")
  } catch {
    return ""
  }
}

/** "host:port" (as stored with a device certificate) → host and port. */
function splitAddress(address: string): { apiHost: string; apiPort: string } {
  const i = address.lastIndexOf(":")
  if (i > 0 && /^\d+$/.test(address.slice(i + 1))) return { apiHost: address.slice(0, i), apiPort: address.slice(i + 1) }
  return { apiHost: address, apiPort: "" }
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
/** New key: the old one stored "off" for everyone, because the switch used to default to off. */
const SCREEN_AUDIO_KEY = "voixex-screen-with-audio-v2"

/** Phone layout: narrow screens, and phones held sideways (short and touch-only). */
const NARROW_QUERY = "(max-width: 767px), (pointer: coarse) and (max-height: 520px)"
/** Tray and minimized-call preferences (desktop and Android). */
const SHELL_PREFS_KEY = "voixex-shell-prefs"

/** Member-list group id for admins (the only role the UI manages). */
const ADMIN_ROLE_GROUP = "admin"

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
  type AppSettingsTab =
    | "language"
    | "voice"
    | "keybinds"
    | "window"
    | "security"
    | "server_general"
    | "server_channels"
    | "server_roles"
    | "server_members"
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
    /**
     * Device certificate for this server (key held by the Electron main process). When set, the
     * profile keeps no passwords or nick: signing in needs certificate + nick + password.
     */
    identityRef?: string
    certId?: string
    /** Member id on this server (per server, so servers cannot correlate members). */
    serverClientId?: string
    /** Protection level chosen on this server; absent = old unprotected (server password only) profile. */
    authMode?: AuthMode
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
    /** The noise-suppression worklet in the capture chain: RNNoise (AI) or Speex. */
    speexWorklet: SpeexWorkletNode | RnnoiseWorkletNode | null
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
  /** Narrow screens (phones): channel list and member list are drawers over the chat. */
  const [isNarrow, setIsNarrow] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  /** Phones: the call screen is open (covers the app), or collapsed to a bar above the chat. */
  const [voiceViewOpen, setVoiceViewOpen] = useState(false)
  const [isMobileApp, setIsMobileApp] = useState(false)
  const isMobileAppRef = useRef(false)
  isMobileAppRef.current = isMobileApp
  useEffect(() => {
    setIsMobileApp(window.voixexWindow?.platform === "android")
    // Phones in landscape are wider than 767 px but still phones: keep the phone layout.
    const mq = window.matchMedia(NARROW_QUERY)
    const apply = () => {
      setIsNarrow(mq.matches)
      if (mq.matches) setShowMemberList(false)
    }
    apply()
    mq.addEventListener("change", apply)
    return () => mq.removeEventListener("change", apply)
  }, [])
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
  const membersRefreshAtRef = useRef(0)
  /** Keys stored on this device (desktop only); null = bridge unavailable or too old to list them. */
  const [deviceIdentities, setDeviceIdentities] = useState<VoixexStoredIdentity[] | null>(null)
  const [showCertStorage, setShowCertStorage] = useState(false)
  const refreshDeviceIdentities = useCallback(async () => {
    const list = window.voixexIdentity?.list
    if (!list) return
    try {
      setDeviceIdentities(await list())
    } catch {
      setDeviceIdentities([])
    }
  }, [])
  const [status, setStatus] = useState("Disconnected")
  const [error, setError] = useState("")
  const [joining, setJoining] = useState(false)
  const [connectedToApi, setConnectedToApi] = useState(false)
  /** Sign-in / registration dialog for a server (null = closed). */
  const [accessMode, setAccessMode] = useState<AccessMode | null>(null)
  /** Saved server whose connection settings are being edited. */
  const [editDraft, setEditDraft] = useState<{ serverId: string; draft: ConnectionDraft } | null>(null)
  const [serverReachability, setServerReachability] = useState<Record<string, "online" | "offline">>({})
  const [sessionRevoked, setSessionRevoked] = useState(false)
  /** The server raised its minimum protection level above this profile's level. */
  const [sessionLevelTooLow, setSessionLevelTooLow] = useState(false)
  /** Level-2 card signing in with one click. */
  const [busyServerId, setBusyServerId] = useState<string | null>(null)
  /** Remembered between a sign-in that needs a higher level and the "raise level" step. */
  const pendingLoginRef = useRef<{ nick: string; password: string; superuserPassword?: string } | null>(null)
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
  /** SpeexDSP preprocess in AudioWorklet; causes hollow "tube" sound — off by default, browser NS is better. */
  const [speexNoiseSuppressionEnabled, setSpeexNoiseSuppressionEnabled] = useState(false)
  /** AI noise suppression (RNNoise neural network, on device), like Krisp. On by default. */
  const [aiNoiseSuppressionEnabled, setAiNoiseSuppressionEnabled] = useState(true)
  const aiNoiseSuppressionEnabledRef = useRef(true)
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
  /** The meter is only shown in Voice settings; elsewhere its updates would just re-render the page. */
  const micMeterVisibleRef = useRef(false)
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
  /**
   * Viewer's stream quality: "original" is the full stream (WebSocket relay or the top LiveKit
   * layer); "medium"/"low" watch a smaller LiveKit simulcast layer and turn the WS relay off.
   */
  const [viewerStreamQuality, setViewerStreamQuality] = useState<"original" | "medium" | "low">("original")
  const viewerStreamQualityRef = useRef(viewerStreamQuality)
  const [localScreenPreviewUrl, setLocalScreenPreviewUrl] = useState<string | null>(null)
  const [screenSources, setScreenSources] = useState<Array<{ id: string; name: string }>>([])
  const [selectedScreenSourceId, setSelectedScreenSourceId] = useState<string | null>(null)
  const [screenResolution, setScreenResolution] = useState("1920x1080")
  const [screenFps, setScreenFps] = useState(30)
  const [screenBitrateKbps, setScreenBitrateKbps] = useState(6000)
  /** motion: videos/games (keep fps); detail: text/code (keep sharpness). */
  const [screenContent, setScreenContent] = useState<"motion" | "detail">("motion")
  // Stream sound on by default, like Discord.
  const [screenShareWithAudio, setScreenShareWithAudio] = useState(true)
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
  const screenRecorderConfigRef = useRef<{ mimeType: string; bitsPerSecond: number } | null>(null)
  const startScreenRecorderRef = useRef<() => void>(() => {})
  const webRtcAudioSinkRef = useRef<HTMLDivElement | null>(null)
  const webRtcSessionRef = useRef<WebRtcMediaSession | null>(null)
  /** serverId:roomId the current WebRtcMediaSession belongs to. */
  const webRtcSessionKeyRef = useRef("")
  /** In-flight start, shared by concurrent callers so they don't kick each other (DUPLICATE_IDENTITY). */
  const webRtcStartRef = useRef<{ key: string; promise: Promise<void> } | null>(null)
  /** Bumped by every start/stop; a start that finds a newer value after an await discards its session. */
  const webRtcStartSeqRef = useRef(0)
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
  /** Serializes sidebar server switches so disconnect + connect never overlap. */
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
      setSessionRevoked(Boolean(u.connection.revoked))
      setSessionLevelTooLow(Boolean(u.connection.levelTooLow))
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
      // Everyone registered on the server; presence decides online/offline. Profiles that came online
      // after the list was loaded (just registered) trigger one reload.
      const registered = u.registeredMembers
      const known = new Set(registered.map((m) => m.clientId))
      if (registered.length > 0 && [...onlineByClientId.keys()].some((id) => !known.has(id))) {
        const now = Date.now()
        if (now - membersRefreshAtRef.current > 5000) {
          membersRefreshAtRef.current = now
          void uiClient.refreshMembers()
        }
      }
      const adminIds = new Set(registered.filter((m) => m.isAdmin).map((m) => m.clientId))
      const merged = new Map<string, { clientId: string; displayName: string; online: boolean }>()
      for (const m of registered) merged.set(m.clientId, { clientId: m.clientId, displayName: m.displayName, online: false })
      for (const m of onlineByClientId.values()) merged.set(m.clientId, { ...m, online: true })
      setMembers(
        Array.from(merged.values())
          .sort((a, b) => {
            const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
            if (byName !== 0) return byName
            return a.clientId.localeCompare(b.clientId)
          })
          .map((m) => ({
            id: m.clientId,
            name: m.displayName,
            avatar: m.displayName.slice(0, 1).toUpperCase(),
            status: m.online ? "online" : "offline",
            roles: adminIds.has(m.clientId) ? [ADMIN_ROLE_GROUP] : []
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
      // Profiles saved by 0.3.0 had a certificate and always used level 3.
      for (const s of valid) {
        if (s.identityRef && !s.authMode) s.authMode = "password_certificate"
      }
      // The app starts on the server list: a server stays closed until you sign in to it.
      setSavedServers(valid)
      setServers(valid.map((s) => ({ id: s.serverId, name: s.serverName, icon: s.serverName.slice(0, 1).toUpperCase() || "S" })))
    } catch {
      // ignore malformed saved server payload
    }
  }, [])

  useEffect(() => {
    setHasDesktopBridge(Boolean(window.electronVoice))
  }, [])

  // Reachability of saved servers for the server list (only /health, nothing behind sign-in).
  useEffect(() => {
    if (activeServerId || savedServers.length === 0) return
    let cancelled = false
    const check = async () => {
      const results = await Promise.all(
        savedServers.map(async (s) => {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 5000)
          try {
            const res = await fetch(`${buildApiBaseUrl(s.apiHost, s.apiPort, Boolean(s.apiUseHttps))}/health`, { signal: ctrl.signal })
            return [s.serverId, res.ok ? "online" : "offline"] as const
          } catch {
            return [s.serverId, "offline"] as const
          } finally {
            clearTimeout(timer)
          }
        })
      )
      if (!cancelled) setServerReachability(Object.fromEntries(results))
    }
    void check()
    const id = setInterval(() => void check(), 30_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeServerId, savedServers])

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
        speexNoiseSuppressionEnabled?: boolean
        aiNoiseSuppressionEnabled?: boolean
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
      if (typeof parsed.speexNoiseSuppressionEnabled === "boolean") setSpeexNoiseSuppressionEnabled(parsed.speexNoiseSuppressionEnabled)
      if (typeof parsed.aiNoiseSuppressionEnabled === "boolean") setAiNoiseSuppressionEnabled(parsed.aiNoiseSuppressionEnabled)
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
        speexNoiseSuppressionEnabled,
        aiNoiseSuppressionEnabled
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
    speexNoiseSuppressionEnabled,
    aiNoiseSuppressionEnabled
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
    aiNoiseSuppressionEnabledRef.current = aiNoiseSuppressionEnabled
  }, [aiNoiseSuppressionEnabled])

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
    webRtcStartSeqRef.current += 1
    webRtcStartRef.current = null
    webRtcSessionKeyRef.current = ""
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
    if (!webRtcSessionRef.current?.connected) return
    // UDP/WebSocket voice: nobody listens to the mic in LiveKit, and every republish renegotiates
    // the whole connection, which stalls a screen share for a moment.
    if (mediaEngineRef.current !== "webrtc") {
      void webRtcSessionRef.current.unpublishMic()
      return
    }
    const mic = getWebRtcMicTrackFromPipeline()
    if (!mic) return
    void webRtcSessionRef.current.publishMicTrack(mic)
    void webRtcSessionRef.current.setMuted(mutedRef.current)
  }

  const resolveRosterDisplayName = (identity: string) => {
    // A phone shares its screen as a second LiveKit participant "<clientId>:screen".
    const clientId = identity.endsWith(":screen") ? identity.slice(0, -":screen".length) : identity
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
      const legacyActive = legacyStreamHasBufferedRef.current && viewerStreamQualityRef.current === "original"
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

  /**
   * fallback: this viewer needs the WebSocket stream. By default only when it has no LiveKit
   * connection; with LiveKit the sharer is not asked to upload the video a second time.
   */
  const requestViewerStreamResync = (roomId: string, force = false, fallback = !webRtcSessionRef.current?.live) => {
    if (!roomId || !hasDesktopBridge || streamHiddenByUserRef.current) return
    const now = Date.now()
    const prev = lastViewerScreenResyncReqRef.current
    if (!force && prev && prev.room === roomId && now - prev.at < 2500) return
    lastViewerScreenResyncReqRef.current = { room: roomId, at: now }
    pendingLegacyStreamResyncRef.current = true
    setStreamLoading(true)
    getVoiceWsClientRef.current().requestScreenResync(roomId, fallback)
  }

  const getStreamRoomSharerId = (roomId: string) => {
    const state = latestVoiceStateRef.current ?? latestUiStateRef.current
    if (!state) return null
    return state.activeScreenShareByRoom[roomId] ?? null
  }

  const rebindViewerStreamElements = () => {
    webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
    webRtcSessionRef.current?.resumeScreenAudio()
    const v = remoteStreamVideoRef.current
    if (legacyStreamHasBufferedRef.current && screenVideoUrlRef.current && v) {
      void v.play().catch(() => {})
    }
    if (streamWindowRef.current && !streamWindowRef.current.closed) {
      renderStreamWindowRef.current()
    }
  }
  const rebindViewerStreamElementsRef = useRef(rebindViewerStreamElements)
  rebindViewerStreamElementsRef.current = rebindViewerStreamElements

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

  const startWebRtcSession = (serverId: string, roomId: string): Promise<void> => {
    const key = `${serverId}:${roomId}`
    // Already connected to this room: keep it. Re-creating the session drops voice/video for everyone.
    if (webRtcSessionRef.current?.live && webRtcSessionKeyRef.current === key) return Promise.resolve()
    const inflight = webRtcStartRef.current
    if (inflight && inflight.key === key) return inflight.promise

    const seq = ++webRtcStartSeqRef.current
    const superseded = () => webRtcStartSeqRef.current !== seq
    const entry = { key, promise: Promise.resolve() }
    entry.promise = (async () => {
      const sink = webRtcAudioSinkRef.current
      if (!sink) throw new Error("WebRTC audio sink is not ready")
      // Replace a stale/other-room session without announcing "left the room" to the server.
      const previous = webRtcSessionRef.current
      webRtcSessionRef.current = null
      webRtcSessionKeyRef.current = ""
      if (previous) await previous.disconnect()
      if (superseded()) return
      const token = await getVoiceWsClientRef.current().getSfuToken(serverId, roomId)
      if (superseded()) return
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
      try {
        await session.connect(token)
        if (superseded()) {
          await session.disconnect()
          return
        }
        const devices = (await window.electronVoice?.getAudioDevices()) as { inputId: string | null; outputId: string | null } | undefined
        await session.setOutputDevice(devices?.outputId ?? null)
        await session.setDeafened(deafenedRef.current)
        const mic = mediaEngineRef.current === "webrtc" ? getWebRtcMicTrackFromPipeline() : null
        if (mic) {
          await session.publishMicTrack(mic)
          await session.setMuted(mutedRef.current)
        }
        if (superseded()) {
          await session.disconnect()
          return
        }
      } catch (err) {
        await session.disconnect()
        throw err
      }
      // Report what is really going on: a sharer must stay "sharing" across a session restart.
      getVoiceWsClientRef.current().syncPresence({
        roomId,
        muted: mutedRef.current,
        deafened: deafenedRef.current,
        screenSharing: isScreenSharingRef.current,
        watchingScreen: isWatchingScreenRef.current,
        mediaEngine: mediaEngineRef.current
      })
      webRtcSessionRef.current = session
      webRtcSessionKeyRef.current = key
    })().finally(() => {
      if (webRtcStartRef.current === entry) webRtcStartRef.current = null
    })
    webRtcStartRef.current = entry
    return entry.promise
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
      // Watching a lower LiveKit layer: chunks still arriving from an older server are ignored.
      if (viewerStreamQualityRef.current !== "original") return
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

  // Outside a voice channel the pipeline also runs while the Voice settings tab is open, so the mic
  // can be tested (level meter, monitor, volume sliders) without sending anything to the server.
  const micTestActive = hasDesktopBridge && showAppSettings && appSettingsTab === "voice" && !isInVoice
  micMeterVisibleRef.current = showAppSettings && appSettingsTab === "voice"
  const voicePipelineMode: "voice" | "test" | null =
    hasDesktopBridge && isInVoice && currentVoiceChannel ? "voice" : micTestActive ? "test" : null

  useEffect(() => {
    if (!voicePipelineMode) {
      stopVoicePipeline()
      return
    }
    const sendsToServer = voicePipelineMode === "voice"

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
        let speexWorklet: SpeexWorkletNode | RnnoiseWorkletNode | null = null
        let aiActive = false
        if (aiNoiseSuppressionEnabledRef.current) {
          try {
            speexWorklet = await createRnnoiseWorklet(captureCtx)
            aiActive = true
          } catch (e) {
            console.warn("[voixex] RNNoise failed:", e)
            setDeviceError(t("notices.aiNoiseFailed"))
          }
        }
        if (!aiActive && speexRequested) {
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
        // Any worklet suppressor (AI or Speex) replaces the browser's own noise suppression.
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
          startMs: 60,
          maxQueuedSec: 0.4
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
        if (sendsToServer) republishWebRtcMicFromPipeline()
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
        // Frames go to the desktop engine as PCM; it encodes Opus itself when the server supports
        // it (the renderer-side encoder never worked: Buffer does not exist in the isolated renderer).
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
          // The neural network already removes the noise between words; a gate on top would only
          // clip quiet speech.
          const gatedPcm = gateEnabledRef.current && !aiActive
            ? applyUplinkNoiseGate(pcm, muteAmp, openAmp, gateFloorRatio)
            : pcm
          // The mute button applies to the call; a mic test should still show and play the mic.
          const muted = sendsToServer && mutedRef.current
          const txPcm = muted ? new Int16Array(gatedPcm.length) : gatedPcm

          const now = Date.now()
          if (micMeterVisibleRef.current && now - lastMeterEmitAt >= 80) {
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
            if (sendsToServer && !mutedRef.current) {
              const frame = merged.subarray(offset, offset + frameSize)
              void window.electronVoice?.sendPcm16Frame(encodePcm16Base64(frame))
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

        runtime.unsubscribeIncoming = !sendsToServer ? null : window.electronVoice?.onPcm16Frame((pcm16Base64) => {
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
        if (sendsToServer) {
          setStatus((prev) => {
            if (prev.includes("Voice I/O active")) return prev
            return prev.includes("In room:") ? `${prev} | Voice I/O active` : "Voice I/O active"
          })
        }
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
    voicePipelineMode,
    currentVoiceChannel,
    audioDevicesRevision,
    noiseSuppressionEnabled,
    echoCancellationEnabled,
    autoGainControlEnabled,
    speexNoiseSuppressionEnabled,
    aiNoiseSuppressionEnabled
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
    // v2 keys: the old ones stored the old defaults (720p, 3.5 Mbit/s) for everyone.
    const savedRes = localStorage.getItem("voixex-screen-resolution-v2")
    const savedFps = Number(localStorage.getItem("voixex-screen-fps") || "30")
    const savedBitrate = Number(localStorage.getItem("voixex-screen-bitrate-kbps-v2") || "6000")
    const savedContent = localStorage.getItem("voixex-screen-content")
    if (savedContent === "motion" || savedContent === "detail") setScreenContent(savedContent)
    const savedWithAudio = localStorage.getItem(SCREEN_AUDIO_KEY)
    if (savedRes && /^\d+x\d+$/.test(savedRes)) setScreenResolution(savedRes)
    if (Number.isFinite(savedFps) && savedFps > 0) setScreenFps(savedFps)
    if (Number.isFinite(savedBitrate) && savedBitrate > 0) setScreenBitrateKbps(savedBitrate)
    if (savedWithAudio === "0") setScreenShareWithAudio(false)
  }, [])

  useEffect(() => {
    localStorage.setItem("voixex-screen-resolution-v2", screenResolution)
  }, [screenResolution])

  useEffect(() => {
    localStorage.setItem("voixex-screen-fps", String(screenFps))
  }, [screenFps])

  useEffect(() => {
    localStorage.setItem("voixex-screen-bitrate-kbps-v2", String(screenBitrateKbps))
  }, [screenBitrateKbps])

  useEffect(() => {
    localStorage.setItem("voixex-screen-content", screenContent)
  }, [screenContent])

  useEffect(() => {
    localStorage.setItem(SCREEN_AUDIO_KEY, screenShareWithAudio ? "1" : "0")
  }, [screenShareWithAudio])

  useEffect(() => {
    screenVideoUrlRef.current = screenVideoUrl
  }, [screenVideoUrl])

  const viewingLegacyStream = Boolean((screenVideoUrl || screenImageUrl) && legacyStreamBuffered && viewerStreamQuality === "original")
  const viewingWebRtcStream = hasRemoteWebRtcVideo && !viewingLegacyStream
  const streamPathLabel = viewingLegacyStream ? "Legacy" : viewingWebRtcStream ? "WebRTC" : ""

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
    if (isMobileAppRef.current && isScreenSharingRef.current) await stopNativeScreenShare()
    try {
      await webRtcSessionRef.current?.stopScreenShare()
    } catch {
      // A dead LiveKit room must not keep the stream "on": the steps below tell the server it stopped.
    }
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
    isScreenSharingRef.current = false
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
  const stopScreenShareRef = useRef(stopScreenShare)
  stopScreenShareRef.current = stopScreenShare

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
    const bps = Math.max(600_000, Math.min(12_000_000, screenBitrateKbps * 1000))

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
    return c.subscribeScreenResyncRequests((roomId, fallback) => {
      if (roomId !== currentVoiceChannelRef.current) return
      const recorder = screenMediaRecorderRef.current
      if (!recorder || recorder.state === "inactive") {
        // Streaming through LiveKit only: start the WS copy just for viewers who need it.
        if (fallback) startScreenRecorderRef.current()
        return
      }
      resyncScreenForLateViewers()
    })
  }, [hasDesktopBridge, isScreenSharing, isVoiceSplit, uiClient, voiceClient, resyncScreenForLateViewers])

  useEffect(() => {
    if (!hasDesktopBridge || !currentVoiceChannel || isScreenSharing || !activeScreenSharerName || !isInVoice || streamHiddenByUser) return
    setStreamLoading(true)
    const room = currentVoiceChannel
    // A stream started: make sure we are in its LiveKit room (the session may have dropped).
    const serverId = voiceServerIdRef.current
    if (serverId) void ensureLiveKitForVoiceRoom(serverId, room)
    // Refreshes the WebM header if the WS stream runs; the 5 s check below asks for it otherwise.
    const timer = window.setTimeout(() => requestViewerStreamResync(room, true, false), 350)
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
      // Nothing arrived through LiveKit either: ask for the WebSocket stream.
      if (!isLegacyStreamBuffered() && !hasRemoteWebRtcVideo) {
        requestViewerStreamResync(room, true, true)
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
        // The LiveKit track stayed subscribed while hidden, so no new TrackSubscribed event will
        // announce it: restore the "has WebRTC video" state from the live session ourselves.
        const sharer = webRtcSessionRef.current?.remoteScreenSharer
        if (sharer) applyRemoteWebRtcVideo(true, sharer)
        requestViewerStreamResync(room, true)
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => rebindViewerStreamElements())
        })
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
      // Same dark palette as the app; the video fills the window and keeps its aspect ratio.
      const platform = window.voixexWindow?.customTitleBar ? window.voixexWindow.platform : null
      const barPadding = platform === "darwin" ? "0 80px" : platform ? "0 150px 0 12px" : "0 12px"
      const style = doc.createElement("style")
      style.textContent = `
        html, body { margin: 0; height: 100%; background: #08080a; color: #e6e6eb; overflow: hidden;
          font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, sans-serif; color-scheme: dark; }
        #voixex-stream-root { display: flex; flex-direction: column; height: 100%; }
        #voixex-stream-bar { height: 32px; flex-shrink: 0; display: flex; align-items: center; gap: 8px;
          padding: ${barPadding}; background: #0f0f14; color: #9494a1; user-select: none;
          -webkit-app-region: ${platform ? "drag" : "no-drag"}; white-space: nowrap; overflow: hidden; }
        #voixex-stream-live { background: #da373c; color: #fff; font-size: 9px; font-weight: 700; letter-spacing: .04em;
          padding: 2px 5px; border-radius: 4px; text-transform: uppercase; }
        #voixex-streaming { color: #e6e6eb; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
        #voixex-viewers { margin-left: auto; overflow: hidden; text-overflow: ellipsis; opacity: .75; }
        #voixex-stream-stage { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
        #voixex-stream-video { width: 100%; height: 100%; object-fit: contain; background: #000; display: none; }
        #voixex-stream-placeholder { color: #6e6e7a; font-size: 13px; }
      `
      doc.head.appendChild(style)
      doc.body.innerHTML = `
        <div id="voixex-stream-root">
          <div id="voixex-stream-bar">
            <span id="voixex-stream-live">Live</span>
            <span id="voixex-streaming"></span>
            <span id="voixex-viewers"></span>
          </div>
          <div id="voixex-stream-stage">
            <div id="voixex-stream-audio-host" style="display:none"></div>
            <video id="voixex-stream-video" autoplay playsinline></video>
            <div id="voixex-stream-placeholder">${t("voice.popupNoFrame")}</div>
          </div>
        </div>
      `
      const video = doc.getElementById("voixex-stream-video") as HTMLVideoElement | null
      // Double-click toggles fullscreen, like most players.
      video?.addEventListener("dblclick", () => {
        if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => {})
        else void video.requestFullscreen().catch(() => {})
      })
    }
    const streamingEl = doc.getElementById("voixex-streaming")
    const viewersEl = doc.getElementById("voixex-viewers")
    const imageEl = doc.getElementById("voixex-stream-video") as HTMLVideoElement | null
    const placeholderEl = doc.getElementById("voixex-stream-placeholder")
    if (streamingEl) streamingEl.textContent = t("voice.popupStreaming", { name: activeScreenSharerName || t("common.none") })
    if (viewersEl) viewersEl.textContent = t("voice.popupViewers", { names: viewers })
    const liveEl = doc.getElementById("voixex-stream-live")
    if (liveEl) liveEl.style.display = activeScreenSharerName || isScreenSharing ? "" : "none"
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
    // Android app: element fullscreen in the WebView shows an empty player. Maximize the stream
    // in the call screen instead and turn the phone sideways.
    if (isMobileApp) {
      const next = !streamVideoFullscreen
      setStreamVideoFullscreen(next)
      setScreenOrientation(next ? "landscape" : "auto")
      return
    }
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

  // Leaving the call, collapsing the call screen or the stream ending ends the maximized view.
  useEffect(() => {
    if (!isMobileApp || !streamVideoFullscreen) return
    if (!isInVoice || !voiceViewOpen || (!activeScreenSharerName && !isScreenSharing)) {
      setStreamVideoFullscreen(false)
      setScreenOrientation("auto")
    }
  }, [isMobileApp, streamVideoFullscreen, isInVoice, voiceViewOpen, activeScreenSharerName, isScreenSharing])

  /** Every new stream <video> (rotation, collapse/expand, layout switch) gets the stream at once. */
  const attachRemoteStreamVideo = useCallback((el: HTMLVideoElement | null) => {
    remoteStreamVideoRef.current = el
    if (el) window.requestAnimationFrame(() => rebindViewerStreamElementsRef.current())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (isMobileApp) return
    const onFullscreenChange = () => {
      setStreamVideoFullscreen(document.fullscreenElement === remoteStreamVideoRef.current)
    }
    document.addEventListener("fullscreenchange", onFullscreenChange)
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange)
  }, [isMobileApp])

  // Android ended the capture (notification, quick settings): stop sharing here too.
  useEffect(() => {
    if (!isMobileApp) return
    return onNativeScreenShareStopped(() => {
      if (isScreenSharingRef.current) void stopScreenShareRef.current()
    })
  }, [isMobileApp])

  /** Phone: capture natively and publish as "<clientId>:screen" in the same LiveKit room. */
  const startMobileScreenShare = async () => {
    if (!isInVoice || !currentVoiceChannel || !voiceServerIdRef.current) throw new Error(t("notices.joinVoiceFirst"))
    if (isScreenSharingRef.current) return
    const token = await getVoiceWsClientRef.current().getSfuToken(voiceServerIdRef.current, currentVoiceChannel, "screen")
    // Servers before 0.6.2 ignore purpose=screen and return our own identity, which would kick
    // this phone's voice/stream session out of the LiveKit room.
    if (!jwtSubject(token.token).endsWith(":screen")) throw new Error(t("notices.serverTooOldForPhoneShare"))
    const [, heightRaw] = screenResolution.split("x").map((v) => Number(v))
    const result = await startNativeScreenShare({
      url: token.url,
      token: token.token,
      maxHeight: Number.isFinite(heightRaw) ? heightRaw : 1080,
      fps: screenFps,
      bitrateKbps: screenBitrateKbps,
      content: screenContent
    })
    if (!result.started) {
      if (result.reason === "denied") return
      throw new Error(result.reason || t("notices.toggleScreenShareFailed"))
    }
    setIsScreenSharing(true)
    isScreenSharingRef.current = true
    getVoiceWsClientRef.current().setScreenShare(true)
  }

  const startScreenShare = async () => {
    if (isMobileApp) return startMobileScreenShare()
    if (!hasDesktopBridge || !window.electronVoice) {
      throw new Error(t("notices.screenShareDesktopOnly"))
    }
    if (!isInVoice || !currentVoiceChannel) {
      throw new Error(t("notices.joinVoiceFirst"))
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(t("notices.screenCaptureUnavailable"))
    }
    // The ref, not state: an automatic restart calls this right after stopScreenShare().
    if (isScreenSharingRef.current) return
    const meId = getVoiceWsClientRef.current().getMeState()?.clientId
    if (activeScreenSharerId && (!meId || activeScreenSharerId !== meId)) {
      throw new Error(t("notices.anotherStreaming"))
    }

    const fps = Math.max(8, Math.min(60, screenFps))
    const [targetWidthRaw, targetHeightRaw] = screenResolution.split("x").map((v) => Number(v))
    const targetWidth = Number.isFinite(targetWidthRaw) ? targetWidthRaw : 1280
    const targetHeight = Number.isFinite(targetHeightRaw) ? targetHeightRaw : 720
    const bitrateKbps = Math.max(600, Math.min(12000, screenBitrateKbps))
    await window.electronVoice.setScreenSource(selectedScreenSourceId)

    const wantAudio = screenShareWithAudioRef.current
    const videoConstraints = {
      frameRate: fps,
      width: { ideal: targetWidth, max: targetWidth },
      height: { ideal: targetHeight, max: targetHeight }
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: wantAudio })
    } catch (e) {
      // System audio capture is not available everywhere: share the picture without it.
      if (!wantAudio) throw e
      stream = await navigator.mediaDevices.getDisplayMedia({ video: videoConstraints, audio: false })
    }
    if (wantAudio && stream.getAudioTracks().length === 0) toast.warning(t("notices.screenAudioUnavailable"))
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
    if (videoTrack) videoTrack.contentHint = screenContent

    const mimeCandidates = wantAudio
      ? [
          "video/webm;codecs=vp9,opus",
          "video/webm;codecs=vp8,opus",
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm"
        ]
      : ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
    screenRecorderConfigRef.current = {
      mimeType: mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm",
      bitsPerSecond: bitrateKbps * 1000
    }
    screenInitSegmentRef.current = null

    setIsScreenSharing(true)
    isScreenSharingRef.current = true
    getVoiceWsClientRef.current().setScreenShare(true)
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => {
        void stopScreenShare()
      }
    })

    let viaLiveKit = false
    try {
      // The LiveKit session may be gone (dropped, or never started for this room): without it the
      // video only went out as the WebSocket copy, which phones could not play.
      if (activeServerId) await ensureLiveKitForVoiceRoom(activeServerId, currentVoiceChannel)
      const published = await webRtcSessionRef.current?.publishScreenStream(stream, { fps, bitrateKbps, content: screenContent })
      viaLiveKit = Boolean(published?.video)
      if (published?.audio === false) {
        // Viewers on LiveKit (phones) would get no sound: say why, and keep the WebSocket copy
        // (which carries the sound) running for everyone else.
        toast.warning(t("notices.screenAudioPublishFailed", { error: published.audioError ?? "?" }))
        viaLiveKit = false
      }
    } catch {
      viaLiveKit = false
    }
    // Viewers watch through LiveKit. The WebSocket copy (a second full upload of the same video)
    // only starts when there is no LiveKit or a viewer asks for it.
    if (!viaLiveKit) startScreenRecorder()

    setStatus("Screen share started")
  }

  /** WebSocket stream (MediaRecorder WebM chunks), the fallback for viewers without LiveKit video. */
  const startScreenRecorder = () => {
    const stream = screenCaptureStreamRef.current
    const config = screenRecorderConfigRef.current
    if (!stream || !config || !isScreenSharingRef.current) return
    const running = screenMediaRecorderRef.current
    if (running && running.state !== "inactive") return
    try {
      const recorder = new MediaRecorder(stream, { mimeType: config.mimeType, videoBitsPerSecond: config.bitsPerSecond })
      recorder.ondataavailable = (event) => {
        if (!event.data || event.data.size === 0) return
        void event.data.arrayBuffer().then((buffer) => {
          sendScreenVideoChunkBytes(new Uint8Array(buffer))
        })
      }
      recorder.start(250)
      screenMediaRecorderRef.current = recorder
    } catch {
      screenMediaRecorderRef.current = null
    }
  }
  startScreenRecorderRef.current = startScreenRecorder

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

  // Changing source/resolution/FPS/bitrate while sharing restarts the share with the new settings.
  const shareSettingsKey = `${selectedScreenSourceId}|${screenResolution}|${screenFps}|${screenBitrateKbps}|${screenContent}`
  const appliedShareSettingsRef = useRef(shareSettingsKey)
  useEffect(() => {
    if (!isScreenSharing) {
      appliedShareSettingsRef.current = shareSettingsKey
      return
    }
    if (appliedShareSettingsRef.current === shareSettingsKey) return
    const timer = setTimeout(() => {
      appliedShareSettingsRef.current = shareSettingsKey
      void (async () => {
        try {
          await stopScreenShare()
          await startScreenShare()
          toast.success(t("voice.streamRestarted"))
        } catch (e) {
          setError(errorText(e, "notices.toggleScreenShareFailed"))
        }
      })()
    }, 500)
    return () => clearTimeout(timer)
    // stop/startScreenShare are recreated every render; the settings key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareSettingsKey, isScreenSharing])

  const handleViewerStreamQualityChange = (quality: "original" | "medium" | "low") => {
    viewerStreamQualityRef.current = quality
    setViewerStreamQuality(quality)
    webRtcSessionRef.current?.setScreenViewQuality(quality === "original" ? "high" : quality)
    getVoiceWsClientRef.current().setScreenRelay(quality === "original")
    if (quality !== "original") {
      resetLegacyStreamPlayback()
      webRtcSessionRef.current?.rebindRemoteScreenVideo(remoteStreamVideoRef.current)
    } else {
      const room = currentVoiceChannelRef.current
      if (room) requestViewerStreamResync(room, true)
      window.requestAnimationFrame(() => rebindViewerStreamElements())
    }
  }

  // Stream over or left voice: back to the original quality and the normal relay.
  useEffect(() => {
    if ((activeScreenSharerId && isInVoice) || viewerStreamQualityRef.current === "original") return
    viewerStreamQualityRef.current = "original"
    setViewerStreamQuality("original")
    webRtcSessionRef.current?.setScreenViewQuality("high")
    if (isInVoice) getVoiceWsClientRef.current().setScreenRelay(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScreenSharerId, isInVoice])

  // A new WebSocket starts with the relay on; repeat the viewer's choice after reconnecting.
  useEffect(() => {
    if (viewerStreamQualityRef.current === "original") return
    if (!(wsConnected || voiceSigWsConnected)) return
    getVoiceWsClientRef.current().setScreenRelay(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, voiceSigWsConnected])

  const handleChannelSelect = async (channelId: string) => {
    const channel = categories.flatMap((c) => c.channels).find((c) => c.id === channelId)
    // Voice channels are joined, not opened: the text channel stays on screen with the voice
    // stage above it. Clicking the voice channel you are already in does nothing.
    if (channel?.type !== "voice") setActiveChannelId(channelId)
    if (channel?.type === "voice" && isInVoice && currentVoiceChannel === channelId) return
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
          apiBase: uiClient.getApiBase(),
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
    const removeText = entry.identityRef
      ? t("notices.confirmRemoveProtected", { name: entry.serverName || entry.apiHost })
      : t("notices.confirmRemoveServer", { name: entry.serverName || entry.apiHost })
    if (!window.confirm(removeText)) return
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
    if (entry.identityRef) void window.voixexIdentity?.remove(entry.identityRef)
    if (next.length === 0) {
      localStorage.removeItem("voixex-last-server-id")
      setActiveServerId("")
      // Don't leave the removed profile's credentials in the connect form.
      setApiHost(CONNECTION_DEFAULTS.host)
      setApiPort(CONNECTION_DEFAULTS.port)
      setServerPassword(CONNECTION_DEFAULTS.password)
      setSuperuserPasswordInput("")
      setConnectServerListName("")
      setError("")
      toast.success(t("notices.serverRemoved"))
      return
    }
    if (activeServerId === serverId) {
      setActiveServerId("")
      activeServerIdRef.current = ""
    }
    toast.success(t("notices.serverRemoved"))
  }

  const activeChannel = categories.flatMap((c) => c.channels).find((c) => c.id === activeChannelId)
  const allChannels = categories.flatMap((c) => c.channels)
  const voiceChannelName = categories.flatMap((c) => c.channels).find((c) => c.id === currentVoiceChannel)?.name || ""

  // Tray (desktop) / call notification (Android), and the call view while the app is minimized:
  // a small always-on-top window on desktop, picture-in-picture on Android.
  const [hasShell, setHasShell] = useState(false)
  const [closeToTray, setCloseToTray] = useState(true)
  const [miniCallEnabled, setMiniCallEnabled] = useState(true)
  const [appMinimized, setAppMinimized] = useState(false)
  const [miniCallDismissed, setMiniCallDismissed] = useState(false)
  const shellActionRef = useRef<(action: VoixexShellAction) => void>(() => {})
  shellActionRef.current = (action) => {
    if (action === "toggle_mute") {
      if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
      applyMute(!mutedRef.current)
    } else if (action === "toggle_deafen") {
      applyDeafen(!deafenedRef.current)
    } else if (action === "leave") {
      if (isInVoiceRef.current) handleDisconnect()
    } else if (action === "show") {
      window.voixexShell?.showMain()
    }
  }
  useEffect(() => {
    const shell = window.voixexShell
    if (!shell) return
    setHasShell(true)
    try {
      const saved = JSON.parse(localStorage.getItem(SHELL_PREFS_KEY) ?? "{}") as { closeToTray?: boolean; miniCall?: boolean }
      if (typeof saved.closeToTray === "boolean") setCloseToTray(saved.closeToTray)
      if (typeof saved.miniCall === "boolean") setMiniCallEnabled(saved.miniCall)
    } catch {
      /* defaults */
    }
    const offAction = shell.onAction((action) => shellActionRef.current(action))
    const offMinimized = shell.onMinimizedChange((minimized) => {
      setAppMinimized(minimized)
      // Hiding the mini window lasts until the app is opened again.
      if (!minimized) setMiniCallDismissed(false)
    })
    void shell.isMinimized().then(setAppMinimized, () => {})
    return () => {
      offAction()
      offMinimized()
    }
  }, [])
  useEffect(() => {
    if (!hasShell) return
    window.voixexShell?.setPreferences({ closeToTray, miniWindow: miniCallEnabled })
    try {
      localStorage.setItem(SHELL_PREFS_KEY, JSON.stringify({ closeToTray, miniCall: miniCallEnabled }))
    } catch {
      /* not persisted */
    }
  }, [hasShell, closeToTray, miniCallEnabled])
  const inVoiceCall = isInVoice && Boolean(currentVoiceChannel)
  useEffect(() => {
    if (!hasShell) return
    window.voixexShell?.setCallState({
      inVoice: inVoiceCall,
      channel: voiceChannelName,
      muted: isMuted,
      deafened: isDeafened,
      labels: {
        open: t("tray.open"),
        mute: t("userPanel.mute"),
        unmute: t("userPanel.unmute"),
        deafen: t("userPanel.deafen"),
        undeafen: t("userPanel.undeafen"),
        leave: t("userPanel.leaveVoiceChannel"),
        quit: t("tray.quit"),
        notInVoice: t("tray.notInVoice")
      }
    })
  }, [hasShell, inVoiceCall, voiceChannelName, isMuted, isDeafened, t])
  const miniCallVisible = hasShell && miniCallEnabled && appMinimized && inVoiceCall
  const miniCallView = (pip: boolean) => (
    <MiniCallView
      channelName={voiceChannelName}
      participants={voiceUsers[currentVoiceChannel] ?? []}
      live={activeScreenSharerName || (isScreenSharing ? "Live" : null)}
      isMuted={isMuted}
      isDeafened={isDeafened}
      onToggleMute={() => shellActionRef.current("toggle_mute")}
      onToggleDeafen={() => shellActionRef.current("toggle_deafen")}
      onLeave={() => shellActionRef.current("leave")}
      onOpen={() => window.voixexShell?.showMain()}
      onClose={pip ? undefined : () => setMiniCallDismissed(true)}
      pip={pip}
    />
  )
  const isTextChannel = activeChannel?.type === "text"
  const canOpenServerSettings = Boolean(activeServerId && canManageServer)
  const serverSettingsScope = appSettingsTab.startsWith("server_")
  // Lost the admin role (taken away, or gave it up) while server settings were open.
  useEffect(() => {
    if (showAppSettings && serverSettingsScope && !canOpenServerSettings) setShowAppSettings(false)
  }, [showAppSettings, serverSettingsScope, canOpenServerSettings])
  // Worst of ping, loss and jitter decides the colour: a 200+ ms ping is not "green" even with no loss.
  const qualityClass = useMemo(() => {
    if (!voiceStats) return "text-muted-foreground"
    const ping = voiceStats.pingNowMs ?? 0
    const loss = voiceStats.packetLossPct ?? 0
    // Current jitter, like the current ping: the worst-1% value spikes and is shown in the stats panel.
    const jitter = voiceStats.jitterNowMs ?? 0
    if (ping < 150 && loss < 1 && jitter < 30) return "text-accent"
    if (ping < 300 && loss < 3 && jitter < 60) return "text-yellow-500"
    return "text-destructive"
  }, [voiceStats])
  const voiceStatsSummary = useMemo(() => {
    if (!isInVoice || !voiceStats) return ""
    return t("stats.summary", { ping: voiceStats.pingNowMs ?? 0, loss: voiceStats.packetLossPct ?? 0 })
  }, [isInVoice, voiceStats, t])

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

  /**
   * Connects to a server. With `auth` (and a profile holding a device certificate) it signs in with
   * certificate + nick + password; otherwise it uses the old password-only join. Errors are thrown
   * to the caller when `auth` or `opts.rethrow` is set (dialogs show them), else shown in `error`.
   */
  const connectAndJoin = async (
    preset?: SavedServerProfile,
    auth?: { nick: string; password: string; superuserPassword?: string },
    opts: { rethrow?: boolean } = {}
  ) => {
    const protectedLogin = Boolean(auth && preset?.authMode)
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
      if (!protectedLogin) {
        setDisplayNameInput(normalizedDisplayName)
        localStorage.setItem("voip-last-display-name", normalizedDisplayName)
      }
      uiClient.setApiBase(buildApiBaseUrl(host, port, resolvedUseHttps))
      setError("")
      setStatus(`Connecting API: ${host}:${port}`)
      const health = await uiClient.healthcheck()
      if (!health.ok) throw new Error(t("notices.serverNotHealthy"))
      setConnectedToApi(true)
      setStatus("Joining server...")
      let join: Awaited<ReturnType<typeof uiClient.joinServer>>
      if (protectedLogin && auth && preset?.authMode) {
        if (modeNeedsCertificate(preset.authMode)) {
          const identityRef = preset.identityRef
          const identity = identityRef ? await window.voixexIdentity?.get(identityRef) : null
          if (!identityRef || !identity?.certificate) throw new ApiError("certificateMissing", "certificate missing on this device")
          join = await uiClient.loginWithCertificate({
            certificate: identity.certificate,
            // The level saved on this device may be outdated (changed on another device), so send
            // nick + password whenever they were typed; the server asks for them if it needs them.
            ...(auth.nick || auth.password ? { nick: auth.nick, password: auth.password } : {}),
            superuserPassword: auth.superuserPassword,
            signLoginMessage: (message) => window.voixexIdentity!.sign(identityRef, message)
          })
        } else {
          join = await uiClient.loginWithPassword({
            nick: auth.nick,
            password: auth.password,
            superuserPassword: auth.superuserPassword
          })
        }
        if (join.upgradeRequired) {
          // The limited session stays in uiClient so the member can raise the level right away.
          throw new ApiError("upgradeRequired", "protection level below the server minimum", {
            minLevel: join.upgradeRequired.minLevel
          })
        }
      } else {
        const clientId = localStorage.getItem("voip-client-id") || crypto.randomUUID()
        join = await uiClient.joinServer(password, clientId, normalizedDisplayName, superPassword || undefined)
      }
      const joinedServerId = join.serverId
      const joinedServerName = join.serverName ?? "Server"
      const effectiveListName =
        (preset?.serverName?.trim() || connectServerListName.trim() || joinedServerName).trim() || "Server"
      // Drop the old entry for this server (same host:port or same server id) so it is replaced, not duplicated.
      const withoutSameHostForName = savedServers.filter(
        (s) => !(s.apiHost === host && s.apiPort === port) && s.serverId !== joinedServerId
      )
      // Labels are local; only the old add-by-form flow insisted on unique names.
      if (
        !preset &&
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
      if (!protectedLogin) {
        // Old password-only identity is shared by all servers; certificate logins have their own per server.
        localStorage.setItem("voip-client-id", join.profile.clientId)
        localStorage.setItem("voip-last-display-name", join.profile.displayName)
      }
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
              apiBase: uiClient.getApiBase(),
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
                  apiBase: uiClient.getApiBase(),
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
      const updatedProfile: SavedServerProfile = protectedLogin
        ? {
            // Nothing secret is kept for a protected profile: nick and password are typed each time.
            serverId: joinedServerId,
            serverName: effectiveListName,
            apiHost: host,
            apiPort: port,
            apiUseHttps: resolvedUseHttps,
            serverPassword: "",
            displayName: "",
            mediaEngine: effectiveMediaEngine,
            voiceTransport: effectiveVoiceTransport,
            ...(resolvedUdpOverride.trim() ? { udpPortOverride: resolvedUdpOverride.trim() } : {}),
            identityRef: preset?.identityRef,
            certId: preset?.certId,
            serverClientId: join.profile.clientId,
            authMode: join.authMode ?? preset?.authMode
          }
        : {
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
      if (updatedProfile.identityRef) {
        // Label the device certificate so the home screen can say whose it is and for which server.
        void window.voixexIdentity
          ?.setMeta?.(updatedProfile.identityRef, {
            nick: join.profile.displayName,
            label: effectiveListName,
            address: port ? `${host}:${port}` : host,
            secure: resolvedUseHttps
          })
          .then(() => refreshDeviceIdentities())
          .catch(() => {})
      }
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
      if (auth || opts.rethrow) {
        if (!(e instanceof ApiError && e.code === "upgradeRequired")) uiClient.disconnect()
        throw e
      }
      setError(errorText(e, "notices.joinServerFailed"))
    } finally {
      setJoining(false)
    }
  }

  /** Server administration lives in its own dialog and is only reachable for admins. */
  const openServerSettings = (initialTab: AppSettingsTab = "server_general") => {
    if (!canOpenServerSettings) return
    setAppSettingsTab(initialTab)
    setShowAppSettings(true)
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

  const persistSavedServers = (next: SavedServerProfile[]) => {
    setSavedServers(next)
    localStorage.setItem("voixex-saved-servers", JSON.stringify(next))
    setServers(next.map((s) => ({ id: s.serverId, name: s.serverName, icon: s.serverName.slice(0, 1).toUpperCase() || "S" })))
  }

  /** Saves a profile right away, so a freshly issued certificate is not lost if sign-in then fails. */
  const upsertSavedServer = (profile: SavedServerProfile) => {
    persistSavedServers([profile, ...savedServers.filter((s) => s.serverId !== profile.serverId)])
  }

  const requireIdentityBridge = () => {
    const bridge = window.voixexIdentity
    if (!bridge) throw new Error(t("access.desktopOnly"))
    return bridge
  }

  const describeAuthError = (e: unknown): DescribedError => {
    if (e instanceof ApiError) {
      const params = {
        level: typeof e.details.minLevel === "number" ? e.details.minLevel : "",
        own: typeof e.details.ownLevel === "number" ? e.details.ownLevel : ""
      }
      for (const key of [`authErrors.${e.code}`, `notices.${e.code}`]) {
        const text = t(key, params)
        if (text !== key) return { text, code: e.code, details: e.details }
      }
      return { text: e.message, code: e.code, details: e.details }
    }
    return { text: e instanceof Error ? e.message : String(e) }
  }

  const newServerMediaDefaults = () => {
    const prefs = loadGlobalConnectionPrefs()
    return {
      mediaEngine: normalizeMediaEngine(prefs.mediaEngine ?? mediaEngine),
      voiceTransport: normalizeVoiceTransport(prefs.voiceTransport ?? voiceTransport)
    }
  }

  /**
   * Creates the profile on the server. Levels 2 and 3 first create a device key whose certificate
   * the server signs; it is stored on this device (and removed again if the server refuses).
   */
  const createProtectedProfile = async (
    address: { apiHost: string; apiPort: string; apiUseHttps?: boolean },
    authMode: AuthMode,
    request: (publicKey: string | undefined) => Promise<IssuedProfile>
  ) => {
    uiClient.setApiBase(buildApiBaseUrl(address.apiHost.trim(), address.apiPort.trim(), Boolean(address.apiUseHttps)))
    await uiClient.healthcheck()
    if (!modeNeedsCertificate(authMode)) return { ref: undefined, issued: await request(undefined) }
    const identity = requireIdentityBridge()
    const { ref, publicKey } = await identity.create()
    try {
      const issued = await request(publicKey)
      if (!issued.certificate) throw new Error("server issued no certificate")
      await identity.setCertificate(ref, issued.certificate)
      return { ref, issued }
    } catch (e) {
      await identity.remove(ref).catch(() => {})
      throw e
    }
  }

  const updateSavedServer = (serverId: string, patch: Partial<SavedServerProfile>) => {
    const next = savedServers.map((s) => (s.serverId === serverId ? { ...s, ...patch } : s))
    persistSavedServers(next)
    return next.find((s) => s.serverId === serverId)
  }

  /**
   * Signs in to a protected profile. A level below the server minimum turns into the "raise level"
   * step; a level changed on another device is remembered so the next attempt asks the right thing.
   */
  const signInToProfile = async (
    profile: SavedServerProfile,
    credentials: { nick: string; password: string; superuserPassword?: string }
  ) => {
    try {
      await connectAndJoin(profile, credentials)
      pendingLoginRef.current = null
      setAccessMode(null)
    } catch (e) {
      // The level saved on this device may be stale. A certificate-only attempt that the server
      // turns down for lack of nick/password means the profile now needs them (servers before
      // 0.4.1 answer that with invalidCredentials and no level): switch the dialog to those fields.
      const triedCertificateAlone = Boolean(profile.identityRef) && !credentials.nick && !credentials.password
      if (e instanceof ApiError && triedCertificateAlone && (e.code === "passwordRequired" || e.code === "invalidCredentials")) {
        const mode = levelFromError(e) ?? "password_certificate"
        const updated = updateSavedServer(profile.serverId, { authMode: mode }) ?? { ...profile, authMode: mode }
        openLoginDialog(updated, mode, t("access.levelNowNeedsPassword"))
        return
      }
      if (e instanceof ApiError && e.code === "authModeMismatch" && levelFromError(e)) {
        const mode = levelFromError(e)!
        const updated = updateSavedServer(profile.serverId, { authMode: mode }) ?? { ...profile, authMode: mode }
        openLoginDialog(updated, mode, t("access.levelNowPasswordOnly"))
        return
      }
      if (e instanceof ApiError && e.code === "upgradeRequired" && profile.authMode) {
        pendingLoginRef.current = credentials
        setAccessMode({
          kind: "upgrade",
          serverId: profile.serverId,
          label: profile.serverName || profile.apiHost,
          minLevel: Number(e.details.minLevel) || 1,
          currentMode: profile.authMode,
          secure: Boolean(profile.apiUseHttps)
        })
        return
      }
      if (
        e instanceof ApiError &&
        (e.code === "authModeMismatch" || e.code === "certificateRequired" || e.code === "passwordRequired")
      ) {
        const mode = e.details.authMode
        if (mode === "password" || mode === "certificate" || mode === "password_certificate") {
          updateSavedServer(profile.serverId, { authMode: mode })
          if (modeNeedsCertificate(mode) && !profile.identityRef) throw new ApiError("certificateMissing", e.message)
        }
      }
      throw e
    }
  }

  const handleRegister = async (input: RegisterInput) => {
    const { ref, issued } = await createProtectedProfile(input, input.authMode, (publicKey) =>
      uiClient.registerMember({
        serverPassword: input.serverPassword,
        nick: input.nick,
        authMode: input.authMode,
        ...(modeNeedsPassword(input.authMode) ? { password: input.password } : {}),
        ...(publicKey ? { publicKey } : {})
      })
    )
    const profile: SavedServerProfile = {
      serverId: issued.serverId,
      serverName: input.label,
      apiHost: input.apiHost,
      apiPort: input.apiPort,
      apiUseHttps: input.apiUseHttps,
      serverPassword: "",
      displayName: "",
      authMode: issued.authMode,
      identityRef: ref,
      certId: issued.certificate?.certId,
      serverClientId: issued.clientId,
      ...newServerMediaDefaults()
    }
    upsertSavedServer(profile)
    await signInToProfile(profile, { nick: input.nick, password: input.password })
  }

  const handleImportCertificate = async (input: ImportInput) => {
    if (input.storedRef) return signInWithStoredCertificate(input.storedRef, input)
    if (!input.file) throw new Error(t("access.pickFileFirst"))
    const identity = requireIdentityBridge()
    const imported = await identity.importFromFile(input.file.contents, input.filePassphrase)
    const fromFile = imported.server
    const address = input.apiHost
      ? { apiHost: input.apiHost, apiPort: input.apiPort ?? "", apiUseHttps: Boolean(input.apiUseHttps) }
      : { apiHost: fromFile.apiHost ?? "", apiPort: fromFile.apiPort ?? "", apiUseHttps: Boolean(fromFile.apiUseHttps) }
    if (!address.apiHost) {
      await identity.remove(imported.ref).catch(() => {})
      throw new Error(t("access.fillAddress"))
    }
    const authMode: AuthMode =
      fromFile.authMode === "certificate" || fromFile.authMode === "password_certificate"
        ? fromFile.authMode
        : "password_certificate"
    const existing = savedServers.find((s) => s.serverId === imported.certificate.serverId)
    if (existing?.identityRef && existing.identityRef !== imported.ref) {
      await identity.remove(existing.identityRef).catch(() => {})
    }
    const profile: SavedServerProfile = {
      ...newServerMediaDefaults(),
      ...(existing ?? {}),
      serverId: imported.certificate.serverId,
      serverName: input.label || existing?.serverName || fromFile.label || "",
      ...address,
      serverPassword: "",
      displayName: "",
      superuserPassword: undefined,
      authMode,
      identityRef: imported.ref,
      certId: imported.certificate.certId,
      serverClientId: imported.certificate.clientId
    }
    upsertSavedServer(profile)
    if (modeNeedsPassword(authMode) && (!input.nick || !input.password)) throw new Error(t("access.fillNickPassword"))
    await signInToProfile(profile, { nick: input.nick, password: input.password })
  }

  /** Sign in with a certificate already on this device (no file, no file password). */
  const signInWithStoredCertificate = async (ref: string, input: ImportInput) => {
    const identity = requireIdentityBridge()
    const stored = await identity.get(ref)
    if (!stored?.certificate) throw new Error(t("deviceCerts.notIssued"))
    const certificate = stored.certificate
    const meta = deviceIdentities?.find((d) => d.ref === ref)?.meta
    const existing = savedServers.find((s) => s.serverId === certificate.serverId)
    const fromMeta = meta?.address ? splitAddress(meta.address) : null
    const address = input.apiHost
      ? { apiHost: input.apiHost, apiPort: input.apiPort ?? "", apiUseHttps: Boolean(input.apiUseHttps) }
      : existing
        ? { apiHost: existing.apiHost, apiPort: existing.apiPort, apiUseHttps: Boolean(existing.apiUseHttps) }
        : fromMeta
          ? { ...fromMeta, apiUseHttps: meta?.secure ?? fromMeta.apiPort === "443" }
          : null
    if (!address?.apiHost) throw new Error(t("deviceCerts.needAddress"))
    // Level 3 needs nick + password; without them try level 2 (the server says if more is needed).
    const authMode: AuthMode = existing?.authMode ?? (input.nick && input.password ? "password_certificate" : "certificate")
    if (existing?.identityRef && existing.identityRef !== ref) {
      await identity.remove(existing.identityRef).catch(() => {})
    }
    const profile: SavedServerProfile = {
      ...newServerMediaDefaults(),
      ...(existing ?? {}),
      serverId: certificate.serverId,
      serverName: input.label || existing?.serverName || meta?.label || address.apiHost,
      ...address,
      serverPassword: "",
      displayName: "",
      superuserPassword: undefined,
      authMode,
      identityRef: ref,
      certId: certificate.certId,
      serverClientId: certificate.clientId
    }
    upsertSavedServer(profile)
    if (modeNeedsPassword(authMode) && (!input.nick || !input.password)) throw new Error(t("access.fillNickPassword"))
    await signInToProfile(profile, { nick: input.nick, password: input.password })
  }

  const handleLogin = async (input: LoginInput) => {
    if (accessMode?.kind !== "login") return
    const profile = savedServers.find((s) => s.serverId === accessMode.serverId)
    if (!profile) return
    await signInToProfile(profile, {
      nick: input.nick,
      password: input.password,
      superuserPassword: input.superuserPassword || undefined
    })
  }

  /** Old profile (server password only): pick a protection level and keep nick + history. */
  const handleClaim = async (input: ClaimInput) => {
    if (accessMode?.kind !== "claim") return
    const saved = savedServers.find((s) => s.serverId === accessMode.serverId)
    if (!saved) return
    const legacyClientId = localStorage.getItem("voip-client-id") ?? ""
    const { ref, issued } = await createProtectedProfile(saved, input.authMode, (publicKey) =>
      uiClient.claimMember({
        serverPassword: saved.serverPassword,
        clientId: legacyClientId,
        authMode: input.authMode,
        ...(modeNeedsPassword(input.authMode) ? { password: input.password } : {}),
        ...(publicKey ? { publicKey } : {}),
        nick: input.nick
      })
    )
    const profile: SavedServerProfile = {
      ...saved,
      serverId: issued.serverId,
      serverPassword: "",
      displayName: "",
      superuserPassword: undefined,
      authMode: issued.authMode,
      identityRef: ref,
      certId: issued.certificate?.certId,
      serverClientId: issued.clientId
    }
    upsertSavedServer(profile)
    // Claiming drops roles; the superuser password saved by the old client restores admin once.
    await signInToProfile(profile, { nick: issued.nick, password: input.password, superuserPassword: saved.superuserPassword })
  }

  /**
   * Changes the protection level using the current session (full, or limited when the server
   * minimum is higher). Creates a device certificate when the new level needs one and this device
   * has none yet.
   */
  const changeProtectionLevel = async (
    profile: SavedServerProfile,
    authMode: AuthMode,
    input: { currentPassword: string; newPassword: string }
  ) => {
    const needsNewKey = modeNeedsCertificate(authMode) && !profile.identityRef
    const identity = needsNewKey ? requireIdentityBridge() : null
    const key = identity ? await identity.create() : null
    try {
      const result = await uiClient.setAuthMode(profile.serverId, {
        authMode,
        ...(input.currentPassword ? { currentPassword: input.currentPassword } : {}),
        ...(input.newPassword ? { newPassword: input.newPassword } : {}),
        ...(key ? { publicKey: key.publicKey } : {})
      })
      if (key && identity) {
        if (!result.certificate) throw new Error("server issued no certificate")
        await identity.setCertificate(key.ref, result.certificate)
      }
      return (
        updateSavedServer(profile.serverId, {
          authMode: result.authMode,
          ...(key && result.certificate ? { identityRef: key.ref, certId: result.certificate.certId } : {})
        }) ?? { ...profile, authMode: result.authMode }
      )
    } catch (e) {
      if (key && identity) await identity.remove(key.ref).catch(() => {})
      throw e
    }
  }

  /** Below the server minimum: raise the level with the limited session, then sign in again. */
  const handleUpgrade = async (input: UpgradeInput) => {
    if (accessMode?.kind !== "upgrade") return
    const profile = savedServers.find((s) => s.serverId === accessMode.serverId)
    const pending = pendingLoginRef.current
    if (!profile || !pending) return
    const updated = await changeProtectionLevel(profile, input.authMode, {
      currentPassword: profile.authMode && modeNeedsPassword(profile.authMode) ? pending.password : "",
      newPassword: input.newPassword
    })
    uiClient.disconnect()
    await signInToProfile(updated, {
      nick: pending.nick,
      password: input.newPassword || pending.password,
      superuserPassword: pending.superuserPassword
    })
  }

  /** For servers that do not support protected profiles yet: the old shared-password join. */
  const handleLegacyJoin = async (input: {
    address?: { apiHost: string; apiPort: string; apiUseHttps: boolean }
    label?: string
    serverPassword?: string
    nick?: string
  }) => {
    if (accessMode?.kind === "add" && input.address) {
      if (!input.serverPassword || !input.nick) throw new Error(t("access.fillNickPassword"))
      await connectAndJoin(
        {
          serverId: "",
          serverName: input.label ?? "",
          ...input.address,
          serverPassword: input.serverPassword,
          displayName: input.nick,
          ...newServerMediaDefaults()
        },
        undefined,
        { rethrow: true }
      )
    } else if (accessMode && "serverId" in accessMode) {
      const saved = savedServers.find((s) => s.serverId === accessMode.serverId)
      if (!saved) return
      await connectAndJoin(saved, undefined, { rethrow: true })
    }
    setAccessMode(null)
  }

  const openLoginDialog = (saved: SavedServerProfile, authMode: AuthMode | undefined = saved.authMode, notice?: string) => {
    if (!authMode) return
    setAccessMode({
      kind: "login",
      serverId: saved.serverId,
      label: saved.serverName || saved.apiHost,
      authMode,
      secure: Boolean(saved.apiUseHttps),
      ...(notice ? { notice } : {})
    })
  }

  const levelFromError = (e: unknown): AuthMode | undefined => {
    const mode = e instanceof ApiError ? e.details.authMode : undefined
    return mode === "password" || mode === "certificate" || mode === "password_certificate" ? mode : undefined
  }

  const openServer = (serverId: string) => {
    const saved = savedServers.find((s) => s.serverId === serverId)
    if (!saved) return
    const label = saved.serverName || saved.apiHost
    if (!saved.authMode) {
      setAccessMode({ kind: "claim", serverId, label, nick: saved.displayName, secure: Boolean(saved.apiUseHttps) })
      return
    }
    if (!saved.identityRef) {
      openLoginDialog(saved)
      return
    }
    // With a certificate on this device, try it alone first: the level may have been changed on
    // another device, and only the server knows. Nick + password are asked only if it needs them.
    setBusyServerId(serverId)
    void signInToProfile(saved, { nick: "", password: "" })
      .catch((e) => {
        toast.error(describeAuthError(e).text)
        openLoginDialog(saved, levelFromError(e) ?? saved.authMode)
      })
      .finally(() => setBusyServerId(null))
  }

  /** Leaves the server completely: a server is a closed space, nothing of it stays on screen. */
  const leaveServer = async () => {
    if (isInVoiceRef.current && !window.confirm(t("notices.confirmLeaveServer"))) return
    await fullyDisconnectFromApi()
    setActiveServerId("")
    activeServerIdRef.current = ""
  }

  useEffect(() => {
    if (!(sessionRevoked || sessionLevelTooLow) || !activeServerIdRef.current) return
    toast.error(sessionLevelTooLow ? t("notices.levelRaised") : t("notices.sessionRevoked"))
    void (async () => {
      await fullyDisconnectFromApi()
      setActiveServerId("")
      activeServerIdRef.current = ""
    })()
    // fullyDisconnectFromApi is recreated every render; the flags are what matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionRevoked, sessionLevelTooLow])

  const handleEditServer = (serverId: string) => {
    const s = savedServers.find((x) => x.serverId === serverId)
    if (!s) return
    setEditDraft({
      serverId,
      draft: {
        serverName: s.serverName,
        apiHost: s.apiHost,
        apiPort: s.apiPort,
        apiUseHttps: Boolean(s.apiUseHttps),
        udpPortOverride: s.udpPortOverride ?? "",
        mediaEngine: normalizeMediaEngine(s.mediaEngine),
        voiceTransport: normalizeVoiceTransport(s.voiceTransport)
      }
    })
  }

  const handleSaveConnection = (draft: ConnectionDraft) => {
    if (!editDraft) return
    persistSavedServers(
      savedServers.map((s) =>
        s.serverId === editDraft.serverId
          ? {
              ...s,
              serverName: draft.serverName.trim() || s.serverName,
              apiHost: draft.apiHost.trim(),
              apiPort: draft.apiPort.trim(),
              apiUseHttps: draft.apiUseHttps,
              udpPortOverride: draft.udpPortOverride.trim() || undefined,
              mediaEngine: draft.mediaEngine,
              voiceTransport: draft.voiceTransport
            }
          : s
      )
    )
    setEditDraft(null)
    toast.success(t("notices.connectionSaved"))
  }

  const serverCards = useMemo<ServerCardInfo[]>(
    () =>
      savedServers.map((s) => ({
        id: s.serverId,
        label: s.serverName || s.apiHost,
        address: s.apiPort ? `${s.apiHost}:${s.apiPort}` : s.apiHost,
        secure: Boolean(s.apiUseHttps),
        authMode: s.authMode ?? null,
        reachable: serverReachability[s.serverId] ?? "unknown"
      })),
    [savedServers, serverReachability]
  )
  const activeProfile = savedServers.find((s) => s.serverId === activeServerId)

  useEffect(() => {
    if (!activeServerId) void refreshDeviceIdentities()
  }, [activeServerId, savedServers, refreshDeviceIdentities])

  const deviceCertificates = useMemo<DeviceCertificate[] | null>(() => {
    if (!deviceIdentities) return null
    return deviceIdentities
      .map((identity) => {
        const saved = savedServers.find((s) => s.identityRef === identity.ref)
        return {
          ref: identity.ref,
          certId: identity.certificate?.certId ?? null,
          nick: identity.meta.nick || null,
          serverLabel: identity.meta.label || saved?.serverName || null,
          address: identity.meta.address || (saved ? (saved.apiPort ? `${saved.apiHost}:${saved.apiPort}` : saved.apiHost) : null),
          issuedAt: identity.certificate?.issuedAt ?? null,
          inUse: Boolean(saved)
        }
      })
      .sort((a, b) => Number(b.inUse) - Number(a.inUse) || (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""))
  }, [deviceIdentities, savedServers])

  const exportDeviceCertificate = async (ref: string, passphrase: string) => {
    const identity = requireIdentityBridge()
    const saved = savedServers.find((s) => s.identityRef === ref)
    const meta = deviceIdentities?.find((d) => d.ref === ref)?.meta
    return identity.exportToFile(ref, passphrase, {
      label: saved?.serverName || meta?.label,
      authMode: saved?.authMode,
      apiHost: saved?.apiHost,
      apiPort: saved?.apiPort,
      apiUseHttps: saved?.apiUseHttps
    })
  }

  const removeDeviceCertificate = async (ref: string) => {
    await requireIdentityBridge().remove(ref)
    // A saved server that used this certificate falls back to signing in with nick + password.
    if (savedServers.some((s) => s.identityRef === ref)) {
      const next = savedServers.map((s) => {
        if (s.identityRef !== ref) return s
        const { identityRef: _ref, certId: _cert, ...rest } = s
        return rest
      })
      setSavedServers(next)
      localStorage.setItem("voixex-saved-servers", JSON.stringify(next))
    }
    await refreshDeviceIdentities()
  }

  // Phones: swipes like Discord. In the chat: right opens channels, left opens members; the
  // opposite swipe closes an open panel; on the call screen a swipe down goes back to the chat.
  const swipeStateRef = useRef({ mobileNavOpen, showMemberList, callScreenOpen: false, immersive: false })
  swipeStateRef.current = {
    mobileNavOpen,
    showMemberList,
    callScreenOpen: isNarrow && isInVoice && Boolean(currentVoiceChannel) && voiceViewOpen,
    immersive: streamVideoFullscreen
  }
  useEffect(() => {
    if (!isNarrow || !activeServerId) return
    let start: { x: number; y: number; t: number } | null = null
    const onStart = (e: TouchEvent) => {
      const target = e.target as HTMLElement | null
      // Text fields, dialogs and sideways-scrolling lists keep their own gestures.
      if (e.touches.length !== 1 || target?.closest("input, textarea, [role=dialog], [role=slider], [data-noswipe]")) {
        start = null
        return
      }
      for (let el = target; el && el !== document.body; el = el.parentElement) {
        if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== "visible") {
          start = null
          return
        }
      }
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() }
    }
    const onEnd = (e: TouchEvent) => {
      if (!start) return
      const dx = e.changedTouches[0].clientX - start.x
      const dy = e.changedTouches[0].clientY - start.y
      const quick = Date.now() - start.t < 700
      start = null
      if (!quick) return
      const st = swipeStateRef.current
      const horizontal = Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) * 0.6
      const down = dy > 80 && Math.abs(dx) < dy * 0.6
      if (st.callScreenOpen) {
        if (down && !st.immersive) setVoiceViewOpen(false)
        return
      }
      if (!horizontal) return
      if (st.mobileNavOpen) {
        if (dx < 0) setMobileNavOpen(false)
      } else if (st.showMemberList) {
        if (dx > 0) setShowMemberList(false)
      } else if (dx > 0) {
        setMobileNavOpen(true)
      } else {
        setShowMemberList(true)
      }
    }
    document.addEventListener("touchstart", onStart, { passive: true })
    document.addEventListener("touchend", onEnd, { passive: true })
    return () => {
      document.removeEventListener("touchstart", onStart)
      document.removeEventListener("touchend", onEnd)
    }
  }, [isNarrow, activeServerId])

  // Phones: joining a voice channel opens the call screen; leaving closes it.
  useEffect(() => {
    if (!isInVoice) setVoiceViewOpen(false)
    else if (window.matchMedia(NARROW_QUERY).matches) setVoiceViewOpen(true)
  }, [isInVoice, currentVoiceChannel])
  // The stream <video> is a new element each time the call screen opens: attach the stream to it.
  useEffect(() => {
    if (!voiceViewOpen) return
    const raf = window.requestAnimationFrame(() => rebindViewerStreamElements())
    return () => window.cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceViewOpen])

  /** The voice stage: inline above the chat on wide screens, a full call screen on phones. */
  const renderVoiceStage = (fullscreen: boolean) => (
    <VoiceStage
                  roomId={currentVoiceChannel}
                  channelName={voiceChannelName}
                  participants={voiceUsers[currentVoiceChannel] ?? []}
                  error={error}
                  isMuted={isMuted}
                  isDeafened={isDeafened}
                  onToggleMute={() => {
                    if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
                    applyMute(!isMuted)
                  }}
                  onToggleDeafen={() => applyDeafen(!isDeafened)}
                  onLeaveVoice={handleDisconnect}
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
                  hasDesktopBridge={hasDesktopBridge}
                  canStartScreenShare={canStartScreenShare}
                  desktopControls={!isMobileApp}
                  screenShareWithAudio={screenShareWithAudio}
                  screenSources={screenSources}
                  selectedScreenSourceId={selectedScreenSourceId}
                  screenResolution={screenResolution}
                  screenFps={screenFps}
                  screenBitrateKbps={screenBitrateKbps}
                  localPreviewVideoRef={localPreviewVideoRef}
                  remoteStreamVideoRef={attachRemoteStreamVideo}
                  onScreenSourceChange={setSelectedScreenSourceId}
                  onScreenResolutionChange={setScreenResolution}
                  onScreenFpsChange={setScreenFps}
                  onScreenBitrateChange={setScreenBitrateKbps}
                  screenContent={screenContent}
                  onScreenContentChange={setScreenContent}
                  onScreenShareWithAudioToggle={() => setScreenShareWithAudio((v) => !v)}
                  onScreenShareToggle={() => void handleScreenShareToggle()}
                  onToggleStreamWindow={toggleStreamWindow}
                  onToggleStreamFullscreen={() => void toggleStreamVideoFullscreen()}
                  onStreamVolumeLiveChange={applyStreamVolumeLive}
                  onStreamVolumeCommit={handleStreamVolumeCommit}
                  streamHiddenByUser={streamHiddenByUser}
                  onHideStream={handleHideStream}
                  onShowStream={handleShowStream}
                  viewerQuality={viewerStreamQuality}
                  onViewerQualityChange={handleViewerStreamQualityChange}
                  viewerQualityAvailable={hasRemoteWebRtcVideo}
                  selfClientId={myVoiceClientId}
                  peerVolumePct={peerVolumePct}
                  enablePeerVolume={hasDesktopBridge && isInVoice && wsForVoiceJoin}
                  onPeerVolumeChange={handlePeerVolumeChange}
                  fullscreen={fullscreen}
                  onCollapse={() => setVoiceViewOpen(false)}
                />
  )

  // Wide screens: the stage above the chat; phones: the full call screen. Both fade out on leave.
  const inlineStage = isInVoice && currentVoiceChannel && !isNarrow ? renderVoiceStage(false) : null
  const inlineStageLeaving = useExitSnapshot(inlineStage, 200)
  const callScreen = isNarrow && isInVoice && currentVoiceChannel && voiceViewOpen ? renderVoiceStage(true) : null
  const callScreenLeaving = useExitSnapshot(callScreen, 200)

  return (
    <>
      {isMobileApp ? (
        miniCallVisible ? <div className="fixed inset-0 z-[200]">{miniCallView(true)}</div> : null
      ) : (
        <MiniCallWindow open={miniCallVisible && !miniCallDismissed} onClosed={() => setMiniCallDismissed(true)}>
          {miniCallView(false)}
        </MiniCallWindow>
      )}
      <div className="flex h-dvh flex-col bg-background">
      <TitleBar title={activeServerId ? `Voixex — ${servers.find((s) => s.id === activeServerId)?.name ?? ""}` : "Voixex"} />
      <main className="flex min-h-0 flex-1 overflow-hidden bg-background">
        <div ref={webRtcAudioSinkRef} className="hidden" aria-hidden="true" />

        {activeServerId && isNarrow && (mobileNavOpen || showMemberList) ? (
          <button
            type="button"
            aria-label={t("common.close")}
            className="fixed inset-0 z-30 bg-black/60 md:hidden"
            onClick={() => {
              setMobileNavOpen(false)
              setShowMemberList(false)
            }}
          />
        ) : null}
        {activeServerId ? (
          <aside
            className={cn(
              "flex h-full min-h-0 shrink-0 flex-col bg-card",
              "fixed inset-y-0 left-0 z-40 w-[min(85vw,20rem)] pt-[env(safe-area-inset-top)] transition-transform duration-200 md:static md:z-auto md:w-60 md:translate-x-0 md:pt-0 md:transition-none",
              mobileNavOpen ? "translate-x-0" : "-translate-x-full"
            )}
          >
            <ChannelSidebar
              serverName={servers.find((s) => s.id === activeServerId)?.name || t("common.noServer")}
              serverAddress={activeProfile ? (activeProfile.apiPort ? `${activeProfile.apiHost}:${activeProfile.apiPort}` : activeProfile.apiHost) : undefined}
              onLeaveServer={() => void leaveServer()}
              onOpenServerSettings={canOpenServerSettings ? () => openServerSettings() : undefined}
              security={
                activeProfile
                  ? {
                      secure: Boolean(activeProfile.apiUseHttps),
                      levelLabel: activeProfile.authMode
                        ? t("levels.sidebarShort", { level: authLevel(activeProfile.authMode) })
                        : t("levels.unprotected"),
                      levelHint: activeProfile.authMode
                        ? t("levels.short", { level: authLevel(activeProfile.authMode), name: t(`levels.${activeProfile.authMode}`) })
                        : undefined
                    }
                  : undefined
              }
              serverBannerUrl={serverAppearance.serverBannerUrl}
              categories={categories}
              activeChannelId={activeChannelId}
              currentVoiceChannelId={currentVoiceChannel}
              isInVoice={isInVoice}
              onChannelSelect={(id) => {
                setMobileNavOpen(false)
                void handleChannelSelect(id)
              }}
              voiceUsers={voiceUsers}
            />
            <UserPanel
              user={currentUser}
              isMuted={isMuted}
              isInVoice={isInVoice}
              voiceChannelName={voiceChannelName}
              onToggleMute={() => {
                const next = !isMuted
                if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
                applyMute(next)
              }}
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
          <ServerHome
            servers={serverCards}
            busyServerId={busyServerId}
            onSignInAsAdmin={(id) => {
              const saved = savedServers.find((x) => x.serverId === id)
              if (saved?.authMode) openLoginDialog(saved)
              else if (saved) openServer(id)
            }}
            onOpen={openServer}
            onAdd={() => setAccessMode({ kind: "add" })}
            onImport={() => setAccessMode({ kind: "import" })}
            onEdit={handleEditServer}
            onRemove={(id) => void handleRemoveSavedServer(id)}
            onOpenDeviceSettings={() => void openAppSettings("voice")}
            onOpenCertificateStorage={
              deviceCertificates
                ? () => {
                    void refreshDeviceIdentities()
                    setShowCertStorage(true)
                  }
                : undefined
            }
            storedCertificateCount={deviceCertificates?.length ?? 0}
          />
        ) : (
          <ChatArea
            channelName={activeChannel?.type === "text" ? activeChannel.name : ""}
            channelType="text"
            messages={activeChannel?.type === "text" ? messages : []}
            onSendMessage={handleSendMessage}
            onUploadAttachment={handleUploadAttachment}
            canSend={Boolean(activeServerId && activeChannelId && isTextChannel)}
            showMemberList={showMemberList}
            onToggleMemberList={() => setShowMemberList(!showMemberList)}
            onOpenNavigation={() => setMobileNavOpen(true)}
            stage={
              isInVoice && currentVoiceChannel ? (
                isNarrow ? (
                  voiceViewOpen ? null : (
                    <VoiceMiniBar
                      channelName={voiceChannelName}
                      participants={voiceUsers[currentVoiceChannel] ?? []}
                      live={Boolean(activeScreenSharerName || isScreenSharing)}
                      isMuted={isMuted}
                      onToggleMute={() => {
                        if (pttTimerRef.current) clearTimeout(pttTimerRef.current)
                        applyMute(!isMuted)
                      }}
                      onLeave={handleDisconnect}
                      onOpen={() => setVoiceViewOpen(true)}
                    />
                  )
                ) : (
                  inlineStage
                )
              ) : inlineStageLeaving ? (
                <div className="animate-out fade-out slide-out-to-top-3 duration-200 fill-mode-forwards">{inlineStageLeaving}</div>
              ) : null
            }
          />
        )}

        {showMemberList && activeServerId ? (
          <div className="fixed inset-y-0 right-0 z-40 pt-[env(safe-area-inset-top)] md:static md:z-auto md:pt-0">
          <MemberList
            members={members}
            roles={[{ id: ADMIN_ROLE_GROUP, name: t("members.admins"), color: "#8b87f5" }]}
            onClose={() => setShowMemberList(false)}
            inVoiceIds={Object.values(voiceUsers).flat().map((u) => u.id)}
            speakingIds={Object.values(voiceUsers).flat().filter((u) => u.isSpeaking).map((u) => u.id)}
          />
          </div>
        ) : null}
      </main>
      </div>
      {callScreen ?? (callScreenLeaving ? <div className="animate-out fade-out duration-200 fill-mode-forwards">{callScreenLeaving}</div> : null)}

      <ConnectServerDialog
        draft={editDraft?.draft ?? null}
        onOpenChange={(open) => {
          if (!open) setEditDraft(null)
        }}
        onSave={handleSaveConnection}
      />
      <ServerAccessDialog
        mode={accessMode}
        onOpenChange={(open) => {
          if (!open) setAccessMode(null)
        }}
        defaultAddress={{ apiHost: "", apiPort: "443", apiUseHttps: true }}
        onRegister={handleRegister}
        onImport={handleImportCertificate}
        onLogin={handleLogin}
        onClaim={handleClaim}
        onUpgrade={handleUpgrade}
        onLegacyJoin={handleLegacyJoin}
        pickCertificateFile={async () => (await window.voixexIdentity?.pickImportFile()) ?? null}
        storedCertificates={(deviceCertificates ?? [])
          .filter((c) => c.certId)
          .map((c) => ({
            ref: c.ref,
            title: `${c.nick ?? t("deviceCerts.unknownNick")} · ${c.serverLabel ?? t("deviceCerts.unknownServer")}`,
            subtitle: [c.address, c.inUse ? t("deviceCerts.inUse") : t("deviceCerts.unused")].filter(Boolean).join(" · ")
          }))}
        describeError={describeAuthError}
        hasDesktopBridge={hasDesktopBridge}
      />
      <Dialog open={showCertStorage} onOpenChange={setShowCertStorage}>
        <DialogContent className="flex max-h-[min(85vh,720px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <DialogHeader className="shrink-0 px-6 pb-3 pt-5">
            <DialogTitle>{t("deviceCerts.title")}</DialogTitle>
            <DialogDescription>{t("deviceCerts.intro")}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <DeviceCertificates
              certificates={deviceCertificates ?? []}
              onExport={exportDeviceCertificate}
              onRemove={removeDeviceCertificate}
            />
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={showAppSettings} onOpenChange={setShowAppSettings}>
        <DialogContent className="flex h-[min(85vh,720px)] max-w-3xl flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="shrink-0 border-b border-border px-6 py-4">
            <DialogTitle>
              {serverSettingsScope
                ? t("settings.serverTitle", { name: servers.find((s) => s.id === activeServerId)?.name ?? "" })
                : t("settings.title")}
            </DialogTitle>
            <DialogDescription>{serverSettingsScope ? t("settings.serverDescription") : t("settings.description")}</DialogDescription>
          </DialogHeader>
          <Tabs
            value={appSettingsTab}
            onValueChange={(v) => setAppSettingsTab(v as AppSettingsTab)}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
              <TabsList className="flex h-auto w-full shrink-0 flex-row items-stretch justify-start gap-1 overflow-x-auto rounded-none border-b border-border bg-muted/20 p-2 sm:w-44 sm:flex-col sm:overflow-visible sm:border-b-0 sm:border-r">
                {!serverSettingsScope ? (
                  <>
                    <TabsTrigger value="language" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabLanguage")}
                    </TabsTrigger>
                    <TabsTrigger value="voice" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabVoice")}
                    </TabsTrigger>
                    <TabsTrigger value="keybinds" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabKeybinds")}
                    </TabsTrigger>
                    {hasShell ? (
                      <TabsTrigger value="window" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                        {t("settings.tabWindow")}
                      </TabsTrigger>
                    ) : null}
                  </>
                ) : null}
                {!serverSettingsScope && activeServerId && activeProfile?.authMode ? (
                  <TabsTrigger value="security" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                    {t("settings.tabSecurity")}
                  </TabsTrigger>
                ) : null}
                {serverSettingsScope && canOpenServerSettings ? (
                  <>
                    <TabsTrigger value="server_general" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabServer")}
                    </TabsTrigger>
                    <TabsTrigger value="server_channels" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabChannels")}
                    </TabsTrigger>
                    <TabsTrigger value="server_roles" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabRoles")}
                    </TabsTrigger>
                    <TabsTrigger value="server_members" className="shrink-0 justify-start px-3 py-2 text-xs sm:w-full sm:text-sm">
                      {t("settings.tabMembers")}
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
                  active={voicePipelineMode !== null}
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

              <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Label>{t("settings.aiNoise")}</Label>
                    <p className="text-xs text-muted-foreground">{t("settings.aiNoiseHint")}</p>
                  </div>
                  <Switch checked={aiNoiseSuppressionEnabled} onCheckedChange={setAiNoiseSuppressionEnabled} />
                </div>
              </div>

              {hasDesktopBridge && !aiNoiseSuppressionEnabled ? (
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

            <TabsContent value="window" className="mt-0 space-y-3">
              {isMobileApp ? null : (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                  <div>
                    <Label>{t("settings.closeToTray")}</Label>
                    <p className="text-xs text-muted-foreground">{t("settings.closeToTrayHint")}</p>
                  </div>
                  <Switch checked={closeToTray} onCheckedChange={setCloseToTray} />
                </div>
              )}
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
                <div>
                  <Label>{isMobileApp ? t("settings.miniCallPip") : t("settings.miniCall")}</Label>
                  <p className="text-xs text-muted-foreground">{isMobileApp ? t("settings.miniCallPipHint") : t("settings.miniCallHint")}</p>
                </div>
                <Switch checked={miniCallEnabled} onCheckedChange={setMiniCallEnabled} />
              </div>
            </TabsContent>

            <TabsContent value="server_general" className="mt-0 space-y-4">
              {canOpenServerSettings ? (
                <ServerSecurityPolicy
                  load={() => uiClient.getSecurityPolicy(activeServerId)}
                  save={async (level) => {
                    await uiClient.setSecurityPolicy(activeServerId, level)
                  }}
                  describeError={describeAuthError}
                />
              ) : null}
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

            <TabsContent value="security" className="mt-0">
              {activeServerId && activeProfile?.authMode ? (
                <MySecurityPanel
                  load={() => uiClient.getMySecurity(activeServerId)}
                  secure={Boolean(activeProfile.apiUseHttps)}
                  canExport={Boolean(activeProfile.identityRef)}
                  onChangeLevel={async (mode, input) => {
                    await changeProtectionLevel(activeProfile, mode, input)
                  }}
                  onRevoke={async (certId) => {
                    await uiClient.revokeMyCertificate(activeServerId, certId)
                    toast.success(t("security.revokedToast"))
                  }}
                  onChangePassword={async (current, next) => {
                    await uiClient.changeMyPassword(activeServerId, current, next)
                  }}
                  onExport={async (passphrase) => {
                    const identity = requireIdentityBridge()
                    return identity.exportToFile(activeProfile.identityRef!, passphrase, {
                      label: activeProfile.serverName,
                      authMode: activeProfile.authMode,
                      apiHost: activeProfile.apiHost,
                      apiPort: activeProfile.apiPort,
                      apiUseHttps: activeProfile.apiUseHttps
                    })
                  }}
                  describeError={describeAuthError}
                />
              ) : null}
            </TabsContent>

            <TabsContent value="server_members" className="mt-0">
              {canOpenServerSettings ? (
                <MemberSecurityAdmin
                  members={members.map((m) => ({ id: m.id, name: m.name }))}
                  load={(clientId) => uiClient.getMemberSecurity(activeServerId, clientId)}
                  onRevoke={async (clientId, certId) => {
                    await uiClient.revokeMemberCertificate(activeServerId, clientId, certId)
                  }}
                  onReset={async (clientId) => {
                    await uiClient.resetMemberCredentials(activeServerId, clientId)
                  }}
                  describeError={describeAuthError}
                />
              ) : null}
            </TabsContent>

            <TabsContent value="server_roles" className="mt-0">
              {canOpenServerSettings ? (
                <RolesAdmin
                  members={members.map((m) => ({
                    id: m.id,
                    name: m.name,
                    isAdmin: Boolean(m.roles?.includes(ADMIN_ROLE_GROUP)),
                    online: m.status !== "offline"
                  }))}
                  meId={uiClient.getMeState()?.clientId ?? null}
                  onSetAdmin={(clientId, admin) => uiClient.setMemberAdmin(activeServerId, clientId, admin)}
                  describeError={describeAuthError}
                />
              ) : null}
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
