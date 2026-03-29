import Fastify, { type FastifyInstance } from "fastify"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import bcrypt from "bcryptjs"
import { randomUUID, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs"
import { basename, dirname, extname, join, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { Readable } from "node:stream"
import { z } from "zod"
import { config } from "./config.js"
import { initDb } from "./db.js"
import { makeAuthToken, makeMediaToken, verifyToken } from "./token.js"
import type { WsClientEvent, WsServerEvent } from "./contracts.js"
import { createMediaServer, removeMember, setMemberFlags, setMemberRoom, setMemberSpeaking } from "./media.js"
import { extractWebmInitPrefix } from "./webm-init.js"

const app = Fastify({ logger: true })
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-file-name", "x-file-mime"]
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
const clients = new Map<string, Set<WebSocket>>()
/** Map WebSocket → client for targeted broadcast (screen chunks). */
const wsClientMeta = new Map<WebSocket, { serverId: string; clientId: string }>()
const screenShareStateByClient = new Map<string, { serverId: string; roomId: string | null; active: boolean }>()
/** Viewer IDs temporarily forced into WS screen relay after join/resync. */
const forceScreenRelayByRoom = new Map<string, Map<string, number>>()
/** WebM init prefix (base64) per active sharer; avoids MediaRecorder restart on late join. */
const screenWebmInitByClient = new Map<string, { serverId: string; roomId: string; initBase64: string }>()
const screenWsRateByClient = new Map<string, { sec: number; count: number }>()
let screenRelayLogCounter = 0

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

function isVoiceRoomId(serverId: string, roomId: string): boolean {
  const row = db.prepare("SELECT kind FROM rooms WHERE server_id = ? AND id = ? LIMIT 1").get(serverId, roomId) as { kind: string } | undefined
  return row?.kind === "voice"
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

function sendScreenWebmInitToViewer(serverId: string, roomId: string, viewerSocket: WebSocket, viewerClientId: string) {
  if (viewerSocket.readyState !== viewerSocket.OPEN) return
  for (const [sharerId, share] of screenShareStateByClient.entries()) {
    if (sharerId === viewerClientId) continue
    if (share.serverId !== serverId || !share.active || share.roomId !== roomId) continue
    const cached = screenWebmInitByClient.get(sharerId)
    if (!cached || cached.serverId !== serverId || cached.roomId !== roomId) continue
    viewerSocket.send(
      JSON.stringify({
        type: "screen_chunk",
        fromClientId: sharerId,
        chunkBase64: cached.initBase64
      } satisfies WsServerEvent)
    )
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

function getRooms(serverId: string) {
  return db.prepare("SELECT id, name, kind FROM rooms WHERE server_id = ? ORDER BY created_at ASC").all(serverId) as Array<{
    id: string
    name: string
    kind: "voice" | "text"
  }>
}

function isLobbyVoiceRoom(serverId: string, roomId: string) {
  const row = db
    .prepare("SELECT kind, name FROM rooms WHERE server_id = ? AND id = ? LIMIT 1")
    .get(serverId, roomId) as { kind: "voice" | "text"; name: string } | undefined
  if (!row) return false
  return row.kind === "voice" && row.name.toLowerCase() === "lobby"
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
      `SELECT ms.server_id, ms.room_id, ms.client_id, sm.display_name, ms.muted, ms.deafened, ms.speaking
       FROM member_state ms
       JOIN server_members sm ON sm.server_id = ms.server_id AND sm.client_id = ms.client_id
       WHERE ms.server_id = ? AND ms.client_id = ?`
    )
    .get(serverId, clientId) as
    | { server_id: string; room_id: string | null; client_id: string; display_name: string; muted: number; deafened: number; speaking: number }
    | undefined
}

function getRoster(serverId: string, roomId: string | null) {
  const rows = db
    .prepare(
      `SELECT ms.client_id, sm.display_name, ms.muted, ms.deafened, ms.speaking
       FROM member_state ms
       JOIN server_members sm ON sm.server_id = ms.server_id AND sm.client_id = ms.client_id
       WHERE ms.server_id = ? AND ms.room_id IS ?
       ORDER BY ms.last_seen DESC`
    )
    .all(serverId, roomId) as Array<{ client_id: string; display_name: string; muted: number; deafened: number; speaking: number }>
  return rows.map((r) => ({
    clientId: r.client_id,
    displayName: r.display_name,
    muted: Boolean(r.muted),
    deafened: Boolean(r.deafened),
    speaking: Boolean(r.speaking)
  }))
}

createMediaServer(app.log, {
  onSpeakingChanged: ({ clientId, speaking }) => {
    const row = db
      .prepare("SELECT server_id, room_id FROM member_state WHERE client_id = ? ORDER BY last_seen DESC LIMIT 1")
      .get(clientId) as { server_id: string; room_id: string | null } | undefined
    if (!row) return
    db.prepare("UPDATE member_state SET speaking = ? WHERE server_id = ? AND client_id = ?").run(speaking ? 1 : 0, row.server_id, clientId)
    const snap = getMemberSnapshot(row.server_id, clientId)
    if (!snap) return
    emitToServer(row.server_id, {
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

async function issueJoinForServer(input: { serverId: string; clientId: string; displayName: string; superuserPassword?: string }) {
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
    { serverId: input.serverId, clientId: input.clientId, displayName: resolvedName, mediaSeed },
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
  ensureDefaultRooms(server.id)
  const joined = await issueJoinForServer({
    serverId: server.id,
    clientId: body.clientId,
    displayName: body.displayName,
    superuserPassword: body.superuserPassword
  })
  return rep.send({ ...joined, serverName: server.name })
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
  ensureDefaultRooms(params.serverId)
  const joined = await issueJoinForServer({
    serverId: params.serverId,
    clientId: body.clientId,
    displayName: body.displayName,
    superuserPassword: body.superuserPassword
  })
  return rep.send(joined)
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

app.get("/v1/servers/:serverId/rooms", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1) }).parse(req.params)
  const auth = (req as any).auth as { serverId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  return rep.send({ rooms: getRooms(params.serverId) })
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
  const absPath = resolve(config.uploadDir, relPath)
  if (!absPath.startsWith(resolve(config.uploadDir))) {
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
  const safeRoot = resolve(config.uploadDir)
  const absPath = resolve(row.storage_path)
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
  const cursorClause = query.cursor ? "AND m.id < ?" : ""
  const rows = db
    .prepare(
      `SELECT m.id, m.channel_id, m.body, m.created_at, m.client_id, sm.display_name
       FROM messages m
       JOIN server_members sm ON sm.server_id = m.server_id AND sm.client_id = m.client_id
       WHERE m.server_id = ? AND m.channel_id = ? ${cursorClause}
       ORDER BY m.id DESC LIMIT ?`
    )
    .all(...(query.cursor ? [params.serverId, params.channelId, query.cursor, query.limit] : [params.serverId, params.channelId, query.limit])) as Array<{
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
      createdAt: row.created_at,
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
  const message = {
    id,
    channelId: params.channelId,
    author: { clientId: auth.clientId, displayName: member?.display_name ?? auth.clientId },
    body: body.body.trim(),
    createdAt: new Date().toISOString(),
    attachments: getAttachmentsByMessageIds(params.serverId, [id], token).get(id) ?? []
  }
  emitToServer(params.serverId, { type: "chat_message", message })
  return rep.send({ message })
})

app.get("/v1/ws", { websocket: true }, (socket, req) => {
  const url = new URL(req.url ?? "", "http://localhost")
  const token = url.searchParams.get("token")
  if (!token) return socket.close(4001, "missing token")
  const auth = verifyToken(token, config.tokenSecret)
  if (!auth || auth.sub !== "auth") return socket.close(4002, "invalid token")

  const key = auth.serverId
  const set = clients.get(key) ?? new Set<WebSocket>()
  set.add(socket)
  clients.set(key, set)
  wsClientMeta.set(socket, { serverId: auth.serverId, clientId: auth.clientId })

  socket.send(JSON.stringify({ type: "hello", clientId: auth.clientId, serverId: auth.serverId } satisfies WsServerEvent))
  socket.send(JSON.stringify({ type: "rooms_snapshot", rooms: getRooms(auth.serverId) } satisfies WsServerEvent))
  socket.send(JSON.stringify({ type: "roster_snapshot", roomId: null, members: getRoster(auth.serverId, null) } satisfies WsServerEvent))
  for (const [clientId, state] of screenShareStateByClient.entries()) {
    if (state.serverId !== auth.serverId || !state.active) continue
    socket.send(JSON.stringify({ type: "screen_share_state", clientId, roomId: state.roomId, active: true } satisfies WsServerEvent))
  }

  socket.onmessage = (msg: { data: unknown }) => {
    try {
      const event = JSON.parse(String(msg.data)) as WsClientEvent
      if (event.type === "join_room") {
        const forceMutedInLobby = isLobbyVoiceRoom(auth.serverId, event.roomId)
        db.prepare(
          "UPDATE member_state SET room_id = ?, speaking = 0, muted = ?, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?"
        ).run(event.roomId, forceMutedInLobby ? 1 : 0, auth.serverId, auth.clientId)
        setMemberRoom(auth.clientId, event.roomId)
        setMemberSpeaking(auth.clientId, false)
        setMemberFlags(auth.clientId, forceMutedInLobby, false)
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
        if (keepScreenShareActive) {
          emitScreenShareState(auth.serverId, auth.clientId, event.roomId, true)
        } else {
          emitScreenShareState(auth.serverId, auth.clientId, event.roomId, false)
        }
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          emitToServer(auth.serverId, {
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
        emitToServer(auth.serverId, { type: "roster_snapshot", roomId: event.roomId, members: getRoster(auth.serverId, event.roomId) })
        if (isVoiceRoomId(auth.serverId, event.roomId)) {
          markForceScreenRelay(event.roomId, auth.clientId)
          sendScreenWebmInitToViewer(auth.serverId, event.roomId, socket, auth.clientId)
        }
      } else if (event.type === "request_screen_resync") {
        const row = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        if (row?.room_id !== event.roomId) return
        if (!isVoiceRoomId(auth.serverId, event.roomId)) return
        markForceScreenRelay(event.roomId, auth.clientId)
        sendScreenWebmInitToViewer(auth.serverId, event.roomId, socket, auth.clientId)
      } else if (event.type === "leave_room") {
        db.prepare("UPDATE member_state SET room_id = NULL, speaking = 0 WHERE server_id = ? AND client_id = ?").run(auth.serverId, auth.clientId)
        setMemberRoom(auth.clientId, null)
        setMemberSpeaking(auth.clientId, false)
        for (const forced of forceScreenRelayByRoom.values()) {
          forced.delete(auth.clientId)
        }
        screenShareStateByClient.set(auth.clientId, { serverId: auth.serverId, roomId: null, active: false })
        emitScreenShareState(auth.serverId, auth.clientId, null, false)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          emitToServer(auth.serverId, {
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
      } else if (event.type === "set_mute") {
        const room = db
          .prepare("SELECT room_id FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
          .get(auth.serverId, auth.clientId) as { room_id: string | null } | undefined
        const forceMutedInLobby = Boolean(room?.room_id && isLobbyVoiceRoom(auth.serverId, room.room_id))
        const effectiveMuted = forceMutedInLobby ? true : event.muted
        db.prepare("UPDATE member_state SET muted = ? WHERE server_id = ? AND client_id = ?").run(effectiveMuted ? 1 : 0, auth.serverId, auth.clientId)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          setMemberFlags(auth.clientId, Boolean(snap.muted), Boolean(snap.deafened))
          emitToServer(auth.serverId, {
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
      } else if (event.type === "set_deafen") {
        db.prepare("UPDATE member_state SET deafened = ? WHERE server_id = ? AND client_id = ?").run(event.deafened ? 1 : 0, auth.serverId, auth.clientId)
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          setMemberFlags(auth.clientId, Boolean(snap.muted), Boolean(snap.deafened))
          emitToServer(auth.serverId, {
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
      } else if (event.type === "set_profile") {
        db.prepare("UPDATE server_members SET display_name = ?, updated_at = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          event.displayName,
          auth.serverId,
          auth.clientId
        )
        const snap = getMemberSnapshot(auth.serverId, auth.clientId)
        if (snap) {
          emitToServer(auth.serverId, {
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
      } else if (event.type === "ping") {
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
        const raw = Buffer.from(event.chunkBase64, "base64")
        const u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
        const initPrefix = extractWebmInitPrefix(u8)
        if (initPrefix && initPrefix.length > 0) {
          screenWebmInitByClient.set(auth.clientId, {
            serverId: auth.serverId,
            roomId,
            initBase64: Buffer.from(initPrefix).toString("base64")
          })
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
        const active = Boolean(event.active && roomId)
        if (!active) {
          screenWebmInitByClient.delete(auth.clientId)
        }
        screenShareStateByClient.set(auth.clientId, { serverId: auth.serverId, roomId, active })
        if (config.screenLog) {
          app.log.info({ msg: "set_screen_share", clientId: auth.clientId, roomId, active })
        }
        emitScreenShareState(auth.serverId, auth.clientId, roomId, active)
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "bad ws message" } satisfies WsServerEvent))
    }
  }

  socket.onclose = () => {
    const snap = getMemberSnapshot(auth.serverId, auth.clientId)
    db.prepare("DELETE FROM member_state WHERE server_id = ? AND client_id = ?").run(auth.serverId, auth.clientId)
    removeMember(auth.clientId)
    const shareSnap = screenShareStateByClient.get(auth.clientId)
    screenShareStateByClient.delete(auth.clientId)
    screenWebmInitByClient.delete(auth.clientId)
    for (const forced of forceScreenRelayByRoom.values()) {
      forced.delete(auth.clientId)
    }
    const shareRoomEmit =
      shareSnap?.active && shareSnap.roomId ? shareSnap.roomId : null
    emitScreenShareState(auth.serverId, auth.clientId, shareRoomEmit, false)
    if (snap) {
      emitToServer(auth.serverId, {
        type: "member_updated",
        member: {
          clientId: snap.client_id,
          displayName: snap.display_name,
          roomId: null,
          muted: Boolean(snap.muted),
          deafened: Boolean(snap.deafened),
          speaking: false
        }
      })
    }
    const bucket = clients.get(key)
    bucket?.delete(socket)
    wsClientMeta.delete(socket)
    if (bucket && bucket.size === 0) clients.delete(key)
  }
})

await app.listen({ host: config.host, port: config.port })
