import { createElement, useState } from "react"
import { createRoot } from "react-dom/client"
import { useCamera } from "../lib/camera/use-camera"
export { WebVoiceEngine } from "../lib/web-voice/engine"
export { CameraAssembler, fragmentCamera } from "../lib/camera/protocol"
export { WebRtcMediaSession } from "../lib/webrtc-media"

// Browser-only integration fixture: exercise asynchronous capture/room lifetimes.
export function mountCameraHarness() {
  let update: (room: string) => void
  function Harness() {
    const [room, setRoom] = useState("room-a")
    update = setRoom
    const camera = useCamera({
      roomKey: room, serverId: "test", roomId: room, allowed: true,
      client: () => ({ getCameraCapabilities: async () => ({ version: 1, allowCamera: true, livekit: false }) }) as never,
      session: () => null, ensureSession: async () => {}, errorMessage: code => code
    })
    Object.assign(window, { cameraControls: camera.controls })
    return null
  }
  const container = document.createElement("div")
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(createElement(Harness))
  return { room: (room: string) => update(room), unmount: () => { root.unmount(); container.remove() } }
}
