import Fastify, { type FastifyInstance } from "fastify"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import bcrypt from "bcryptjs"
import { randomUUID, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve as resolvePath } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { AccessToken, RoomServiceClient, TrackSource } from "livekit-server-sdk"
import { z } from "zod"
import { config } from "./config.js"
import { initDb } from "./db.js"
import { makeAuthToken, makeMediaToken, verifyToken } from "./token.js"
import type { WsClientEvent, WsServerEvent, RosterMember, RoomInfo, RoomPolicy } from "./contracts.js"
import { attachMediaSocket, createMediaServer, removeMember, setMemberFlags, setMemberRoom, setMemberSpeaking, setPeerVolume } from "./media.js"
import {
  AttemptLimiter,
  ChallengeStore,
  authLevel,
  isAuthMode,
  modeNeedsCertificate,
  modeNeedsPassword,
  type AuthMode,
  isValidNick,
  isValidPassword,
  loadServerSigningKey,
  loginSigningInput,
  nickKey,
  normalizeNick,
  parseEd25519PublicKey,
  signCertificate,
  verifyEd25519
} from "./auth.js"

const app = Fastify({
  logger: true,
  ...(config.tlsEnabled
    ? {
        https: {
          cert: readFileSync(resolvePath(config.tlsCertPath)),
          key: readFileSync(resolvePath(config.tlsKeyPath))
        }
      }
    : {})
})
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-file-name", "x-file-mime", "x-voice-transport"]
})
await app.register(websocket, {
  options: {
    maxPayload: config.wsMaxPayloadBytes
  }
})
app.addContentTypeParser(
  /^application\/octet-stream$|^image\/|^audio\/|^video\//i,
  { parseAs: "buffer", bodyLimit: config.uploadMaxMb * 1024 * 1024 },
  (_req, body, done) => done(null, body)
)
const db = initDb(config.dbPath)
{
  const r = db.prepare("DELETE FROM member_state").run()
  if (r.changes > 0) {
    app.log.info(
      { clearedRows: r.changes },
      "startup: cleared member_state (stale voice presence after restart)"
    )
  }
}
const certSigningKey = loadServerSigningKey(db)
const loginChallenges = new ChallengeStore()
/** Failed logins per nick: password guessing needs the certificate too, this caps the rest. */
const loginFailuresByNick = new AttemptLimiter(10, 10 * 60_000)
/** Server-password checks on register/claim, for all clients together (they share one proxy IP). */
const serverPasswordAttempts = new AttemptLimiter(30, 10 * 60_000)
const clients = new Map<string, Set<WebSocket>>()
/** Map WebSocket → client for targeted broadcast (screen chunks). */
const wsClientMeta = new Map<
  WebSocket,
  {
    serverId: string
    clientId: string
    certId?: string
    screenRelayOff?: boolean
    /** Viewer's socket could not keep up; chunks were skipped and it waits for a fresh WebM header. */
    screenLagging?: boolean
  }
>()
/**
 * Queued bytes on a viewer's socket above which screen chunks are skipped for it. Without a cap a
 * slow viewer's backlog (and its delay behind the live picture) grows without bound.
 */
const SCREEN_WS_LAG_BYTES = 2 * 1024 * 1024
const lastLagResyncAtByRoom = new Map<string, number>()
const screenShareStateByClient = new Map<string, { serverId: string; roomId: string | null; active: boolean }>()
/** Viewer IDs temporarily forced into WS screen relay after join/resync. */
const forceScreenRelayByRoom = new Map<string, Map<string, number>>()
const screenWsRateByClient = new Map<string, { sec: number; count: number }>()
let screenRelayLogCounter = 0
/** Bumped on process start so clients can detect redeploy and resync presence. */
const serverGeneration = Date.now()
/** Live WebSocket connections per (serverId, clientId) — presence evicted only when last socket closes. */
const clientSockets = new Map<string, Set<WebSocket>>()

function clientSocketsKey(serverId: string, clientId: string) {
  return `${serverId}:${clientId}`
}

function touchLastSeen(serverId: string, clientId: string) {
  db.prepare("UPDATE member_state SET last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(serverId, clientId)
}

function memberFromRow(r: {
  client_id: string
  display_name: string
  muted: number
  deafened: number
  speaking: number
  screen_sharing?: number
  watching_screen?: number
  media_engine?: string
}): RosterMember {
  return {
    clientId: r.client_id,
    displayName: r.display_name,
    muted: Boolean(r.muted),
    deafened: Boolean(r.deafened),
    speaking: Boolean(r.speaking),
    screenSharing: Boolean(r.screen_sharing),
    watchingScreen: Boolean(r.watching_screen),
    mediaEngine: r.media_engine === "webrtc" ? "webrtc" : "legacy"
  }
}

function memberFromSnap(snap: {
  client_id: string
  display_name: string
  room_id: string | null
  muted: number
  deafened: number
  speaking: number
  screen_sharing?: number
  watching_screen?: number
  media_engine?: string
}): RosterMember & { roomId: string | null } {
  return {
    ...memberFromRow(snap),
    roomId: snap.room_id
  }
}

function emitRosterSnapshots(serverId: string, roomIds: Array<string | null>) {
  const seen = new Set<string>()
  for (const roomId of roomIds) {
    const key = roomId ?? "__lobby__"
    if (seen.has(key)) continue
    seen.add(key)
    emitToServer(serverId, {
      type: "roster_snapshot",
      roomId,
      members: getRoster(serverId, roomId)
    })
  }
}

function buildScreenByRoom(serverId: string): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const [clientId, state] of screenShareStateByClient.entries()) {
    if (state.serverId !== serverId || !state.active || !state.roomId) continue
    out[state.roomId] = clientId
  }
  return out
}

function buildPresenceSnapshot(serverId: string): Extract<WsServerEvent, { type: "presence_snapshot" }> {
  const rosters: Record<string, RosterMember[]> = {}
  const roomRows = db
    .prepare(
      `SELECT DISTINCT room_id FROM member_state WHERE server_id = ? AND room_id IS NOT NULL`
    )
    .all(serverId) as Array<{ room_id: string }>
  for (const row of roomRows) {
    rosters[row.room_id] = getRoster(serverId, row.room_id)
  }
  return {
    type: "presence_snapshot",
    rosters,
    lobby: getRoster(serverId, null),
    screenByRoom: buildScreenByRoom(serverId)
  }
}

function sendPresenceSnapshotToSocket(socket: WebSocket, serverId: string) {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(buildPresenceSnapshot(serverId)))
}

function evictMemberPresence(serverId: string, clientId: string) {
  const snap = getMemberSnapshot(serverId, clientId)
  const prevRoomId = snap?.room_id ?? null
  db.prepare("DELETE FROM member_state WHERE server_id = ? AND client_id = ?").run(serverId, clientId)
  removeMember(clientId)
  const shareSnap = screenShareStateByClient.get(clientId)
  screenShareStateByClient.delete(clientId)
  for (const forced of forceScreenRelayByRoom.values()) {
    forced.delete(clientId)
  }
  screenWsRateByClient.delete(clientId)
  if (shareSnap?.active) {
    const shareRoomEmit = shareSnap.roomId ?? null
    emitScreenShareState(serverId, clientId, shareRoomEmit, false)
  }
  if (snap) {
    emitToServer(serverId, {
      type: "member_updated",
      member: {
        ...memberFromSnap(snap),
        roomId: null,
        speaking: false,
        screenSharing: false,
        watchingScreen: false
      }
    })
    emitRosterSnapshots(serverId, [prevRoomId, null])
  }
}

function sweepStalePresence() {
  const rows = db
    .prepare(
      `SELECT server_id, client_id FROM member_state
       WHERE last_seen < datetime('now', ?)`
    )
    .all(`-${config.presenceTtlSec} seconds`) as Array<{ server_id: string; client_id: string }>
  for (const row of rows) {
    const key = clientSocketsKey(row.server_id, row.client_id)
    if ((clientSockets.get(key)?.size ?? 0) > 0) {
      touchLastSeen(row.server_id, row.client_id)
      continue
    }
    evictMemberPresence(row.server_id, row.client_id)
  }
}

setInterval(sweepStalePresence, config.presenceSweepSec * 1000).unref?.()

type PermissionKey = "manage_server" | "manage_channels" | "manage_roles" | "manage_chat"
type PermissionMap = Record<PermissionKey, boolean>
const ADMIN_PERMISSIONS: PermissionMap = {
  manage_server: true,
  manage_channels: true,
  manage_roles: true,
  manage_chat: true
}

function emitToServer(serverId: string, event: WsServerEvent) {
  const payload = JSON.stringify(event)
  for (const ws of clients.get(serverId) ?? []) {
    if (ws.readyState === ws.OPEN) ws.send(payload)
  }
}

function getServerBannerUrl(serverId: string): string | null {
  const row = db.prepare("SELECT banner_url FROM servers WHERE id = ?").get(serverId) as { banner_url: string | null } | undefined
  const url = row?.banner_url?.trim()
  return url || null
}

function isVoiceRoomId(serverId: string, roomId: string): boolean {
  const row = db.prepare("SELECT kind FROM rooms WHERE server_id = ? AND id = ? LIMIT 1").get(serverId, roomId) as { kind: string } | undefined
  return row?.kind === "voice"
}

/** SQLite `datetime('now')` is UTC without TZ marker. Expose as ISO-8601 with Z so clients sort the same as WS payloads. */
function sqliteUtcToIso(createdAt: string): string {
  if (createdAt.includes("T")) return createdAt
  const m = createdAt.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`
  return createdAt
}

function allowScreenWsRate(clientId: string): boolean {
  const sec = Math.floor(Date.now() / 1000)
  let e = screenWsRateByClient.get(clientId)
  if (!e || e.sec !== sec) {
    e = { sec, count: 0 }
    screenWsRateByClient.set(clientId, e)
  }
  e.count += 1
  return e.count <= config.screenWsMaxPerSec
}

function markForceScreenRelay(roomId: string, viewerClientId: string, ttlMs = 20_000) {
  const now = Date.now()
  const roomMap = forceScreenRelayByRoom.get(roomId) ?? new Map<string, number>()
  roomMap.set(viewerClientId, now + ttlMs)
  for (const [clientId, expiresAt] of roomMap.entries()) {
    if (expiresAt <= now) roomMap.delete(clientId)
  }
  if (roomMap.size > 0) forceScreenRelayByRoom.set(roomId, roomMap)
  else forceScreenRelayByRoom.delete(roomId)
}

function broadcastScreenChunkWs(app: FastifyInstance, serverId: string, roomId: string, fromClientId: string, event: WsServerEvent) {
  const memberIds = new Set(getRoster(serverId, roomId).map((m) => m.clientId))
  const now = Date.now()
  const forced = forceScreenRelayByRoom.get(roomId)
  const payload = JSON.stringify(event)
  let sent = 0
  let openSameServer = 0
  for (const ws of clients.get(serverId) ?? []) {
    if (ws.readyState !== ws.OPEN) continue
    openSameServer++
    const meta = wsClientMeta.get(ws)
    if (!meta || meta.clientId === fromClientId) continue
    // The viewer chose a LiveKit quality layer and does not want the full-quality WS stream.
    if (meta.screenRelayOff) continue
    let allowed = memberIds.has(meta.clientId)
    if (!allowed && forced) {
      const expiresAt = forced.get(meta.clientId)
      if (expiresAt && expiresAt > now) {
        allowed = true
      } else if (expiresAt) {
        forced.delete(meta.clientId)
      }
    }
    if (!allowed) continue
    if (ws.bufferedAmount > SCREEN_WS_LAG_BYTES) {
      if (!meta.screenLagging) {
        meta.screenLagging = true
        app.log.info({ serverId, roomId, clientId: meta.clientId, bufferedBytes: ws.bufferedAmount }, "screen viewer lagging; skipping chunks")
      }
      continue
    }
    if (meta.screenLagging) {
      // Skipped chunks broke this viewer's WebM stream: once its socket has drained, ask the
      // sharer for a fresh header (throttled per room) and resume from there.
      if (ws.bufferedAmount > SCREEN_WS_LAG_BYTES / 4) continue
      meta.screenLagging = false
      if (now - (lastLagResyncAtByRoom.get(roomId) ?? 0) > 3000) {
        lastLagResyncAtByRoom.set(roomId, now)
        notifyActiveScreenSharerToResync(serverId, roomId, meta.clientId, true)
      }
    }
    ws.send(payload)
    sent++
  }
  if (forced && forced.size === 0) forceScreenRelayByRoom.delete(roomId)
  if (config.screenLog) {
    if (sent === 0) {
      app.log.warn({
        msg: "screen_chunk relayed to 0 viewers",
        serverId,
        roomId,
        fromClientId,
        rosterCount: memberIds.size,
        wsOpenSameServer: openSameServer
      })
    } else {
      screenRelayLogCounter++
      if (screenRelayLogCounter % 25 === 0) {
        app.log.info({
          msg: "screen_chunk relay sample",
          serverId,
          roomId,
          fromClientId,
          sent,
          rosterCount: memberIds.size,
          approxPayloadKb: Math.round(payload.length / 1024)
        })
      }
    }
  }
}

function emitScreenShareState(serverId: string, clientId: string, roomId: string | null, active: boolean) {
  emitToServer(serverId, { type: "screen_share_state", clientId, roomId, active })
}

function findOpenSocketForClient(serverId: string, clientId: string): WebSocket | null {
  for (const ws of clients.get(serverId) ?? []) {
    if (ws.readyState !== ws.OPEN) continue
    const meta = wsClientMeta.get(ws)
    if (meta?.clientId === clientId) return ws
  }
  return null
}

/** New viewer joined a voice room: ask active sharer(s) to restart MediaRecorder so WebM init is sent again. */
function notifyActiveScreenSharerToResync(serverId: string, joinedRoomId: string, joinedClientId: string, fallback = false) {
  for (const [sharerId, share] of screenShareStateByClient.entries()) {
    if (sharerId === joinedClientId) continue
    if (share.serverId !== serverId || !share.active || share.roomId !== joinedRoomId) continue
    const ws = findOpenSocketForClient(serverId, sharerId)
    if (!ws) continue
    ws.send(JSON.stringify({ type: "screen_share_resync_request", roomId: joinedRoomId, fallback } satisfies WsServerEvent))
  }
}


function ensureAdminRole(serverId: string) {
  const existing = db
    .prepare("SELECT id, permissions_json FROM server_roles WHERE server_id = ? AND role_key = 'admin' LIMIT 1")
    .get(serverId) as { id: string; permissions_json: string } | undefined
  if (existing) {
    let hasAllAdminPermissions = true
    try {
      const parsed = JSON.parse(existing.permissions_json) as Partial<PermissionMap>
      for (const key of Object.keys(ADMIN_PERMISSIONS) as PermissionKey[]) {
        if (!parsed[key]) {
          hasAllAdminPermissions = false
          break
        }
      }
    } catch {
      hasAllAdminPermissions = false
    }
    if (!hasAllAdminPermissions) {
      db.prepare("UPDATE server_roles SET permissions_json = ?, name = 'Admin', is_system = 1 WHERE id = ?").run(
        JSON.stringify(ADMIN_PERMISSIONS),
        existing.id
      )
    }
    return existing.id
  }
  const id = randomUUID()
  db.prepare(
    "INSERT INTO server_roles(id, server_id, role_key, name, permissions_json, is_system) VALUES (?, ?, 'admin', 'Admin', ?, 1)"
  ).run(id, serverId, JSON.stringify(ADMIN_PERMISSIONS))
  return id
}

function ensureMemberHasRole(serverId: string, clientId: string, roleId: string) {
  db.prepare(
    `INSERT INTO member_roles(server_id, client_id, role_id)
     VALUES (?, ?, ?)
     ON CONFLICT(server_id, client_id, role_id) DO NOTHING`
  ).run(serverId, clientId, roleId)
}

function getMemberRoles(serverId: string, clientId: string) {
  return db
    .prepare(
      `SELECT r.id, r.role_key, r.name, r.permissions_json
       FROM member_roles mr
       JOIN server_roles r ON r.id = mr.role_id
       WHERE mr.server_id = ? AND mr.client_id = ?`
    )
    .all(serverId, clientId) as Array<{ id: string; role_key: string; name: string; permissions_json: string }>
}

function getMemberPermissions(serverId: string, clientId: string) {
  const roles = getMemberRoles(serverId, clientId)
  const permissions: PermissionMap = { manage_server: false, manage_channels: false, manage_roles: false, manage_chat: false }
  for (const role of roles) {
    try {
      const parsed = JSON.parse(role.permissions_json) as Partial<PermissionMap>
      for (const key of Object.keys(permissions) as PermissionKey[]) {
        permissions[key] = permissions[key] || Boolean(parsed[key])
      }
    } catch {
      // Ignore malformed role permissions.
    }
  }
  return { roles: roles.map((r) => ({ id: r.id, key: r.role_key, name: r.name })), permissions }
}

type RoomRow = { id: string; name: string; kind: "voice" | "text"; options: string | null }

function parseRoomOptions(raw: string | null): Record<string, unknown> {
  try {
    const value = JSON.parse(raw ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function policyOf(row: Pick<RoomRow, "name" | "kind" | "options">): RoomPolicy {
  const options = parseRoomOptions(row.options)
  // Before channel rules existed a voice channel named "Lobby" was always muted: keep that
  // until an admin sets the rule.
  const legacyLobby = row.kind === "voice" && row.name.toLowerCase() === "lobby"
  return {
    allowMic: typeof options.allowMic === "boolean" ? options.allowMic : !legacyLobby,
    allowStreams: typeof options.allowStreams === "boolean" ? options.allowStreams : true
  }
}

function getRooms(serverId: string): RoomInfo[] {
  const rows = db.prepare("SELECT id, name, kind, options FROM rooms WHERE server_id = ? ORDER BY created_at ASC").all(serverId) as RoomRow[]
  return rows.map((r) => (r.kind === "voice" ? { id: r.id, name: r.name, kind: r.kind, policy: policyOf(r) } : { id: r.id, name: r.name, kind: r.kind }))
}

function getRoomPolicy(serverId: string, roomId: string): RoomPolicy {
  const row = db.prepare("SELECT name, kind, options FROM rooms WHERE server_id = ? AND id = ? LIMIT 1").get(serverId, roomId) as
    | Pick<RoomRow, "name" | "kind" | "options">
    | undefined
  return row ? policyOf(row) : { allowMic: true, allowStreams: true }
}

/** What a LiveKit participant may publish in a room with these rules. */
function livekitSources(policy: RoomPolicy, screen: boolean): TrackSource[] {
  if (screen) return policy.allowStreams ? [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO] : []
  const sources: TrackSource[] = []
  if (policy.allowMic) sources.push(TrackSource.MICROPHONE)
  if (policy.allowStreams) sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO)
  return sources
}

function sendToClient(serverId: string, clientId: string, event: WsServerEvent) {
  const payload = JSON.stringify(event)
  for (const ws of clientSockets.get(clientSocketsKey(serverId, clientId)) ?? []) {
    try {
      ws.send(payload)
    } catch {
      // closing
    }
  }
}

/**
 * New rules apply at once to who is already in the channel: microphones are muted, streams
 * end (the app stops capturing when it sees the rule), and LiveKit permissions follow.
 */
async function applyRoomPolicy(serverId: string, roomId: string, policy: RoomPolicy) {
  const members = db
    .prepare("SELECT client_id, muted FROM member_state WHERE server_id = ? AND room_id = ?")
    .all(serverId, roomId) as Array<{ client_id: string; muted: number }>
  for (const m of members) {
    let changed = false
    if (!policy.allowMic && !m.muted) {
      db.prepare("UPDATE member_state SET muted = 1 WHERE server_id = ? AND client_id = ?").run(serverId, m.client_id)
      changed = true
    }
    const share = screenShareStateByClient.get(m.client_id)
    if (!policy.allowStreams && share?.active && share.roomId === roomId) {
      screenShareStateByClient.set(m.client_id, { ...share, active: false })
      db.prepare("UPDATE member_state SET screen_sharing = 0 WHERE server_id = ? AND client_id = ?").run(serverId, m.client_id)
      emitScreenShareState(serverId, m.client_id, roomId, false)
      changed = true
    }
    if (changed) {
      const snap = getMemberSnapshot(serverId, m.client_id)
      if (snap) {
        setMemberFlags(m.client_id, Boolean(snap.muted), Boolean(snap.deafened))
        emitMemberUpdated(serverId, snap)
      }
    }
  }
  if (members.length > 0) emitRosterSnapshots(serverId, [roomId])
  if (!config.livekitApiUrl || !config.livekitApiKey || !config.livekitApiSecret) return
  const roomName = `${serverId}:${roomId}`
  try {
    const service = new RoomServiceClient(config.livekitApiUrl, config.livekitApiKey, config.livekitApiSecret)
    const participants = await service.listParticipants(roomName)
    for (const p of participants) {
      const screen = p.identity.endsWith(":screen")
      if (screen && !policy.allowStreams) {
        await service.removeParticipant(roomName, p.identity)
        continue
      }
      const sources = livekitSources(policy, screen)
      await service.updateParticipant(roomName, p.identity, undefined, {
        canPublish: sources.length > 0,
        canPublishSources: sources,
        canSubscribe: !screen,
        canPublishData: !screen
      })
    }
  } catch (err) {
    // No LiveKit room yet (nobody connected over WebRTC) or the SFU is unreachable.
    app.log.debug({ err: String(err), roomName }, "livekit permission update skipped")
  }
}

type AttachmentRow = {
  id: string
  message_id: string | null
  server_id: string
  channel_id: string
  uploader_client_id: string
  storage_path: string
  original_name: string
  mime: string
  size_bytes: number
}

const ATTACHMENT_ALLOWED_MIME_PREFIXES = ["audio/", "image/", "video/"]
const ATTACHMENT_ALLOWED_MIME_EXACT = new Set(["image/gif"])

function isAllowedAttachmentMime(mime: string) {
  if (ATTACHMENT_ALLOWED_MIME_EXACT.has(mime)) return true
  return ATTACHMENT_ALLOWED_MIME_PREFIXES.some((prefix) => mime.startsWith(prefix))
}

function sanitizeFilename(input: string) {
  const base = basename(input).replace(/[^a-zA-Z0-9._-]/g, "_")
  return base.length > 0 ? base : "file"
}

function attachmentUrl(serverId: string, attachmentId: string, token: string) {
  return `/v1/servers/${serverId}/attachments/${attachmentId}?token=${encodeURIComponent(token)}`
}

function getAttachmentsByMessageIds(serverId: string, messageIds: string[], token: string) {
  if (messageIds.length === 0) return new Map<string, Array<{ id: string; name: string; mime: string; sizeBytes: number; url: string }>>()
  const placeholders = messageIds.map(() => "?").join(",")
  const rows = db
    .prepare(
      `SELECT id, message_id, server_id, original_name, mime, size_bytes
       FROM message_attachments
       WHERE server_id = ? AND message_id IN (${placeholders})
       ORDER BY created_at ASC`
    )
    .all(serverId, ...messageIds) as Array<{
    id: string
    message_id: string
    server_id: string
    original_name: string
    mime: string
    size_bytes: number
  }>
  const out = new Map<string, Array<{ id: string; name: string; mime: string; sizeBytes: number; url: string }>>()
  for (const row of rows) {
    const list = out.get(row.message_id) ?? []
    list.push({
      id: row.id,
      name: row.original_name,
      mime: row.mime,
      sizeBytes: row.size_bytes,
      url: attachmentUrl(row.server_id, row.id, token)
    })
    out.set(row.message_id, list)
  }
  return out
}

function getMemberSnapshot(serverId: string, clientId: string) {
  return db
    .prepare(
      `SELECT ms.server_id, ms.room_id, ms.client_id, sm.display_name, ms.muted, ms.deafened, ms.speaking,
              ms.screen_sharing, ms.watching_screen, ms.media_engine
       FROM member_state ms
       JOIN server_members sm ON sm.server_id = ms.server_id AND sm.client_id = ms.client_id
       WHERE ms.server_id = ? AND ms.client_id = ?`
    )
    .get(serverId, clientId) as
    | {
        server_id: string
        room_id: string | null
        client_id: string
        display_name: string
        muted: number
        deafened: number
        speaking: number
        screen_sharing: number
        watching_screen: number
        media_engine: string
      }
    | undefined
}

function getRoster(serverId: string, roomId: string | null): RosterMember[] {
  const rows = db
    .prepare(
      `SELECT ms.client_id, sm.display_name, ms.muted, ms.deafened, ms.speaking, ms.screen_sharing, ms.watching_screen, ms.media_engine
       FROM member_state ms
       JOIN server_members sm ON sm.server_id = ms.server_id AND sm.client_id = ms.client_id
       WHERE ms.server_id = ? AND ms.room_id IS ?
       ORDER BY ms.last_seen DESC`
    )
    .all(serverId, roomId) as Array<{
    client_id: string
    display_name: string
    muted: number
    deafened: number
    speaking: number
    screen_sharing: number
    watching_screen: number
    media_engine: string
  }>
  return rows.map((r) => memberFromRow(r))
}

function emitMemberUpdated(serverId: string, snap: NonNullable<ReturnType<typeof getMemberSnapshot>>) {
  emitToServer(serverId, {
    type: "member_updated",
    member: memberFromSnap(snap)
  })
}

/** roomId → serverId for voice level events (room ids never move between servers). */
const serverIdByRoom = new Map<string, string | null>()

createMediaServer(app.log, {
  onVoiceLevels: ({ roomId, levels }) => {
    if (!serverIdByRoom.has(roomId)) {
      const row = db.prepare("SELECT server_id FROM rooms WHERE id = ? LIMIT 1").get(roomId) as { server_id: string } | undefined
      serverIdByRoom.set(roomId, row?.server_id ?? null)
    }
    const serverId = serverIdByRoom.get(roomId)
    if (serverId) emitToServer(serverId, { type: "voice_levels", roomId, levels })
  },
  onSpeakingChanged: ({ clientId, speaking }) => {
    const row = db
      .prepare("SELECT server_id, room_id FROM member_state WHERE client_id = ? ORDER BY last_seen DESC LIMIT 1")
      .get(clientId) as { server_id: string; room_id: string | null } | undefined
    if (!row) return
    db.prepare("UPDATE member_state SET speaking = ? WHERE server_id = ? AND client_id = ?").run(speaking ? 1 : 0, row.server_id, clientId)
    const snap = getMemberSnapshot(row.server_id, clientId)
    if (!snap) return
    emitMemberUpdated(row.server_id, snap)
  },
  onSessionStale: ({ clientId }) => {
    const row = db
      .prepare("SELECT server_id FROM member_state WHERE client_id = ? ORDER BY last_seen DESC LIMIT 1")
      .get(clientId) as { server_id: string } | undefined
    if (!row) return
    db.prepare("UPDATE member_state SET speaking = 0 WHERE server_id = ? AND client_id = ?").run(row.server_id, clientId)
    setMemberSpeaking(clientId, false)
    const snap = getMemberSnapshot(row.server_id, clientId)
    if (snap) emitMemberUpdated(row.server_id, snap)
  }
})
app.get("/health", async () => ({ ok: true }))

function ensureDefaultRooms(serverId: string) {
  ensureAdminRole(serverId)
  const voiceCount = db
    .prepare("SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND kind = 'voice'")
    .get(serverId) as { c: number }
  if (voiceCount.c === 0) {
    db.prepare("INSERT INTO rooms(id, server_id, name, kind, options) VALUES (?, ?, ?, ?, '{}')").run(
      randomUUID(),
      serverId,
      "Lobby",
      "voice"
    )
  }
  const textCount = db
    .prepare("SELECT COUNT(*) AS c FROM rooms WHERE server_id = ? AND kind = 'text'")
    .get(serverId) as { c: number }
  if (textCount.c === 0) {
    db.prepare("INSERT INTO rooms(id, server_id, name, kind, options) VALUES (?, ?, ?, ?, '{}')").run(
      randomUUID(),
      serverId,
      "general",
      "text"
    )
  }
}

async function issueJoinForServer(input: {
  serverId: string
  clientId: string
  displayName: string
  superuserPassword?: string
  certId?: string
  credentialed?: boolean
  limited?: boolean
}) {
  const existingMember = db
    .prepare("SELECT display_name FROM server_members WHERE server_id = ? AND client_id = ?")
    .get(input.serverId, input.clientId) as { display_name: string } | undefined
  const resolvedName = existingMember?.display_name ?? input.displayName

  // Reuse the same logical identity on reconnect and clean up leaked suffix sessions
  // from prior joins (<clientId>-xxxxxxxx), so roster does not duplicate one user.
  const staleRows = db
    .prepare(
      `SELECT ms.client_id, sm.display_name, ms.muted, ms.deafened
       FROM member_state ms
       JOIN server_members sm ON sm.server_id = ms.server_id AND sm.client_id = ms.client_id
       WHERE ms.server_id = ? AND (ms.client_id = ? OR ms.client_id LIKE ?)`
    )
    .all(input.serverId, input.clientId, `${input.clientId}-%`) as Array<{
    client_id: string
    display_name: string
    muted: number
    deafened: number
  }>
  for (const stale of staleRows) {
    db.prepare("DELETE FROM member_state WHERE server_id = ? AND client_id = ?").run(input.serverId, stale.client_id)
    removeMember(stale.client_id)
    emitToServer(input.serverId, {
      type: "member_updated",
      member: {
        clientId: stale.client_id,
        displayName: stale.display_name,
        roomId: null,
        muted: Boolean(stale.muted),
        deafened: Boolean(stale.deafened),
        speaking: false
      }
    })
  }
  db.prepare("DELETE FROM member_roles WHERE server_id = ? AND client_id LIKE ? AND client_id != ?").run(
    input.serverId,
    `${input.clientId}-%`,
    input.clientId
  )
  db.prepare("DELETE FROM server_members WHERE server_id = ? AND client_id LIKE ? AND client_id != ?").run(
    input.serverId,
    `${input.clientId}-%`,
    input.clientId
  )
  db.prepare(
    `INSERT INTO server_members(server_id, client_id, display_name)
     VALUES (?, ?, ?)
     ON CONFLICT(server_id, client_id) DO UPDATE SET display_name = excluded.display_name, updated_at = datetime('now')`
  ).run(input.serverId, input.clientId, resolvedName)

  db.prepare(
    `INSERT INTO member_state(server_id, room_id, client_id, display_name, muted, deafened, speaking, last_seen)
     VALUES (?, NULL, ?, ?, 0, 0, 0, datetime('now'))
     ON CONFLICT(server_id, client_id) DO UPDATE SET last_seen = datetime('now')`
  ).run(input.serverId, input.clientId, resolvedName)

  if (input.superuserPassword && input.superuserPassword === config.superuserPassword) {
    const adminRoleId = ensureAdminRole(input.serverId)
    ensureMemberHasRole(input.serverId, input.clientId, adminRoleId)
  }

  const mediaSeed = randomBytes(32).toString("base64")
  const authToken = makeAuthToken(
    {
      serverId: input.serverId,
      clientId: input.clientId,
      displayName: resolvedName,
      mediaSeed,
      ...(input.certId ? { certId: input.certId } : {}),
      ...(input.credentialed ? { credentialed: true } : {}),
      ...(input.limited ? { limited: true } : {})
    },
    config.tokenSecret
  )
  const mediaToken = makeMediaToken(
    { serverId: input.serverId, clientId: input.clientId, displayName: resolvedName, mediaSeed },
    config.tokenSecret
  )
  return {
    serverId: input.serverId,
    authToken,
    mediaToken,
    profile: { clientId: input.clientId, displayName: resolvedName },
    udp: { host: config.publicUdpHost, port: config.udpPort }
  }
}

app.post("/v1/servers", async (req, rep) => {
  const body = z.object({ name: z.string().min(1), password: z.string().min(4) }).parse(req.body)
  const id = randomUUID()
  const hash = await bcrypt.hash(body.password, 10)
  db.prepare("INSERT INTO servers(id, name, access_password_hash) VALUES (?, ?, ?)").run(id, body.name, hash)
  ensureDefaultRooms(id)
  return rep.send({ id, name: body.name })
})

app.post("/v1/join", async (req, rep) => {
  const body = z
    .object({
      password: z.string().min(1),
      clientId: z.string().min(3),
      displayName: z.string().min(1),
      serverName: z.string().min(1).optional(),
      superuserPassword: z.string().min(1).optional()
    })
    .parse(req.body)

  let server = db
    .prepare("SELECT id, name, access_password_hash FROM servers ORDER BY created_at DESC LIMIT 1")
    .get() as { id: string; name: string; access_password_hash: string } | undefined

  if (!server) {
    const id = randomUUID()
    const name = body.serverName ?? "Main Server"
    const hash = await bcrypt.hash(body.password, 10)
    db.prepare("INSERT INTO servers(id, name, access_password_hash) VALUES (?, ?, ?)").run(id, name, hash)
    ensureDefaultRooms(id)
    server = { id, name, access_password_hash: hash }
  }

  const ok = await bcrypt.compare(body.password, server.access_password_hash)
  if (!ok) return rep.code(401).send({ message: "invalid password" })
  const legacyError = legacyJoinError(server.id, body.clientId)
  if (legacyError) return rep.code(403).send(legacyError)
  ensureDefaultRooms(server.id)
  const joined = await issueJoinForServer({
    serverId: server.id,
    clientId: body.clientId,
    displayName: body.displayName,
    superuserPassword: body.superuserPassword
  })
  return rep.send({ ...joined, serverName: server.name, bannerUrl: getServerBannerUrl(server.id) })
})

app.post("/v1/servers/:serverId/join", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z
    .object({
      password: z.string().min(1),
      clientId: z.string().min(3),
      displayName: z.string().min(1),
      superuserPassword: z.string().min(1).optional()
    })
    .parse(req.body)
  const server = db.prepare("SELECT id, access_password_hash FROM servers WHERE id = ?").get(params.serverId) as
    | { id: string; access_password_hash: string }
    | undefined
  if (!server) return rep.code(404).send({ message: "server not found" })
  const ok = await bcrypt.compare(body.password, server.access_password_hash)
  if (!ok) return rep.code(401).send({ message: "invalid password" })
  const legacyError = legacyJoinError(params.serverId, body.clientId)
  if (legacyError) return rep.code(403).send(legacyError)
  ensureDefaultRooms(params.serverId)
  const joined = await issueJoinForServer({
    serverId: params.serverId,
    clientId: body.clientId,
    displayName: body.displayName,
    superuserPassword: body.superuserPassword
  })
  return rep.send({ ...joined, bannerUrl: getServerBannerUrl(params.serverId) })
})

// ---------------------------------------------------------------------------
// Member authentication. The shared server password is needed once, to create (or protect) a
// profile. Afterwards the member signs in at the protection level they chose:
//   password             — nick + personal password, from any device
//   certificate          — this device's certificate alone
//   password_certificate — certificate + nick + personal password
// ---------------------------------------------------------------------------

type CredentialsRow = { client_id: string; nick: string; nick_key: string; password_hash: string; auth_mode: string }
type CertificateRow = {
  id: string
  server_id: string
  client_id: string
  public_key: string
  issued_at: string
  last_used_at: string | null
  revoked_at: string | null
  revoked_by: string | null
}

function getCredentials(serverId: string, clientId: string) {
  return db
    .prepare(
      "SELECT client_id, nick, nick_key, password_hash, auth_mode FROM member_credentials WHERE server_id = ? AND client_id = ?"
    )
    .get(serverId, clientId) as CredentialsRow | undefined
}

function credentialsMode(row: CredentialsRow): AuthMode {
  return isAuthMode(row.auth_mode) ? row.auth_mode : "password_certificate"
}

/** Minimum protection level (0 = none, 1..3) the server admin requires to enter. */
function serverMinLevel(serverId: string) {
  const row = db.prepare("SELECT min_auth_level FROM servers WHERE id = ?").get(serverId) as { min_auth_level: number } | undefined
  return row?.min_auth_level ?? 0
}

function levelTooLow(minLevel: number) {
  return { message: `this server requires protection level ${minLevel} or higher`, code: "level_too_low", minLevel }
}

function isCertificateActive(certId: string) {
  const row = db.prepare("SELECT revoked_at FROM member_certificates WHERE id = ?").get(certId) as
    | { revoked_at: string | null }
    | undefined
  return Boolean(row && !row.revoked_at)
}

function activeCertificateCount(serverId: string, clientId: string) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM member_certificates WHERE server_id = ? AND client_id = ? AND revoked_at IS NULL")
    .get(serverId, clientId) as { c: number }
  return row.c
}

function listCertificates(serverId: string, clientId: string) {
  const rows = db
    .prepare(
      `SELECT id, issued_at, last_used_at, revoked_at, revoked_by FROM member_certificates
       WHERE server_id = ? AND client_id = ? ORDER BY issued_at DESC`
    )
    .all(serverId, clientId) as Array<Pick<CertificateRow, "id" | "issued_at" | "last_used_at" | "revoked_at" | "revoked_by">>
  return rows.map((r) => ({
    certId: r.id,
    issuedAt: r.issued_at,
    lastUsedAt: r.last_used_at,
    revokedAt: r.revoked_at,
    revokedByAdmin: Boolean(r.revoked_at && r.revoked_by && r.revoked_by !== clientId)
  }))
}

function securitySummary(serverId: string, clientId: string) {
  const creds = getCredentials(serverId, clientId)
  return {
    minAuthLevel: serverMinLevel(serverId),
    protected: Boolean(creds),
    nick: creds?.nick ?? null,
    authMode: creds ? credentialsMode(creds) : null,
    hasPassword: Boolean(creds?.password_hash),
    certificates: listCertificates(serverId, clientId)
  }
}

/** Why a password-only /v1/join is refused, or null when it is allowed. */
function legacyJoinError(serverId: string, clientId: string) {
  // Never let the old path open a protected profile: client ids are visible to every member.
  if (getCredentials(serverId, clientId)) {
    return { message: "this profile is protected; sign in with your nick, password or certificate", code: "profile_protected" }
  }
  // An unprotected profile is level 0, below any minimum the admin set.
  const minLevel = serverMinLevel(serverId)
  if (minLevel > 0) return levelTooLow(minLevel)
  if (config.legacyJoin === "open") return null
  if (config.legacyJoin === "off") {
    return { message: "password-only join is disabled on this server", code: "legacy_join_disabled" }
  }
  const member = db.prepare("SELECT 1 FROM server_members WHERE server_id = ? AND client_id = ?").get(serverId, clientId)
  if (!member) {
    return { message: "new members create a protected profile; update the client", code: "registration_required" }
  }
  return null
}

function isNickTaken(serverId: string, nick: string, exceptClientId?: string) {
  const key = nickKey(nick)
  const cred = db
    .prepare("SELECT client_id FROM member_credentials WHERE server_id = ? AND nick_key = ?")
    .get(serverId, key) as { client_id: string } | undefined
  if (cred && cred.client_id !== exceptClientId) return true
  // Old (not yet protected) members keep their names, so a newcomer cannot take one.
  const members = db
    .prepare("SELECT client_id, display_name FROM server_members WHERE server_id = ?")
    .all(serverId) as Array<{ client_id: string; display_name: string }>
  return members.some((m) => m.client_id !== exceptClientId && nickKey(m.display_name) === key)
}

function currentServer() {
  return db.prepare("SELECT id, name, access_password_hash FROM servers ORDER BY created_at DESC LIMIT 1").get() as
    | { id: string; name: string; access_password_hash: string }
    | undefined
}

/** Checks the shared server password; the first registration on an empty instance creates the server. */
async function checkServerPassword(
  serverPassword: string,
  options: { createIfMissing: boolean; serverName?: string }
): Promise<{ serverId: string } | { status: number; error: { message: string; code: string } }> {
  if (serverPasswordAttempts.blocked("all")) {
    return { status: 429, error: { message: "too many attempts, try again later", code: "too_many_attempts" } }
  }
  let server = currentServer()
  if (!server) {
    if (!options.createIfMissing) return { status: 404, error: { message: "server not found", code: "server_not_found" } }
    const id = randomUUID()
    const name = options.serverName ?? "Main Server"
    const hash = await bcrypt.hash(serverPassword, 10)
    db.prepare("INSERT INTO servers(id, name, access_password_hash) VALUES (?, ?, ?)").run(id, name, hash)
    ensureDefaultRooms(id)
    server = { id, name, access_password_hash: hash }
  }
  if (!(await bcrypt.compare(serverPassword, server.access_password_hash))) {
    serverPasswordAttempts.record("all")
    return { status: 401, error: { message: "invalid server password", code: "invalid_server_password" } }
  }
  return { serverId: server.id }
}

function issueCertificate(serverId: string, clientId: string, publicKey: string) {
  const certId = randomUUID()
  const issuedAt = new Date().toISOString()
  db.prepare("INSERT INTO member_certificates(id, server_id, client_id, public_key, issued_at) VALUES (?, ?, ?, ?, ?)").run(
    certId,
    serverId,
    clientId,
    publicKey,
    issuedAt
  )
  return signCertificate(certSigningKey, { certId, serverId, clientId, publicKey, issuedAt })
}

/** Drops live WebSocket sessions opened with a certificate (or every session of the member). */
function closeSessions(serverId: string, clientId: string, certId?: string) {
  const sockets = clientSockets.get(clientSocketsKey(serverId, clientId))
  if (!sockets) return
  for (const ws of [...sockets]) {
    const meta = wsClientMeta.get(ws)
    if (certId && meta?.certId !== certId) continue
    try {
      ws.close(4003, "session ended")
    } catch {
      // already closing
    }
  }
}

function revokeCertificate(serverId: string, clientId: string, certId: string, revokedBy: string) {
  const r = db
    .prepare(
      `UPDATE member_certificates SET revoked_at = datetime('now'), revoked_by = ?
       WHERE id = ? AND server_id = ? AND client_id = ? AND revoked_at IS NULL`
    )
    .run(revokedBy, certId, serverId, clientId)
  if (r.changes > 0) closeSessions(serverId, clientId, certId)
  return r.changes > 0
}

const nickSchema = z.string().max(64)
const passwordSchema = z.string().max(256)
const publicKeySchema = z.string().max(128)
const authModeSchema = z.enum(["password", "certificate", "password_certificate"])

/** Checks that what the chosen level needs (password and/or device key) is present and valid. */
function validateProtection(input: { nick?: string; authMode: AuthMode; password?: string; publicKey?: string }) {
  if (input.nick !== undefined && !isValidNick(input.nick)) {
    return { message: "nick must be 2-32 letters, digits, spaces, dots, dashes or underscores", code: "invalid_nick" }
  }
  if (modeNeedsPassword(input.authMode) && !isValidPassword(input.password ?? "")) {
    return { message: "password must be at least 8 characters", code: "weak_password" }
  }
  if (modeNeedsCertificate(input.authMode) && !parseEd25519PublicKey(input.publicKey ?? "")) {
    return { message: "invalid public key", code: "invalid_public_key" }
  }
  return null
}

async function storeCredentials(serverId: string, clientId: string, nick: string, authMode: AuthMode, password?: string) {
  const hash = modeNeedsPassword(authMode) && password ? await bcrypt.hash(password, 10) : ""
  db.prepare(
    "INSERT INTO member_credentials(server_id, client_id, nick, nick_key, password_hash, auth_mode) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(serverId, clientId, nick, nickKey(nick), hash, authMode)
}

function protectionResult(serverId: string, clientId: string, nick: string, authMode: AuthMode, publicKey?: string) {
  const certificate = modeNeedsCertificate(authMode) && publicKey ? issueCertificate(serverId, clientId, publicKey) : null
  return { serverId, clientId, nick, authMode, certificate }
}

app.post("/v1/auth/register", async (req, rep) => {
  const body = z
    .object({
      serverPassword: z.string().min(1).max(256),
      nick: nickSchema,
      // Clients from before protection levels always used certificate + password.
      authMode: authModeSchema.default("password_certificate"),
      password: passwordSchema.optional(),
      publicKey: publicKeySchema.optional(),
      serverName: z.string().min(1).max(64).optional()
    })
    .parse(req.body)
  const nick = normalizeNick(body.nick)
  const invalid = validateProtection({ nick, authMode: body.authMode, password: body.password, publicKey: body.publicKey })
  if (invalid) return rep.code(400).send(invalid)
  const server = await checkServerPassword(body.serverPassword, { createIfMissing: true, serverName: body.serverName })
  if ("error" in server) return rep.code(server.status).send(server.error)
  const minLevel = serverMinLevel(server.serverId)
  if (authLevel(body.authMode) < minLevel) return rep.code(400).send(levelTooLow(minLevel))
  if (isNickTaken(server.serverId, nick)) return rep.code(409).send({ message: "nick is taken", code: "nick_taken" })
  const clientId = randomUUID()
  try {
    await storeCredentials(server.serverId, clientId, nick, body.authMode, body.password)
  } catch {
    return rep.code(409).send({ message: "nick is taken", code: "nick_taken" })
  }
  return rep.code(201).send(protectionResult(server.serverId, clientId, nick, body.authMode, body.publicKey))
})

/** Protects a profile created before protection existed; keeps its nick, messages and history. */
app.post("/v1/auth/claim", async (req, rep) => {
  const body = z
    .object({
      serverPassword: z.string().min(1).max(256),
      clientId: z.string().min(3).max(128),
      authMode: authModeSchema.default("password_certificate"),
      password: passwordSchema.optional(),
      publicKey: publicKeySchema.optional(),
      nick: nickSchema.optional()
    })
    .parse(req.body)
  const server = await checkServerPassword(body.serverPassword, { createIfMissing: false })
  if ("error" in server) return rep.code(server.status).send(server.error)
  const member = db
    .prepare("SELECT display_name FROM server_members WHERE server_id = ? AND client_id = ?")
    .get(server.serverId, body.clientId) as { display_name: string } | undefined
  if (!member) return rep.code(404).send({ message: "profile not found on this server", code: "member_not_found" })
  if (getCredentials(server.serverId, body.clientId)) {
    return rep.code(409).send({ message: "this profile is already protected", code: "profile_protected" })
  }
  const nick = normalizeNick(body.nick ?? member.display_name)
  const invalid = validateProtection({ nick, authMode: body.authMode, password: body.password, publicKey: body.publicKey })
  if (invalid) return rep.code(400).send(invalid)
  const minLevel = serverMinLevel(server.serverId)
  if (authLevel(body.authMode) < minLevel) return rep.code(400).send(levelTooLow(minLevel))
  if (isNickTaken(server.serverId, nick, body.clientId)) {
    return rep.code(409).send({ message: "nick is taken", code: "nick_taken" })
  }
  try {
    await storeCredentials(server.serverId, body.clientId, nick, body.authMode, body.password)
  } catch {
    return rep.code(409).send({ message: "nick is taken", code: "nick_taken" })
  }
  db.prepare("UPDATE server_members SET display_name = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?").run(
    nick,
    server.serverId,
    body.clientId
  )
  // Client ids were visible to everyone, so whoever claims one must not inherit its roles.
  // An admin gets the role back by signing in with the superuser password.
  db.prepare("DELETE FROM member_roles WHERE server_id = ? AND client_id = ?").run(server.serverId, body.clientId)
  return rep.code(201).send(protectionResult(server.serverId, body.clientId, nick, body.authMode, body.publicKey))
})

app.post("/v1/auth/challenge", async (req, rep) => {
  const body = z.object({ certId: z.string().min(1).max(64) }).parse(req.body)
  // Issued for any id, so the endpoint does not reveal which certificates exist.
  return rep.send(loginChallenges.issue(body.certId))
})

async function finishLogin(serverId: string, creds: CredentialsRow, superuserPassword: string | undefined, certId?: string) {
  const server = db.prepare("SELECT id, name FROM servers WHERE id = ?").get(serverId) as { id: string; name: string } | undefined
  if (!server) return null
  ensureDefaultRooms(server.id)
  const minLevel = serverMinLevel(server.id)
  // Below the minimum the member gets a session that can only raise its protection level.
  const limited = authLevel(credentialsMode(creds)) < minLevel
  const joined = await issueJoinForServer({
    serverId: server.id,
    clientId: creds.client_id,
    displayName: creds.nick,
    superuserPassword: limited ? undefined : superuserPassword,
    certId,
    credentialed: true,
    limited
  })
  return {
    ...joined,
    serverName: server.name,
    bannerUrl: getServerBannerUrl(server.id),
    authMode: credentialsMode(creds),
    ...(certId ? { certId } : {}),
    ...(limited ? { upgradeRequired: { minLevel } } : {})
  }
}

/** Levels 2 and 3: device certificate (plus nick + password for level 3). */
app.post("/v1/auth/login", async (req, rep) => {
  const body = z
    .object({
      certId: z.string().min(1).max(64),
      nonce: z.string().min(1).max(128),
      signature: z.string().min(1).max(128),
      nick: nickSchema.optional(),
      password: passwordSchema.optional(),
      superuserPassword: z.string().min(1).max(256).optional()
    })
    .parse(req.body)
  const invalid = { message: "invalid certificate, nick or password", code: "invalid_credentials" }
  if (!loginChallenges.consume(body.nonce, body.certId)) {
    return rep.code(401).send({ message: "login challenge expired, try again", code: "challenge_expired" })
  }
  const cert = db.prepare("SELECT * FROM member_certificates WHERE id = ?").get(body.certId) as CertificateRow | undefined
  const publicKey = cert ? parseEd25519PublicKey(cert.public_key) : null
  if (!cert || !publicKey || !verifyEd25519(publicKey, loginSigningInput(cert.server_id, cert.id, body.nonce), body.signature)) {
    return rep.code(401).send(invalid)
  }
  if (cert.revoked_at) return rep.code(403).send({ message: "this certificate has been revoked", code: "cert_revoked" })
  const creds = getCredentials(cert.server_id, cert.client_id)
  if (!creds) return rep.code(401).send(invalid)
  const mode = credentialsMode(creds)
  if (!modeNeedsCertificate(mode)) {
    return rep.code(403).send({ message: "this profile signs in with nick and password", code: "auth_mode_mismatch", authMode: mode })
  }
  if (modeNeedsPassword(mode)) {
    // The signature already proved possession of the certificate, so telling its holder that this
    // level also needs nick + password reveals nothing new (and is not a failed attempt).
    if (!body.nick && !body.password) {
      return rep.code(401).send({ message: "this profile also needs nick and password", code: "password_required", authMode: mode })
    }
    const limiterKey = `${cert.server_id}:${nickKey(body.nick ?? "")}`
    if (loginFailuresByNick.blocked(limiterKey)) {
      return rep.code(429).send({ message: "too many attempts, try again later", code: "too_many_attempts" })
    }
    const passwordOk = await bcrypt.compare(body.password ?? "", creds.password_hash)
    if (creds.nick_key !== nickKey(body.nick ?? "") || !passwordOk) {
      loginFailuresByNick.record(limiterKey)
      return rep.code(401).send(invalid)
    }
    loginFailuresByNick.reset(limiterKey)
  }
  db.prepare("UPDATE member_certificates SET last_used_at = datetime('now') WHERE id = ?").run(cert.id)
  const out = await finishLogin(cert.server_id, creds, body.superuserPassword, cert.id)
  if (!out) return rep.code(404).send({ message: "server not found", code: "server_not_found" })
  return rep.send(out)
})

/** Level 1: nick + personal password, from any device. */
app.post("/v1/auth/password-login", async (req, rep) => {
  const body = z
    .object({ nick: nickSchema, password: passwordSchema, superuserPassword: z.string().min(1).max(256).optional() })
    .parse(req.body)
  const invalid = { message: "invalid nick or password", code: "invalid_credentials" }
  const server = currentServer()
  if (!server) return rep.code(404).send({ message: "server not found", code: "server_not_found" })
  const key = nickKey(body.nick)
  const limiterKey = `${server.id}:${key}`
  if (loginFailuresByNick.blocked(limiterKey)) {
    return rep.code(429).send({ message: "too many attempts, try again later", code: "too_many_attempts" })
  }
  const creds = db
    .prepare(
      "SELECT client_id, nick, nick_key, password_hash, auth_mode FROM member_credentials WHERE server_id = ? AND nick_key = ?"
    )
    .get(server.id, key) as CredentialsRow | undefined
  const mode = creds ? credentialsMode(creds) : null
  const passwordOk = creds?.password_hash ? await bcrypt.compare(body.password, creds.password_hash) : false
  if (!creds || (mode !== "certificate" && !passwordOk)) {
    loginFailuresByNick.record(limiterKey)
    return rep.code(401).send(invalid)
  }
  if (mode && modeNeedsCertificate(mode)) {
    // Only revealed after the password matched (or for a certificate-only profile, which has none).
    return rep.code(403).send({ message: "this profile needs its certificate", code: "certificate_required", authMode: mode })
  }
  loginFailuresByNick.reset(limiterKey)
  const out = await finishLogin(server.id, creds, body.superuserPassword)
  if (!out) return rep.code(404).send({ message: "server not found", code: "server_not_found" })
  return rep.send(out)
})

app.addHook("preHandler", async (req, rep) => {
  if (!req.url.startsWith("/v1/servers/") || req.url.includes("/join")) return
  let token = req.headers.authorization?.replace("Bearer ", "")
  if (!token && req.method === "GET" && req.url.includes("/attachments/")) {
    const url = new URL(req.url, "http://localhost")
    token = url.searchParams.get("token") ?? undefined
  }
  if (!token) return rep.code(401).send({ message: "missing auth token" })
  const payload = verifyToken(token, config.tokenSecret)
  if (!payload || payload.sub !== "auth") return rep.code(401).send({ message: "invalid token" })
  if (payload.certId && !isCertificateActive(payload.certId)) {
    return rep.code(401).send({ message: "certificate revoked", code: "cert_revoked" })
  }
  if (payload.credentialed && !getCredentials(payload.serverId, payload.clientId)) {
    return rep.code(401).send({ message: "access was reset by an admin", code: "session_expired" })
  }
  if (payload.limited) {
    const path = req.url.split("?")[0]
    const allowed =
      (req.method === "GET" && /^\/v1\/servers\/[^/]+\/me\/security$/.test(path)) ||
      (req.method === "POST" && /^\/v1\/servers\/[^/]+\/me\/auth-mode$/.test(path))
    if (!allowed) return rep.code(403).send(levelTooLow(serverMinLevel(payload.serverId)))
  }
  ;(req as any).auth = payload
})

function requirePermission(rep: any, serverId: string, clientId: string, permission: PermissionKey) {
  const info = getMemberPermissions(serverId, clientId)
  if (!info.permissions[permission]) {
    rep.code(403).send({ message: "forbidden" })
    return null
  }
  return info
}

app.get("/v1/servers/:serverId/me/security", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string; certId?: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  return rep.send({ ...securitySummary(params.serverId, auth.clientId), currentCertId: auth.certId ?? null })
})

/** Change the protection level. Needs the current password when the profile has one. */
app.post("/v1/servers/:serverId/me/auth-mode", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z
    .object({
      authMode: authModeSchema,
      currentPassword: passwordSchema.optional(),
      newPassword: passwordSchema.optional(),
      publicKey: publicKeySchema.optional()
    })
    .parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const creds = getCredentials(params.serverId, auth.clientId)
  if (!creds) return rep.code(409).send({ message: "this profile is not protected yet", code: "profile_not_protected" })
  const minLevel = serverMinLevel(params.serverId)
  if (authLevel(body.authMode) < minLevel) return rep.code(400).send(levelTooLow(minLevel))
  const limiterKey = `${params.serverId}:${creds.nick_key}`
  if (creds.password_hash) {
    if (loginFailuresByNick.blocked(limiterKey)) {
      return rep.code(429).send({ message: "too many attempts, try again later", code: "too_many_attempts" })
    }
    if (!(await bcrypt.compare(body.currentPassword ?? "", creds.password_hash))) {
      loginFailuresByNick.record(limiterKey)
      return rep.code(401).send({ message: "current password is wrong", code: "invalid_credentials" })
    }
  }
  let passwordHash = ""
  if (modeNeedsPassword(body.authMode)) {
    if (body.newPassword) {
      if (!isValidPassword(body.newPassword)) {
        return rep.code(400).send({ message: "password must be at least 8 characters", code: "weak_password" })
      }
      passwordHash = await bcrypt.hash(body.newPassword, 10)
    } else if (creds.password_hash) {
      passwordHash = creds.password_hash
    } else {
      return rep.code(400).send({ message: "set a password for this level", code: "weak_password" })
    }
  }
  let certificate = null
  if (modeNeedsCertificate(body.authMode)) {
    if (body.publicKey) {
      if (!parseEd25519PublicKey(body.publicKey)) return rep.code(400).send({ message: "invalid public key", code: "invalid_public_key" })
      certificate = issueCertificate(params.serverId, auth.clientId, body.publicKey)
    } else if (activeCertificateCount(params.serverId, auth.clientId) === 0) {
      return rep.code(400).send({ message: "this level needs a certificate", code: "certificate_required" })
    }
  }
  db.prepare(
    "UPDATE member_credentials SET auth_mode = ?, password_hash = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?"
  ).run(body.authMode, passwordHash, params.serverId, auth.clientId)
  return rep.send({ authMode: body.authMode, certificate })
})

app.post("/v1/servers/:serverId/me/certificates/:certId/revoke", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), certId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const creds = getCredentials(params.serverId, auth.clientId)
  // Revoking the last certificate of a certificate level would lock the member out for good.
  if (
    creds &&
    modeNeedsCertificate(credentialsMode(creds)) &&
    isCertificateActive(params.certId) &&
    activeCertificateCount(params.serverId, auth.clientId) <= 1
  ) {
    return rep.code(409).send({ message: "this is your last certificate; change the protection level first", code: "last_certificate" })
  }
  if (!revokeCertificate(params.serverId, auth.clientId, params.certId, auth.clientId)) {
    return rep.code(404).send({ message: "certificate not found or already revoked" })
  }
  return rep.send({ ok: true })
})

app.post("/v1/servers/:serverId/me/password", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ currentPassword: passwordSchema, newPassword: passwordSchema }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const creds = getCredentials(params.serverId, auth.clientId)
  if (!creds?.password_hash) return rep.code(409).send({ message: "this profile has no password", code: "no_password" })
  const limiterKey = `${params.serverId}:${creds.nick_key}`
  if (loginFailuresByNick.blocked(limiterKey)) {
    return rep.code(429).send({ message: "too many attempts, try again later", code: "too_many_attempts" })
  }
  if (!(await bcrypt.compare(body.currentPassword, creds.password_hash))) {
    loginFailuresByNick.record(limiterKey)
    return rep.code(401).send({ message: "current password is wrong", code: "invalid_credentials" })
  }
  if (!isValidPassword(body.newPassword)) {
    return rep.code(400).send({ message: "password must be at least 8 characters", code: "weak_password" })
  }
  const hash = await bcrypt.hash(body.newPassword, 10)
  db.prepare("UPDATE member_credentials SET password_hash = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?").run(
    hash,
    params.serverId,
    auth.clientId
  )
  return rep.send({ ok: true })
})

app.get("/v1/servers/:serverId/security-policy", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  return rep.send({ minAuthLevel: serverMinLevel(params.serverId) })
})

/** Admin: minimum protection level to enter (0 none, 1 password, 2 certificate, 3 both). */
app.patch("/v1/servers/:serverId/security-policy", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ minAuthLevel: z.number().int().min(0).max(3) }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_server")) return
  const own = getCredentials(params.serverId, auth.clientId)
  const ownLevel = authLevel(own ? credentialsMode(own) : null)
  if (ownLevel < body.minAuthLevel) {
    return rep.code(409).send({
      message: "raise your own protection level first, or you would lock yourself out",
      code: "own_level_too_low",
      ownLevel
    })
  }
  db.prepare("UPDATE servers SET min_auth_level = ? WHERE id = ?").run(body.minAuthLevel, params.serverId)
  // Members now below the minimum are disconnected; signing in again asks them to raise their level.
  for (const [ws, meta] of wsClientMeta) {
    if (meta.serverId !== params.serverId) continue
    const creds = getCredentials(params.serverId, meta.clientId)
    if (authLevel(creds ? credentialsMode(creds) : null) < body.minAuthLevel) {
      try {
        ws.close(4004, "protection level too low")
      } catch {
        // already closing
      }
    }
  }
  return rep.send({ minAuthLevel: body.minAuthLevel })
})

app.get("/v1/servers/:serverId/members/:clientId/security", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_server")) return
  return rep.send(securitySummary(params.serverId, params.clientId))
})

app.post("/v1/servers/:serverId/members/:clientId/certificates/:certId/revoke", async (req, rep) => {
  const params = z
    .object({ serverId: z.string().min(1), clientId: z.string().min(1), certId: z.string().min(1) })
    .parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_server")) return
  if (!revokeCertificate(params.serverId, params.clientId, params.certId, auth.clientId)) {
    return rep.code(404).send({ message: "certificate not found or already revoked" })
  }
  return rep.send({ ok: true })
})

/** Lost device and password: drop the member's password and certificates so they can claim the profile again. */
app.post("/v1/servers/:serverId/members/:clientId/reset-credentials", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_server")) return
  db.prepare(
    "UPDATE member_certificates SET revoked_at = datetime('now'), revoked_by = ? WHERE server_id = ? AND client_id = ? AND revoked_at IS NULL"
  ).run(auth.clientId, params.serverId, params.clientId)
  db.prepare("DELETE FROM member_credentials WHERE server_id = ? AND client_id = ?").run(params.serverId, params.clientId)
  closeSessions(params.serverId, params.clientId)
  return rep.send({ ok: true })
})

app.get("/v1/servers/:serverId", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const server = db
    .prepare("SELECT id, name, banner_url FROM servers WHERE id = ?")
    .get(params.serverId) as { id: string; name: string; banner_url: string | null } | undefined
  if (!server) return rep.code(404).send({ message: "server not found" })
  return rep.send({ id: server.id, name: server.name, bannerUrl: getServerBannerUrl(server.id) })
})

app.patch("/v1/servers/:serverId", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ bannerUrl: z.string().max(2048).nullable().optional() }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_server")) return
  let bannerUrl: string | null = null
  if (body.bannerUrl !== undefined && body.bannerUrl !== null) {
    const trimmed = body.bannerUrl.trim()
    bannerUrl = trimmed || null
  }
  db.prepare("UPDATE servers SET banner_url = ? WHERE id = ?").run(bannerUrl, params.serverId)
  emitToServer(params.serverId, { type: "server_appearance_updated", bannerUrl })
  return rep.send({ bannerUrl })
})

app.get("/v1/servers/:serverId/me", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const me = db
    .prepare("SELECT client_id, display_name FROM server_members WHERE server_id = ? AND client_id = ?")
    .get(params.serverId, auth.clientId) as { client_id: string; display_name: string } | undefined
  if (!me) return rep.code(404).send({ message: "profile not found" })
  const access = getMemberPermissions(params.serverId, auth.clientId)
  return rep.send({ clientId: me.client_id, displayName: me.display_name, roles: access.roles, permissions: access.permissions })
})

app.patch("/v1/servers/:serverId/me", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ displayName: z.string().min(1) }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  db.prepare("UPDATE server_members SET display_name = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?").run(
    body.displayName,
    params.serverId,
    auth.clientId
  )
  const snap = getMemberSnapshot(params.serverId, auth.clientId)
  if (snap) {
    emitToServer(params.serverId, {
      type: "member_updated",
      member: {
        clientId: snap.client_id,
        displayName: snap.display_name,
        roomId: snap.room_id,
        muted: Boolean(snap.muted),
        deafened: Boolean(snap.deafened),
        speaking: Boolean(snap.speaking)
      }
    })
  }
  return rep.send({ ok: true, displayName: body.displayName })
})

app.post("/v1/servers/:serverId/rooms", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ name: z.string().min(1), kind: z.enum(["voice", "text"]).default("voice") }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_channels")) return
  const id = randomUUID()
  db.prepare("INSERT INTO rooms(id, server_id, name, kind, options) VALUES (?, ?, ?, ?, '{}')").run(id, params.serverId, body.name, body.kind)
  const rooms = getRooms(params.serverId)
  emitToServer(params.serverId, { type: "rooms_updated", rooms })
  return rep.send({ id, name: body.name, kind: body.kind })
})

app.get("/v1/servers/:serverId/roles", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const access = requirePermission(rep, params.serverId, auth.clientId, "manage_roles")
  if (!access) return
  const roles = db
    .prepare("SELECT id, role_key, name, permissions_json, is_system FROM server_roles WHERE server_id = ? ORDER BY created_at ASC")
    .all(params.serverId) as Array<{ id: string; role_key: string; name: string; permissions_json: string; is_system: number }>
  return rep.send({
    roles: roles.map((r) => ({
      id: r.id,
      key: r.role_key,
      name: r.name,
      isSystem: Boolean(r.is_system),
      permissions: JSON.parse(r.permissions_json) as PermissionMap
    })),
    me: access
  })
})

app.post("/v1/servers/:serverId/roles", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const body = z.object({ name: z.string().min(1), permissions: z.record(z.string(), z.boolean()).default({}) }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_roles")) return
  const roleId = randomUUID()
  const roleKey = `custom-${roleId.slice(0, 8)}`
  db.prepare("INSERT INTO server_roles(id, server_id, role_key, name, permissions_json, is_system) VALUES (?, ?, ?, ?, ?, 0)").run(
    roleId,
    params.serverId,
    roleKey,
    body.name,
    JSON.stringify(body.permissions)
  )
  return rep.send({ id: roleId, key: roleKey, name: body.name, permissions: body.permissions, isSystem: false })
})

/** Every registered member (online or not) with roles, for the member list and role management. */
app.get("/v1/servers/:serverId/members", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const rows = db
    .prepare(
      `SELECT client_id, display_name, created_at FROM server_members WHERE server_id = ?
       UNION ALL
       SELECT mc.client_id, mc.nick, mc.created_at FROM member_credentials mc
       WHERE mc.server_id = ? AND NOT EXISTS (
         SELECT 1 FROM server_members sm WHERE sm.server_id = mc.server_id AND sm.client_id = mc.client_id
       )
       ORDER BY 2 COLLATE NOCASE ASC`
    )
    .all(params.serverId, params.serverId) as Array<{ client_id: string; display_name: string; created_at: string }>
  const roleRows = db
    .prepare(
      `SELECT mr.client_id, r.id, r.role_key, r.name
       FROM member_roles mr JOIN server_roles r ON r.id = mr.role_id
       WHERE mr.server_id = ?`
    )
    .all(params.serverId) as Array<{ client_id: string; id: string; role_key: string; name: string }>
  const rolesByClient = new Map<string, Array<{ id: string; key: string; name: string }>>()
  for (const r of roleRows) {
    const list = rolesByClient.get(r.client_id) ?? []
    list.push({ id: r.id, key: r.role_key, name: r.name })
    rolesByClient.set(r.client_id, list)
  }
  return rep.send({
    members: rows.map((m) => {
      const roles = rolesByClient.get(m.client_id) ?? []
      return {
        clientId: m.client_id,
        displayName: m.display_name,
        roles,
        isAdmin: roles.some((r) => r.key === "admin"),
        joinedAt: m.created_at
      }
    })
  })
})

function countAdmins(serverId: string) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM member_roles mr JOIN server_roles r ON r.id = mr.role_id
       WHERE mr.server_id = ? AND r.role_key = 'admin'`
    )
    .get(serverId) as { n: number }
  return row.n
}

/** Grant (PUT) or take away (DELETE) the built-in admin role. The last admin cannot be removed. */
app.put("/v1/servers/:serverId/members/:clientId/admin", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_roles")) return
  const member = db
    .prepare(
      `SELECT client_id FROM server_members WHERE server_id = ? AND client_id = ?
       UNION SELECT client_id FROM member_credentials WHERE server_id = ? AND client_id = ?`
    )
    .get(params.serverId, params.clientId, params.serverId, params.clientId)
  if (!member) return rep.code(404).send({ code: "unknown_member", message: "member not found" })
  ensureMemberHasRole(params.serverId, params.clientId, ensureAdminRole(params.serverId))
  emitToServer(params.serverId, { type: "members_changed", clientId: params.clientId })
  return rep.send({ ok: true, isAdmin: true })
})

app.delete("/v1/servers/:serverId/members/:clientId/admin", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_roles")) return
  const adminRoleId = ensureAdminRole(params.serverId)
  const has = db
    .prepare("SELECT 1 FROM member_roles WHERE server_id = ? AND client_id = ? AND role_id = ?")
    .get(params.serverId, params.clientId, adminRoleId)
  if (!has) return rep.send({ ok: true, isAdmin: false })
  if (countAdmins(params.serverId) <= 1) {
    return rep.code(400).send({ code: "last_admin", message: "the server needs at least one admin" })
  }
  db.prepare("DELETE FROM member_roles WHERE server_id = ? AND client_id = ? AND role_id = ?").run(
    params.serverId,
    params.clientId,
    adminRoleId
  )
  emitToServer(params.serverId, { type: "members_changed", clientId: params.clientId })
  return rep.send({ ok: true, isAdmin: false })
})

app.post("/v1/servers/:serverId/members/:clientId/roles/:roleId", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1), roleId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_roles")) return
  const role = db
    .prepare("SELECT id FROM server_roles WHERE id = ? AND server_id = ?")
    .get(params.roleId, params.serverId) as { id: string } | undefined
  if (!role) return rep.code(404).send({ message: "role not found" })
  ensureMemberHasRole(params.serverId, params.clientId, params.roleId)
  return rep.send({ ok: true })
})

app.delete("/v1/servers/:serverId/members/:clientId/roles/:roleId", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), clientId: z.string().min(1), roleId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_roles")) return
  const role = db
    .prepare("SELECT role_key, is_system FROM server_roles WHERE id = ? AND server_id = ?")
    .get(params.roleId, params.serverId) as { role_key: string; is_system: number } | undefined
  if (!role) return rep.code(404).send({ message: "role not found" })
  if (role.role_key === "admin" && role.is_system) {
    return rep.code(400).send({ message: "cannot remove built-in admin role" })
  }
  db.prepare("DELETE FROM member_roles WHERE server_id = ? AND client_id = ? AND role_id = ?").run(
    params.serverId,
    params.clientId,
    params.roleId
  )
  return rep.send({ ok: true })
})

/** Channel rules: microphones and/or streams allowed in a voice channel (admins). */
app.patch("/v1/servers/:serverId/rooms/:roomId/policy", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), roomId: z.string().min(1) }).parse(req.params)
  const body = z.object({ allowMic: z.boolean().optional(), allowStreams: z.boolean().optional() }).parse(req.body ?? {})
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!requirePermission(rep, params.serverId, auth.clientId, "manage_channels")) return
  const row = db.prepare("SELECT name, kind, options FROM rooms WHERE server_id = ? AND id = ? LIMIT 1").get(params.serverId, params.roomId) as
    | Pick<RoomRow, "name" | "kind" | "options">
    | undefined
  if (!row || row.kind !== "voice") return rep.code(404).send({ message: "voice room not found" })
  const options = { ...parseRoomOptions(row.options) }
  if (body.allowMic !== undefined) options.allowMic = body.allowMic
  if (body.allowStreams !== undefined) options.allowStreams = body.allowStreams
  const raw = JSON.stringify(options)
  db.prepare("UPDATE rooms SET options = ? WHERE server_id = ? AND id = ?").run(raw, params.serverId, params.roomId)
  const policy = policyOf({ ...row, options: raw })
  emitToServer(params.serverId, { type: "rooms_updated", rooms: getRooms(params.serverId) })
  await applyRoomPolicy(params.serverId, params.roomId, policy)
  return rep.send({ ok: true, policy })
})

app.get("/v1/servers/:serverId/rooms", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  return rep.send({ rooms: getRooms(params.serverId) })
})

app.post("/v1/servers/:serverId/rooms/:roomId/sfu-token", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), roomId: z.string().min(1) }).parse(req.params)
  // purpose=screen: a second, publish-only participant "<clientId>:screen" for screen sharing from
  // a phone (the Android app publishes natively, next to its WebView voice/LiveKit session).
  const query = z.object({ purpose: z.enum(["media", "screen"]).default("media") }).parse(req.query ?? {})
  const auth = (req as any).auth as { serverId: string; clientId: string; displayName?: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  if (!config.livekitUrl || !config.livekitApiKey || !config.livekitApiSecret) {
    return rep.code(503).send({ message: "SFU is not configured" })
  }
  const room = db
    .prepare("SELECT id, kind FROM rooms WHERE server_id = ? AND id = ? LIMIT 1")
    .get(params.serverId, params.roomId) as { id: string; kind: "voice" | "text" } | undefined
  if (!room || room.kind !== "voice") return rep.code(404).send({ message: "voice room not found" })
  const member = db
    .prepare("SELECT display_name FROM server_members WHERE server_id = ? AND client_id = ? LIMIT 1")
    .get(params.serverId, auth.clientId) as { display_name: string } | undefined
  const roomName = `${params.serverId}:${params.roomId}`
  const screen = query.purpose === "screen"
  const policy = getRoomPolicy(params.serverId, params.roomId)
  if (screen && !policy.allowStreams) return rep.code(403).send({ message: "streams are disabled in this channel", code: "streams_disabled" })
  const sources = livekitSources(policy, screen)
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: screen ? `${auth.clientId}:screen` : auth.clientId,
    name: member?.display_name ?? auth.displayName ?? auth.clientId,
    ttl: config.livekitTokenTtlSec
  })
  token.addGrant({
    room: roomName,
    roomJoin: true,
    canPublish: sources.length > 0,
    canPublishSources: sources,
    canSubscribe: !screen,
    canPublishData: !screen
  })
  return rep.send({
    enabled: true,
    url: config.livekitUrl,
    token: await token.toJwt(),
    roomName,
    expiresInSec: config.livekitTokenTtlSec
  })
})

app.post("/v1/servers/:serverId/channels/:channelId/attachments", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), channelId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  const token = req.headers.authorization?.replace("Bearer ", "") ?? ""
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const channel = db
    .prepare("SELECT id, kind FROM rooms WHERE id = ? AND server_id = ?")
    .get(params.channelId, params.serverId) as { id: string; kind: "voice" | "text" } | undefined
  if (!channel || channel.kind !== "text") return rep.code(400).send({ message: "attachments allowed only in text channels" })

  const mime = String(req.headers["x-file-mime"] ?? "").toLowerCase()
  const originalName = String(req.headers["x-file-name"] ?? "upload.bin")
  if (!mime || !isAllowedAttachmentMime(mime)) {
    return rep.code(400).send({ message: "unsupported file type" })
  }
  const maxBytes = config.uploadMaxMb * 1024 * 1024
  const rawBody = req.body
  const chunks: Buffer[] = []
  let size = 0
  if (Buffer.isBuffer(rawBody)) {
    size = rawBody.length
    if (size > maxBytes) {
      return rep.code(400).send({ message: `file too large, max ${config.uploadMaxMb}MB` })
    }
    chunks.push(rawBody)
  } else {
    for await (const chunk of req.raw) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buf.length
      if (size > maxBytes) {
        return rep.code(400).send({ message: `file too large, max ${config.uploadMaxMb}MB` })
      }
      chunks.push(buf)
    }
  }
  if (size === 0) return rep.code(400).send({ message: "file is required" })

  const attachmentId = randomUUID()
  const safeName = sanitizeFilename(originalName)
  const ext = extname(safeName) || ".bin"
  const relPath = join(params.serverId, params.channelId, `${attachmentId}${ext}`)
  const absPath = resolvePath(config.uploadDir, relPath)
  if (!absPath.startsWith(resolvePath(config.uploadDir))) {
    return rep.code(400).send({ message: "invalid file path" })
  }
  mkdirSync(dirname(absPath), { recursive: true })
  const stream = createWriteStream(absPath)
  await pipeline(Readable.from(chunks), stream)
  const writtenSize = statSync(absPath).size

  db.prepare(
    `INSERT INTO message_attachments(
      id, message_id, server_id, channel_id, uploader_client_id, storage_path, original_name, mime, size_bytes, width, height, duration_ms
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
  ).run(attachmentId, params.serverId, params.channelId, auth.clientId, absPath, safeName, mime, writtenSize)
  app.log.info(
    { serverId: params.serverId, channelId: params.channelId, attachmentId, clientId: auth.clientId, mime, sizeBytes: writtenSize },
    "chat attachment uploaded"
  )

  return rep.send({
    attachment: {
      id: attachmentId,
      name: safeName,
      mime,
      sizeBytes: writtenSize,
      url: attachmentUrl(params.serverId, attachmentId, token)
    }
  })
})

app.get("/v1/servers/:serverId/attachments/:attachmentId", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), attachmentId: z.string().uuid() }).parse(req.params)
  const query = z.object({ token: z.string().optional() }).parse(req.query)
  const bearerToken = req.headers.authorization?.replace("Bearer ", "")
  const token = bearerToken || query.token
  if (!token) return rep.code(401).send({ message: "missing auth token" })
  const payload = verifyToken(token, config.tokenSecret)
  if (!payload || payload.sub !== "auth") return rep.code(401).send({ message: "invalid token" })
  if (payload.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const row = db
    .prepare(
      `SELECT id, message_id, server_id, channel_id, uploader_client_id, storage_path, original_name, mime, size_bytes
       FROM message_attachments
       WHERE id = ? AND server_id = ?`
    )
    .get(params.attachmentId, params.serverId) as AttachmentRow | undefined
  if (!row) return rep.code(404).send({ message: "attachment not found" })
  const safeRoot = resolvePath(config.uploadDir)
  const absPath = resolvePath(row.storage_path)
  if (!absPath.startsWith(safeRoot)) return rep.code(403).send({ message: "forbidden" })
  rep.header("Content-Type", row.mime)
  rep.header("Content-Length", String(row.size_bytes))
  rep.header("Content-Disposition", `inline; filename=\"${row.original_name}\"`)
  return rep.send(createReadStream(absPath))
})

app.get("/v1/servers/:serverId/channels/:channelId/messages", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), channelId: z.string().min(1) }).parse(req.params)
  const query = z.object({ limit: z.coerce.number().min(1).max(100).default(50), cursor: z.string().optional() }).parse(req.query)
  const token = req.headers.authorization?.replace("Bearer ", "") ?? ""
  const auth = (req as any).auth as { serverId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  /** Pagination by time: UUID order is not chronological. Cursor = id of oldest message in previous page. */
  const cursorClause = query.cursor
    ? `AND (
         datetime(m.created_at) < (SELECT datetime(created_at) FROM messages WHERE id = ? AND server_id = ? AND channel_id = ?)
         OR (
           datetime(m.created_at) = (SELECT datetime(created_at) FROM messages WHERE id = ? AND server_id = ? AND channel_id = ?)
           AND m.id < ?
         )
       )`
    : ""
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.body, m.created_at, m.client_id, sm.display_name
       FROM messages m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.client_id = m.client_id
       WHERE m.server_id = ? AND m.channel_id = ? ${cursorClause}
       ORDER BY datetime(m.created_at) DESC, m.id DESC LIMIT ?`
    )
    .all(
      ...(query.cursor
        ? [
            params.serverId,
            params.channelId,
            query.cursor,
            params.serverId,
            params.channelId,
            query.cursor,
            params.serverId,
            params.channelId,
            query.cursor,
            query.limit
          ]
        : [params.serverId, params.channelId, query.limit])
    ) as Array<{
      id: string
      channel_id: string
      body: string
      created_at: string
      client_id: string
      display_name: string
    }>
  const messageIds = rows.map((row) => row.id)
  const attachmentsByMessageId = getAttachmentsByMessageIds(params.serverId, messageIds, token)
  const messages = rows
    .map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      author: { clientId: row.client_id, displayName: row.display_name },
      body: row.body,
      createdAt: sqliteUtcToIso(row.created_at),
      attachments: attachmentsByMessageId.get(row.id) ?? []
    }))
    .reverse()
  const nextCursor = rows.length === query.limit ? rows[rows.length - 1].id : null
  return rep.send({ messages, nextCursor })
})

app.post("/v1/servers/:serverId/channels/:channelId/messages", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), channelId: z.string().min(1) }).parse(req.params)
  const body = z
    .object({
      body: z.string().max(2000).optional().default(""),
      attachmentIds: z.array(z.string().uuid()).max(10).optional().default([])
    })
    .parse(req.body)
  const token = req.headers.authorization?.replace("Bearer ", "") ?? ""
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const channel = db
    .prepare("SELECT id, kind FROM rooms WHERE id = ? AND server_id = ?")
    .get(params.channelId, params.serverId) as { id: string; kind: "voice" | "text" } | undefined
  if (!channel || channel.kind !== "text") return rep.code(400).send({ message: "chat allowed only in text channels" })
  if (body.body.trim().length === 0 && body.attachmentIds.length === 0) {
    return rep.code(400).send({ message: "message body or attachments required" })
  }
  if (body.attachmentIds.length > 0) {
    const placeholders = body.attachmentIds.map(() => "?").join(",")
    const rows = db
      .prepare(
        `SELECT id FROM message_attachments
         WHERE server_id = ? AND channel_id = ? AND uploader_client_id = ? AND message_id IS NULL AND id IN (${placeholders})`
      )
      .all(params.serverId, params.channelId, auth.clientId, ...body.attachmentIds) as Array<{ id: string }>
    if (rows.length !== body.attachmentIds.length) {
      return rep.code(400).send({ message: "invalid attachmentIds" })
    }
  }
  const id = randomUUID()
  db.prepare("INSERT INTO messages(id, server_id, channel_id, client_id, body) VALUES (?, ?, ?, ?, ?)").run(
    id,
    params.serverId,
    params.channelId,
    auth.clientId,
    body.body.trim()
  )
  if (body.attachmentIds.length > 0) {
    const update = db.prepare("UPDATE message_attachments SET message_id = ? WHERE server_id = ? AND id = ?")
    for (const attachmentId of body.attachmentIds) {
      update.run(id, params.serverId, attachmentId)
    }
  }
  const member = db
    .prepare("SELECT display_name FROM server_members WHERE server_id = ? AND client_id = ?")
    .get(params.serverId, auth.clientId) as { display_name: string } | undefined
  const createdRow = db
    .prepare("SELECT created_at FROM messages WHERE id = ? AND server_id = ?")
    .get(id, params.serverId) as { created_at: string } | undefined
  const createdAt = sqliteUtcToIso(createdRow?.created_at ?? new Date().toISOString())
  const message = {
    id,
    channelId: params.channelId,
    author: { clientId: auth.clientId, displayName: member?.display_name ?? auth.clientId },
    body: body.body.trim(),
    createdAt,
    attachments: getAttachmentsByMessageIds(params.serverId, [id], token).get(id) ?? []
  }
  emitToServer(params.serverId, { type: "chat_message", message })
  return rep.send({ message })
})

/**
 * Voice media over WebSocket for clients without UDP/TCP (phones, browsers): binary frames, the
 * first one HELLO2 with the media token, then the same encrypted packets as on UDP/TCP.
 */
app.get("/v1/media/ws", { websocket: true }, (socket, req) => {
  const connId = randomUUID()
  const label = `ws:${req.headers["x-forwarded-for"] ?? req.ip}`
  const conn = attachMediaSocket(connId, label, {
    send: (data) => {
      if (socket.readyState === socket.OPEN) socket.send(data)
    },
    close: () => socket.close(4000, "media session ended"),
    bufferedAmount: () => socket.bufferedAmount
  })
  socket.binaryType = "nodebuffer"
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary || data.length > 64 * 1024) return
    conn.data(data)
  })
  socket.on("close", () => conn.closed())
})

app.get("/v1/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url ?? "", "http://localhost")
  const token = url.searchParams.get("token")
  if (!token) return socket.close(4001, "missing token")
  const auth = verifyToken(token, config.tokenSecret)
  if (!auth || auth.sub !== "auth") return socket.close(4002, "invalid token")
  if (auth.certId && !isCertificateActive(auth.certId)) return socket.close(4003, "certificate revoked")
  if (auth.credentialed && !getCredentials(auth.serverId, auth.clientId)) return socket.close(4003, "session ended")
  if (auth.limited) return socket.close(4004, "protection level too low")

  const key = auth.serverId
  const set = clients.get(key) ?? new Set<WebSocket>()
  set.add(socket)
  clients.set(key, set)
  wsClientMeta.set(socket, { serverId: auth.serverId, clientId: auth.clientId, certId: auth.certId })
  const sockKey = clientSocketsKey(auth.serverId, auth.clientId)
  const sockSet = clientSockets.get(sockKey) ?? new Set<WebSocket>()
  sockSet.add(socket)
  clientSockets.set(sockKey, sockSet)
  touchLastSeen(auth.serverId, auth.clientId)

  socket.send(
    JSON.stringify({
      type: "hello",
      clientId: auth.clientId,
      serverId: auth.serverId,
      serverGeneration,
      bannerUrl: getServerBannerUrl(auth.serverId)
    } satisfies WsServerEvent)
  )
  socket.send(JSON.stringify({ type: "rooms_snapshot", rooms: getRooms(auth.serverId) } satisfies WsServerEvent))
  sendPresenceSnapshotToSocket(socket, auth.serverId)
  for (const [clientId, state] of screenShareStateByClient.entries()) {
    if (state.serverId !== auth.serverId || !state.active) continue
    socket.send(JSON.stringify({ type: "screen_share_state", clientId, roomId: state.roomId, active: true } satisfies WsServerEvent))
  }

  socket.onmessage = (msg: { data: unknown }) => {
    try {
      const event = JSON.parse(String(msg.data)) as WsClientEvent
      if (event.type === "join_room") {
        const prevRow = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const prevRoomId = prevRow?.room_id ?? null
        const forceMuted = !getRoomPolicy(auth.serverId, event.roomId).allowMic
        db.prepare(
          "UPDATE member_state SET room_id = ?, speaking = 0, muted = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?"
        ).run(event.roomId, forceMuted ? 1 : 0, auth.serverId, auth.clientId)
        setMemberRoom(auth.clientId, event.roomId)
        setMemberSpeaking(auth.clientId, false)
        setMemberFlags(auth.clientId, forceMuted, false)
        const prevShare = screenShareStateByClient.get(auth.clientId)
        const keepScreenShareActive =
          Boolean(
            prevShare?.active &&
              prevShare.serverId === auth.serverId &&
              prevShare.roomId === event.roomId
          )
        screenShareStateByClient.set(auth.clientId, {
          serverId: auth.serverId,
          roomId: event.roomId,
          active: keepScreenShareActive
        })
        db.prepare("UPDATE member_state SET screen_sharing = ? WHERE server_id = ? AND client_id = ?").run(
          keepScreenShareActive ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        if (keepScreenShareActive) {
          emitScreenShareState(auth.serverId, auth.clientId, event.roomId, true)
        } else {
          emitScreenShareState(auth.serverId, auth.clientId, event.roomId, false)
        }
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
        emitRosterSnapshots(auth.serverId, [prevRoomId, event.roomId, null])
        if (isVoiceRoomId(auth.serverId, event.roomId)) {
          markForceScreenRelay(event.roomId, auth.clientId)
          notifyActiveScreenSharerToResync(auth.serverId, event.roomId, auth.clientId)
        }
      } else if (event.type === "request_screen_resync") {
        const row = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        if (row?.room_id !== event.roomId) return
        if (!isVoiceRoomId(auth.serverId, event.roomId)) return
        markForceScreenRelay(event.roomId, auth.clientId)
        notifyActiveScreenSharerToResync(auth.serverId, event.roomId, auth.clientId, event.fallback ?? true)
      } else if (event.type === "leave_room") {
        const prevRow = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const prevRoomId = prevRow?.room_id ?? null
        db.prepare(
          "UPDATE member_state SET room_id = NULL, speaking = 0, screen_sharing = 0, watching_screen = 0 WHERE server_id = ? AND client_id = ?"
        ).run(auth.serverId, auth.clientId)
        setMemberRoom(auth.clientId, null)
        setMemberSpeaking(auth.clientId, false)
        for (const forced of forceScreenRelayByRoom.values()) {
          forced.delete(auth.clientId)
        }
        screenShareStateByClient.set(auth.clientId, { serverId: auth.serverId, roomId: null, active: false })
        emitScreenShareState(auth.serverId, auth.clientId, prevRoomId, false)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
        emitRosterSnapshots(auth.serverId, [prevRoomId, null])
      } else if (event.type === "sync_presence") {
        const prevSnap = getMemberSnapshot(auth.serverId, auth.clientId)
        const prevRoomId = prevSnap?.room_id ?? null
        const roomId = event.roomId
        const roomPolicy = roomId ? getRoomPolicy(auth.serverId, roomId) : { allowMic: true, allowStreams: true }
        const forceMuted = !roomPolicy.allowMic
        const effectiveMuted = forceMuted ? true : event.muted
        const roomChanged = prevRoomId !== roomId
        const mediaEngine = event.mediaEngine === "webrtc" ? "webrtc" : "legacy"
        db.prepare(
          `UPDATE member_state SET room_id = ?, muted = ?, deafened = ?, screen_sharing = ?, watching_screen = ?,
           media_engine = ?,
           speaking = CASE WHEN ? THEN 0 ELSE speaking END, last_seen = datetime('now')
           WHERE server_id = ? AND client_id = ?`
        ).run(
          roomId,
          effectiveMuted ? 1 : 0,
          event.deafened ? 1 : 0,
          event.screenSharing && roomPolicy.allowStreams ? 1 : 0,
          event.watchingScreen ? 1 : 0,
          mediaEngine,
          roomChanged ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        setMemberRoom(auth.clientId, roomId)
        setMemberFlags(auth.clientId, effectiveMuted, event.deafened)
        if (roomChanged) setMemberSpeaking(auth.clientId, false)
        const active = Boolean(event.screenSharing && roomId && roomPolicy.allowStreams)
        screenShareStateByClient.set(auth.clientId, { serverId: auth.serverId, roomId, active })
        emitScreenShareState(auth.serverId, auth.clientId, roomId, active)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
        emitRosterSnapshots(auth.serverId, [prevRoomId, roomId, null])
        if (roomId && isVoiceRoomId(auth.serverId, roomId)) {
          markForceScreenRelay(roomId, auth.clientId)
          notifyActiveScreenSharerToResync(auth.serverId, roomId, auth.clientId)
        }
      } else if (event.type === "set_screen_relay") {
        const meta = wsClientMeta.get(socket)
        if (meta) meta.screenRelayOff = !event.enabled
      } else if (event.type === "set_watching_screen") {
        db.prepare("UPDATE member_state SET watching_screen = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          event.watching ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
      } else if (event.type === "set_mute") {
        const room = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const forceMuted = Boolean(room?.room_id && !getRoomPolicy(auth.serverId, room.room_id).allowMic)
        const effectiveMuted = forceMuted ? true : event.muted
        if (forceMuted && !event.muted && room?.room_id) {
          socket.send(JSON.stringify({ type: "policy_denied", roomId: room.room_id, what: "mic" } satisfies WsServerEvent))
        }
        db.prepare("UPDATE member_state SET muted = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          effectiveMuted ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          setMemberFlags(auth.clientId, Boolean(snap.muted), Boolean(snap.deafened))
          emitMemberUpdated(auth.serverId, snap)
        }
      } else if (event.type === "set_deafen") {
        db.prepare("UPDATE member_state SET deafened = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          event.deafened ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          setMemberFlags(auth.clientId, Boolean(snap.muted), Boolean(snap.deafened))
          emitMemberUpdated(auth.serverId, snap)
        }
      } else if (event.type === "set_peer_volume") {
        if (
          typeof event.roomId !== "string" ||
          typeof event.targetClientId !== "string" ||
          typeof event.volumePct !== "number"
        ) {
          return
        }
        const row = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        if (!row?.room_id || row.room_id !== event.roomId) return
        if (!isVoiceRoomId(auth.serverId, event.roomId)) return
        if (event.targetClientId === auth.clientId) return
        const roster = getRoster(auth.serverId, event.roomId)
        if (!roster.some((m) => m.clientId === event.targetClientId)) return
        setPeerVolume(auth.clientId, event.targetClientId, event.volumePct)
      } else if (event.type === "set_profile") {
        db.prepare("UPDATE server_members SET display_name = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          event.displayName,
          auth.serverId,
          auth.clientId
        )
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
      } else if (event.type === "ping") {
        touchLastSeen(auth.serverId, auth.clientId)
        socket.send(JSON.stringify({ type: "pong", ts: event.ts } satisfies WsServerEvent))
      } else if (event.type === "screen_chunk") {
        if (typeof event.chunkBase64 !== "string" || event.chunkBase64.length === 0) {
          if (config.screenLog) app.log.warn({ msg: "screen_chunk dropped", reason: "empty_chunk", clientId: auth.clientId })
          return
        }
        if (event.chunkBase64.length > config.screenWsMaxBase64Chars) {
          if (config.screenLog) {
            app.log.warn({
              msg: "screen_chunk dropped",
              reason: "chunk_too_large",
              clientId: auth.clientId,
              base64Len: event.chunkBase64.length,
              max: config.screenWsMaxBase64Chars
            })
          }
          return
        }
        if (!allowScreenWsRate(auth.clientId)) {
          if (config.screenLog) app.log.warn({ msg: "screen_chunk dropped", reason: "rate_limit", clientId: auth.clientId })
          return
        }
        const row = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const roomId = row?.room_id
        if (!roomId) {
          if (config.screenLog) app.log.warn({ msg: "screen_chunk dropped", reason: "not_in_voice_room", clientId: auth.clientId })
          return
        }
        if (!isVoiceRoomId(auth.serverId, roomId)) {
          if (config.screenLog) app.log.warn({ msg: "screen_chunk dropped", reason: "room_not_voice", clientId: auth.clientId, roomId })
          return
        }
        const share = screenShareStateByClient.get(auth.clientId)
        if (!share?.active || share.roomId !== roomId) {
          if (config.screenLog) {
            app.log.warn({
              msg: "screen_chunk dropped",
              reason: "share_inactive_or_room_mismatch",
              clientId: auth.clientId,
              roomId,
              shareActive: share?.active ?? false,
              shareRoomId: share?.roomId ?? null
            })
          }
          return
        }
        broadcastScreenChunkWs(app, auth.serverId, roomId, auth.clientId, {
          type: "screen_chunk",
          fromClientId: auth.clientId,
          chunkBase64: event.chunkBase64
        })
      } else if (event.type === "set_screen_share") {
        const room = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const roomId = room?.room_id ?? null
        const streamsAllowed = roomId ? getRoomPolicy(auth.serverId, roomId).allowStreams : true
        if (event.active && roomId && !streamsAllowed) {
          socket.send(JSON.stringify({ type: "policy_denied", roomId, what: "stream" } satisfies WsServerEvent))
        }
        const active = Boolean(event.active && roomId && streamsAllowed)
        screenShareStateByClient.set(auth.clientId, { serverId: auth.serverId, roomId, active })
        db.prepare("UPDATE member_state SET screen_sharing = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          active ? 1 : 0,
          auth.serverId,
          auth.clientId
        )
        if (config.screenLog) {
          app.log.info({ msg: "set_screen_share", clientId: auth.clientId, roomId, active })
        }
        emitScreenShareState(auth.serverId, auth.clientId, roomId, active)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) emitMemberUpdated(auth.serverId, snap)
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "bad ws message" } satisfies WsServerEvent))
    }
  }

  socket.onclose = () => {
    const sockKey = clientSocketsKey(auth.serverId, auth.clientId)
    const sockSet = clientSockets.get(sockKey)
    sockSet?.delete(socket)
    if (sockSet && sockSet.size === 0) clientSockets.delete(sockKey)
    wsClientMeta.delete(socket)
    const bucket = clients.get(key)
    bucket?.delete(socket)
    if (bucket && bucket.size === 0) clients.delete(key)
    if (sockSet && sockSet.size > 0) return
    evictMemberPresence(auth.serverId, auth.clientId)
  }
})

await app.listen({ host: config.host, port: config.port })
