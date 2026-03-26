import dgram, { type RemoteInfo } from "node:dgram"
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import { MEDIA_MAGIC } from "./contracts.js"
import { config } from "./config.js"
import { verifyToken } from "./token.js"

const MEDIA_CIPHER = "aes-256-gcm"

type MemberSession = {
  clientId: string
  roomId: string | null
  remote?: { address: string; port: number }
  key?: Buffer
  lastSeqIn: number
  seqOut: number
  packetCountSecond: number
  currentSecond: number
  muted: boolean
  deafened: boolean
  rxPackets: number
  txPackets: number
  rxBytes: number
  txBytes: number
  rxLostEstimated: number
  rxReplayDropped: number
  rxRateLimitDropped: number
  rxDecryptDropped: number
  rxRoomMismatchDropped: number
  lastTransitMs: number | null
  jitterMs: number
  delaySamplesMs: number[]
  jitterSamplesMs: number[]
  lastReportAtMs: number
  speaking: boolean
  lastSpeakingSignalAtMs: number
}

type FrameEntry = {
  clientId: string
  pcm16: Buffer
}

const sessions = new Map<string, MemberSession>()
const roomFrames = new Map<string, FrameEntry[]>()
const desiredRoomByClient = new Map<string, string | null>()
const desiredFlagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
const desiredSpeakingByClient = new Map<string, boolean>()

export function setMemberRoom(clientId: string, roomId: string | null) {
  desiredRoomByClient.set(clientId, roomId)
  const existing = sessions.get(clientId)
  if (!existing) return
  existing.roomId = roomId
}

export function setMemberFlags(clientId: string, muted: boolean, deafened: boolean) {
  desiredFlagsByClient.set(clientId, { muted, deafened })
  const existing = sessions.get(clientId)
  if (!existing) return
  existing.muted = muted
  existing.deafened = deafened
}

export function setMemberSpeaking(clientId: string, speaking: boolean) {
  desiredSpeakingByClient.set(clientId, speaking)
  const existing = sessions.get(clientId)
  if (!existing) return
  existing.speaking = speaking
}

export function removeMember(clientId: string) {
  sessions.delete(clientId)
  desiredRoomByClient.delete(clientId)
  desiredFlagsByClient.delete(clientId)
  desiredSpeakingByClient.delete(clientId)
}

function deriveKey(mediaSeedB64: string) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(mediaSeedB64, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
}

function encryptFrame(key: Buffer, seq: number, ts: number, roomId: string, payload: Buffer): Buffer {
  const roomIdBuf = Buffer.from(roomId)
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(ts >>> 0, 0)
  nonce.writeUInt32BE(seq >>> 0, 4)
  randomBytes(4).copy(nonce, 8)
  const cipher = createCipheriv(MEDIA_CIPHER, key, nonce, { authTagLength: 16 })
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(3 + 4 + 4 + 1 + roomIdBuf.length + 12 + 2)
  MEDIA_MAGIC.copy(header, 0)
  header.writeUInt32BE(seq >>> 0, 3)
  header.writeUInt32BE(ts >>> 0, 7)
  header.writeUInt8(roomIdBuf.length, 11)
  roomIdBuf.copy(header, 12)
  nonce.copy(header, 12 + roomIdBuf.length)
  header.writeUInt16BE(tag.length, 12 + roomIdBuf.length + 12)
  return Buffer.concat([header, encrypted, tag])
}

function decryptFrame(key: Buffer, packet: Buffer) {
  if (packet.length < 3 + 4 + 4 + 1 + 12 + 2 + 16) return null
  if (!packet.subarray(0, 3).equals(MEDIA_MAGIC)) return null
  const seq = packet.readUInt32BE(3)
  const ts = packet.readUInt32BE(7)
  const roomIdLen = packet.readUInt8(11)
  const roomStart = 12
  const roomEnd = roomStart + roomIdLen
  const nonceStart = roomEnd
  const nonceEnd = nonceStart + 12
  const tagLenPos = nonceEnd
  const tagLen = packet.readUInt16BE(tagLenPos)
  const encStart = tagLenPos + 2
  const encEnd = packet.length - tagLen
  if (encEnd <= encStart) return null
  const roomId = packet.subarray(roomStart, roomEnd).toString()
  const nonce = packet.subarray(nonceStart, nonceEnd)
  const encrypted = packet.subarray(encStart, encEnd)
  const tag = packet.subarray(encEnd)
  const decipher = createDecipheriv(MEDIA_CIPHER, key, nonce, { authTagLength: 16 })
  decipher.setAuthTag(tag)
  const payload = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return { seq, ts, roomId, payload }
}

function mixPcm16(buffers: Buffer[]): Buffer {
  if (buffers.length === 0) return Buffer.alloc(0)
  const minLen = Math.min(...buffers.map((b) => b.length))
  const out = Buffer.alloc(minLen)
  for (let i = 0; i < minLen; i += 2) {
    let sum = 0
    for (const b of buffers) {
      sum += b.readInt16LE(i)
    }
    const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / buffers.length)))
    out.writeInt16LE(mixed, i)
  }
  return out
}

function pushSample(target: number[], value: number, maxLen = 2048) {
  target.push(value)
  if (target.length > maxLen) {
    target.splice(0, target.length - maxLen)
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))
  return sorted[idx]
}

function safeTransitDeltaMs(nowTs32: number, packetTs32: number): number | null {
  const signedDelta = (nowTs32 - packetTs32) | 0
  if (signedDelta < 0) return null
  if (signedDelta > 60_000) return null
  return signedDelta
}

function calcRmsEnergyPcm16(payload: Buffer): number {
  if (payload.length < 2) return 0
  let sum = 0
  const samples = Math.floor(payload.length / 2)
  for (let i = 0; i < payload.length; i += 2) {
    const v = payload.readInt16LE(i) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / samples)
}

type MediaHooks = {
  onSpeakingChanged?: (input: { clientId: string; speaking: boolean }) => void
}

export function createMediaServer(logger: FastifyBaseLogger, hooks: MediaHooks = {}) {
  const socket = dgram.createSocket("udp4")

  socket.on("message", (packet: Buffer, rinfo: RemoteInfo) => {
    if (packet.length < 20) return
    // bootstrap packet: "HELLO <mediaToken>"
    if (packet.subarray(0, 6).toString() === "HELLO ") {
      const token = packet.subarray(6).toString().trim()
      const payload = verifyToken(token, config.tokenSecret)
      if (!payload || payload.sub !== "media" || !payload.mediaSeed) return
      sessions.set(payload.clientId, {
        clientId: payload.clientId,
        roomId: desiredRoomByClient.get(payload.clientId) ?? null,
        remote: { address: rinfo.address, port: rinfo.port },
        key: deriveKey(payload.mediaSeed),
        lastSeqIn: 0,
        seqOut: 1,
        packetCountSecond: 0,
        currentSecond: Math.floor(Date.now() / 1000),
        muted: desiredFlagsByClient.get(payload.clientId)?.muted ?? false,
        deafened: desiredFlagsByClient.get(payload.clientId)?.deafened ?? false,
        rxPackets: 0,
        txPackets: 0,
        rxBytes: 0,
        txBytes: 0,
        rxLostEstimated: 0,
        rxReplayDropped: 0,
        rxRateLimitDropped: 0,
        rxDecryptDropped: 0,
        rxRoomMismatchDropped: 0,
        lastTransitMs: null,
        jitterMs: 0,
        delaySamplesMs: [],
        jitterSamplesMs: [],
        lastReportAtMs: Date.now(),
        speaking: desiredSpeakingByClient.get(payload.clientId) ?? false,
        lastSpeakingSignalAtMs: 0
      })
      logger.info(
        { clientId: payload.clientId, remoteAddress: rinfo.address, remotePort: rinfo.port },
        "media session HELLO accepted"
      )
      return
    }

    for (const session of sessions.values()) {
      if (!session.remote || !session.key) continue
      if (session.remote.address !== rinfo.address || session.remote.port !== rinfo.port) continue

      const sec = Math.floor(Date.now() / 1000)
      if (sec !== session.currentSecond) {
        session.currentSecond = sec
        session.packetCountSecond = 0
      }
      session.packetCountSecond += 1
      if (session.packetCountSecond > config.mediaRateLimitPerSec) {
        session.rxRateLimitDropped += 1
        return
      }

      const decoded = decryptFrame(session.key, packet)
      if (!decoded) {
        session.rxDecryptDropped += 1
        return
      }
      if (decoded.seq <= session.lastSeqIn) {
        session.rxReplayDropped += 1
        return
      }
      if (session.lastSeqIn > 0 && decoded.seq > session.lastSeqIn + 1) {
        session.rxLostEstimated += decoded.seq - session.lastSeqIn - 1
      }
      session.lastSeqIn = decoded.seq
      session.rxPackets += 1
      session.rxBytes += packet.length
      const nowTs32 = Date.now() >>> 0
      const transit = safeTransitDeltaMs(nowTs32, decoded.ts)
      if (transit !== null) {
        pushSample(session.delaySamplesMs, transit)
        if (session.lastTransitMs !== null) {
          const d = Math.abs(transit - session.lastTransitMs)
          session.jitterMs += (d - session.jitterMs) / 16
          pushSample(session.jitterSamplesMs, session.jitterMs)
        }
        session.lastTransitMs = transit
      }

      if (!session.roomId || session.roomId !== decoded.roomId || session.muted) {
        session.rxRoomMismatchDropped += 1
        return
      }

      const energy = calcRmsEnergyPcm16(decoded.payload)
      const nowEnergyTs = Date.now()
      const speakingThreshold = 0.02
      if (energy > speakingThreshold) {
        session.lastSpeakingSignalAtMs = nowEnergyTs
      }
      const speaking = nowEnergyTs - session.lastSpeakingSignalAtMs < 250
      if (speaking !== session.speaking) {
        session.speaking = speaking
        hooks.onSpeakingChanged?.({ clientId: session.clientId, speaking })
      }

      const list = roomFrames.get(session.roomId) ?? []
      list.push({ clientId: session.clientId, pcm16: decoded.payload })
      roomFrames.set(session.roomId, list)
      return
    }
  })

  setInterval(() => {
    for (const [roomId, frames] of roomFrames.entries()) {
      if (frames.length === 0) continue
      for (const session of sessions.values()) {
        if (!session.roomId || session.roomId !== roomId || !session.remote || !session.key || session.deafened) continue
        // Avoid sidetone: each recipient gets room mix without own frame.
        const otherFrames = frames.filter((f) => f.clientId !== session.clientId).map((f) => f.pcm16)
        if (otherFrames.length === 0) continue
        const mixed = mixPcm16(otherFrames)
        const packet = encryptFrame(session.key, session.seqOut++, Date.now(), roomId, mixed)
        socket.send(packet, session.remote.port, session.remote.address)
        session.txPackets += 1
        session.txBytes += packet.length
      }
      roomFrames.set(roomId, [])
    }
  }, 20)

  setInterval(() => {
    const now = Date.now()
    for (const session of sessions.values()) {
      const elapsedMs = Math.max(1, now - session.lastReportAtMs)
      session.lastReportAtMs = now
      const rxPps = Number(((session.rxPackets * 1000) / elapsedMs).toFixed(2))
      const txPps = Number(((session.txPackets * 1000) / elapsedMs).toFixed(2))
      const lossPct = session.rxPackets + session.rxLostEstimated > 0
        ? Number(((session.rxLostEstimated / (session.rxPackets + session.rxLostEstimated)) * 100).toFixed(3))
        : 0
      const delayP99 = Number(percentile(session.delaySamplesMs, 0.99).toFixed(3))
      const delayP999 = Number(percentile(session.delaySamplesMs, 0.999).toFixed(3))
      const jitterP99 = Number(percentile(session.jitterSamplesMs, 0.99).toFixed(3))
      const jitterP999 = Number(percentile(session.jitterSamplesMs, 0.999).toFixed(3))
      logger.info(
        {
          clientId: session.clientId,
          roomId: session.roomId,
          remote: session.remote ? `${session.remote.address}:${session.remote.port}` : null,
          rxPackets: session.rxPackets,
          txPackets: session.txPackets,
          rxBytes: session.rxBytes,
          txBytes: session.txBytes,
          rxPps,
          txPps,
          rxLostEstimated: session.rxLostEstimated,
          packetLossPct: lossPct,
          delayP99Ms: delayP99,
          delayP999Ms: delayP999,
          jitterP99Ms: jitterP99,
          jitterP999Ms: jitterP999,
          ping1PctMs: delayP99,
          ping01PctMs: delayP999,
          jitter1PctMs: jitterP99,
          jitter01PctMs: jitterP999,
          rxReplayDropped: session.rxReplayDropped,
          rxRateLimitDropped: session.rxRateLimitDropped,
          rxDecryptDropped: session.rxDecryptDropped,
          rxRoomMismatchDropped: session.rxRoomMismatchDropped
        },
        "media network stats snapshot"
      )
      session.rxPackets = 0
      session.txPackets = 0
      session.rxBytes = 0
      session.txBytes = 0
      session.rxLostEstimated = 0
      session.rxReplayDropped = 0
      session.rxRateLimitDropped = 0
      session.rxDecryptDropped = 0
      session.rxRoomMismatchDropped = 0
    }
  }, 5000)

  socket.bind(config.udpPort, config.udpHost, () => {
    logger.info({ udpHost: config.udpHost, udpPort: config.udpPort }, "media UDP server listening")
  })

  return socket
}
