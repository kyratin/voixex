import { useState, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { MiniCallView } from "../components/voip/mini-call"
import { VoiceStage } from "../components/voip/voice-stage"
import { UserPanel } from "../components/voip/user-panel"
import { I18nProvider } from "../lib/i18n/provider"
import { VoiceActivityDetector, setLocalVoiceActivity, resetLocalVoiceActivity } from "../lib/voice-activity"
export { VoiceActivityDetector }

export function mountStageHarness() {
  const canvas = document.createElement("canvas")
  canvas.width = 640; canvas.height = 360
  const ctx = canvas.getContext("2d")!
  ctx.fillStyle = "#38487c"; ctx.fillRect(0, 0, 640, 360)
  ctx.fillStyle = "#ffffff"; ctx.font = "40px sans-serif"; ctx.fillText("CAMERA", 230, 195)
  const image = canvas.toDataURL("image/jpeg")
  const capture = canvas.captureStream(10)
  const detector = new VoiceActivityDetector()
  type State = { count: number; fullscreen: boolean; muted: boolean; inVoice: boolean; packets: number; sharing: boolean; popup: boolean; mini: boolean; cameras: boolean; collapsed: boolean; watching: boolean }
  let update: (patch: Partial<State>) => void
  function Harness() {
    const [state, setState] = useState<State>({ count: 1, fullscreen: false, muted: false, inVoice: true, packets: 0, sharing: false, popup: false, mini: false, cameras: true, collapsed: false, watching: false })
    update = patch => setState(previous => ({ ...previous, ...patch }))
    const participants = Array.from({ length: state.count }, (_, i) => ({ id: `person-${i}`, name: `Participant ${i + 1}`, avatar: String(i + 1), isSpeaking: false }))
    const noop = () => {}
    const props: ComponentProps<typeof VoiceStage> = {
      roomId: "layout-room", channelName: "Voice channel", participants, error: "", isMuted: false, isDeafened: false,
      onToggleMute: noop, onToggleDeafen: noop, onLeaveVoice: noop, activeScreenSharerName: "", watchingNames: "",
      isScreenSharing: state.sharing, viewingLegacyStream: false, viewingWebRtcStream: state.watching, streamLoading: false,
      screenVideoUrl: null, screenImageUrl: null, streamVolumePct: 100, streamVideoFullscreen: false, showingStreamWindow: state.popup,
      hasDesktopBridge: true, screenShareWithAudio: false, screenSources: [], selectedScreenSourceId: null,
      screenResolution: "1080", screenFps: 30, screenBitrateKbps: 6000, localPreviewVideoRef: { current: null }, remoteStreamVideoRef: el => { if (el) { el.srcObject = capture; void el.play() } },
      onScreenSourceChange: noop, onScreenResolutionChange: noop, onScreenFpsChange: noop, onScreenBitrateChange: noop,
      onScreenShareWithAudioToggle: noop, onScreenShareToggle: noop, onToggleStreamWindow: noop, onToggleStreamFullscreen: noop,
      onCollapse: () => setState(previous => ({ ...previous, collapsed: true })),
      onStreamVolumeLiveChange: noop, onStreamVolumeCommit: noop, fullscreen: state.fullscreen,
      selfClientId: "person-0", enablePeerVolume: true, onPeerVolumeChange: noop,
      camera: { enabled: true, busy: false, supported: true, error: "", devices: [], deviceId: "", local: state.cameras ? capture : null,
        pictures: state.cameras ? Object.fromEntries(participants.slice(1).map(p => [p.id, { image }])) : {}, toggle: noop, select: noop }
    }
    return <I18nProvider>
      <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        {state.mini ? <div style={{ width: 480, height: 320 }}><MiniCallView channelName="Voice channel" participants={participants} live={null} isMuted={false} isDeafened={false} onToggleMute={noop} onToggleDeafen={noop} onLeave={noop} onOpen={noop} camera={props.camera} selfClientId="person-0" /></div> : <div style={{ display: state.collapsed ? "none" : "contents" }}><VoiceStage {...props} /></div>}
        <div style={{ width: 260, marginTop: 20 }}>
          <UserPanel user={{ id: "person-0", name: "Participant 1", avatar: "1", status: "online" }} isMuted={state.muted}
            isInVoice={state.inVoice} voiceChannelName="Voice channel" onToggleMute={noop} onOpenSettings={noop}
            voiceStats={{ txPackets: state.packets }} />
        </div>
      </div>
    </I18nProvider>
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<Harness />)
  return {
    update: (patch: Partial<State>) => update(patch),
    rms: (value: number, now: number, enabled = true) => setLocalVoiceActivity(detector.sample(value, now, enabled)),
    unmount: () => { resetLocalVoiceActivity(); root.unmount(); capture.getTracks().forEach(t => t.stop()); container.remove() }
  }
}

import { VoiceMediaSettings, type ConnectionDraft } from "../components/voip/connect-server-dialog"
export function mountConnectionHarness() {
  function Harness() {
    const [value, setValue] = useState<Pick<ConnectionDraft, "mediaEngine" | "voiceTransport" | "udpPortOverride">>({ mediaEngine: "legacy", voiceTransport: "udp", udpPortOverride: "" })
    Object.assign(window, { connectionValues: value })
    return <I18nProvider><div style={{ padding: 24, maxWidth: 480 }}><VoiceMediaSettings value={value} onChange={patch => setValue(previous => ({ ...previous, ...patch }))} /></div></I18nProvider>
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<Harness />)
  return { unmount: () => { root.unmount(); container.remove() } }
}

export { loadVoiceCaptureWorklet } from "../lib/voice-playout"
