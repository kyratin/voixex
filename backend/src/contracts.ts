export type MediaEngineMode = "legacy" | "webrtc"

export type RosterMember = {
  clientId: string
  displayName: string
  muted: boolean
  deafened: boolean
  speaking: boolean
  screenSharing?: boolean
  watchingScreen?: boolean
  /** Client voice/screen transport preference (server is source of truth). */
  mediaEngine?: MediaEngineMode
}

export type WsClientEvent =
  | { type: "join_room"; roomId: string }
  | { type: "leave_room" }
  /** Per-listener volume for another participant in the same voice room (0–200, 100 = default). */
  | { type: "set_peer_volume"; roomId: string; targetClientId: string; volumePct: number }
  | { type: "set_mute"; muted: boolean }
  | { type: "set_deafen"; deafened: boolean }
  | { type: "set_profile"; displayName: string }
  | { type: "set_screen_share"; active: boolean }
  | {
      type: "sync_presence"
      roomId: string | null
      muted: boolean
      deafened: boolean
      screenSharing: boolean
      watchingScreen: boolean
      mediaEngine?: MediaEngineMode
    }
  | { type: "set_watching_screen"; watching: boolean; roomId?: string }
  /** Viewer watching a lower-quality LiveKit layer: stop relaying WS screen chunks to this socket. */
  | { type: "set_screen_relay"; enabled: boolean }
  /** One MediaRecorder WebM blob, base64 (reliable path; avoids UDP packet loss). */
  | { type: "screen_chunk"; chunkBase64: string }
  /** Viewer asks server to nudge the active sharer (fresh WebM header for MSE). */
  /** fallback: the viewer needs the WebSocket stream (no LiveKit video); old clients omit it. */
  | { type: "request_screen_resync"; roomId: string; fallback?: boolean }
  | { type: "ping"; ts: number }

export type WsServerEvent =
  | { type: "hello"; clientId: string; serverId: string; serverGeneration: number; bannerUrl?: string | null }
  | { type: "server_appearance_updated"; bannerUrl: string | null }
  | { type: "members_changed"; clientId?: string }
  /** ~10 Hz while someone in the room talks: loudness 0..1 per speaking member (UI rings). */
  | { type: "voice_levels"; roomId: string; levels: Record<string, number> }
  | { type: "rooms_snapshot"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
  | { type: "rooms_updated"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
  | { type: "roster_snapshot"; roomId: string | null; members: RosterMember[] }
  | {
      type: "presence_snapshot"
      rosters: Record<string, RosterMember[]>
      lobby: RosterMember[]
      screenByRoom: Record<string, string | null>
    }
  | {
      type: "member_updated"
      member: RosterMember & { roomId: string | null }
    }
  | {
      type: "chat_history_snapshot"
      channelId: string
      messages: Array<{
        id: string
        channelId: string
        author: { clientId: string; displayName: string }
        body: string
        createdAt: string
        attachments?: Array<{
          id: string
          name: string
          mime: string
          sizeBytes: number
          url: string
        }>
      }>
      nextCursor: string | null
    }
  | {
      type: "chat_message"
      message: {
        id: string
        channelId: string
        author: { clientId: string; displayName: string }
        body: string
        createdAt: string
        attachments?: Array<{
          id: string
          name: string
          mime: string
          sizeBytes: number
          url: string
        }>
      }
    }
  | { type: "screen_share_state"; clientId: string; roomId: string | null; active: boolean }
  /** Tells the active sharer to restart encoding so late joiners get a fresh WebM header (MSE). */
  /**
   * fallback=false: someone joined (refresh the WebM header if the WS stream runs);
   * fallback=true: a viewer cannot get LiveKit video, so the WS stream must run.
   */
  | { type: "screen_share_resync_request"; roomId: string; fallback: boolean }
  | { type: "screen_chunk"; fromClientId: string; chunkBase64: string }
  | { type: "pong"; ts: number }
  | { type: "error"; message: string }

export const MEDIA_MAGIC = Buffer.from([0x56, 0x50, 0x01])
