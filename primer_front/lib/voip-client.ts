"use client"

import type { ChannelCategory, VoiceUser } from "@/components/voip/channel-sidebar"

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:18080"

export type JoinResult = {
  serverId: string
  serverName?: string
  bannerUrl?: string | null
  authToken: string
  mediaToken: string
  profile: { clientId: string; displayName: string }
  udp: { host: string; port: number }
}

export type SfuTokenResult = {
  enabled: true
  url: string
  token: string
  roomName: string
  expiresInSec: number
}

export type MediaEngineMode = "legacy" | "webrtc"

export type RosterMember = {
  clientId: string
  displayName: string
  muted: boolean
  deafened: boolean
  speaking: boolean
  screenSharing?: boolean
  watchingScreen?: boolean
  mediaEngine?: MediaEngineMode
}

export type RealtimeState = {
  rooms: Array<{ id: string; name: string; kind: "voice" | "text" }>
  rosterByRoom: Record<string, RosterMember[]>
  lobby: RosterMember[]
  messagesByChannel: Record<string, ChatMessage[]>
  activeScreenShareByRoom: Record<string, string | null>
  serverBannerUrl: string | null
  me: {
    clientId: string
    displayName: string
    roles?: Array<{ id: string; key: string; name: string }>
    permissions?: {
      manage_server: boolean
      manage_channels: boolean
      manage_roles: boolean
      manage_chat: boolean
    }
  } | null
  connection: { wsConnected: boolean; reconnecting: boolean }
}

export type ChatMessage = {
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

/** Parse server time: ISO with Z, or legacy SQLite "YYYY-MM-DD HH:MM:SS" (UTC). Avoids local-vs-UTC sort bugs. */
function parseMessageTimeMs(createdAt: string): number {
  if (!createdAt) return 0
  const direct = Date.parse(createdAt)
  if (!Number.isNaN(direct)) return direct
  const m = createdAt.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (m) return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`)
  return 0
}

function normalizeCreatedAt(raw: string): string {
  if (!raw) return raw
  if (raw.includes("T")) return raw
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`
  return raw
}

function compareMessagesByTime(a: ChatMessage, b: ChatMessage) {
  const ta = parseMessageTimeMs(a.createdAt)
  const tb = parseMessageTimeMs(b.createdAt)
  if (ta !== tb) return ta - tb
  return a.id.localeCompare(b.id)
}

function compareRosterMembersByName(a: RosterMember, b: RosterMember) {
  const byName = a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "base" })
  if (byName !== 0) return byName
  return a.clientId.localeCompare(b.clientId)
}

function ensureValidClientId(clientId: string): string {
  const normalized = clientId.trim()
  if (normalized.length >= 3) return normalized
  try {
    return crypto.randomUUID()
  } catch {
    return `client-${Math.random().toString(36).slice(2, 10)}`
  }
}

export class VoipClient {
  private apiBase: string = DEFAULT_API_BASE
  private ws: WebSocket | null = null
  private authToken: string | null = null
  private mediaToken: string | null = null
  private listeners = new Set<(s: RealtimeState) => void>()
  private state: RealtimeState = {
    rooms: [],
    rosterByRoom: {},
    lobby: [],
    messagesByChannel: {},
    activeScreenShareByRoom: {},
    serverBannerUrl: null,
    me: null,
    connection: { wsConnected: false, reconnecting: false }
  }
  private currentServerId: string | null = null
  /** Resolved host/port + media token for desktop UDP (after last joinServer). */
  private electronVoiceParams: { host: string; port: number; mediaToken: string } | null = null
  private pendingWsMessages: string[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private lastServerGeneration: number | null = null
  private screenChunkListeners = new Set<(fromClientId: string, chunkBase64: string) => void>()
  private screenResyncListeners = new Set<(roomId: string) => void>()
  
  setApiBase(url: string) {
    this.apiBase = url.replace(/\/+$/, "")
  }

  async createServer(name: string, password: string) {
    const res = await fetch(`${this.apiBase}/v1/servers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, password })
    })
    if (!res.ok) throw new Error("create server failed")
    return res.json() as Promise<{ id: string; name: string }>
  }

  async joinServer(password: string, clientId: string, displayName: string, superuserPassword?: string): Promise<JoinResult> {
    const safeClientId = ensureValidClientId(clientId)
    const res = await fetch(`${this.apiBase}/v1/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, clientId: safeClientId, displayName, superuserPassword })
    })
    if (!res.ok) {
      let details = `join server failed (${res.status})`
      try {
        const payload = (await res.json()) as { message?: unknown; error?: unknown }
        const message =
          typeof payload.message === "string"
            ? payload.message
            : typeof payload.error === "string"
              ? payload.error
              : ""
        if (message) details = `${details}: ${message}`
      } catch {
        /* ignore non-JSON payload */
      }
      throw new Error(details)
    }
    const out = (await res.json()) as JoinResult
    this.authToken = out.authToken
    this.mediaToken = out.mediaToken
    this.currentServerId = out.serverId
    this.state.me = out.profile
    if (out.bannerUrl !== undefined) {
      this.state.serverBannerUrl = out.bannerUrl?.trim() || null
    }
    let apiHostname = "localhost"
    try {
      apiHostname = new URL(this.apiBase).hostname
    } catch {
      /* keep default */
    }
    const voiceHost = out.udp.host === "backend" ? apiHostname : out.udp.host
    this.electronVoiceParams = { host: voiceHost, port: out.udp.port, mediaToken: out.mediaToken }
    return out
  }

  async createRoom(serverId: string, name: string, kind: "voice" | "text") {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/rooms`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name, kind })
    })
    if (!res.ok) throw new Error("create room failed")
    return res.json() as Promise<{ id: string; name: string; kind: "voice" | "text" }>
  }

  async getRooms(serverId: string) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/rooms`, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw new Error("rooms load failed")
    const body = (await res.json()) as { rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
    this.state.rooms = body.rooms
    this.emit()
    return body.rooms
  }

  async getSfuToken(serverId: string, roomId: string): Promise<SfuTokenResult> {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/rooms/${roomId}/sfu-token`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) {
      let details = `SFU token failed (${res.status})`
      try {
        const payload = (await res.json()) as { message?: unknown }
        if (typeof payload.message === "string") details = `${details}: ${payload.message}`
      } catch {
        /* ignore non-JSON payload */
      }
      throw new Error(details)
    }
    return res.json() as Promise<SfuTokenResult>
  }

  async getServer(serverId: string) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}`, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw new Error("server load failed")
    const body = (await res.json()) as { id: string; name: string; bannerUrl?: string | null }
    if (body.bannerUrl !== undefined) {
      this.state.serverBannerUrl = body.bannerUrl?.trim() || null
      this.emit()
    }
    return body
  }

  async updateServerBanner(serverId: string, bannerUrl: string | null) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bannerUrl })
    })
    if (!res.ok) throw new Error("server banner update failed")
    const body = (await res.json()) as { bannerUrl: string | null }
    this.state.serverBannerUrl = body.bannerUrl?.trim() || null
    this.emit()
    return body
  }

  async getMe(serverId: string) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/me`, { headers: { Authorization: `Bearer ${this.authToken}` } })
    if (!res.ok) throw new Error("profile load failed")
    const me = (await res.json()) as RealtimeState["me"] & { clientId: string; displayName: string }
    this.state.me = me
    this.emit()
    return me
  }

  async updateProfile(serverId: string, displayName: string) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/me`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayName })
    })
    if (!res.ok) throw new Error("profile update failed")
    if (this.state.me) this.state.me.displayName = displayName
    this.emit()
    this.sendWsEvent({ type: "set_profile", displayName })
  }

  async getMessages(serverId: string, channelId: string, limit = 50, cursor?: string) {
    if (!this.authToken) throw new Error("not authorized")
    const url = new URL(`${this.apiBase}/v1/servers/${serverId}/channels/${channelId}/messages`)
    url.searchParams.set("limit", String(limit))
    if (cursor) url.searchParams.set("cursor", cursor)
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${this.authToken}` } })
    if (!res.ok) throw new Error("messages load failed")
    const body = (await res.json()) as { messages: ChatMessage[]; nextCursor: string | null }
    this.state.messagesByChannel[channelId] = body.messages.map((m) => this.normalizeMessage(m)).sort(compareMessagesByTime)
    this.emit()
    return body
  }

  async sendMessage(serverId: string, channelId: string, body: string, attachmentIds?: string[]) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.authToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body, attachmentIds: attachmentIds ?? [] })
    })
    if (!res.ok) throw new Error("send message failed")
    const payload = (await res.json()) as { message: ChatMessage }
    return payload.message
  }

  async uploadAttachment(serverId: string, channelId: string, file: File) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/channels/${channelId}/attachments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.authToken}`,
        "x-file-name": file.name,
        "x-file-mime": file.type || "application/octet-stream"
      },
      body: file
    })
    if (!res.ok) throw new Error("attachment upload failed")
    return (await res.json()) as {
      attachment: { id: string; name: string; mime: string; sizeBytes: number; url: string }
    }
  }

  /** Close WebSocket, clear auth, stop auto-reconnect. Call when leaving a server from the client UI. */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.stopPing()
    const socket = this.ws
    if (socket) {
      socket.onclose = null
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.authToken = null
    this.mediaToken = null
    this.currentServerId = null
    this.electronVoiceParams = null
    this.pendingWsMessages = []
    this.lastServerGeneration = null
    this.state = {
      rooms: [],
      rosterByRoom: {},
      lobby: [],
      messagesByChannel: {},
      activeScreenShareByRoom: {},
      serverBannerUrl: null,
      me: null,
      connection: { wsConnected: false, reconnecting: false }
    }
    this.emit()
  }

  connectWs() {
    if (!this.authToken) throw new Error("not authorized")
    // Always replace the socket when (re)connecting: after a new /v1/join the token changes; keeping an
    // OPEN socket would skip opening WSS with the new token and leave the old session (broken UI / "can't connect").
    const existing = this.ws
    if (existing) {
      existing.onclose = null
      try {
        existing.close()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    const url = new URL(`${this.apiBase}/v1/ws`)
    url.searchParams.set("token", this.authToken)
    const wsUrl = url.toString().replace("http://", "ws://").replace("https://", "wss://")
    this.ws = new WebSocket(wsUrl)
    this.ws.binaryType = "arraybuffer"
    this.ws.onopen = () => {
      this.state.connection = { wsConnected: true, reconnecting: false }
      this.emit()
      for (const message of this.pendingWsMessages) {
        this.ws?.send(message)
      }
      this.pendingWsMessages = []
      this.startPing()
    }
    this.ws.onmessage = (event) => {
      const raw = String(event.data)
      let data: Record<string, unknown>
      try {
        data = JSON.parse(raw) as Record<string, unknown>
      } catch {
        return
      }
      if (data.type === "screen_chunk") {
        const fromClientId = data.fromClientId as string
        const chunkBase64 = data.chunkBase64 as string
        if (typeof fromClientId !== "string" || typeof chunkBase64 !== "string") return
        for (const cb of this.screenChunkListeners) {
          try {
            cb(fromClientId, chunkBase64)
          } catch {
            /* ignore */
          }
        }
        return
      }
      if (data.type === "screen_share_resync_request") {
        const roomId = data.roomId as string
        if (typeof roomId !== "string") return
        for (const cb of this.screenResyncListeners) {
          try {
            cb(roomId)
          } catch {
            /* ignore */
          }
        }
        return
      }
      const typed = data as
        | { type: "hello"; clientId: string; serverId: string; serverGeneration?: number; bannerUrl?: string | null }
        | { type: "server_appearance_updated"; bannerUrl: string | null }
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
        | { type: "chat_message"; message: ChatMessage }
        | { type: "screen_share_state"; clientId: string; roomId: string | null; active: boolean }
      if (typed.type === "hello") {
        if (typeof typed.serverGeneration === "number") {
          this.lastServerGeneration = typed.serverGeneration
        }
        if (typed.bannerUrl !== undefined) {
          this.state.serverBannerUrl = typed.bannerUrl?.trim() || null
        }
      } else if (typed.type === "server_appearance_updated") {
        this.state.serverBannerUrl = typed.bannerUrl?.trim() || null
      } else if (typed.type === "rooms_snapshot") {
        this.state.rooms = typed.rooms
      } else if (typed.type === "rooms_updated") {
        this.state.rooms = typed.rooms
      } else if (typed.type === "roster_snapshot") {
        if (typed.roomId) {
          this.state.rosterByRoom[typed.roomId] = [...typed.members].sort(compareRosterMembersByName)
        } else {
          this.state.lobby = [...typed.members].sort(compareRosterMembersByName)
        }
      } else if (typed.type === "presence_snapshot") {
        const rosters: Record<string, RosterMember[]> = {}
        for (const [roomId, members] of Object.entries(typed.rosters)) {
          rosters[roomId] = [...members].sort(compareRosterMembersByName)
        }
        this.state.rosterByRoom = rosters
        this.state.lobby = [...typed.lobby].sort(compareRosterMembersByName)
        this.state.activeScreenShareByRoom = { ...typed.screenByRoom }
      } else if (typed.type === "member_updated") {
        for (const roomId of Object.keys(this.state.rosterByRoom)) {
          this.state.rosterByRoom[roomId] = this.state.rosterByRoom[roomId].filter((m) => m.clientId !== typed.member.clientId)
        }
        this.state.lobby = this.state.lobby.filter((m) => m.clientId !== typed.member.clientId)
        const member: RosterMember = {
          clientId: typed.member.clientId,
          displayName: typed.member.displayName,
          muted: typed.member.muted,
          deafened: typed.member.deafened,
          speaking: typed.member.speaking,
          screenSharing: typed.member.screenSharing,
          watchingScreen: typed.member.watchingScreen,
          mediaEngine: typed.member.mediaEngine === "webrtc" ? "webrtc" : "legacy"
        }
        if (typed.member.roomId) {
          const next = this.state.rosterByRoom[typed.member.roomId] ?? []
          this.state.rosterByRoom[typed.member.roomId] = [...next, member].sort(compareRosterMembersByName)
        } else {
          this.state.lobby = [...this.state.lobby, member].sort(compareRosterMembersByName)
        }
      } else if (typed.type === "chat_message") {
        const channel = typed.message.channelId
        const existing = this.state.messagesByChannel[channel] ?? []
        this.state.messagesByChannel[channel] = [...existing, this.normalizeMessage(typed.message)]
          .sort(compareMessagesByTime)
          .slice(-200)
      } else if (typed.type === "screen_share_state") {
        if (typed.active && typed.roomId) {
          this.state.activeScreenShareByRoom[typed.roomId] = typed.clientId
        } else if (!typed.active) {
          if (typed.roomId) {
            if (this.state.activeScreenShareByRoom[typed.roomId] === typed.clientId) {
              this.state.activeScreenShareByRoom[typed.roomId] = null
            }
          } else {
            for (const rid of Object.keys(this.state.activeScreenShareByRoom)) {
              if (this.state.activeScreenShareByRoom[rid] === typed.clientId) {
                this.state.activeScreenShareByRoom[rid] = null
              }
            }
          }
        }
      }
      this.emit()
    }
    this.ws.onclose = () => {
      this.ws = null
      this.stopPing()
      this.state.connection = { wsConnected: false, reconnecting: true }
      this.emit()
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
      this.reconnectTimer = setTimeout(() => this.connectWs(), 1500)
    }
  }

  subscribe(cb: (s: RealtimeState) => void) {
    this.listeners.add(cb)
    cb(this.state)
    return () => this.listeners.delete(cb)
  }

  private emit() {
    for (const cb of this.listeners) cb(this.state)
  }

  joinRoom(roomId: string) {
    this.sendWsEvent({ type: "join_room", roomId })
  }

  leaveRoom() {
    this.sendWsEvent({ type: "leave_room" })
  }

  syncPresence(input: {
    roomId: string | null
    muted: boolean
    deafened: boolean
    screenSharing: boolean
    watchingScreen: boolean
    mediaEngine?: MediaEngineMode
  }) {
    this.sendWsEvent({ type: "sync_presence", ...input })
  }

  setWatchingScreen(watching: boolean, roomId?: string) {
    this.sendWsEvent({ type: "set_watching_screen", watching, roomId })
  }

  setMute(muted: boolean) {
    this.sendWsEvent({ type: "set_mute", muted })
  }

  setDeafen(deafened: boolean) {
    this.sendWsEvent({ type: "set_deafen", deafened })
  }

  /** Per-listener volume for another participant in the same voice room (0–200, 100 = default). */
  setPeerVolume(roomId: string, targetClientId: string, volumePct: number) {
    this.sendWsEvent({ type: "set_peer_volume", roomId, targetClientId, volumePct })
  }

  setScreenShare(active: boolean) {
    this.sendWsEvent({ type: "set_screen_share", active })
  }

  /** Ask server to signal the active sharer in this voice room (MSE needs a fresh WebM header). */
  requestScreenResync(roomId: string) {
    this.sendWsEvent({ type: "request_screen_resync", roomId })
  }

  /** Reliable screen: one MediaRecorder blob per message (TCP/WebSocket). */
  sendScreenVideoChunk(chunkBase64: string) {
    this.sendWsEvent({ type: "screen_chunk", chunkBase64 })
  }

  subscribeScreenVideoChunks(cb: (fromClientId: string, chunkBase64: string) => void) {
    this.screenChunkListeners.add(cb)
    return () => {
      this.screenChunkListeners.delete(cb)
    }
  }

  /** Only the active screen sharer receives this (server targets their socket). */
  subscribeScreenResyncRequests(cb: (roomId: string) => void) {
    this.screenResyncListeners.add(cb)
    return () => {
      this.screenResyncListeners.delete(cb)
    }
  }

  toSidebarCategories(): ChannelCategory[] {
    const textChannels = this.state.rooms.filter((room) => room.kind === "text")
    const voiceChannels = this.state.rooms.filter((room) => room.kind === "voice")
    return [
      { id: "text", name: "Text", channels: textChannels.map((room) => ({ id: room.id, name: room.name, type: "text" as const })) },
      { id: "voice", name: "Voice", channels: voiceChannels.map((room) => ({ id: room.id, name: room.name, type: "voice" as const })) }
    ]
  }

  toVoiceUsers(): Record<string, VoiceUser[]> {
    const out: Record<string, VoiceUser[]> = {}
    for (const [roomId, users] of Object.entries(this.state.rosterByRoom)) {
      out[roomId] = [...users]
        .sort(compareRosterMembersByName)
        .map((u) => ({
        id: u.clientId,
        name: u.displayName,
        avatar: u.displayName.slice(0, 1).toUpperCase(),
        isMuted: u.muted,
        isDeafened: u.deafened,
        isSpeaking: u.speaking,
        isScreenSharing: u.screenSharing,
        isWatchingScreen: u.watchingScreen
      }))
    }
    return out
  }

  getMediaToken() {
    return this.mediaToken
  }

  getElectronVoiceConnectParams() {
    return this.electronVoiceParams
  }

  getCurrentServerId() {
    return this.currentServerId
  }

  getMeState() {
    return this.state.me
  }

  getMessagesState(channelId: string) {
    return this.state.messagesByChannel[channelId] ?? []
  }

  async healthcheck() {
    let res: Response
    try {
      res = await fetch(`${this.apiBase}/health`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/failed to fetch|networkerror|load failed/i.test(msg)) {
        throw new Error(
          "Cannot reach API. Check host/port (HTTPS often uses 443 or your nginx port, not plain HTTP), firewall, and TLS. " +
            "Self-signed HTTPS: use the latest desktop build (trusts custom certs) or open the API URL in the browser once and accept the certificate."
        )
      }
      throw e
    }
    if (!res.ok) throw new Error("server unavailable")
    return res.json() as Promise<{ ok: boolean }>
  }

  private sendWsEvent(payload: object) {
    const message = JSON.stringify(payload)
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message)
      return
    }
    this.pendingWsMessages.push(message)
  }

  private startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      this.sendWsEvent({ type: "ping", ts: Date.now() })
    }, 15_000)
  }

  private stopPing() {
    if (!this.pingTimer) return
    clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private normalizeMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
      createdAt: normalizeCreatedAt(message.createdAt),
      attachments: (message.attachments ?? []).map((attachment) => ({
        ...attachment,
        url: this.normalizeAttachmentUrl(attachment.url)
      }))
    }
  }

  private normalizeAttachmentUrl(url: string): string {
    if (url.startsWith("http://") || url.startsWith("https://")) return url
    if (url.startsWith("/")) return `${this.apiBase}${url}`
    return `${this.apiBase}/${url}`
  }
}
