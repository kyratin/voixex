"use client"

import type { ChannelCategory, VoiceUser } from "@/components/voip/channel-sidebar"

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:18080"

export type JoinResult = {
  serverId: string
  serverName?: string
  authToken: string
  mediaToken: string
  profile: { clientId: string; displayName: string }
  udp: { host: string; port: number }
}

export type RosterMember = {
  clientId: string
  displayName: string
  muted: boolean
  deafened: boolean
  speaking: boolean
}

export type RealtimeState = {
  rooms: Array<{ id: string; name: string; kind: "voice" | "text" }>
  rosterByRoom: Record<string, RosterMember[]>
  lobby: RosterMember[]
  messagesByChannel: Record<string, ChatMessage[]>
  activeScreenShareByRoom: Record<string, string | null>
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
    me: null,
    connection: { wsConnected: false, reconnecting: false }
  }
  private currentServerId: string | null = null
  private pendingWsMessages: string[] = []
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
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
    const res = await fetch(`${this.apiBase}/v1/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password, clientId, displayName, superuserPassword })
    })
    if (!res.ok) throw new Error("join server failed")
    const out = (await res.json()) as JoinResult
    this.authToken = out.authToken
    this.mediaToken = out.mediaToken
    this.currentServerId = out.serverId
    this.state.me = out.profile
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
    this.state.messagesByChannel[channelId] = body.messages.map((m) => this.normalizeMessage(m))
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
    this.pendingWsMessages = []
    this.state = {
      rooms: [],
      rosterByRoom: {},
      lobby: [],
      messagesByChannel: {},
      activeScreenShareByRoom: {},
      me: null,
      connection: { wsConnected: false, reconnecting: false }
    }
    this.emit()
  }

  connectWs() {
    if (!this.authToken) throw new Error("not authorized")
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
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
        | { type: "rooms_snapshot"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
        | { type: "rooms_updated"; rooms: Array<{ id: string; name: string; kind: "voice" | "text" }> }
        | { type: "roster_snapshot"; roomId: string | null; members: RosterMember[] }
        | {
            type: "member_updated"
            member: { clientId: string; displayName: string; roomId: string | null; muted: boolean; deafened: boolean; speaking: boolean }
          }
        | { type: "chat_message"; message: ChatMessage }
        | { type: "screen_share_state"; clientId: string; roomId: string | null; active: boolean }
      if (typed.type === "rooms_snapshot") {
        this.state.rooms = typed.rooms
      } else if (typed.type === "rooms_updated") {
        this.state.rooms = typed.rooms
      } else if (typed.type === "roster_snapshot") {
        if (typed.roomId) this.state.rosterByRoom[typed.roomId] = typed.members
        else this.state.lobby = typed.members
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
          speaking: typed.member.speaking
        }
        if (typed.member.roomId) {
          const next = this.state.rosterByRoom[typed.member.roomId] ?? []
          this.state.rosterByRoom[typed.member.roomId] = [...next, member]
        } else {
          this.state.lobby = [...this.state.lobby, member]
        }
      } else if (typed.type === "chat_message") {
        const channel = typed.message.channelId
        const existing = this.state.messagesByChannel[channel] ?? []
        this.state.messagesByChannel[channel] = [...existing, this.normalizeMessage(typed.message)].slice(-200)
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

  setMute(muted: boolean) {
    this.sendWsEvent({ type: "set_mute", muted })
  }

  setDeafen(deafened: boolean) {
    this.sendWsEvent({ type: "set_deafen", deafened })
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
      out[roomId] = users.map((u) => ({
        id: u.clientId,
        name: u.displayName,
        avatar: u.displayName.slice(0, 1).toUpperCase(),
        isMuted: u.muted,
        isDeafened: u.deafened,
        isSpeaking: u.speaking
      }))
    }
    return out
  }

  getMediaToken() {
    return this.mediaToken
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
    const res = await fetch(`${this.apiBase}/health`)
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

  private normalizeMessage(message: ChatMessage): ChatMessage {
    return {
      ...message,
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
