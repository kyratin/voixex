import { attachWindowsScreenAudio } from "./windows-screen-audio"

/** Request OS capture with explicit exclusion of the calling application, never plain loopback. */
type AudioIsolationConstraints = MediaTrackConstraints & { restrictOwnAudio: boolean; suppressLocalAudioPlayback: boolean }
type AudioIsolationSettings = MediaTrackSettings & { restrictOwnAudio?: boolean }
type CaptureOptions = DisplayMediaStreamOptions & { systemAudio: "include" | "exclude" }

export function isolatedScreenCaptureOptions(video: MediaTrackConstraints, withAudio: boolean): CaptureOptions {
  const audio: AudioIsolationConstraints = { restrictOwnAudio: true, suppressLocalAudioPlayback: false }
  return { video, audio: withAudio ? audio : false, systemAudio: withAudio ? "include" : "exclude" }
}

export async function captureScreenWithIsolatedAudio(video: MediaTrackConstraints, withAudio: boolean): Promise<MediaStream> {
  const devices = navigator.mediaDevices
  if (typeof window !== "undefined" && window.voixexWindow?.platform === "win32" && window.electronVoice?.startScreenAudio) {
    // Windows PCM is captured by WASAPI in a dedicated helper, bypassing
    // Chromium's loopback implementation and its restrictOwnAudio support gate.
    const stream = await devices.getDisplayMedia(isolatedScreenCaptureOptions(video, false))
    // Never accept an unexpected Electron loopback track alongside native audio.
    for (const track of stream.getAudioTracks()) { track.stop(); stream.removeTrack(track) }
    if (withAudio) {
      try { await attachWindowsScreenAudio(stream) }
      catch (error) { console.warn("Native Windows screen audio unavailable", error) }
    }
    return stream
  }
  const supported = devices.getSupportedConstraints() as MediaTrackSupportedConstraints & { restrictOwnAudio?: boolean }
  // Older runtimes silently ignore unknown constraints and would recapture call audio.
  const platformSupported = typeof window === "undefined" || window.voixexWindow?.systemAudioExclusionSupported !== false
  const safeAudio = withAudio && platformSupported && supported.restrictOwnAudio === true
  let acceptedAudio = safeAudio
  let stream: MediaStream
  try {
    stream = await devices.getDisplayMedia(isolatedScreenCaptureOptions(video, safeAudio))
  } catch (error) {
    if (!safeAudio || (error instanceof DOMException && ["NotAllowedError", "AbortError", "InvalidStateError"].includes(error.name))) throw error
    // Capture the picture if isolated audio is unavailable; never retry unrestricted audio.
    acceptedAudio = false
    stream = await devices.getDisplayMedia(isolatedScreenCaptureOptions(video, false))
  }
  for (const track of stream.getAudioTracks()) {
    const settings = track.getSettings() as AudioIsolationSettings
    if (!acceptedAudio || track.readyState !== "live" || settings.restrictOwnAudio !== true) {
      track.stop()
      stream.removeTrack(track)
    }
  }
  return stream
}
