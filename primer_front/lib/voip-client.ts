"use client"

import type { ChannelCategory, VoiceUser } from "@/components/voip/channel-sidebar"
import { clearVoiceLevels, setRoomVoiceLevels } from "@/lib/voice-levels"

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:18080"

export type JoinResult = {
  serverId: string
  /** Protection level as the server knows it (protected profiles only); the device copy may be stale. */
  authMode?: AuthMode
  /** Set when the member is below the server's minimum protection level: raise it before entering. */
  upgradeRequired?: { minLevel: number }
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

/** A profile registered on the server, online or not. */
export type RegisteredMember = {
  clientId: string
  displayName: string
  roles: Array<{ id: string; key: string; name: string }>
  isAdmin: boolean
  joinedAt: string
}

export type RealtimeState = {
  /** Every registered profile (empty until loaded or on servers without the endpoint). */
  registeredMembers: RegisteredMember[]
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
  /**
   * revoked: the server ended the session (certificate revoked or access reset);
   * levelTooLow: the server now requires a higher protection level than this profile has.
   */
  connection: { wsConnected: boolean; reconnecting: boolean; revoked?: boolean; levelTooLow?: boolean }
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

/** Error with a stable code so the UI can show a translated message instead of `message`. */
const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y", к: "k", л: "l",
  м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh",
  щ: "shch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya", і: "i", ї: "yi", є: "ye", ґ: "g"
}

/**
 * HTTP header values must be ISO-8859-1, so fetch() throws for names like "Снимок экрана.png".
 * The server only keeps [a-zA-Z0-9._-] anyway; transliterating first keeps the name readable.
 */
export function toHeaderSafeFileName(name: string): string {
  let out = ""
  for (const ch of name.normalize("NFC")) {
    const lower = ch.toLowerCase()
    const mapped = CYRILLIC_TO_LATIN[lower]
    if (mapped !== undefined) {
      out += lower === ch ? mapped : mapped.charAt(0).toUpperCase() + mapped.slice(1)
    } else if (/^[\x20-\x7e]$/.test(ch)) {
      out += ch
    } else {
      out += "_"
    }
  }
  return out.trim() || "upload.bin"
}

export class ApiError extends Error {
  /** camelCase code, e.g. "apiUnreachable" or a server auth code such as "invalidCredentials". */
  constructor(
    readonly code: string,
    message: string,
    /** Extra fields of the error response, e.g. `authMode` for auth_mode_mismatch. */
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = "ApiError"
  }
}

/**
 * Protection level a member chose on a server:
 * 1 "password" — nick + password; 2 "certificate" — this device's certificate;
 * 3 "password_certificate" — certificate + nick + password.
 */
export type AuthMode = "password" | "certificate" | "password_certificate"

export const modeNeedsPassword = (mode: AuthMode) => mode !== "certificate"
export const modeNeedsCertificate = (mode: AuthMode) => mode !== "password"

/** 1 password, 2 certificate, 3 both; 0 for an unprotected profile. */
export const authLevel = (mode: AuthMode | null | undefined) =>
  mode === "password" ? 1 : mode === "certificate" ? 2 : mode === "password_certificate" ? 3 : 0

export const AUTH_MODES_BY_LEVEL: readonly AuthMode[] = ["password", "certificate", "password_certificate"]

/** Device certificate issued by a server (see backend auth.ts). */
export type ServerCertificate = {
  v: 1
  certId: string
  serverId: string
  clientId: string
  publicKey: string
  issuedAt: string
  sig: string
}

export type IssuedProfile = {
  serverId: string
  clientId: string
  nick: string
  authMode: AuthMode
  certificate: ServerCertificate | null
}

export type CertificateInfo = {
  certId: string
  issuedAt: string
  lastUsedAt: string | null
  revokedAt: string | null
  revokedByAdmin: boolean
}

export type SecurityInfo = {
  /** Minimum protection level the server requires (0 none, 1..3). */
  minAuthLevel?: number
  protected: boolean
  nick: string | null
  authMode: AuthMode | null
  hasPassword: boolean
  currentCertId?: string | null
  certificates: CertificateInfo[]
}

const snakeToCamel = (value: string) => value.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())

/** Turns an error response into ApiError (server code) or a plain Error with the server message. */
async function errorFromResponse(res: Response, fallback: string): Promise<Error> {
  let message = `${fallback} (${res.status})`
  try {
    const payload = (await res.json()) as { message?: unknown; code?: unknown } & Record<string, unknown>
    if (typeof payload.message === "string" && payload.message) message = payload.message
    if (typeof payload.code === "string" && payload.code && !payload.code.startsWith("FST_")) {
      return new ApiError(snakeToCamel(payload.code), message, payload)
    }
    // Fastify's own 404 for an unknown route: the server is older than certificate login.
    if (res.status === 404 && /^Route \w+:\/v1\/auth\//.test(message)) return new ApiError("authNotSupported", message)
  } catch {
    /* non-JSON body */
  }
  return new Error(message)
}

export class VoipClient {
  private apiBase: string = DEFAULT_API_BASE
  private ws: WebSocket | null = null
  private authToken: string | null = null
  private mediaToken: string | null = null
  private listeners = new Set<(s: RealtimeState) => void>()
  private state: RealtimeState = {
    registeredMembers: [],
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
  /** fallback: a viewer needs the WebSocket stream; false (or old servers) = someone joined. */
  private screenResyncListeners = new Set<(roomId: string, fallback: boolean) => void>()
  
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
    this.applyJoinResult(out)
    return out
  }

  private applyJoinResult(out: JoinResult) {
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
  }

  private async postJson<T>(path: string, body: unknown, fallback: string, auth = false): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth && this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {})
      },
      body: JSON.stringify(body ?? {})
    })
    if (!res.ok) throw await errorFromResponse(res, fallback)
    return (await res.json()) as T
  }

  /**
   * First visit: the shared server password lets a new member create a profile at the chosen level
   * (password and/or device public key, depending on `authMode`).
   */
  registerMember(input: { serverPassword: string; nick: string; authMode: AuthMode; password?: string; publicKey?: string }) {
    return this.postJson<IssuedProfile>("/v1/auth/register", input, "registration failed")
  }

  /** Protects a profile created before protection existed; keeps its nick and history. */
  claimMember(input: {
    serverPassword: string
    clientId: string
    authMode: AuthMode
    password?: string
    publicKey?: string
    nick?: string
  }) {
    return this.postJson<IssuedProfile>("/v1/auth/claim", input, "could not protect the profile")
  }

  /** Level 1: nick + personal password. */
  async loginWithPassword(input: { nick: string; password: string; superuserPassword?: string }) {
    const out = await this.postJson<JoinResult & { authMode: AuthMode }>(
      "/v1/auth/password-login",
      {
        nick: input.nick,
        password: input.password,
        ...(input.superuserPassword ? { superuserPassword: input.superuserPassword } : {})
      },
      "login failed"
    )
    this.applyJoinResult(out)
    return out
  }

  async getSecurityPolicy(serverId: string): Promise<{ minAuthLevel: number }> {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/security-policy`, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw await errorFromResponse(res, "security policy failed")
    return (await res.json()) as { minAuthLevel: number }
  }

  /** Admin: minimum protection level to enter (0 none, 1..3). */
  async setSecurityPolicy(serverId: string, minAuthLevel: number): Promise<{ minAuthLevel: number }> {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/security-policy`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.authToken}` },
      body: JSON.stringify({ minAuthLevel })
    })
    if (!res.ok) throw await errorFromResponse(res, "security policy update failed")
    return (await res.json()) as { minAuthLevel: number }
  }

  /** Changes the protection level; returns a certificate when a new device key was sent. */
  setAuthMode(
    serverId: string,
    input: { authMode: AuthMode; currentPassword?: string; newPassword?: string; publicKey?: string }
  ) {
    return this.postJson<{ authMode: AuthMode; certificate: ServerCertificate | null }>(
      `/v1/servers/${serverId}/me/auth-mode`,
      input,
      "could not change the protection level",
      true
    )
  }

  /**
   * Levels 2 and 3: the server sends a one-time challenge and the device key signs it (in the
   * Electron main process); level 3 also checks nick + password.
   */
  async loginWithCertificate(input: {
    certificate: ServerCertificate
    nick?: string
    password?: string
    superuserPassword?: string
    signLoginMessage: (message: string) => Promise<string>
  }): Promise<JoinResult & { certId: string; authMode: AuthMode }> {
    const { certificate } = input
    const challenge = await this.postJson<{ nonce: string }>(
      "/v1/auth/challenge",
      { certId: certificate.certId },
      "login failed"
    )
    const message = `voixex-login:v1\n${certificate.serverId}\n${certificate.certId}\n${challenge.nonce}`
    const signature = await input.signLoginMessage(message)
    const out = await this.postJson<JoinResult & { certId: string; authMode: AuthMode }>(
      "/v1/auth/login",
      {
        certId: certificate.certId,
        nonce: challenge.nonce,
        signature,
        ...(input.nick ? { nick: input.nick } : {}),
        ...(input.password ? { password: input.password } : {}),
        ...(input.superuserPassword ? { superuserPassword: input.superuserPassword } : {})
      },
      "login failed"
    )
    this.applyJoinResult(out)
    return out
  }

  async getMySecurity(serverId: string): Promise<SecurityInfo> {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/me/security`, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw await errorFromResponse(res, "security info failed")
    return (await res.json()) as SecurityInfo
  }

  revokeMyCertificate(serverId: string, certId: string) {
    return this.postJson<{ ok: true }>(`/v1/servers/${serverId}/me/certificates/${certId}/revoke`, {}, "revoke failed", true)
  }

  changeMyPassword(serverId: string, currentPassword: string, newPassword: string) {
    return this.postJson<{ ok: true }>(
      `/v1/servers/${serverId}/me/password`,
      { currentPassword, newPassword },
      "password change failed",
      true
    )
  }

  async getMemberSecurity(serverId: string, clientId: string): Promise<SecurityInfo> {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/members/${clientId}/security`, {
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw await errorFromResponse(res, "security info failed")
    return (await res.json()) as SecurityInfo
  }

  revokeMemberCertificate(serverId: string, clientId: string, certId: string) {
    return this.postJson<{ ok: true }>(
      `/v1/servers/${serverId}/members/${clientId}/certificates/${certId}/revoke`,
      {},
      "revoke failed",
      true
    )
  }

  resetMemberCredentials(serverId: string, clientId: string) {
    return this.postJson<{ ok: true }>(`/v1/servers/${serverId}/members/${clientId}/reset-credentials`, {}, "reset failed", true)
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

  /** Loads all registered members; older servers without the endpoint keep the list empty. */
  async refreshMembers(serverId = this.currentServerId) {
    if (!this.authToken || !serverId) return
    try {
      const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/members`, { headers: { Authorization: `Bearer ${this.authToken}` } })
      if (!res.ok) return
      const body = (await res.json()) as { members: RegisteredMember[] }
      if (serverId !== this.currentServerId) return
      this.state.registeredMembers = body.members
      this.emit()
    } catch {
      /* offline: keep the last list */
    }
  }

  async setMemberAdmin(serverId: string, clientId: string, admin: boolean) {
    if (!this.authToken) throw new Error("not authorized")
    const res = await fetch(`${this.apiBase}/v1/servers/${serverId}/members/${clientId}/admin`, {
      method: admin ? "PUT" : "DELETE",
      headers: { Authorization: `Bearer ${this.authToken}` }
    })
    if (!res.ok) throw await errorFromResponse(res, "role change failed")
    await this.refreshMembers(serverId)
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
        "x-file-name": toHeaderSafeFileName(file.name),
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
    clearVoiceLevels()
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
      registeredMembers: [],
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
      // ~10 Hz: straight to the level store, without re-rendering everything that watches state.
      if (data.type === "voice_levels") {
        if (typeof data.roomId === "string" && data.levels && typeof data.levels === "object") {
          setRoomVoiceLevels(data.roomId, data.levels as Record<string, number>)
        }
        return
      }
      if (data.type === "screen_share_resync_request") {
        const roomId = data.roomId as string
        if (typeof roomId !== "string") return
        // Servers before 0.5 do not say why; treat that as a viewer needing the WS stream.
        const fallback = data.fallback !== false
        for (const cb of this.screenResyncListeners) {
          try {
            cb(roomId, fallback)
          } catch {
            /* ignore */
          }
        }
        return
      }
      const typed = data as
        | { type: "hello"; clientId: string; serverId: string; serverGeneration?: number; bannerUrl?: string | null }
        | { type: "server_appearance_updated"; bannerUrl: string | null }
        | { type: "members_changed"; clientId?: string }
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
        // (Re)connected: the member list may have changed while we were away.
        void this.refreshMembers()
        if (typeof typed.serverGeneration === "number") {
          this.lastServerGeneration = typed.serverGeneration
        }
        if (typed.bannerUrl !== undefined) {
          this.state.serverBannerUrl = typed.bannerUrl?.trim() || null
        }
      } else if (typed.type === "server_appearance_updated") {
        this.state.serverBannerUrl = typed.bannerUrl?.trim() || null
      } else if (typed.type === "members_changed") {
        void this.refreshMembers()
        // Our own roles changed: reload permissions so admin-only UI appears or disappears.
        if (this.currentServerId && typed.clientId && typed.clientId === this.state.me?.clientId) {
          void this.getMe(this.currentServerId).catch(() => {})
        }
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
    this.ws.onclose = (event) => {
      this.ws = null
      this.stopPing()
      // 4002 invalid token / 4003 session ended / 4004 level too low: retrying with the same token cannot succeed.
      if (event.code === 4002 || event.code === 4003 || event.code === 4004) {
        this.state.connection = {
          wsConnected: false,
          reconnecting: false,
          revoked: event.code !== 4004,
          levelTooLow: event.code === 4004
        }
        this.emit()
        return
      }
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

  /** Viewer on a lower LiveKit layer: ask the server to stop relaying the full WS screen stream. */
  setScreenRelay(enabled: boolean) {
    this.sendWsEvent({ type: "set_screen_relay", enabled })
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
  requestScreenResync(roomId: string, fallback = true) {
    this.sendWsEvent({ type: "request_screen_resync", roomId, fallback })
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
  subscribeScreenResyncRequests(cb: (roomId: string, fallback: boolean) => void) {
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

  getApiBase() {
    return this.apiBase
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
        throw new ApiError(
          "apiUnreachable",
          "Cannot reach API. Check host/port (HTTPS often uses 443 or your nginx port, not plain HTTP), firewall, and TLS. " +
            "Self-signed HTTPS: use the latest desktop build (trusts custom certs) or open the API URL in the browser once and accept the certificate."
        )
      }
      throw e
    }
    if (!res.ok) throw new ApiError("serverUnavailable", "server unavailable")
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
