import {
  ConnectionState,
  LocalAudioTrack,
  LocalTrack,
  LocalVideoTrack,
  RemoteTrack,
  RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
  VideoQuality
} from "livekit-client"

export type WebRtcMediaToken = {
  url: string
  token: string
  roomName: string
}

/** Viewer-selected screen share quality: the publisher's original, or a smaller simulcast layer. */
export type ScreenViewQuality = "high" | "medium" | "low"

export type ScreenPublishOptions = {
  fps?: number
  bitrateKbps?: number
}

type WebRtcMediaOptions = {
  audioSink: HTMLElement
  /** When true, play remote microphone tracks via LiveKit (WebRTC voice path). */
  playRemoteVoice?: boolean
  onStatus?: (message: string) => void
  onRemoteVideo?: (active: boolean, participantIdentity: string | null) => void
  onScreenShareChange?: (active: boolean) => void
  onWatchingScreenChange?: (watching: boolean) => void
}

export class WebRtcMediaSession {
  private readonly opts: WebRtcMediaOptions
  private room: Room | null = null
  private screenTracks: LocalTrack[] = []
  private micTrack: LocalAudioTrack | null = null
  private remoteElements = new Map<string, HTMLMediaElement>()
  private voiceAudioElements = new Set<HTMLMediaElement>()
  private voiceAudioByIdentity = new Map<string, Set<HTMLMediaElement>>()
  private peerVoiceVolumeByIdentity = new Map<string, number>()
  private screenAudioElements = new Set<HTMLMediaElement>()
  private remoteScreenTrack: RemoteTrack | null = null
  private remoteScreenPublication: RemoteTrackPublication | null = null
  /** Identity of the participant whose screen track is subscribed. */
  private remoteScreenIdentity: string | null = null
  private screenViewQuality: ScreenViewQuality = "high"
  private remoteScreenVideoEl: HTMLVideoElement | null = null
  private remoteScreenPopupEl: HTMLVideoElement | null = null
  private screenAudioContainer: HTMLElement | null = null
  private playRemoteVoice: boolean
  private deafened = false
  private outputDeviceId: string | null = null

  constructor(opts: WebRtcMediaOptions) {
    this.opts = opts
    this.screenAudioContainer = opts.audioSink
    this.playRemoteVoice = Boolean(opts.playRemoteVoice)
  }

  get connected() {
    return Boolean(this.room)
  }

  /** True while the LiveKit room is usable or recovering by itself; false once it is gone for good. */
  get live() {
    const state = this.room?.state
    return state !== undefined && state !== ConnectionState.Disconnected
  }

  async connect(input: WebRtcMediaToken) {
    await this.disconnect()
    const room = new Room({
      // Fixed screen quality on LiveKit fallback; legacy WS/MSE is preferred for viewers.
      adaptiveStream: false,
      // The sharer stops encoding simulcast layers nobody is watching, saving its uplink.
      dynacast: true
    })
    room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        this.attachRemoteTrack(track, publication, participant.identity)
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        this.detachRemoteTrack(track, publication, participant.identity)
      })
      .on(RoomEvent.Disconnected, () => {
        this.cleanupRemoteTracks()
        this.opts.onStatus?.("WebRTC disconnected")
      })

    await room.connect(input.url, input.token, { autoSubscribe: true })
    this.room = room
    this.syncExistingRemoteTracks(room)
    this.opts.onStatus?.(`LiveKit connected: ${input.roomName}`)
  }

  setPlayRemoteVoice(play: boolean) {
    this.playRemoteVoice = play
    if (!play) {
      this.clearVoiceAudioElements()
      return
    }
    if (this.room) this.syncExistingRemoteTracks(this.room)
  }

  bindRemoteScreenVideo(el: HTMLVideoElement | null) {
    if (this.remoteScreenVideoEl && this.remoteScreenTrack) {
      this.remoteScreenTrack.detach(this.remoteScreenVideoEl)
    }
    this.remoteScreenVideoEl = el
    if (el && this.remoteScreenTrack) {
      this.remoteScreenTrack.attach(el)
      el.muted = true
      void el.play().catch(() => {})
    }
  }

  /** Who is sharing the currently subscribed screen track (stays subscribed while the viewer hides the stream). */
  get remoteScreenSharer(): string | null {
    return this.remoteScreenTrack ? this.remoteScreenIdentity : null
  }

  /** Re-attach an existing remote screen track (e.g. after rejoin or video element remount). */
  rebindRemoteScreenVideo(el: HTMLVideoElement | null) {
    if (el) this.remoteScreenVideoEl = el
    const target = this.remoteScreenVideoEl
    if (!target) return
    if (this.remoteScreenTrack) {
      this.remoteScreenTrack.detach(target)
      this.remoteScreenTrack.attach(target)
      target.muted = true
      void target.play().catch(() => {})
      this.syncPopupScreenVideo()
      return
    }
    if (this.room) this.syncExistingRemoteTracks(this.room)
  }

  bindPopupScreenVideo(el: HTMLVideoElement | null) {
    this.remoteScreenPopupEl = el
    this.syncPopupScreenVideo()
  }

  unbindPopupScreenVideo() {
    const el = this.remoteScreenPopupEl
    if (el) {
      const stream = el.srcObject
      if (stream instanceof MediaStream) {
        for (const track of stream.getTracks()) track.stop()
      }
      el.srcObject = null
    }
    this.remoteScreenPopupEl = null
  }

  private syncPopupScreenVideo() {
    const el = this.remoteScreenPopupEl
    if (!el) return
    if (!this.remoteScreenTrack) {
      el.srcObject = null
      return
    }
    const mt = this.remoteScreenTrack.mediaStreamTrack
    if (!mt || mt.readyState === "ended") {
      el.srcObject = null
      return
    }
    const prev = el.srcObject
    if (prev instanceof MediaStream) {
      for (const track of prev.getTracks()) track.stop()
    }
    const cloned = mt.clone()
    el.srcObject = new MediaStream([cloned])
    el.muted = true
    void el.play().catch(() => {})
  }

  relocateScreenAudio(container: HTMLElement | null) {
    this.screenAudioContainer = container ?? this.opts.audioSink
    for (const element of this.screenAudioElements) {
      if (element.parentElement !== this.screenAudioContainer) {
        element.remove()
        this.screenAudioContainer.appendChild(element)
      }
    }
    void this.applyOutputDeviceToElements()
  }

  async publishMicTrack(track: MediaStreamTrack) {
    const room = this.room
    if (!room) return
    await this.unpublishMic()
    this.micTrack = new LocalAudioTrack(track)
    await room.localParticipant.publishTrack(this.micTrack, {
      source: Track.Source.Microphone,
      dtx: false,
      red: true
    })
    if (this.deafened) await this.micTrack.mute()
  }

  async unpublishMic() {
    const room = this.room
    try {
      if (this.micTrack && room) {
        await room.localParticipant.unpublishTrack(this.micTrack)
      }
    } catch {
      // room already gone
    } finally {
      this.micTrack = null
    }
  }

  async setMuted(muted: boolean) {
    if (!this.micTrack) return
    if (muted) await this.micTrack.mute()
    else await this.micTrack.unmute()
  }

  async setDeafened(deafened: boolean) {
    this.deafened = deafened
    for (const element of this.voiceAudioElements) {
      element.muted = deafened
    }
    for (const element of this.screenAudioElements) {
      element.muted = deafened
    }
  }

  setScreenAudioVolume(volumePct: number) {
    const vol = Math.max(0, Math.min(1, volumePct / 100))
    for (const element of this.screenAudioElements) {
      try {
        element.volume = vol
      } catch {
        /* detached or invalid media element */
      }
    }
  }

  /** Per-participant voice volume for WebRTC path (0–200%, 100 = default). */
  setPeerVoiceVolume(participantIdentity: string, volumePct: number) {
    const pct = Math.max(0, Math.min(200, Math.round(volumePct)))
    const gain = pct / 100
    if (pct === 100) this.peerVoiceVolumeByIdentity.delete(participantIdentity)
    else this.peerVoiceVolumeByIdentity.set(participantIdentity, gain)
    this.applyPeerVoiceVolume(participantIdentity)
  }

  private applyPeerVoiceVolume(participantIdentity: string) {
    const gain = this.peerVoiceVolumeByIdentity.get(participantIdentity) ?? 1
    const vol = Math.min(1, gain)
    const elements = this.voiceAudioByIdentity.get(participantIdentity)
    if (!elements) return
    for (const element of elements) {
      element.volume = vol
    }
  }

  private trackVoiceElement(participantIdentity: string, element: HTMLMediaElement) {
    let bucket = this.voiceAudioByIdentity.get(participantIdentity)
    if (!bucket) {
      bucket = new Set()
      this.voiceAudioByIdentity.set(participantIdentity, bucket)
    }
    bucket.add(element)
    const gain = this.peerVoiceVolumeByIdentity.get(participantIdentity) ?? 1
    element.volume = Math.min(1, gain)
  }

  private untrackVoiceElement(participantIdentity: string, element: HTMLMediaElement) {
    const bucket = this.voiceAudioByIdentity.get(participantIdentity)
    if (!bucket) return
    bucket.delete(element)
    if (bucket.size === 0) this.voiceAudioByIdentity.delete(participantIdentity)
  }

  async setOutputDevice(deviceId: string | null) {
    this.outputDeviceId = deviceId
    await this.applyOutputDeviceToElements()
  }

  /**
   * video: the screen reached LiveKit (viewers can watch without the WS relay).
   * audio: the stream sound reached LiveKit (null when the capture has no audio track);
   * audioError says why it did not.
   */
  async publishScreenStream(
    stream: MediaStream,
    encoding?: ScreenPublishOptions
  ): Promise<{ video: boolean; audio: boolean | null; audioError?: string }> {
    const room = this.room
    if (!room || !this.live) return { video: false, audio: null }
    await this.stopScreenShare()
    const published: LocalTrack[] = []
    const video = stream.getVideoTracks()[0]
    if (video) {
      video.contentHint = "detail"
      const track = new LocalVideoTrack(video)
      const maxBitrate = Math.max(600_000, Math.min(10_000_000, (encoding?.bitrateKbps ?? 3500) * 1000))
      const maxFramerate = Math.max(8, Math.min(60, encoding?.fps ?? 30))
      // Smaller simulcast layers (lowest first, as LiveKit expects) let each viewer pick a lower
      // quality when the stream stutters; the top layer is the captured original.
      const settings = video.getSettings()
      const height = settings.height ?? 1080
      const width = settings.width ?? Math.round((height * 16) / 9)
      const layer = (targetHeight: number, bitrate: number, fps: number) =>
        new VideoPreset(Math.round((width * targetHeight) / height), targetHeight, Math.min(bitrate, maxBitrate), Math.min(fps, maxFramerate))
      const layers: VideoPreset[] = []
      if (height > 360) layers.push(layer(360, 500_000, 15))
      if (height > 720) layers.push(layer(720, 1_800_000, 30))
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.ScreenShare,
        simulcast: layers.length > 0,
        screenShareEncoding: {
          maxBitrate,
          maxFramerate
        },
        ...(layers.length > 0 ? { screenShareSimulcastLayers: layers } : {})
      })
      published.push(track)
    }
    // The stream sound is published separately: a failure here must not take the picture down.
    let audioOk: boolean | null = null
    let audioError: string | undefined
    const audio = stream.getAudioTracks()[0]
    if (audio) {
      audioOk = false
      // Some system-audio captures are rejected with RED/DTX: retry as plain Opus.
      for (const options of [{ source: Track.Source.ScreenShareAudio }, { source: Track.Source.ScreenShareAudio, red: false, dtx: false }]) {
        const track = new LocalAudioTrack(audio)
        try {
          await room.localParticipant.publishTrack(track, options)
          published.push(track)
          audioOk = true
          break
        } catch (e) {
          audioError = e instanceof Error ? e.message : String(e)
        }
      }
    }
    this.screenTracks = published
    this.opts.onScreenShareChange?.(true)
    return { video: Boolean(video), audio: audioOk, audioError }
  }

  /** Viewer side: which simulcast layer of the remote screen share to receive. */
  setScreenViewQuality(quality: ScreenViewQuality) {
    this.screenViewQuality = quality
    this.applyScreenViewQuality()
  }

  private applyScreenViewQuality() {
    const quality =
      this.screenViewQuality === "low" ? VideoQuality.LOW : this.screenViewQuality === "medium" ? VideoQuality.MEDIUM : VideoQuality.HIGH
    try {
      this.remoteScreenPublication?.setVideoQuality(quality)
    } catch {
      // publication already gone
    }
  }

  async stopScreenShare() {
    const room = this.room
    for (const track of this.screenTracks) {
      // A dead or kicked room makes unpublishTrack throw; the local track still has to be released.
      try {
        if (room) await room.localParticipant.unpublishTrack(track)
      } catch {
        // ignore
      }
      track.stop()
    }
    this.screenTracks = []
    this.opts.onScreenShareChange?.(false)
  }

  async disconnect() {
    // Each step is independent: a failing unpublish must not leave the room connected.
    try {
      await this.stopScreenShare()
    } catch {
      // ignore
    }
    try {
      await this.unpublishMic()
    } catch {
      // ignore
    }
    if (this.room) {
      try {
        this.room.disconnect()
      } catch {
        // ignore
      }
      this.room = null
    }
    this.cleanupRemoteTracks()
    this.opts.onWatchingScreenChange?.(false)
  }

  private async applyOutputDeviceToElements() {
    const sinkId = this.outputDeviceId
    if (!sinkId) return
    const setSink = (el: HTMLMediaElement) => {
      const withSink = el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }
      if (typeof withSink.setSinkId !== "function") return
      void withSink.setSinkId(sinkId).catch(() => {})
    }
    for (const element of this.voiceAudioElements) setSink(element)
    for (const element of this.screenAudioElements) setSink(element)
  }

  private clearVoiceAudioElements() {
    for (const element of this.voiceAudioElements) {
      element.remove()
    }
    this.voiceAudioElements.clear()
    this.voiceAudioByIdentity.clear()
  }

  private syncExistingRemoteTracks(room: Room) {
    for (const participant of room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (!publication.track || !publication.isSubscribed) continue
        this.attachRemoteTrack(publication.track, publication, participant.identity)
      }
    }
  }

  private remoteTrackKey(participantIdentity: string, track: RemoteTrack) {
    return `${participantIdentity}:${track.sid ?? "unknown"}`
  }

  private attachRemoteTrack(track: RemoteTrack, publication: RemoteTrackPublication, participantIdentity: string) {
    // Our own phone screen share (a separate participant "<identity>:screen") is not a remote stream.
    const self = this.room?.localParticipant.identity
    if (self && participantIdentity === `${self}:screen`) return
    const localIdentity = this.room?.localParticipant.identity
    if (localIdentity && participantIdentity === localIdentity) return

    if (track.kind === Track.Kind.Audio) {
      if (publication.source === Track.Source.Microphone) {
        if (!this.playRemoteVoice) return
        const element = track.attach() as HTMLMediaElement
        const key = this.remoteTrackKey(participantIdentity, track)
        this.remoteElements.set(key, element)
        this.voiceAudioElements.add(element)
        this.trackVoiceElement(participantIdentity, element)
        element.muted = this.deafened
        this.opts.audioSink.appendChild(element)
        void this.applyOutputDeviceToElements()
        void element.play?.().catch(() => {})
        return
      }
      if (publication.source !== Track.Source.ScreenShareAudio) return
      const element = track.attach() as HTMLMediaElement
      const key = this.remoteTrackKey(participantIdentity, track)
      this.remoteElements.set(key, element)
      this.screenAudioElements.add(element)
      element.muted = this.deafened
      const container = this.screenAudioContainer ?? this.opts.audioSink
      container.appendChild(element)
      void this.applyOutputDeviceToElements()
      void element.play?.().catch(() => {})
      return
    }
    if (track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) return

    if (this.remoteScreenTrack && this.remoteScreenVideoEl) {
      this.remoteScreenTrack.detach(this.remoteScreenVideoEl)
    }
    this.remoteScreenTrack = track
    this.remoteScreenPublication = publication
    this.remoteScreenIdentity = participantIdentity
    this.applyScreenViewQuality()
    this.opts.onWatchingScreenChange?.(true)
    this.opts.onRemoteVideo?.(true, participantIdentity)
    if (this.remoteScreenVideoEl) {
      track.attach(this.remoteScreenVideoEl)
      this.remoteScreenVideoEl.muted = true
      void this.remoteScreenVideoEl.play().catch(() => {})
    }
    this.syncPopupScreenVideo()
  }

  private detachRemoteTrack(track: RemoteTrack, publication: RemoteTrackPublication, participantIdentity: string) {
    const key = this.remoteTrackKey(participantIdentity, track)
    const element = this.remoteElements.get(key)
    if (element) {
      track.detach(element)
      element.remove()
      this.remoteElements.delete(key)
      this.voiceAudioElements.delete(element)
      this.untrackVoiceElement(participantIdentity, element)
      this.screenAudioElements.delete(element)
    }
    if (track.kind === Track.Kind.Video && publication.source === Track.Source.ScreenShare) {
      if (this.remoteScreenTrack === track) {
        if (this.remoteScreenVideoEl) track.detach(this.remoteScreenVideoEl)
        this.unbindPopupScreenVideo()
        this.remoteScreenTrack = null
        this.remoteScreenPublication = null
      }
      this.opts.onWatchingScreenChange?.(false)
      this.opts.onRemoteVideo?.(false, null)
    }
  }

  private cleanupRemoteTracks() {
    if (this.remoteScreenTrack && this.remoteScreenVideoEl) {
      this.remoteScreenTrack.detach(this.remoteScreenVideoEl)
    }
    this.unbindPopupScreenVideo()
    this.remoteScreenTrack = null
    this.remoteScreenPublication = null
    this.remoteScreenVideoEl = null
    this.clearVoiceAudioElements()
    for (const element of this.remoteElements.values()) {
      element.remove()
    }
    this.remoteElements.clear()
    this.screenAudioElements.clear()
    this.voiceAudioByIdentity.clear()
    this.screenAudioContainer = this.opts.audioSink
    this.opts.onWatchingScreenChange?.(false)
    this.opts.onRemoteVideo?.(false, null)
  }
}
