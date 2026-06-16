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
  transport: "udp" | "tcp"
  remote?: { address: string; port: number }
  tcpSend?: ((packet: Buffer) => void) | null
  tcpLabel?: string
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
  lastPacketAtMs: number
  rxAudioFrames: number
  txAudioFrames: number
  rxOpusDecodeDropped: number
  /** Opus decoder state must be per-stream/client. */
  opusDecoder: OpusScript
}

type FrameEntry = {
  clientId: string
  pcm16: Buffer
  seq: number
  ts: number
  receivedAtMs: number
}

type SpeakerFrameBuffer = {
  queue: FrameEntry[]
  lastPcm16: Buffer
  lastAtMs: number
}

type ScreenChunkEntry = {
  clientId: string
  chunk: Buffer
}

const sessions = new Map<string, MemberSession>()
const roomSpeakerBuffers = new Map<string, Map<string, SpeakerFrameBuffer>>()
const roomScreenChunks = new Map<string, ScreenChunkEntry[]>()
const desiredRoomByClient = new Map<string, string | null>()
const desiredFlagsByClient = new Map<string, { muted: boolean; deafened: boolean }>()
const desiredSpeakingByClient = new Map<string, boolean>()
/** listenerClientId -> (targetClientId -> gain 0..2, from volumePct 0..200) */
const peerVolumeByListener = new Map<string, Map<string, number>>()
const roomMixTickSeq = new Map<string, number>()

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
  for (const [roomId, speakers] of roomSpeakerBuffers.entries()) {
    speakers.delete(clientId)
    if (speakers.size === 0) roomSpeakerBuffers.delete(roomId)
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

/** VoIP frames are 20ms @ 48kHz mono = 1920 bytes. Pad/truncate so mixing stays phase-aligned. */
const PCM20MS_BYTES = 960 * 2

function normalizePcm20ms(pcm: Buffer): Buffer {
  // Always return an owned copy. Decoder outputs can reuse internal buffers.
  if (pcm.length === PCM20MS_BYTES) return Buffer.from(pcm)
  if (pcm.length > PCM20MS_BYTES) return Buffer.from(pcm.subarray(0, PCM20MS_BYTES))
  const out = Buffer.alloc(PCM20MS_BYTES)
  pcm.copy(out, 0, 0, pcm.length)
  return out
}

function mixPcm16WeightedForListener(frames: FrameEntry[], listenerClientId: string): Buffer {
  const gains = peerVolumeByListener.get(listenerClientId)
  if (frames.length === 0) return Buffer.alloc(0)
  const minLen = Math.min(...frames.map((f) => f.pcm16.length))
  const out = Buffer.alloc(minLen)
  for (let i = 0; i < minLen; i += 2) {
    let sum = 0
    let gainSum = 0
    for (const f of frames) {
      const g = gains?.get(f.clientId) ?? 1
      if (g <= 0) continue
      sum += f.pcm16.readInt16LE(i) * g
      gainSum += g
    }
    if (gainSum <= 0) {
      out.writeInt16LE(0, i)
    } else {
      const mixed = Math.max(-32768, Math.min(32767, Math.round(sum / gainSum)))
      out.writeInt16LE(mixed, i)
    }
  }
  return out
}

function mixPcm16FloatForListener(frames: FrameEntry[], listenerClientId: string): Buffer {
  const gains = peerVolumeByListener.get(listenerClientId)
  if (frames.length === 0) return Buffer.alloc(0)
  const minLen = Math.min(...frames.map((f) => f.pcm16.length))
  const out = Buffer.alloc(minLen)
  for (let i = 0; i < minLen; i += 2) {
    let sum = 0
    let gainSum = 0
    for (const f of frames) {
      const g = gains?.get(f.clientId) ?? 1
      if (g <= 0) continue
      sum += (f.pcm16.readInt16LE(i) / 32768) * g
      gainSum += g
    }
    if (gainSum <= 0) {
      out.writeInt16LE(0, i)
      continue
    }
    // Keep primary path linear to preserve timbre; only hard-clamp at int16 bounds.
    const avg = sum / gainSum
    const s16 = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)))
    out.writeInt16LE(s16, i)
  }
  return out
}

function decayPcm16(input: Buffer, gain = 0.985): Buffer {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i += 2) {
    const s = input.readInt16LE(i)
    const d = Math.max(-32768, Math.min(32767, Math.round(s * gain)))
    out.writeInt16LE(d, i)
  }
  return out
}

function scalePcm16(input: Buffer, gain: number): Buffer {
  const out = Buffer.alloc(input.length)
  for (let i = 0; i < input.length; i += 2) {
    const s = input.readInt16LE(i)
    const d = Math.max(-32768, Math.min(32767, Math.round(s * gain)))
    out.writeInt16LE(d, i)
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
  onSessionStale?: (input: { clientId: string }) => void
}

type DecodedFrame = NonNullable<ReturnType<typeof decryptFrame>>

type ProcessContext = {
  logger: FastifyBaseLogger
  hooks: MediaHooks
  sendPacket: (session: MemberSession, packet: Buffer) => void
}

function applyHelloForSession(
  logger: FastifyBaseLogger,
  input: {
    clientId: string
    key: Buffer
    transport: "udp" | "tcp"
    remote?: { address: string; port: number }
    tcpSend?: ((packet: Buffer) => void) | null
    tcpLabel?: string
  }
) {
  const existing = sessions.get(input.clientId)
  const now = Date.now()
  const next: MemberSession = {
    clientId: input.clientId,
    roomId: desiredRoomByClient.get(input.clientId) ?? null,
    transport: input.transport,
    remote: input.transport === "udp" ? input.remote : undefined,
    tcpSend: input.transport === "tcp" ? input.tcpSend ?? null : null,
    tcpLabel: input.transport === "tcp" ? input.tcpLabel ?? "tcp" : undefined,
    key: input.key,
    lastSeqIn: existing?.lastSeqIn ?? 0,
    seqOut: existing?.seqOut ?? 1,
    packetCountSecond: 0,
    currentSecond: Math.floor(now / 1000),
    muted: desiredFlagsByClient.get(input.clientId)?.muted ?? existing?.muted ?? false,
    deafened: desiredFlagsByClient.get(input.clientId)?.deafened ?? existing?.deafened ?? false,
    rxPackets: existing?.rxPackets ?? 0,
    txPackets: existing?.txPackets ?? 0,
    rxBytes: existing?.rxBytes ?? 0,
    txBytes: existing?.txBytes ?? 0,
    rxLostEstimated: existing?.rxLostEstimated ?? 0,
    rxReplayDropped: existing?.rxReplayDropped ?? 0,
    rxRateLimitDropped: existing?.rxRateLimitDropped ?? 0,
    rxDecryptDropped: existing?.rxDecryptDropped ?? 0,
    rxRoomMismatchDropped: existing?.rxRoomMismatchDropped ?? 0,
    lastTransitMs: existing?.lastTransitMs ?? null,
    jitterMs: existing?.jitterMs ?? 0,
    delaySamplesMs: existing?.delaySamplesMs ?? [],
    jitterSamplesMs: existing?.jitterSamplesMs ?? [],
    lastReportAtMs: now,
    speaking: desiredSpeakingByClient.get(input.clientId) ?? existing?.speaking ?? false,
    lastSpeakingSignalAtMs: existing?.lastSpeakingSignalAtMs ?? 0,
    lastProbeAckAtMs: existing?.lastProbeAckAtMs ?? 0,
    lastPacketAtMs: now,
    rxAudioFrames: existing?.rxAudioFrames ?? 0,
    txAudioFrames: existing?.txAudioFrames ?? 0,
    rxOpusDecodeDropped: existing?.rxOpusDecodeDropped ?? 0,
    opusDecoder: existing?.opusDecoder ?? new OpusScript(OPUS_SAMPLE_RATE, OPUS_CHANNELS, OpusScript.Application.AUDIO)
  }
  sessions.set(input.clientId, next)
  if (input.transport === "udp" && input.remote) {
    logger.info(
      { clientId: input.clientId, remoteAddress: input.remote.address, remotePort: input.remote.port },
      "media session HELLO accepted (udp)"
    )
  } else {
    logger.info(
      { clientId: input.clientId, remote: input.tcpLabel ?? "tcp" },
      "media session HELLO accepted (tcp)"
    )
  }
}

function processDecodedPacket(
  session: MemberSession,
  decoded: DecodedFrame,
  packetLength: number,
  ctx: ProcessContext
) {
  const key = session.key
  if (!key) return
  session.lastPacketAtMs = Date.now()

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
  session.rxBytes += packetLength
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

  const nowMs = Date.now()
  if (session.roomId && decoded.roomId === session.roomId && nowMs - session.lastProbeAckAtMs >= 1000) {
    const probeAck = encryptFrame(key, session.seqOut++, decoded.ts, decoded.roomId, Buffer.alloc(0), MEDIA_KIND_AUDIO)
    ctx.sendPacket(session, probeAck)
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
        const out = session.opusDecoder.decode(decoded.payload)
        if (Buffer.isBuffer(out)) {
          pcm16 = out
        } else if (ArrayBuffer.isView(out)) {
          const view = out as ArrayBufferView
          pcm16 = Buffer.from(view.buffer, view.byteOffset, view.byteLength)
        } else {
          pcm16 = Buffer.from(out as ArrayLike<number>)
        }
      } catch {
        session.rxOpusDecodeDropped += 1
        return
      }
    }

    pcm16 = normalizePcm20ms(pcm16)
    const energy = calcRmsEnergyPcm16(pcm16)
    const nowEnergyTs = Date.now()
    const speakingThreshold = 0.02
    if (energy > speakingThreshold) {
      session.lastSpeakingSignalAtMs = nowEnergyTs
    }
    const speaking = nowEnergyTs - session.lastSpeakingSignalAtMs < 250
    if (speaking !== session.speaking) {
      session.speaking = speaking
      ctx.hooks.onSpeakingChanged?.({ clientId: session.clientId, speaking })
    }

    const roomId = session.roomId
    const bySpeaker = roomSpeakerBuffers.get(roomId) ?? new Map<string, SpeakerFrameBuffer>()
    const speaker = bySpeaker.get(session.clientId) ?? {
      queue: [],
      lastPcm16: Buffer.alloc(PCM20MS_BYTES),
      lastAtMs: 0
    }
    const frame: FrameEntry = { clientId: session.clientId, pcm16, seq: decoded.seq, ts: decoded.ts, receivedAtMs: Date.now() }
    speaker.queue.push(frame)
    if (speaker.queue.length > 4) {
      // Keep only a small jitter queue to cap one-way buffering latency.
      speaker.queue.splice(0, speaker.queue.length - 4)
    }
    speaker.lastPcm16 = frame.pcm16
    speaker.lastAtMs = frame.receivedAtMs
    bySpeaker.set(session.clientId, speaker)
    roomSpeakerBuffers.set(roomId, bySpeaker)
    session.rxAudioFrames += 1
    return
  }

  if (decoded.kind === MEDIA_KIND_SCREEN) {
    const chunks = roomScreenChunks.get(session.roomId) ?? []
    chunks.push({ clientId: session.clientId, chunk: decoded.payload })
    roomScreenChunks.set(session.roomId, chunks)
  }
}

function sendViaTransport(socket: dgram.Socket, session: MemberSession, packet: Buffer) {
  if (session.transport === "tcp") {
    session.tcpSend?.(packet)
    return
  }
  if (!session.remote) return
  socket.send(packet, session.remote.port, session.remote.address)
}

function evictStaleMediaSession(clientId: string) {
  for (const [roomId, speakers] of roomSpeakerBuffers.entries()) {
    speakers.delete(clientId)
    if (speakers.size === 0) roomSpeakerBuffers.delete(roomId)
  }
  sessions.delete(clientId)
}

let mediaIdleMonitorStarted = false
function ensureMediaIdleMonitor(hooks: MediaHooks) {
  if (mediaIdleMonitorStarted) return
  mediaIdleMonitorStarted = true
  setInterval(() => {
    const now = Date.now()
    const idleMs = config.mediaSessionIdleSec * 1000
    for (const [clientId, session] of [...sessions.entries()]) {
      if (!session.roomId) continue
      if (now - session.lastPacketAtMs < idleMs) continue
      evictStaleMediaSession(clientId)
      hooks.onSessionStale?.({ clientId })
    }
  }, 15_000).unref?.()
}

export function registerTcpHello(
  logger: FastifyBaseLogger,
  input: { mediaToken: string; sendPacket: (packet: Buffer) => void; remoteLabel?: string }
): { ok: true; clientId: string } | { ok: false } {
  const payload = verifyToken(input.mediaToken, config.tokenSecret)
  if (!payload || payload.sub !== "media" || !payload.mediaSeed) return { ok: false }
  applyHelloForSession(logger, {
    clientId: payload.clientId,
    key: deriveKey(payload.mediaSeed),
    transport: "tcp",
    tcpSend: input.sendPacket,
    tcpLabel: input.remoteLabel ?? "tcp"
  })
  return { ok: true, clientId: payload.clientId }
}

export function detachTcpTransport(clientId: string) {
  const session = sessions.get(clientId)
  if (!session || session.transport !== "tcp") return
  session.tcpSend = null
}

export function handleTcpPacket(
  packet: Buffer,
  clientId: string,
  input: { logger: FastifyBaseLogger; hooks?: MediaHooks }
) {
  const session = sessions.get(clientId)
  if (!session || session.transport !== "tcp" || !session.key) return
  const decoded = decryptFrame(session.key, packet)
  if (!decoded) {
    session.rxDecryptDropped += 1
    return
  }
  processDecodedPacket(session, decoded, packet.length, {
    logger: input.logger,
    hooks: input.hooks ?? {},
    sendPacket: (_s, out) => {
      session.tcpSend?.(out)
    }
  })
}

export function createMediaServer(logger: FastifyBaseLogger, hooks: MediaHooks = {}) {
  const socket = dgram.createSocket("udp4")
  const processCtx: ProcessContext = {
    logger,
    hooks,
    sendPacket: (session, packet) => sendViaTransport(socket, session, packet)
  }

  socket.on("message", (packet: Buffer, rinfo: RemoteInfo) => {
    if (packet.length < 20) return
    // bootstrap packet: "HELLO <mediaToken>"
    if (packet.subarray(0, 6).toString() === "HELLO ") {
      const token = packet.subarray(6).toString().trim()
      const payload = verifyToken(token, config.tokenSecret)
      if (!payload || payload.sub !== "media" || !payload.mediaSeed) return
      applyHelloForSession(logger, {
        clientId: payload.clientId,
        key: deriveKey(payload.mediaSeed),
        transport: "udp",
        remote: { address: rinfo.address, port: rinfo.port }
      })
      socket.send(Buffer.from("HELLO_ACK"), rinfo.port, rinfo.address)
      return
    }

    const sessionsList = [...sessions.values()].filter((s) => s.transport === "udp" && Boolean(s.key))
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
    // Accept valid packets from rebinding clients (NAT/source-port changes).
    if (!session.remote || session.remote.address !== rinfo.address || session.remote.port !== rinfo.port) {
      session.remote = { address: rinfo.address, port: rinfo.port }
      logger.debug({ clientId: session.clientId, remoteAddress: rinfo.address, remotePort: rinfo.port }, "media remote endpoint updated")
    }
    processDecodedPacket(session, decoded, packet.length, processCtx)
  })

  setInterval(() => {
    for (const [roomId, speakers] of roomSpeakerBuffers.entries()) {
      if (speakers.size === 0) continue
      const tickSeq = (roomMixTickSeq.get(roomId) ?? 0) + 1
      roomMixTickSeq.set(roomId, tickSeq)
      const tickAt = Date.now()
      const tickFrames: FrameEntry[] = []
      let queuedFramesBefore = 0
      let syntheticPlcFrames = 0
      let queueDropFrames = 0
      for (const [speakerId, sb] of speakers.entries()) {
        queuedFramesBefore += sb.queue.length
        const frame = sb.queue.shift()
        if (frame) {
          tickFrames.push(frame)
        } else if (tickAt - sb.lastAtMs <= 25 && sb.lastPcm16.length === PCM20MS_BYTES) {
          // Very short-loss concealment only for one tick to avoid "word glue".
          const plcFrame: FrameEntry = {
            clientId: speakerId,
            pcm16: decayPcm16(sb.lastPcm16),
            seq: 0,
            ts: 0,
            receivedAtMs: tickAt
          }
          sb.lastPcm16 = plcFrame.pcm16
          tickFrames.push(plcFrame)
          syntheticPlcFrames += 1
        }
        if (sb.queue.length > 3) {
          const drop = sb.queue.length - 3
          sb.queue.splice(0, drop)
          queueDropFrames += drop
        }
        if (sb.queue.length === 0 && tickAt - sb.lastAtMs > 2_000) {
          speakers.delete(speakerId)
        }
      }
      if (speakers.size === 0) {
        roomSpeakerBuffers.delete(roomId)
      }
      if (tickFrames.length === 0) continue
      for (const session of sessions.values()) {
        if (!session.roomId || session.roomId !== roomId || !session.key || session.deafened) continue
        if (session.transport === "udp" && !session.remote) continue
        if (session.transport === "tcp" && !session.tcpSend) continue
        // Avoid sidetone: each recipient gets room mix without own frame (per-listener volume weights).
        const otherFrames = tickFrames.filter((f) => f.clientId !== session.clientId)
        if (otherFrames.length === 0) continue
        let mixed: Buffer
        if (otherFrames.length === 1) {
          // 1:1 path: bypass mixer coloration for maximum voice fidelity.
          const only = otherFrames[0]
          const g = peerVolumeByListener.get(session.clientId)?.get(only.clientId) ?? 1
          mixed = g === 1 ? Buffer.from(only.pcm16) : scalePcm16(only.pcm16, g)
        } else {
          mixed = mixPcm16FloatForListener(otherFrames, session.clientId)
        }
        const packet = encryptFrame(session.key, session.seqOut++, Date.now(), roomId, mixed)
        sendViaTransport(socket, session, packet)
        session.txPackets += 1
        session.txBytes += packet.length
        session.txAudioFrames += 1
      }
      if (config.voiceTrace) {
        const oldest = Math.min(...tickFrames.map((f) => f.receivedAtMs))
        const newest = Math.max(...tickFrames.map((f) => f.receivedAtMs))
        logger.info(
          {
            roomId,
            tickSeq,
            speakers: new Set(tickFrames.map((f) => f.clientId)).size,
            tickFrames: tickFrames.length,
            queuedFramesBefore,
            queueDropFrames,
            syntheticPlcFrames,
            queueSpanMs: newest - oldest
          },
          "voice trace mixer tick"
        )
      }
    }
  }, 20)

  setInterval(() => {
    for (const [roomId, chunks] of roomScreenChunks.entries()) {
      if (chunks.length === 0) continue
      for (const session of sessions.values()) {
        if (!session.roomId || session.roomId !== roomId || !session.key) continue
        if (session.transport === "udp" && !session.remote) continue
        if (session.transport === "tcp" && !session.tcpSend) continue
        for (const entry of chunks) {
          if (entry.clientId === session.clientId) continue
          if (entry.chunk.length > config.screenMaxChunkBytes + 64) {
            logger.debug({ roomId, fromClientId: entry.clientId, bytes: entry.chunk.length }, "screen chunk dropped: too large")
            continue
          }
          const packet = encryptFrame(session.key, session.seqOut++, Date.now(), roomId, entry.chunk, MEDIA_KIND_SCREEN)
          sendViaTransport(socket, session, packet)
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
          remote: session.transport === "udp"
            ? (session.remote ? `${session.remote.address}:${session.remote.port}` : null)
            : (session.tcpLabel ?? "tcp"),
          transport: session.transport,
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
          rxRoomMismatchDropped: session.rxRoomMismatchDropped,
          rxAudioFrames: session.rxAudioFrames,
          txAudioFrames: session.txAudioFrames,
          rxOpusDecodeDropped: session.rxOpusDecodeDropped
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
      session.rxAudioFrames = 0
      session.txAudioFrames = 0
      session.rxOpusDecodeDropped = 0
    }
  }, 5000)

  ensureMediaIdleMonitor(hooks)

  socket.bind(config.udpPort, config.udpHost, () => {
    logger.info({ udpHost: config.udpHost, udpPort: config.udpPort }, "media UDP server listening")
  })

  return socket
}
