import {
  createLocalAudioTrack,
  createLocalScreenTracks,
  LocalAudioTrack,
  LocalTrack,
  RemoteTrack,
  Room,
  RoomEvent,
  Track
} from "livekit-client"

export type WebRtcMediaToken = {
  url: string
  token: string
  roomName: string
}

type WebRtcMediaOptions = {
  audioSink: HTMLElement
  onStatus?: (message: string) => void
  onRemoteVideo?: (stream: MediaStream | null, participantIdentity: string | null) => void
  onMutedChange?: (muted: boolean) => void
  onScreenShareChange?: (active: boolean) => void
  onWatchingScreenChange?: (watching: boolean) => void
}

export class WebRtcMediaSession {
  private readonly opts: WebRtcMediaOptions
  private room: Room | null = null
  private micTrack: LocalAudioTrack | null = null
  private screenTracks: LocalTrack[] = []
  private remoteElements = new Map<string, HTMLMediaElement>()

  constructor(opts: WebRtcMediaOptions) {
    this.opts = opts
  }

  get connected() {
    return Boolean(this.room)
  }

  async connect(input: WebRtcMediaToken) {
    await this.disconnect()
    const room = new Room({
      adaptiveStream: true,
      dynacast: true
    })
    room
      .on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
        this.attachRemoteTrack(track, participant.identity)
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
        this.detachRemoteTrack(track, participant.identity)
      })
      .on(RoomEvent.Disconnected, () => {
        this.cleanupRemoteTracks()
        this.opts.onStatus?.("WebRTC disconnected")
      })

    await room.connect(input.url, input.token, { autoSubscribe: true })
    this.room = room
    this.opts.onStatus?.(`WebRTC connected: ${input.roomName}`)
  }

  async publishMicrophone(enabled: boolean) {
    const room = this.room
    if (!room) return
    if (!enabled) {
      if (this.micTrack) {
        await room.localParticipant.unpublishTrack(this.micTrack)
        this.micTrack.stop()
        this.micTrack = null
      }
      return
    }
    if (this.micTrack) return
    this.micTrack = await createLocalAudioTrack({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      channelCount: 1
    })
    await room.localParticipant.publishTrack(this.micTrack, {
      source: Track.Source.Microphone,
      dtx: false,
      red: true
    })
  }

  async setMuted(muted: boolean) {
    if (this.micTrack) {
      if (muted) {
        await this.micTrack.mute()
      } else {
        await this.micTrack.unmute()
      }
    }
    this.opts.onMutedChange?.(muted)
  }

  async startScreenShare() {
    const room = this.room
    if (!room || this.screenTracks.length > 0) return
    const tracks = await createLocalScreenTracks({
      audio: true,
      video: true
    })
    this.screenTracks = tracks
    for (const track of tracks) {
      await room.localParticipant.publishTrack(track, {
        source: track.kind === Track.Kind.Video ? Track.Source.ScreenShare : Track.Source.ScreenShareAudio
      })
    }
    this.opts.onScreenShareChange?.(true)
  }

  async stopScreenShare() {
    const room = this.room
    for (const track of this.screenTracks) {
      if (room) await room.localParticipant.unpublishTrack(track)
      track.stop()
    }
    this.screenTracks = []
    this.opts.onScreenShareChange?.(false)
  }

  async disconnect() {
    await this.stopScreenShare()
    if (this.micTrack) {
      this.micTrack.stop()
      this.micTrack = null
    }
    if (this.room) {
      this.room.disconnect()
      this.room = null
    }
    this.cleanupRemoteTracks()
    this.opts.onWatchingScreenChange?.(false)
  }

  private attachRemoteTrack(track: RemoteTrack, participantIdentity: string) {
    const element = track.attach()
    const key = `${participantIdentity}:${track.sid ?? Math.random().toString(36).slice(2)}`
    this.remoteElements.set(key, element)
    if (track.kind === Track.Kind.Audio) {
      element.setAttribute("data-voixex-webrtc-audio", participantIdentity)
      this.opts.audioSink.appendChild(element)
      void element.play?.().catch(() => {})
      return
    }
    if (track.kind === Track.Kind.Video) {
      const stream = (element as HTMLMediaElement).srcObject instanceof MediaStream
        ? ((element as HTMLMediaElement).srcObject as MediaStream)
        : null
      this.opts.onWatchingScreenChange?.(true)
      this.opts.onRemoteVideo?.(stream, participantIdentity)
    }
  }

  private detachRemoteTrack(track: RemoteTrack, participantIdentity: string) {
    for (const [key, element] of this.remoteElements.entries()) {
      if (!key.startsWith(`${participantIdentity}:`)) continue
      track.detach(element)
      element.remove()
      this.remoteElements.delete(key)
    }
    if (track.kind === Track.Kind.Video) {
      this.opts.onWatchingScreenChange?.(false)
      this.opts.onRemoteVideo?.(null, null)
    }
  }

  private cleanupRemoteTracks() {
    for (const element of this.remoteElements.values()) {
      element.remove()
    }
    this.remoteElements.clear()
    this.opts.onWatchingScreenChange?.(false)
    this.opts.onRemoteVideo?.(null, null)
  }
}
