import dgram, { type RemoteInfo } from "node:dgram"
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import type { FastifyBaseLogger } from "fastify"
import OpusScript from "opusscript"
import { MEDIA_MAGIC } from "./contracts.js"
import { config } from "./config.js"
import { verifyToken } from "./token.js"

const MEDIA_CIPHER = "aes-256-gcm"
const MEDIA_KIND_AUDIO = 0
const MEDIA_KIND_SCREEN = 1
const MEDIA_KIND_OPUS = 2

const OPUS_SAMPLE_RATE = 48_000
const OPUS_CHANNELS = 1

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
  lastProbeAckAtMs: number
}

type FrameEntry = {
  clientId: string
  pcm16: Buffer
}

type ScreenChunkEntry = {
  clientId: string
  chunk: Buffer
}

const sessions = new Map<string, MemberSession>()
const roomFrames = new Map<string, FrameEntry[]>()
const roomScreenChunks = new Map<string, ScreenChunkEntry[]>()
const desiredRoomByClient = new Map<string, string | null>()
const desiredFlagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
const desiredSpeakingByClient = new Map<string, boolean>()
/** listenerClientId -> (targetClientId -> gain 0..2, from volumePct 0..200) */
const peerVolumeByListener = new Map<string, Map<string, number>>()

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
  peerVolumeByListener.delete(clientId)
  for (const m of peerVolumeByListener.values()) {
    m.delete(clientId)
  }
  sessions.delete(clientId)
  desiredRoomByClient.delete(clientId)
  desiredFlagsByClient.delete(clientId)
  desiredSpeakingByClient.delete(clientId)
}

/** Per-listener volume for other participants (0–200%, default 100%). */
export function setPeerVolume(listenerClientId: string, targetClientId: string, volumePct: number) {
  const pct = Math.max(0, Math.min(200, Math.round(volumePct)))
  const gain = pct / 100
  let m = peerVolumeByListener.get(listenerClientId)
  if (!m) {
    m = new Map()
    peerVolumeByListener.set(listenerClientId, m)
  }
  if (pct === 100) {
    m.delete(targetClientId)
    if (m.size === 0) peerVolumeByListener.delete(listenerClientId)
  } else {
    m.set(targetClientId, gain)
  }
}

function deriveKey(mediaSeedB64: string) {
  return Buffer.from(hkdfSync("sha256", Buffer.from(mediaSeedB64, "base64"), Buffer.from("voip-salt"), Buffer.from("media-key"), 32))
}

function encryptFrame(key: Buffer, seq: number, ts: number, roomId: string, payload: Buffer, kind = MEDIA_KIND_AUDIO): Buffer {
  const roomIdBuf = Buffer.from(roomId)
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(ts >>> 0, 0)
  nonce.writeUInt32BE(seq >>> 0, 4)
  randomBytes(4).copy(nonce, 8)
  const cipher = createCipheriv(MEDIA_CIPHER, key, nonce, { authTagLength: 16 })
  const plaintext = Buffer.concat([Buffer.from([kind & 0xff]), payload])
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()])
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
  let plaintext: Buffer
  try {
    const decipher = createDecipheriv(MEDIA_CIPHER, key, nonce, { authTagLength: 16 })
    decipher.setAuthTag(tag)
    plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
  } catch {
    return null
  }
  if (plaintext.length < 1) return null
  const kind = plaintext.readUInt8(0)
  const payload = plaintext.subarray(1)
  return { seq, ts, roomId, kind, payload }
}

function mixPcm16WeightedForListener(frames: FrameEntry[], listenerClientId: string): Buffer {
  const gains = peerVolumeByListener.get(listenerClientId)
  if (frames.length === 0) return Buffer.alloc(0)
  const minLen = Math.min(...frames.map((f) => f.pcm16.length))
  const out = Buffer.alloc(minLen)
  for (let i = 0; i < minLen; i += 2) {
    let sum = 0
    let wsum = 0
    for (const f of frames) {
      const g = gains?.get(f.clientId) ?? 1
      if (g <= 0) continue
      sum += f.pcm16.readInt16LE(i) * g
      wsum += g
    }
    if (wsum <= 0) {
      out.writeInt16LE(0, i)
    } else {
      const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / wsum)))
      out.writeInt16LE(mixed, i)
    }
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
  const opusDecoder = new OpusScript(OPUS_SAMPLE_RATE, OPUS_CHANNELS, OpusScript.Application.AUDIO)

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
        lastSpeakingSignalAtMs: 0,
        lastProbeAckAtMs: 0
      })
      logger.info(
        { clientId: payload.clientId, remoteAddress: rinfo.address, remotePort: rinfo.port },
        "media session HELLO accepted"
      )
      return
    }

    const sessionsList = [...sessions.values()].filter((s) => Boolean(s.key))
    const knownRemote = sessionsList.find(
      (s) => s.remote && s.remote.address === rinfo.address && s.remote.port === rinfo.port
    )

    let matchedSession: MemberSession | null = null
    let decoded: ReturnType<typeof decryptFrame> = null

    if (knownRemote?.key) {
      const hit = decryptFrame(knownRemote.key, packet)
      if (hit) {
        matchedSession = knownRemote
        decoded = hit
      } else {
        knownRemote.rxDecryptDropped += 1
      }
    }

    if (!matchedSession) {
      for (const session of sessionsList) {
        if (!session.key) continue
        if (knownRemote && session.clientId === knownRemote.clientId) continue
        const hit = decryptFrame(session.key, packet)
        if (!hit) continue
        matchedSession = session
        decoded = hit
        break
      }
    }

    if (!matchedSession || !decoded || !matchedSession.key) return

    const session = matchedSession
    const key = session.key
    if (!key) return
    // Accept valid packets from rebinding clients (NAT/source-port changes).
    if (!session.remote || session.remote.address !== rinfo.address || session.remote.port !== rinfo.port) {
      session.remote = { address: rinfo.address, port: rinfo.port }
      logger.debug({ clientId: session.clientId, remoteAddress: rinfo.address, remotePort: rinfo.port }, "media remote endpoint updated")
    }

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

    // Return lightweight encrypted probe-acks so clients can compute RTT
    // even when there are no other speakers in the room.
    const nowMs = Date.now()
    if (session.roomId && decoded.roomId === session.roomId && nowMs - session.lastProbeAckAtMs >= 1000) {
      if (!session.remote) return
      const probeAck = encryptFrame(key, session.seqOut++, decoded.ts, decoded.roomId, Buffer.alloc(0), MEDIA_KIND_AUDIO)
      socket.send(probeAck, session.remote.port, session.remote.address)
      session.txPackets += 1
      session.txBytes += probeAck.length
      session.lastProbeAckAtMs = nowMs
    }

    if (!session.roomId || session.roomId !== decoded.roomId) {
      session.rxRoomMismatchDropped += 1
      return
    }

    if (decoded.kind === MEDIA_KIND_AUDIO || decoded.kind === MEDIA_KIND_OPUS) {
      if (session.muted) return

      let pcm16: Buffer | null = null
      if (decoded.kind === MEDIA_KIND_AUDIO) {
        pcm16 = decoded.payload
      } else {
        try {
          const out = opusDecoder.decode(decoded.payload)
          pcm16 = Buffer.isBuffer(out) ? out : Buffer.from(out)
        } catch {
          session.rxDecryptDropped += 1
          return
        }
      }

      const energy = calcRmsEnergyPcm16(pcm16)
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
      list.push({ clientId: session.clientId, pcm16 })
      roomFrames.set(session.roomId, list)
      return
    }
    if (decoded.kind === MEDIA_KIND_SCREEN) {
      const chunks = roomScreenChunks.get(session.roomId) ?? []
      chunks.push({ clientId: session.clientId, chunk: decoded.payload })
      roomScreenChunks.set(session.roomId, chunks)
    }
    return
  })

  setInterval(() => {
    for (const [roomId, frames] of roomFrames.entries()) {
      if (frames.length === 0) continue
      for (const session of sessions.values()) {
        if (!session.roomId || session.roomId !== roomId || !session.remote || !session.key || session.deafened) continue
        // Avoid sidetone: each recipient gets room mix without own frame (per-listener volume weights).
        const otherFrames = frames.filter((f) => f.clientId !== session.clientId)
        if (otherFrames.length === 0) continue
        const mixed = mixPcm16WeightedForListener(otherFrames, session.clientId)
        const packet = encryptFrame(session.key, session.seqOut++, Date.now(), roomId, mixed)
        socket.send(packet, session.remote.port, session.remote.address)
        session.txPackets += 1
        session.txBytes += packet.length
      }
      roomFrames.set(roomId, [])
    }
  }, 20)

  setInterval(() => {
    for (const [roomId, chunks] of roomScreenChunks.entries()) {
      if (chunks.length === 0) continue
      for (const session of sessions.values()) {
        if (!session.roomId || session.roomId !== roomId || !session.remote || !session.key) continue
        for (const entry of chunks) {
          if (entry.clientId === session.clientId) continue
          if (entry.chunk.length > config.screenMaxChunkBytes + 64) {
            logger.debug({ roomId, fromClientId: entry.clientId, bytes: entry.chunk.length }, "screen chunk dropped: too large")
            continue
          }
          const packet = encryptFrame(session.key, session.seqOut++, Date.now(), roomId, entry.chunk, MEDIA_KIND_SCREEN)
          socket.send(packet, session.remote.port, session.remote.address)
          session.txPackets += 1
          session.txBytes += packet.length
        }
      }
      roomScreenChunks.set(roomId, [])
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
