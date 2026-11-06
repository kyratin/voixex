import { useState, type ComponentProps } from "react"
import { createRoot } from "react-dom/client"
import { VoiceStage } from "../components/voip/voice-stage"
import type { CameraControls } from "../lib/camera/use-camera"
import { MiniCallView } from "../components/voip/mini-call"
import { I18nProvider } from "../lib/i18n/provider"
import { VoiceActivityDetector, setLocalVoiceActivity, resetLocalVoiceActivity } from "../lib/voice-activity"
import { clearVoiceLevels, setRoomVoiceLevels, setSfuVoiceLevels } from "../lib/voice-levels"

type State = { cameras: boolean; selfMuted: boolean; remoteMuted: boolean; remoteSpeaking: boolean; remoteSource: "legacy" | "sfu"; miniView: "cameras" | "avatars" }
export function mountCameraSpeakingHarness() {
  const canvas = document.createElement("canvas")
  canvas.width = 320; canvas.height = 180
  const ctx = canvas.getContext("2d")!
  const draw = () => { ctx.fillStyle = "#38487c"; ctx.fillRect(0, 0, 320, 180); ctx.fillStyle = "white"; ctx.fillText("Speaking camera", 90, 90) }
  draw()
  const image = canvas.toDataURL("image/jpeg"), capture = canvas.captureStream(10)
  const drawTimer = setInterval(draw, 100), detector = new VoiceActivityDetector()
  let update: (patch: Partial<State>) => void
  const noop = () => {}
  function Harness() {
    const [state, setState] = useState<State>({ cameras: true, selfMuted: false, remoteMuted: false, remoteSpeaking: false, remoteSource: "legacy", miniView: "cameras" })
    update = patch => setState(previous => ({ ...previous, ...patch }))
    const participants = [
      { id: "self", name: "Local microphone", avatar: "L", isSpeaking: false, isMuted: state.selfMuted },
      { id: "remote", name: "Remote microphone", avatar: "R", isSpeaking: state.remoteSpeaking, isMuted: state.remoteMuted }
    ]
    const camera: CameraControls = { enabled: state.cameras, busy: false, supported: true, error: "", devices: [], deviceId: "", local: state.cameras ? capture : null,
      pictures: state.cameras ? { remote: state.remoteSource === "sfu" ? { stream: capture } : { image } } : {}, toggle: noop, select: noop }
    const props: ComponentProps<typeof VoiceStage> = {
      roomId: "speaking-room", channelName: "Speaking indicators", participants, camera, selfClientId: "self", error: "", isMuted: state.selfMuted, isDeafened: false,
      onToggleMute: noop, onToggleDeafen: noop, onLeaveVoice: noop, activeScreenSharerName: "", watchingNames: "",
      isScreenSharing: false, viewingLegacyStream: false, viewingWebRtcStream: false, streamLoading: false,
      screenVideoUrl: null, screenImageUrl: null, streamVolumePct: 100, streamVideoFullscreen: false, showingStreamWindow: false,
      hasDesktopBridge: true, screenShareWithAudio: false, screenSources: [], selectedScreenSourceId: null,
      screenResolution: "1080", screenFps: 30, screenBitrateKbps: 6000, localPreviewVideoRef: { current: null }, remoteStreamVideoRef: noop,
      onScreenSourceChange: noop, onScreenResolutionChange: noop, onScreenFpsChange: noop, onScreenBitrateChange: noop,
      onScreenShareWithAudioToggle: noop, onScreenShareToggle: noop, onToggleStreamWindow: noop, onToggleStreamFullscreen: noop,
      onStreamVolumeLiveChange: noop, onStreamVolumeCommit: noop, fullscreen: false
    }
    return <I18nProvider>
      <div data-main-speaking style={{ width: 800, height: 420 }}><VoiceStage {...props} /></div>
      <div data-mini-speaking style={{ width: 480, height: 320 }}><MiniCallView channelName="Speaking indicators" participants={participants} camera={camera} selfClientId="self" preferredView={state.miniView}
        live={null} isMuted={state.selfMuted} isDeafened={false} onToggleMute={noop} onToggleDeafen={noop} onLeave={noop} onOpen={noop} /></div>
    </I18nProvider>
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<Harness />)
  return {
    update: (patch: Partial<State>) => update(patch),
    localRms: (rms: number, now = performance.now()) => setLocalVoiceActivity(detector.sample(rms, now, true)),
    legacy: (level: number) => setRoomVoiceLevels("speaking-room", level ? { remote: level } : {}),
    sfu: (level: number) => setSfuVoiceLevels("speaking-room", level ? { remote: level } : {}),
    unmount: () => { resetLocalVoiceActivity(); clearVoiceLevels(); setSfuVoiceLevels("speaking-room", {}); root.unmount(); clearInterval(drawTimer); capture.getTracks().forEach(track => track.stop()); container.remove() }
  }
}
