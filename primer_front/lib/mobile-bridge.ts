import { registerPlugin } from "@capacitor/core"
import { WebVoiceEngine } from "@/lib/web-voice/engine"
import { webIdentity } from "@/lib/web-identity"
import type { VoixexShellAction } from "@/types/electron-voice"

/**
 * Android app (Capacitor): provides the same window.electronVoice / voixexIdentity / voixexWindow
 * bridges as the desktop app, so the UI runs unchanged. Voice goes through WebVoiceEngine
 * (opus2 over WebSocket) instead of the desktop UDP engine.
 */

/** Native side (android/.../VoixexCallPlugin.kt): call audio mode + foreground service. */
const VoixexCall = registerPlugin<{
  start(options: { title: string; text: string }): Promise<void>
  stop(): Promise<void>
  setOrientation(options: { mode: "landscape" | "auto" }): Promise<void>
  update(options: { title: string; text: string; muted: boolean; muteLabel: string; unmuteLabel: string; leaveLabel: string }): Promise<void>
  setPip(options: { enabled: boolean }): Promise<void>
  addListener(event: "action", listener: (e: { action: VoixexShellAction }) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: "pip", listener: (e: { active: boolean }) => void): Promise<{ remove: () => Promise<void> }>
}>("VoixexCall")

/** Phone side of window.voixexShell: the call notification's buttons and picture-in-picture. */
function installShell() {
  const listen = <T,>(event: "action" | "pip", handler: (e: T) => void) => {
    const handle = VoixexCall.addListener(event as "action", handler as never)
    return () => {
      void handle.then((h) => h.remove())
    }
  }
  window.voixexShell = {
    kind: "android",
    setCallState(state) {
      if (!state.inVoice) return
      void VoixexCall.update({
        title: state.channel || "Voixex",
        text: state.muted ? `🔇 ${state.labels.unmute}` : "Voixex",
        muted: state.muted,
        muteLabel: state.labels.mute,
        unmuteLabel: state.labels.unmute,
        leaveLabel: state.labels.leave
      }).catch(() => {})
    },
    setPreferences(prefs) {
      if (typeof prefs.miniWindow === "boolean") void VoixexCall.setPip({ enabled: prefs.miniWindow }).catch(() => {})
    },
    // Tapping the floating window brings the app back by itself.
    showMain() {},
    isMinimized: async () => false,
    onAction: (listener) => listen<{ action: VoixexShellAction }>("action", (e) => listener(e.action)),
    onMinimizedChange: (listener) => listen<{ active: boolean }>("pip", (e) => listener(Boolean(e.active)))
  }
}

/** Native screen capture published to LiveKit (the WebView has no getDisplayMedia). */
const VoixexScreenShare = registerPlugin<{
  start(options: NativeScreenShareOptions): Promise<{ started: boolean; reason?: string }>
  stop(): Promise<void>
  addListener(event: "stopped", listener: () => void): Promise<{ remove: () => Promise<void> }>
}>("VoixexScreenShare")

type NativeScreenShareOptions = {
  url: string
  token: string
  /** Short side of the picture (1080 = 1080p, upright or sideways). */
  maxHeight?: number
  fps?: number
  bitrateKbps?: number
  content?: "motion" | "detail"
}

export async function startNativeScreenShare(options: NativeScreenShareOptions) {
  return VoixexScreenShare.start(options)
}

export async function stopNativeScreenShare() {
  await VoixexScreenShare.stop().catch(() => {})
}

/** The capture ended from Android (notification, quick settings, projection revoked). */
export function onNativeScreenShareStopped(listener: () => void) {
  const handle = VoixexScreenShare.addListener("stopped", listener)
  return () => {
    void handle.then((h) => h.remove())
  }
}

/** Android app: turn the screen sideways for a maximized stream, or give rotation back. */
export function setScreenOrientation(mode: "landscape" | "auto") {
  if (!isNativeApp()) return
  void VoixexCall.setOrientation({ mode }).catch(() => {})
}

type CapacitorGlobal = { isNativePlatform?: () => boolean; getPlatform?: () => string }

export function isNativeApp() {
  if (typeof window === "undefined") return false
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return Boolean(cap?.isNativePlatform?.())
}

function toBase64(bytes: Uint8Array) {
  let s = ""
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function pcmFromBase64(b64: string) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

function installVoiceBridge() {
  const engine = new WebVoiceEngine()
  // Phones switch between Wi-Fi and mobile data: reconnect as soon as a network is back.
  window.addEventListener("online", () => engine.reconnectNow())
  let devices = { inputId: null as string | null, outputId: null as string | null }
  let inCall = false
  const callOn = (on: boolean) => {
    if (on === inCall) return
    inCall = on
    void (on ? VoixexCall.start({ title: "Voixex", text: "Голосовой канал" }) : VoixexCall.stop()).catch(() => {})
  }
  const noKeybinds = { toggleMute: null, toggleDeafen: null, pushToTalk: null }

  window.electronVoice = {
    async requestMicrophoneAccess() {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true })
        s.getTracks().forEach((t) => t.stop())
        return { granted: true }
      } catch {
        return { granted: false }
      }
    },
    async connect(payload) {
      const apiBase = (payload as { apiBase?: string }).apiBase
      if (!apiBase) throw new Error("Voice needs the server address")
      await engine.connect({ apiBase, mediaToken: payload.mediaToken })
      return engine.getStats()
    },
    async setMediaToken(mediaToken) {
      engine.setMediaToken(mediaToken)
      return null
    },
    async joinRoom(roomId) {
      engine.joinRoom(roomId)
      callOn(true)
      return engine.getStats()
    },
    async leaveRoom() {
      engine.leaveRoom()
      callOn(false)
      return engine.getStats()
    },
    async setMute(muted) {
      engine.setMute(muted)
      return engine.getStats()
    },
    async setDeafen(deafened) {
      engine.setDeafen(deafened)
      return engine.getStats()
    },
    async disconnect() {
      engine.close()
      callOn(false)
      return engine.getStats()
    },
    async getState() {
      return engine.getStats()
    },
    async setSelfTestTone() {
      return engine.getStats()
    },
    async getStats() {
      return engine.getStats()
    },
    async listAudioDevices() {
      return [
        { id: "default-input", label: "Microphone", kind: "input" as const, isDefault: true },
        { id: "default-output", label: "Speaker", kind: "output" as const, isDefault: true }
      ]
    },
    async getAudioDevices() {
      return devices
    },
    async setAudioDevices(selection) {
      devices = selection
      return devices
    },
    async getKeybinds() {
      return noKeybinds
    },
    async setKeybinds() {
      return noKeybinds
    },
    async clearKeybinds() {
      return noKeybinds
    },
    sendPcm16Frame(pcm16Base64) {
      engine.sendPcm16(pcmFromBase64(pcm16Base64))
    },
    sendOpusFrame() {},
    sendScreenChunk() {},
    async listScreenSources() {
      return []
    },
    async setScreenSource() {
      return null
    },
    onPcm16Frame(listener) {
      engine.setOnPcm((pcm) => listener(toBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))))
      return () => engine.setOnPcm(null)
    },
    onScreenChunk() {
      return () => {}
    },
    onHotkeyAction() {
      return () => {}
    }
  }
}

/** Installs the bridges once, before the page reads them. No-op outside the Android app. */
export function installMobileBridge() {
  if (!isNativeApp() || window.electronVoice) return
  window.voixexWindow = { platform: "android", customTitleBar: false }
  window.voixexIdentity = webIdentity
  installShell()
  if (WebVoiceEngine.supported()) installVoiceBridge()
}

if (typeof window !== "undefined") installMobileBridge()
