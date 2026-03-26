import Fastify from "fastify"
import cors from "@fastify/cors"
import websocket from "@fastify/websocket"
import bcrypt from "bcryptjs"
import { randomUUID, randomBytes } from "node:crypto"
import { z } from "zod"
import { config } from "./config.js"
import { initDb } from "./db.js"
import { makeAuthToken, makeMediaToken, verifyToken } from "./token.js"
import type { WsClientEvent, WsServerEvent } from "./contracts.js"
import { createMediaServer, removeMember, setMemberFlags, setMemberRoom, setMemberSpeaking } from "./media.js"

const app = Fastify({ logger: true })
await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
})
await app.register(websocket)
const db = initDb(config.dbPath)
const clients = new Map<string, Set<WebSocket>>()

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

function ensureAdminRole(serverId: string) {
  const existing = db
    .prepare("SELECT id FROM server_roles WHERE server_id = ? AND role_key = 'admin' LIMIT 1")
    .get(serverId) as { id: string } | undefined
  if (existing) return existing.id
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

  const currentlyOnline = db
    .prepare("SELECT 1 FROM member_state WHERE server_id = ? AND client_id = ? LIMIT 1")
    .get(input.serverId, input.clientId) as { 1: number } | undefined
  let effectiveClientId = input.clientId
  if (currentlyOnline) {
    // Allow concurrent sessions even if clientId is reused (e.g. two local app instances).
    effectiveClientId = `${input.clientId}-${randomUUID().slice(0, 8)}`
  }

  if (!existingMember && effectiveClientId === input.clientId) {
    db.prepare("INSERT INTO server_members(server_id, client_id, display_name) VALUES (?, ?, ?)").run(
      input.serverId,
      input.clientId,
      resolvedName
    )
  }
  if (effectiveClientId !== input.clientId) {
    const effectiveMember = db
      .prepare("SELECT 1 FROM server_members WHERE server_id = ? AND client_id = ? LIMIT 1")
      .get(input.serverId, effectiveClientId) as { 1: number } | undefined
    if (!effectiveMember) {
      db.prepare("INSERT INTO server_members(server_id, client_id, display_name) VALUES (?, ?, ?)").run(
        input.serverId,
        effectiveClientId,
        resolvedName
      )
    }
  }

  db.prepare(
    `INSERT INTO member_state(server_id, room_id, client_id, display_name, muted, deafened, speaking, last_seen)
     VALUES (?, NULL, ?, ?, 0, 0, 0, datetime('now'))
     ON CONFLICT(server_id, client_id) DO UPDATE SET last_seen = datetime('now')`
  ).run(input.serverId, effectiveClientId, resolvedName)

  if (input.superuserPassword && input.superuserPassword === config.superuserPassword) {
    const adminRoleId = ensureAdminRole(input.serverId)
    ensureMemberHasRole(input.serverId, effectiveClientId, adminRoleId)
  }

  const mediaSeed = randomBytes(32).toString("base64")
  const authToken = makeAuthToken(
    { serverId: input.serverId, clientId: effectiveClientId, displayName: resolvedName, mediaSeed },
    config.tokenSecret
  )
  const mediaToken = makeMediaToken(
    { serverId: input.serverId, clientId: effectiveClientId, displayName: resolvedName, mediaSeed },
    config.tokenSecret
  )
  return {
    serverId: input.serverId,
    authToken,
    mediaToken,
    profile: { clientId: effectiveClientId, displayName: resolvedName },
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
  const token = req.headers.authorization?.replace("Bearer ", "")
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

app.get("/v1/servers/:serverId/channels/:channelId/messages", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), channelId: z.string().min(1) }).parse(req.params)
  const query = z.object({ limit: z.coerce.number().min(1).max(100).default(50), cursor: z.string().optional() }).parse(req.query)
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
  const messages = rows
    .map((row) => ({
      id: row.id,
      channelId: row.channel_id,
      author: { clientId: row.client_id, displayName: row.display_name },
      body: row.body,
      createdAt: row.created_at
    }))
    .reverse()
  const nextCursor = rows.length === query.limit ? rows[rows.length - 1].id : null
  return rep.send({ messages, nextCursor })
})

app.post("/v1/servers/:serverId/channels/:channelId/messages", async (req, rep) => {
  const params = z.object({ serverId: z.string().min(1), channelId: z.string().min(1) }).parse(req.params)
  const body = z.object({ body: z.string().min(1).max(2000) }).parse(req.body)
  const auth = (req as any).auth as { serverId: string; clientId: string }
  if (auth.serverId !== params.serverId) return rep.code(403).send({ message: "forbidden" })
  const channel = db
    .prepare("SELECT id, kind FROM rooms WHERE id = ? AND server_id = ?")
    .get(params.channelId, params.serverId) as { id: string; kind: "voice" | "text" } | undefined
  if (!channel || channel.kind !== "text") return rep.code(400).send({ message: "chat allowed only in text channels" })
  const id = randomUUID()
  db.prepare("INSERT INTO messages(id, server_id, channel_id, client_id, body) VALUES (?, ?, ?, ?, ?)").run(
    id,
    params.serverId,
    params.channelId,
    auth.clientId,
    body.body
  )
  const member = db
    .prepare("SELECT display_name FROM server_members WHERE server_id = ? AND client_id = ?")
    .get(params.serverId, auth.clientId) as { display_name: string } | undefined
  const message = {
    id,
    channelId: params.channelId,
    author: { clientId: auth.clientId, displayName: member?.display_name ?? auth.clientId },
    body: body.body,
    createdAt: new Date().toISOString()
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

  socket.send(JSON.stringify({ type: "hello", clientId: auth.clientId, serverId: auth.serverId } satisfies WsServerEvent))
  socket.send(JSON.stringify({ type: "rooms_snapshot", rooms: getRooms(auth.serverId) } satisfies WsServerEvent))
  socket.send(JSON.stringify({ type: "roster_snapshot", roomId: null, members: getRoster(auth.serverId, null) } satisfies WsServerEvent))

  socket.onmessage = (msg: { data: unknown }) => {
    try {
      const event = JSON.parse(String(msg.data)) as WsClientEvent
      if (event.type === "join_room") {
        db.prepare("UPDATE member_state SET room_id = ?, speaking = 0, last_seen = datetime('now') WHERE server_id = ? AND client_id = ?").run(
          event.roomId,
          auth.serverId,
          auth.clientId
        )
        setMemberRoom(auth.clientId, event.roomId)
        setMemberSpeaking(auth.clientId, false)
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
      } else if (event.type === "leave_room") {
        db.prepare("UPDATE member_state SET room_id = NULL, speaking = 0 WHERE server_id = ? AND client_id = ?").run(auth.serverId, auth.clientId)
        setMemberRoom(auth.clientId, null)
        setMemberSpeaking(auth.clientId, false)
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
        db.prepare("UPDATE member_state SET muted = ? WHERE server_id = ? AND client_id = ?").run(event.muted ? 1 : 0, auth.serverId, auth.clientId)
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
      }
    } catch {
      socket.send(JSON.stringify({ type: "error", message: "bad ws message" } satisfies WsServerEvent))
    }
  }

  socket.onclose = () => {
    const snap = getMemberSnapshot(auth.serverId, auth.clientId)
    db.prepare("DELETE FROM member_state WHERE server_id = ? AND client_id = ?").run(auth.serverId, auth.clientId)
    removeMember(auth.clientId)
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
    if (bucket && bucket.size === 0) clients.delete(key)
  }
})

await app.listen({ host: config.host, port: config.port })
