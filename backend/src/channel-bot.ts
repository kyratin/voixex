import dgram from "node:dgram"
import { createCipheriv, hkdfSync, randomBytes } from "node:crypto"

type JoinResponse = {
  authToken: string
  mediaToken: string
  profile: { clientId: string; displayName: string }
  udp: { host: string; port: number }
}

type Room = { id: string; name: string; kind: "voice" | "text" }

const apiBase = process.env.BOT_API_BASE?.trim() || "http://127.0.0.1:18080"
const serverId = process.env.BOT_SERVER_ID?.trim()
const password = process.env.BOT_SERVER_PASSWORD?.trim()
const requestedRoomId = process.env.BOT_ROOM_ID?.trim() || ""
const clientId = process.env.BOT_CLIENT_ID?.trim() || `bot-${Math.random().toString(16).slice(2, 10)}`
const displayName = process.env.BOT_DISPLAY_NAME?.trim() || "Roster Test Bot"
const toneHz = Number(process.env.BOT_TONE_HZ ?? 440)
const toneGain = Number(process.env.BOT_TONE_GAIN ?? 4500)
const udpHostOverride = process.env.BOT_UDP_HOST?.trim() || ""
const udpPortOverride = Number(process.env.BOT_UDP_PORT ?? 0)

if (!serverId) {
  console.error("BOT_SERVER_ID is required")
  process.exit(1)
}
if (!password) {
  console.error("BOT_SERVER_PASSWORD is required")
  process.exit(1)
}

const toWsUrl = (base: string) => {
  if (base.startsWith("https://")) return `wss://${base.slice("https://".length)}`
  if (base.startsWith("http://")) return `ws://${base.slice("http://".length)}`
  return `ws://${base}`
}

const postJoin = async () => {
  const res = await fetch(`${apiBase}/v1/servers/${serverId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId, password, displayName })
  })
  if (!res.ok) throw new Error(`join failed: ${res.status} ${await res.text()}`)
  return (await res.json()) as JoinResponse
}

const loadRooms = async (authToken: string) => {
  const res = await fetch(`${apiBase}/v1/servers/${serverId}/rooms`, {
    headers: { authorization: `Bearer ${authToken}` }
  })
  if (!res.ok) throw new Error(`rooms failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { rooms: Room[] }
  return data.rooms
}

const run = async () => {
  const joined = await postJoin()
  const rooms = await loadRooms(joined.authToken)
  const roomId = requestedRoomId || rooms.find((room) => room.kind === "voice")?.id
  if (!roomId) throw new Error("voice room not found. Set BOT_ROOM_ID explicitly.")

  const mediaSeed = String(decodeTokenPayload(joined.mediaToken).mediaSeed ?? "")
  if (!mediaSeed) throw new Error("mediaToken has no mediaSeed")
  const mediaKey = deriveKey(mediaSeed)
  const udp = dgram.createSocket("udp4")
  let seqOut = 1
  let toneTimer: NodeJS.Timeout | null = null
  let phase = 0

  const udpHost = udpHostOverride || joined.udp.host
  const udpPort = udpPortOverride > 0 ? udpPortOverride : joined.udp.port

  await new Promise<void>((resolve) => udp.bind(0, "0.0.0.0", () => resolve()))
  udp.send(Buffer.from(`HELLO ${joined.mediaToken}`), udpPort, udpHost)

  const wsBase = toWsUrl(apiBase)
  const ws = new WebSocket(`${wsBase}/v1/ws?token=${encodeURIComponent(joined.authToken)}`)

  let pingTimer: NodeJS.Timeout | null = null

  ws.addEventListener("open", () => {
    console.log(`Bot connected as ${joined.profile.displayName} (${joined.profile.clientId})`)
    console.log(`Joining voice room: ${roomId}`)
    ws.send(JSON.stringify({ type: "join_room", roomId }))
    pingTimer = setInterval(() => {
      ws.send(JSON.stringify({ type: "ping", ts: Date.now() }))
    }, 5000)
    toneTimer = setInterval(() => {
      const frame = makeToneFrame(960, toneHz, toneGain, phase)
      phase = frame.phase
      const packet = encryptFrame(mediaKey, seqOut++, Date.now(), roomId, frame.pcm16)
      udp.send(packet, udpPort, udpHost)
    }, 20)
  })

  ws.addEventListener("message", (event: MessageEvent) => {
    try {
      const data = typeof event.data === "string" ? event.data : String(event.data)
      const parsed = JSON.parse(data) as { type?: string }
      if (parsed.type === "error") {
        console.error("WS error event:", data)
      }
    } catch {
      // Ignore malformed server message logging in test bot.
    }
  })

  ws.addEventListener("close", (event: CloseEvent) => {
    if (pingTimer) clearInterval(pingTimer)
    if (toneTimer) clearInterval(toneTimer)
    udp.close()
    console.log(`Bot disconnected: code=${event.code} reason=${event.reason}`)
    process.exit(0)
  })

  ws.addEventListener("error", () => {
    console.error("WS failure")
  })

  const shutdown = () => {
    if (pingTimer) clearInterval(pingTimer)
    if (toneTimer) clearInterval(toneTimer)
    udp.close()
    ws.close(1000, "bot shutdown")
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})

function decodeTokenPayload(token: string): Record<string, unknown> {
  const parts = token.split(".")
  if (parts.length !== 3) return {}
  const payloadB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/")
  const pad = payloadB64.length % 4
  const withPad = pad ? payloadB64 + "=".repeat(4 - pad) : payloadB64
  return JSON.parse(Buffer.from(withPad, "base64").toString("utf8")) as Record<string, unknown>
}

function deriveKey(mediaSeedB64: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(mediaSeedB64, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
}

function encryptFrame(key: Buffer, seq: number, ts: number, roomId: string, payload: Buffer): Buffer {
  const room = Buffer.from(roomId)
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(ts >>> 0, 0)
  nonce.writeUInt32BE(seq >>> 0, 4)
  randomBytes(4).copy(nonce, 8)
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(3 + 4 + 4 + 1 + room.length + 12 + 2)
  Buffer.from([0x56, 0x50, 0x01]).copy(header, 0)
  header.writeUInt32BE(seq >>> 0, 3)
  header.writeUInt32BE(ts >>> 0, 7)
  header.writeUInt8(room.length, 11)
  room.copy(header, 12)
  nonce.copy(header, 12 + room.length)
  header.writeUInt16BE(tag.length, 12 + room.length + 12)
  return Buffer.concat([header, encrypted, tag])
}

function makeToneFrame(samples: number, hz: number, gain: number, startPhase: number) {
  const pcm16 = Buffer.alloc(samples * 2)
  const step = (2 * Math.PI * hz) / 48000
  let phase = startPhase
  for (let i = 0; i < samples; i += 1) {
    const value = Math.max(-32768, Math.min(32767, Math.round(Math.sin(phase) * gain)))
    pcm16.writeInt16LE(value, i * 2)
    phase += step
    if (phase > Math.PI * 2) phase -= Math.PI * 2
  }
  return { pcm16, phase }
}
